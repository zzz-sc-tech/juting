/**
 * 句听更新包生成器：把一棵目录树打成标准 ZIP（纯 Node 实现，零第三方依赖）。
 *
 * 用途：为启动器（句听.exe）的「检查更新 + 一键覆盖安装」产出 *-update.zip 资产。
 * 启动器优先下载 zip（Node 能原生解压），没有才回退 .7z（需用户本机有 7-Zip）。
 *
 * 与 7z 包的差别（解压语义一致，工具不同）：
 *   - 直接以 srcDir 的内容为根，不额外套一层目录；解压后与安装目录结构完全相同；
 *   - 文件名以 UTF-8 编码，并置 general purpose flag bit 11（文件名含中文：
 *     句听.exe、使用说明.md）；
 *   - 文本类走 deflateRaw（level 1，速度优先）；已压缩的大文件（7z/zip/mp3/exe…）
 *     走 stored 直接存，省 CPU 也避免二次压缩无收益；
 *   - 跳过用户数据与运行态：temp/runtime/{mysql-data,media-store,logs}、
 *     temp/runtime/launcher-*.json、temp/runtime/update*，以及 .git 与 *.log；
 *     仅保留包根的 句听.exe（构建产物），其他位置的 句听.exe 一律跳过。
 *
 * 结构：本地文件头（30B + 名称 + extra）+ 数据 + 中央目录（46B + 名称 + extra）
 *       + EOCD（22B）；超出标准 ZIP 上限时自动补 Zip64 段：
 *         - 条目数 > 65535 → 追加 Zip64 EOCD（56B）+ 定位器（20B），标准 EOCD 的
 *           计数/大小/偏移写 0xFFFF/0xFFFFFFFF 哨兵指向 EOCD64；
 *         - 单条目压缩后/原始大小或本地头偏移 > 4 GiB → 该条目固定字段写哨兵，
 *           真实 64 位值放 extra 字段（ID 0x0001，顺序 uncompSize→compSize→offset）。
 *       两条路径都覆盖，不再因大包中止。7-Zip / Info-ZIP / Windows 资源管理器
 *       均可正常解压；启动器的 Node 原生解压同样支持（lib/解压实现按哨兵查 extra）。
 *
 * 用法（CLI，供独立测试）：node scripts/local/make-update-zip.mjs <srcDir> <zipPath>
 * 编程调用：import { makeUpdateZip } from './make-update-zip.mjs'
 *           makeUpdateZip(srcDir, zipPath, { skip, onProgress })
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// ── CRC32 ───────────────────────────────────────────────────
// Node 22+ 提供原生 zlib.crc32；老版本回退到查表法（多项式 0xEDB88320，
// 即 IEEE 802.3 反射多项式，与 ZIP 规范一致）。
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();
const crc32TableImpl = (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i += 1) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
};
const crc32 = typeof zlib.crc32 === 'function'
    ? (buf) => zlib.crc32(buf) >>> 0
    : crc32TableImpl;

// ── 常量 ────────────────────────────────────────────────────
const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;      // Zip64 中央目录结束记录
const SIG_EOCD64_LOCATOR = 0x07064b50; // Zip64 EOCD 定位器
const FLAG_UTF8 = 0x0800;           // general purpose flag bit 11：文件名 UTF-8
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;          // 2.0：支持 deflate 与目录
const VERSION_NEEDED_ZIP64 = 45;    // 4.5：Zip64
const MAX_UINT32 = 0xFFFFFFFF;
const MAX_UINT16 = 0xFFFF;
const MAX_ENTRIES = MAX_UINT16;     // 标准 EOCD 计数上限
const ZIP64_EXTRA_ID = 0x0001;      // Zip64 扩展字段头 ID

// 已压缩的格式直接用 stored 存，省 CPU 且不会更小。
const STORED_EXTENSIONS = new Set([
    '.7z', '.zip', '.mp3', '.m4a', '.wav', '.png', '.jpg', '.ico',
    '.exe', '.dll', '.whl', '.bin',
]);

// ── 跳过规则（rel 一律用 '/' 分隔）───────────────────────────
export function defaultSkip(rel) {
    const parts = rel.split('/');
    const base = parts[parts.length - 1];
    // 版本库目录不进包
    if (parts.includes('.git')) return true;
    // 用户数据与运行态：升级覆盖时必须原样保留，绝不打包
    if (rel === 'temp/runtime/mysql-data' || rel.startsWith('temp/runtime/mysql-data/')) return true;
    if (rel === 'temp/runtime/media-store' || rel.startsWith('temp/runtime/media-store/')) return true;
    if (rel === 'temp/runtime/logs' || rel.startsWith('temp/runtime/logs/')) return true;
    // 运行态碎片文件（与 temp/runtime 同级，仅匹配直接子项）
    if (parts.length === 3 && parts[0] === 'temp' && parts[1] === 'runtime') {
        if (/^launcher-.*\.json$/.test(base)) return true;
        if (base.startsWith('update')) return true;
    }
    // 日志文件任意层级
    if (base.toLowerCase().endsWith('.log')) return true;
    // 仅保留包根的 句听.exe（构建产物）；其他位置的同名文件跳过
    if (base === '句听.exe' && rel !== '句听.exe') return true;
    return false;
}

// ── DOS 时间戳（ZIP 使用 1980 纪元的 16 位日期/时间）────────
const toDosDateTime = (date) => {
    let year = date.getFullYear();
    if (year < 1980) year = 1980;
    const dosDate = (((year - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0x0F) << 5) | (date.getDate() & 0x1F);
    const dosTime = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F);
    return { dosDate: dosDate & 0xFFFF, dosTime: dosTime & 0xFFFF };
};

// 单次 writeSync 不保证写满，循环补齐。
const writeAll = (fd, buf) => {
    let written = 0;
    while (written < buf.length) {
        written += fs.writeSync(fd, buf, written, buf.length - written);
    }
};

// ── 遍历目录树，产出排序后的条目列表 ────────────────────────
const collectEntries = (rootDir, extraSkip) => {
    const entries = [];
    const skip = (rel) => defaultSkip(rel) || (typeof extraSkip === 'function' && !!extraSkip(rel));
    const walk = (dir) => {
        const names = fs.readdirSync(dir).sort();
        for (const name of names) {
            const abs = path.join(dir, name);
            const rel = path.relative(rootDir, abs).split(path.sep).join('/');
            let stat;
            try {
                stat = fs.statSync(abs); // 跟随符号链接（拷贝阶段已 dereference，正常无链接）
            } catch {
                continue; // 断链等异常项跳过
            }
            if (stat.isDirectory()) {
                if (skip(rel)) continue;
                entries.push({ abs, rel, isDir: true, size: 0, mtime: stat.mtime });
                walk(abs);
            } else if (stat.isFile()) {
                if (skip(rel)) continue;
                entries.push({ abs, rel, isDir: false, size: stat.size, mtime: stat.mtime });
            }
        }
    };
    walk(rootDir);
    return entries;
};

// ── 主函数 ──────────────────────────────────────────────────
/**
 * 把 srcDir 打成 zipPath（以 srcDir 内容为根）。
 * @param {string} srcDir   源目录
 * @param {string} zipPath  目标 zip 路径
 * @param {{ skip?: (rel: string) => boolean, onProgress?: (info: {files:number,bytes:number,rel:string}) => void }} [options]
 *        skip：额外跳过谓词（默认规则始终生效）；onProgress：进度回调（默认每 2000 个文件打印一次）
 * @returns {{ files: number, bytes: number, zipPath: string }}
 */
export function makeUpdateZip(srcDir, zipPath, options = {}) {
    const { skip, onProgress } = options;
    const rootAbs = path.resolve(srcDir);
    if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
        throw new Error(`源目录不存在或不是目录：${rootAbs}`);
    }

    const entries = collectEntries(rootAbs, skip);
    // 条目数超 65535 → 走 Zip64（写 Zip64 EOCD + 定位器）。单文件/偏移超 4 GiB
    // 也走 Zip64（条目级 extra 字段），本函数两条路径都覆盖。
    const needsZip64Eocd = entries.length > MAX_ENTRIES;

    const progress = onProgress || ((info) => {
        console.log(`[zip] 已处理 ${info.files} 个文件…`);
    });

    fs.mkdirSync(path.dirname(zipPath), { recursive: true });
    const fd = fs.openSync(zipPath, 'w');
    let offset = 0;
    let fileCount = 0;
    let totalBytes = 0;
    const central = [];

    const write = (buf) => {
        writeAll(fd, buf);
        offset += buf.length;
    };

    try {
        for (const entry of entries) {
            const { dosDate, dosTime } = toDosDateTime(entry.mtime);
            const nameBuf = Buffer.from(entry.isDir ? `${entry.rel}/` : entry.rel, 'utf8');

            let method = METHOD_STORED;
            let dataBuf = Buffer.alloc(0);
            let uncompSize = 0;
            let crc = 0;
            let payload = Buffer.alloc(0);

            if (entry.isDir) {
                // 目录条目：空数据、crc=0
                payload = Buffer.alloc(0);
            } else {
                dataBuf = fs.readFileSync(entry.abs);
                uncompSize = dataBuf.length;
                crc = crc32(dataBuf);
                const ext = path.extname(entry.rel).toLowerCase();
                if (!STORED_EXTENSIONS.has(ext) && uncompSize > 0) {
                    method = METHOD_DEFLATE;
                    payload = zlib.deflateRawSync(dataBuf, { level: 1 });
                } else {
                    method = METHOD_STORED;
                    payload = dataBuf;
                }
            }

            const compSize = payload.length;
            const localOffset = offset;
            // 条目级 Zip64：压缩后大小、原始大小、本地头偏移任一超 4 GiB 时，
            // 固定字段写 0xFFFFFFFF 哨兵，真实 64 位值放 extra 字段（顺序固定：
            // uncompSize → compSize → localOffset，只放超限的那些）。
            const zip64Size = compSize > MAX_UINT32 || uncompSize > MAX_UINT32;
            const zip64Offset = localOffset > MAX_UINT32;
            const needZip64Extra = zip64Size || zip64Offset;
            let extra = Buffer.alloc(0);
            if (needZip64Extra) {
                const vals = [];
                if (zip64Size) { vals.push(uncompSize, compSize); }
                if (zip64Offset) { vals.push(localOffset); }
                const extraData = Buffer.alloc(4 + vals.length * 8);
                extraData.writeUInt16LE(ZIP64_EXTRA_ID, 0);
                extraData.writeUInt16LE(vals.length * 8, 2);
                vals.forEach((v, i) => extraData.writeBigUInt64LE(BigInt(v), 4 + i * 8));
                extra = extraData;
            }
            const versionNeeded = needZip64Extra ? VERSION_NEEDED_ZIP64 : VERSION_NEEDED;

            const localHead = Buffer.alloc(30);
            localHead.writeUInt32LE(SIG_LOCAL, 0);
            localHead.writeUInt16LE(versionNeeded, 4);
            localHead.writeUInt16LE(FLAG_UTF8, 6);
            localHead.writeUInt16LE(method, 8);
            localHead.writeUInt16LE(dosTime, 10);
            localHead.writeUInt16LE(dosDate, 12);
            localHead.writeUInt32LE(crc, 14);
            // 本地头的大小字段：Zip64 时同样写哨兵 + extra（7-Zip/Info-ZIP 均接受）
            localHead.writeUInt32LE(zip64Size ? MAX_UINT32 : compSize, 18);
            localHead.writeUInt32LE(zip64Size ? MAX_UINT32 : uncompSize, 22);
            localHead.writeUInt16LE(nameBuf.length, 26);
            localHead.writeUInt16LE(extra.length, 28);
            write(localHead);
            write(nameBuf);
            write(extra);
            write(payload);

            const centralHead = Buffer.alloc(46);
            centralHead.writeUInt32LE(SIG_CENTRAL, 0);
            centralHead.writeUInt16LE(versionNeeded, 4);       // version made by
            centralHead.writeUInt16LE(versionNeeded, 6);       // version needed
            centralHead.writeUInt16LE(FLAG_UTF8, 8);
            centralHead.writeUInt16LE(method, 10);
            centralHead.writeUInt16LE(dosTime, 12);
            centralHead.writeUInt16LE(dosDate, 14);
            centralHead.writeUInt32LE(crc, 16);
            centralHead.writeUInt32LE(zip64Size ? MAX_UINT32 : compSize, 20);
            centralHead.writeUInt32LE(zip64Size ? MAX_UINT32 : uncompSize, 24);
            centralHead.writeUInt16LE(nameBuf.length, 28);
            centralHead.writeUInt16LE(extra.length, 30);       // extra len
            centralHead.writeUInt16LE(0, 32);                  // comment len
            centralHead.writeUInt16LE(0, 34);                  // disk start
            centralHead.writeUInt16LE(0, 36);                  // internal attrs
            centralHead.writeUInt32LE(entry.isDir ? 0x10 : 0, 38); // external attrs（目录置 DOS 目录位）
            centralHead.writeUInt32LE(zip64Offset ? MAX_UINT32 : localOffset, 42);
            central.push(Buffer.concat([centralHead, nameBuf, extra]));

            if (!entry.isDir) {
                fileCount += 1;
                totalBytes += uncompSize;
                if (fileCount % 2000 === 0) {
                    progress({ files: fileCount, bytes: totalBytes, rel: entry.rel });
                }
            }
        }

        // 中央目录
        const cdStart = offset;
        for (const record of central) {
            write(record);
        }
        const cdSize = offset - cdStart;
        // 中央目录本身超 4 GiB 也必须走 Zip64（本实现用 64 位值写入 EOCD64）
        const needsZip64 = needsZip64Eocd || cdStart > MAX_UINT32 || cdSize > MAX_UINT32
            || central.length > MAX_ENTRIES;

        if (needsZip64) {
            // Zip64 中央目录结束记录（EOCD64，固定 56 字节，无注释）
            const eocd64Offset = offset;
            const eocd64 = Buffer.alloc(56);
            eocd64.writeUInt32LE(SIG_EOCD64, 0);
            eocd64.writeBigUInt64LE(44n, 4);              // 本记录大小（56 - 12）
            eocd64.writeUInt16LE(VERSION_NEEDED_ZIP64, 12); // version made by
            eocd64.writeUInt16LE(VERSION_NEEDED_ZIP64, 14); // version needed
            eocd64.writeUInt32LE(0, 16);                  // 本磁盘号
            eocd64.writeUInt32LE(0, 20);                  // 中央目录起始磁盘号
            eocd64.writeBigUInt64LE(BigInt(central.length), 24); // 本磁盘条目数
            eocd64.writeBigUInt64LE(BigInt(central.length), 32); // 条目总数
            eocd64.writeBigUInt64LE(BigInt(cdSize), 40);
            eocd64.writeBigUInt64LE(BigInt(cdStart), 48);
            write(eocd64);

            // Zip64 EOCD 定位器（20 字节）
            const locator = Buffer.alloc(20);
            locator.writeUInt32LE(SIG_EOCD64_LOCATOR, 0);
            locator.writeUInt32LE(0, 4);                  // EOCD64 所在磁盘号
            locator.writeBigUInt64LE(BigInt(eocd64Offset), 8);
            locator.writeUInt32LE(1, 16);                 // 磁盘总数
            write(locator);

            // 标准 EOCD（22 字节）：超限字段写哨兵，让老工具知道去看 EOCD64
            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(SIG_EOCD, 0);
            eocd.writeUInt16LE(0, 4);
            eocd.writeUInt16LE(0, 6);
            eocd.writeUInt16LE(Math.min(central.length, MAX_ENTRIES), 8);
            eocd.writeUInt16LE(Math.min(central.length, MAX_ENTRIES), 10);
            eocd.writeUInt32LE(cdSize > MAX_UINT32 ? MAX_UINT32 : cdSize, 12);
            eocd.writeUInt32LE(cdStart > MAX_UINT32 ? MAX_UINT32 : cdStart, 16);
            eocd.writeUInt16LE(0, 20);
            write(eocd);
        } else {
            // 标准 ZIP 路径（条目数与大小都在 16/32 位范围内）
            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(SIG_EOCD, 0);
            eocd.writeUInt16LE(0, 4);                 // 本磁盘号
            eocd.writeUInt16LE(0, 6);                 // 中央目录起始磁盘号
            eocd.writeUInt16LE(central.length, 8);    // 本磁盘条目数
            eocd.writeUInt16LE(central.length, 10);   // 条目总数
            eocd.writeUInt32LE(cdSize, 12);
            eocd.writeUInt32LE(cdStart, 16);
            eocd.writeUInt16LE(0, 20);                // 注释长度
            write(eocd);
        }

        progress({ files: fileCount, bytes: totalBytes, rel: '' });
        return { files: fileCount, bytes: totalBytes, zipPath };
    } finally {
        fs.closeSync(fd);
    }
}

// ── CLI ─────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const [srcDir, zipPath] = process.argv.slice(2);
    if (!srcDir || !zipPath) {
        console.error('用法：node scripts/local/make-update-zip.mjs <srcDir> <zipPath>');
        process.exit(1);
    }
    try {
        const started = Date.now();
        const result = makeUpdateZip(srcDir, zipPath);
        const { size } = fs.statSync(result.zipPath);
        console.log(`[zip] 完成：${result.files} 个文件，${(size / 1024 / 1024).toFixed(1)} MB，耗时 ${Date.now() - started} ms`);
        console.log(`[zip] 输出：${path.resolve(result.zipPath)}`);
    } catch (error) {
        console.error(`[zip] 失败：${error && error.message ? error.message : error}`);
        process.exit(1);
    }
}

export { crc32 };
