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
 * 结构：本地文件头（30B + 名称）+ 数据 + 中央目录（46B + 名称）+ EOCD（22B）。
 * 限制：本实现为标准 ZIP（非 Zip64），单条目/总大小须 < 4 GiB、条目数须 < 65535；
 *       超出即报错中止，绝不产出损坏的归档（避免用户下载到打不开的更新包）。
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
const FLAG_UTF8 = 0x0800;           // general purpose flag bit 11：文件名 UTF-8
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;          // 2.0：支持 deflate 与目录
const MAX_UINT32 = 0xFFFFFFFF;
const MAX_ENTRIES = 0xFFFF;         // 标准 EOCD 计数上限

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
    if (entries.length > MAX_ENTRIES) {
        throw new Error(`条目数 ${entries.length} 超过标准 ZIP 上限 ${MAX_ENTRIES}，需要 Zip64（本实现未支持）`);
    }

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
            if (compSize > MAX_UINT32 || uncompSize > MAX_UINT32) {
                throw new Error(`文件过大（${entry.rel}，${compSize} 字节），超出标准 ZIP 4 GiB 限制，需要 Zip64`);
            }
            if (offset > MAX_UINT32) {
                throw new Error(`归档偏移已超过 4 GiB，需要 Zip64（本实现未支持）`);
            }

            const localOffset = offset;
            const localHead = Buffer.alloc(30);
            localHead.writeUInt32LE(SIG_LOCAL, 0);
            localHead.writeUInt16LE(VERSION_NEEDED, 4);
            localHead.writeUInt16LE(FLAG_UTF8, 6);
            localHead.writeUInt16LE(method, 8);
            localHead.writeUInt16LE(dosTime, 10);
            localHead.writeUInt16LE(dosDate, 12);
            localHead.writeUInt32LE(crc, 14);
            localHead.writeUInt32LE(compSize, 18);
            localHead.writeUInt32LE(uncompSize, 22);
            localHead.writeUInt16LE(nameBuf.length, 26);
            localHead.writeUInt16LE(0, 28);
            write(localHead);
            write(nameBuf);
            write(payload);

            const centralHead = Buffer.alloc(46);
            centralHead.writeUInt32LE(SIG_CENTRAL, 0);
            centralHead.writeUInt16LE(VERSION_NEEDED, 4);      // version made by
            centralHead.writeUInt16LE(VERSION_NEEDED, 6);      // version needed
            centralHead.writeUInt16LE(FLAG_UTF8, 8);
            centralHead.writeUInt16LE(method, 10);
            centralHead.writeUInt16LE(dosTime, 12);
            centralHead.writeUInt16LE(dosDate, 14);
            centralHead.writeUInt32LE(crc, 16);
            centralHead.writeUInt32LE(compSize, 20);
            centralHead.writeUInt32LE(uncompSize, 24);
            centralHead.writeUInt16LE(nameBuf.length, 28);
            centralHead.writeUInt16LE(0, 30);                  // extra len
            centralHead.writeUInt16LE(0, 32);                  // comment len
            centralHead.writeUInt16LE(0, 34);                  // disk start
            centralHead.writeUInt16LE(0, 36);                  // internal attrs
            centralHead.writeUInt32LE(entry.isDir ? 0x10 : 0, 38); // external attrs（目录置 DOS 目录位）
            centralHead.writeUInt32LE(localOffset, 42);
            central.push(Buffer.concat([centralHead, nameBuf]));

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
        if (cdStart > MAX_UINT32 || cdSize > MAX_UINT32) {
            throw new Error('中央目录超出 4 GiB，需要 Zip64（本实现未支持）');
        }

        // 中央目录结束记录（EOCD）
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
