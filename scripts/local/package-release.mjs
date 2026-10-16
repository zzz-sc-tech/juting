/**
 * 句听发布打包脚本：产出可独立分发的 7z 包（默认输出到 ../juting-release/）。
 *
 *   juting-v<版本>-win-lite.7z       简洁版：程序本体 + 便携 Node + 便携 MySQL（裁剪），
 *                                    空课程开箱，双击 句听.exe 即用（托盘常驻；bat 保留作
 *                                    开发者与排障备用），不内置任何运行环境依赖；
 *   juting-v<版本>-win-full-cet6.7z  六级版：= 简洁版 + 六级预设（38 套真题音频与原文）。
 *                                    不含本地识别引擎（2026-10-02 起移除：ASR 需大量校准，
 *                                    单机学习用户用不到；需要时管理后台一键在线安装）。
 *   juting-v<版本>-win-cet4.7z       四级版：= 简洁版 + 四级预设（49 套真题音频与原文）。
 *   （--flavor both 时输出 juting-v<版本>-win-full-cet6cet4.7z，六级 + 四级合一，内部/自用。）
 *
 * 归档命名刻意不对称（详见代码内注释）：cet6 保留 legacy 的 `full` 词元（已发布 v0.5.0
 * 启动器按资产名子串 `full` 选包，必须仍能命中六级包）；cet4 刻意不含 `full`。
 *
 * 同时生成 SHA256SUMS.txt。
 *
 * 发布资产还包含三层增量更新包（2026-10-15 起，替代原来的单个整包 update.zip）：
 *   -update.zip  程序层（~5MB）  ：程序代码 + seed/manifest；排除 temp/、依赖树、预设媒体
 *   -deps.zip    依赖层（~120MB）：依赖树，仅 package-lock 变化时才需下载
 *   -media.zip   媒体层（~218MB）：预设媒体文件，仅音频集合变化时才需下载
 * 三层内部均与安装目录同构，客户端「一键更新」按 update-manifest.json 门控后逐层覆盖安装。
 * 纯 Node 打包（scripts/local/make-update-zip.mjs，已支持 Zip64），客户端原生解压，
 * 无需用户另装 7-Zip（.7z 仍产出，作为全新安装与门控失效时的兜底）。
 * 注意：lite 的包在拷入 presets 之前打（否则会串进预设音频），full 在之后打。
 * 方案与门控细节见 docs/增量更新方案.md。
 *
 * 打包内容要点：
 *   - 不打包含绝对路径的任何 .env（启动器会按当前安装位置现场生成 portable.env）；
 *   - 不打包 mysql-data / media-store / logs：数据库首次启动自动初始化，
 *     预设媒体由预设导入器从 presets/ 硬链/复制进 media-store；
 *   - MySQL 发行目录裁掉调试符号（*.pdb）、C 开发库（lib/*.lib）、日文 mecab 词典、
 *     debug 插件与 include/docs，只留运行所需；
 *   - node_modules 裁掉 .cache、已移除的 mobile-app 工作区残留依赖（Expo/React Native 系），
 *     以及工作区符号链接实体化会带入的 @juting/admin 与 @juting/web-app 两棵前端依赖
 *     （@ant-design/charts ~262MB、react-icons ~85MB，运行时不使用）；
 *   - 打包前必须先 node scripts/local/stop-all.mjs 关掉 MySQL，否则数据文件被锁。
 *
 *   - 启动器 句听.exe 由 scripts/local/build-launcher.mjs 构建（Node SEA 单文件），
 *     打包前自动构建；传 --skip-launcher 时要求产物已存在；
 *
 * 用法：node scripts/local/package-release.mjs [--version 1.0.0] [--skip-build] [--skip-launcher]
 *       [--only lite|full|all] [--flavor cet6|cet4|both] [--presets-from <dir>] [--stage-only]
 *   旧旗标兼容：--no-cet4（= --flavor cet6）、--cet4-only（= --flavor cet4）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { makeUpdateZip } from './make-update-zip.mjs';
import * as layerPaths from './layer-paths.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = path.join(repositoryRoot, '..', 'juting-release');
const stageRoot = path.join(repositoryRoot, '..', 'juting-package');

const startTime = Date.now();
const log = (msg) => console.log(`[打包] ${msg}`);

// ── 参数 ────────────────────────────────────────────────────
const argOf = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};
const rootPackage = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const versionArg = argOf('--version');
const version = versionArg || rootPackage.version || '0.0.0';
// ⚠️ 版本一致性守卫（2026-10-16 实测教训）：`--version` 只影响**归档命名**，不会改包内
// package.json（那是从仓库根原样复制的）。若两者不一致，客户端装完读到的版本仍是旧的
// → 判定「还有新版」→ **无限重复更新**。正式发版必须先改 package.json 再打包；
// `--version` 仅用于测试构建，此时强制要求显式 --allow-version-mismatch 才放行。
if (versionArg && versionArg !== rootPackage.version && !process.argv.includes('--allow-version-mismatch')) {
    throw new Error(
        `--version ${versionArg} 与 package.json 的 ${rootPackage.version} 不一致。\n`
        + '包内 package.json 会保留旧版本号，客户端将陷入「无限重复更新」。\n'
        + '正式发版：先把 package.json 改成目标版本再打包（不要用 --version）。\n'
        + '仅测试构建：加 --allow-version-mismatch 显式放行。',
    );
}
const skipBuild = process.argv.includes('--skip-build');
const skipLauncher = process.argv.includes('--skip-launcher');
const only = argOf('--only') || 'all';
// --stage-only：只搭暂存目录（含预设）供检查，跳过压缩与校验和（验证/排障用）。
const stageOnly = process.argv.includes('--stage-only');
// --flavor：发行版构成（新旗标；旧的 --no-cet4 / --cet4-only 保留为别名）。
const flavorArg = argOf('--flavor');
const cet4Only = process.argv.includes('--cet4-only');
const noCet4 = process.argv.includes('--no-cet4');
if (cet4Only && noCet4 && !flavorArg) {
    throw new Error('--cet4-only 与 --no-cet4 互斥（或改用 --flavor cet6|cet4|both）');
}
const flavor = flavorArg || (cet4Only ? 'cet4' : noCet4 ? 'cet6' : 'both');
if (!['cet6', 'cet4', 'both'].includes(flavor)) {
    throw new Error(`未知 --flavor ${flavor}（可选：cet6 / cet4 / both）`);
}
// --presets-from：预设树来源目录（默认仓库 presets/）。opus 预设树在
// temp/opus-presets/presets 时：--presets-from temp/opus-presets/presets。
const presetsFromArg = argOf('--presets-from');
const presetsSource = presetsFromArg
    ? path.resolve(repositoryRoot, presetsFromArg)
    : path.join(repositoryRoot, 'presets');
if (presetsFromArg && !fs.existsSync(presetsSource)) {
    throw new Error(`--presets-from 指向的目录不存在：${presetsSource}`);
}

// ── 7z 可执行文件定位（环境变量 JUTING_7Z 优先，其次 PATH）────
const locate7z = () => {
    const fromEnv = process.env.JUTING_7Z;
    if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
    try {
        return execSync('where 7z', { shell: 'cmd.exe', stdio: ['ignore', 'pipe', 'ignore'] })
            .toString().trim().split(/\r?\n/)[0];
    } catch {
        return null;
    }
};
const sevenZip = locate7z();
if (!sevenZip && !stageOnly) {
    throw new Error('未找到 7z（本脚本以 7z 为准；请安装 7-Zip 或 scoop 7zip）');
}
const compress = (archiveName, sourceDir) => {
    const archivePath = path.join(outDir, archiveName);
    // 7z a 是增量更新模式：旧归档里已不存在于源目录的条目会被保留。
    // 必须先删旧包，否则上一次打包的内容（比如已移除的文件）会残留。
    fs.rmSync(archivePath, { force: true });
    execSync(`"${sevenZip}" a -t7z -mx=7 -mmt=on "${archivePath}" "${sourceDir}" -y`, { stdio: 'inherit', timeout: 1800_000 });
    return archivePath;
};
// ── 增量更新：三层分包（2026-10-15）─────────────────────────
// 原方案把整棵树打成单个 update.zip（六级 466MB），而实际每轮改动往往只是几 MB
// 程序代码，音频（218MB）与依赖（120MB）根本没变。现拆成三层：
//   1) 程序包 -update.zip（~5MB）  ：程序代码 + presets/<flavor>/{seed,manifest}.json，
//                                    排除 temp/（覆盖安装本就不碰，纯死重）、
//                                    node_modules/、presets/*/media/（另两包承载）；
//   2) 依赖包 -deps.zip（~120MB）  ：node_modules/**，仅 package-lock 变化时才需下载；
//   3) 媒体包 -media.zip（~218MB） ：presets/*/media/**，仅音频文件集合变化时才需下载。
// 程序包内写入 update-manifest.json（版本 / 依赖哈希 / 媒体清单 / 各资产名），
// 客户端先下程序包 → 读清单 → 门控决定要不要下后两个包。详见 docs/增量更新方案.md。
// 注意：lite 须在拷入 presets 前调用，full 在之后调用，否则两个包的课程内容会串。
// 分层路径判定抽在 layer-paths.mjs（打包器与 temp/layer-skip-test.mjs 共用，防漂移）。
const { programSkip, depsSkip, mediaSkip, normRel } = layerPaths;

const makeZip = (assetName, skip) => {
    const zipPath = path.join(outDir, assetName);
    fs.rmSync(zipPath, { force: true }); // 清掉可能的上次残留（本次从头写）
    log(`生成 ${assetName}…`);
    try {
        const result = makeUpdateZip(stage, zipPath, {
            skip,
            onProgress: ({ files }) => console.log(`[打包] ${assetName} 已处理 ${files} 个文件…`),
        });
        log(`${assetName}：${result.files} 个文件，${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);
        return result.zipPath;
    } catch (e) {
        // 生成失败（磁盘空间/IO 等）→ 跳过该资产，不影响 .7z 与 SHA256SUMS；
        // 客户端会回退 .7z（要求用户装 7-Zip）。
        // 注：make-update-zip.mjs 已支持 Zip64（条目数 >65535、单文件/偏移 >4GiB 均可打包），
        // 「超过标准 ZIP 上限」不再是不生成的原因。
        log(`⚠ ${assetName} 生成失败（${e.message}），跳过——客户端将回退 .7z`);
        return null;
    }
};

// 更新清单：写进程序包根，客户端据此做依赖/媒体门控。
// 依赖门控用 package-lock.json 的 sha256（本地取安装目录同名文件比对）；
// 媒体门控用「文件集合清单」（rel + size），本地逐条 stat 比对实际文件——
// 不能拿本地 presets/<flavor>/manifest.json 当判据：它随程序包一起变新，
// 媒体其实缺失时会谎报「已就位」。
const writeUpdateManifest = (label) => {
    const presetsStage = path.join(stage, 'presets');
    const presetKeys = fs.existsSync(presetsStage)
        ? fs.readdirSync(presetsStage).filter((k) => fs.existsSync(path.join(presetsStage, k, 'seed.json'))).sort()
        : [];
    const mediaEntries = [];
    for (const key of presetKeys) {
        const mediaDir = path.join(presetsStage, key, 'media');
        if (!fs.existsSync(mediaDir)) continue;
        const walk = (dir) => {
            for (const name of fs.readdirSync(dir).sort()) {
                const abs = path.join(dir, name);
                const stat = fs.statSync(abs);
                if (stat.isDirectory()) { walk(abs); continue; }
                // rel 相对 presets/ 且**含 media 段**（客户端拼 install/presets/<rel> 校验），
                // 所以基准是 presetsStage 而非 mediaDir。
                mediaEntries.push({ rel: normRel(path.relative(presetsStage, abs)), size: stat.size });
            }
        };
        walk(mediaDir);
    }
    const lockPath = path.join(stage, 'package-lock.json');
    const depsHash = fs.existsSync(lockPath)
        ? createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex')
        : null;
    // 依赖层清单（2026-10-16）：裁剪后不能再用 package-lock 哈希做门控——
    // 裁剪只改「打包进包的内容」，不改 lock，老用户会因此判定「依赖没变」而拿不到裁剪版。
    // 改为：deps.filesHash = 依赖包内文件清单（rel+size）的哈希，客户端用本地标记文件
    // 里记录的「上次已应用的 filesHash」比对（标记由更新器在安装成功后写入）。
    // deps.owned = 本包拥有的顶层包名清单；更新器据此**清理**本地多余的旧依赖
    // （覆盖安装不删文件，不清理则老用户磁盘瘦不下来）。
    const depsDir = path.join(stage, 'node_modules');
    const depsEntries = [];
    const depsOwned = [];
    if (fs.existsSync(depsDir)) {
        for (const name of fs.readdirSync(depsDir).sort()) {
            if (name === '@juting') continue;   // 工作区包归程序层
            if (name.startsWith('@')) {
                for (const sub of fs.readdirSync(path.join(depsDir, name)).sort()) {
                    depsOwned.push(`${name}/${sub}`);
                    const walk = (dir) => {
                        for (const n of fs.readdirSync(dir).sort()) {
                            const abs = path.join(dir, n);
                            const st = fs.statSync(abs);
                            if (st.isDirectory()) { walk(abs); continue; }
                            depsEntries.push({ rel: normRel(path.relative(depsDir, abs)), size: st.size });
                        }
                    };
                    walk(path.join(depsDir, name, sub));
                }
            } else {
                depsOwned.push(name);
                const walk = (dir) => {
                    for (const n of fs.readdirSync(dir).sort()) {
                        const abs = path.join(dir, n);
                        const st = fs.statSync(abs);
                        if (st.isDirectory()) { walk(abs); continue; }
                        depsEntries.push({ rel: normRel(path.relative(depsDir, abs)), size: st.size });
                    }
                };
                walk(path.join(depsDir, name));
            }
        }
    }
    const depsFilesHash = createHash('sha256')
        .update(depsEntries.map((e) => `${e.rel}\n${e.size}`).join('\n'))
        .digest('hex');
    const manifest = {
        schema: 1,
        version,
        label,
        depsHash,
        deps: {
            filesHash: depsFilesHash,
            count: depsEntries.length,
            bytes: depsEntries.reduce((sum, entry) => sum + entry.size, 0),
            owned: depsOwned,
        },
        media: {
            count: mediaEntries.length,
            bytes: mediaEntries.reduce((sum, entry) => sum + entry.size, 0),
            entries: mediaEntries,
        },
        assets: {
            program: `juting-v${version}-win-${label}-update.zip`,
            deps: `juting-v${version}-win-${label}-deps.zip`,
            media: mediaEntries.length > 0 ? `juting-v${version}-win-${label}-media.zip` : null,
        },
    };
    fs.writeFileSync(path.join(stage, 'update-manifest.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
    log(`更新清单：依赖 ${depsOwned.length} 包 / ${depsEntries.length} 文件 / ${(manifest.deps.bytes / 1024 / 1024).toFixed(0)} MB（哈希 ${depsFilesHash.slice(0, 12)}…），媒体 ${mediaEntries.length} 个文件 / ${(manifest.media.bytes / 1024 / 1024).toFixed(0)} MB`);
    return manifest;
};

// 产出某一 label 的三层更新包，返回资产路径数组（null 已剔除）。
const makeSplitAssets = (label) => {
    const manifest = writeUpdateManifest(label);
    const assets = [
        makeZip(`juting-v${version}-win-${label}-update.zip`, programSkip),
        makeZip(`juting-v${version}-win-${label}-deps.zip`, depsSkip),
    ];
    if (manifest.assets.media) assets.push(makeZip(`juting-v${version}-win-${label}-media.zip`, mediaSkip));
    // 清单只属于程序包内部：打完包就从 stage 撤掉，免得被 .7z 收进去
    // （否则 --only all 时 full 的 .7z 会带上 lite 的旧清单，虽无害但易误读）。
    fs.rmSync(path.join(stage, 'update-manifest.json'), { force: true });
    return assets.filter(Boolean);
};

// ── 0. 构建所有产物 ─────────────────────────────────────────
if (!skipBuild) {
    log('构建所有产物…');
    execSync('npm run build', { cwd: path.join(repositoryRoot, 'backend'), stdio: 'inherit' });
    for (const pkg of ['domain', 'app-config', 'ui-tokens', 'api-client', 'shared']) {
        execSync(`npm run build --workspace @juting/${pkg}`, { cwd: repositoryRoot, stdio: 'inherit' });
    }
    for (const app of ['web-app', 'admin']) {
        execSync(`npm run build --workspace @juting/${app}`, { cwd: repositoryRoot, stdio: 'inherit' });
    }
}

// ── 1. 构建启动器 exe（复制文件前先出产物，供「复制文件」段落落到包根）────
const launcherExe = path.join(repositoryRoot, 'temp', 'launcher-build', '句听.exe');
if (!skipLauncher) {
    log('构建启动器 句听.exe…');
    execFileSync(process.execPath, ['scripts/local/build-launcher.mjs'], { cwd: repositoryRoot, stdio: 'inherit' });
}
const launcherAvailable = fs.existsSync(launcherExe);
if (!launcherAvailable && !stageOnly) {
    throw new Error(`未找到启动器产物 ${launcherExe}；请先执行 node scripts/local/build-launcher.mjs（或去掉 --skip-launcher 让打包脚本自动构建）`);
}
if (!launcherAvailable) {
    log('⚠ 未找到启动器产物，--stage-only 下跳过复制（正式打包必须提供）。');
}

// ── 2. 清理旧暂存 ───────────────────────────────────────────
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const stage = path.join(stageRoot, 'juting');
fs.mkdirSync(stage, { recursive: true });

// ── 3. 复制文件 ─────────────────────────────────────────────
// ── 复制目录。⚠️ filter 语义 =「返回 true 即排除（跳过）」——copyDirFiltered 内部
// 对 filter 结果取反（历史调用 docs/HANDOFF 即此约定），写「保留」语义的过滤器
// 会静默把要的东西全排掉（v0.4.2 重打包把 whisper 引擎全过滤掉的事故即此因）。
const copyDirFiltered = (src, dest, filter) => {
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, dest, {
        recursive: true,
        // npm 工作区在 node_modules/@juting/* 里放的是指向各子包的符号链接；
        // Windows 无管理员权限创建 symlink 会 EPERM，dereference 直接拷实体目录。
        dereference: true,
        filter: (candidate) => {
            const rel = path.relative(src, candidate);
            if (!rel) return true;
            return !filter || !filter(rel, candidate);
        },
    });
};
const copyInto = (rel, filter) => copyDirFiltered(path.join(repositoryRoot, rel), path.join(stage, rel), filter);
// 源在仓库相对布局之外（如 temp 构建产物）或目标要落到包根时使用；
// 与 copyFile 的静默跳过不同，源缺失直接报错中止，避免漏文件打进包。
const copyFileFrom = (src, destRel) => {
    if (!fs.existsSync(src)) {
        throw new Error(`打包文件不存在：${src}（目标 ${destRel}）`);
    }
    const dest = path.join(stage, destRel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
};
const copyFile = (rel) => {
    const src = path.join(repositoryRoot, rel);
    if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(stage, rel));
    }
};

// 目录体积（--stage-only 汇总用）。
const directorySizeBytes = (dir) => {
    let total = 0;
    const walk = (current) => {
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const absolute = path.join(current, entry.name);
            if (entry.isDirectory()) walk(absolute);
            else if (entry.isFile()) {
                try { total += fs.statSync(absolute).size; } catch { /* 忽略异常项 */ }
            }
        }
    };
    walk(dir);
    return total;
};

log('复制源码与配置…');
for (const dir of ['backend/src', 'web-app/src', 'admin/src', 'scripts', 'infra']) {
    copyInto(dir);
}
// docs 只随包发用户文档；HANDOFF.md 是内部交接文档（git 已忽略），绝不入包。
copyInto('docs', (rel) => rel.split(path.sep).join('/').startsWith('HANDOFF.md'));
for (const pkg of fs.readdirSync(path.join(repositoryRoot, 'packages'))) {
    copyInto(`packages/${pkg}/src`);
    copyFile(`packages/${pkg}/package.json`);
    copyFile(`packages/${pkg}/tsconfig.json`);
    copyInto(`packages/${pkg}/dist`);
}
for (const f of ['package.json', 'package-lock.json', '.env.example', '.npmrc', '.gitignore',
    'README.md', 'LICENSE', 'NOTICE', '使用说明.md', 'AGENTS.md',
    '启动句听.bat', '停止句听.bat',
    'backend/package.json', 'backend/tsconfig.json', 'backend/Dockerfile',
    'web-app/tsconfig.json', 'web-app/vite.config.ts', 'web-app/index.html', 'web-app/Dockerfile',
    'admin/tsconfig.json', 'admin/vite.config.ts', 'admin/index.html', 'admin/Dockerfile']) {
    copyFile(f);
}
// 启动器与托盘图标落到包根：源分别在 temp/launcher-build 与 docs/images 下。
// 简洁版/完整版都带。
if (launcherAvailable) copyFileFrom(launcherExe, '句听.exe');
copyFileFrom(path.join(repositoryRoot, 'docs/images/juting.ico'), 'juting.ico');

log('复制构建产物…');
copyInto('backend/dist');
copyInto('web-app/dist');
copyInto('admin/dist');

// node_modules：按「运行期依赖闭包」白名单裁剪（2026-10-16）。
// 背景：node_modules 解压后 365MB，其中约 250MB 是只在构建期用的东西（antd/vite 插件/
// typescript/eslint/expo 残留等），而前端与后台都以**预编译 dist** 提供服务，运行期不需要。
// 改用白名单：从真正的运行入口（backend 的 dependencies、packages/* 的 dependencies、
// 以及 vite——start-all 用它 preview 前端 dist）出发递归展开依赖图，只保留闭包内的包。
// 白名单制优于黑名单：新装的无关依赖默认被排除，不会像黑名单那样越漏越多。
// ⚠️ 实测约束（改这里前务必重测）：
//   - vite 8 顶层就 import rolldown（缺了 preview 直接 ERR_MODULE_NOT_FOUND），必须保留；
//   - esbuild 缺了 preview 仍正常（实测），但它在 vite 的依赖里，闭包会带上，无害；
//   - resend（邮件服务，源码仅 env 配置项、零 require）与 mysql v2（已废弃，实际用 mysql2，
//     sequelize 走 _loadDialectModule("mysql2")）从入口摘掉，可连带裁掉 prettier 等一串。
log('复制 node_modules（按运行期依赖闭包裁剪）…');

// 运行期不用的入口依赖（实测零引用，见 HANDOFF）
const ENTRY_EXCLUDE = new Set(['resend', 'mysql']);
// 解析 node_modules 里的包（支持嵌套与 @scope）
const readInstalledPkg = (name, fromDir) => {
    const candidates = [];
    if (fromDir) candidates.push(path.join(fromDir, 'node_modules', name, 'package.json'));
    candidates.push(path.join(repositoryRoot, 'node_modules', name, 'package.json'));
    for (const c of candidates) {
        try {
            if (fs.existsSync(c)) return { dir: path.dirname(c), json: JSON.parse(fs.readFileSync(c, 'utf8')) };
        } catch { /* 忽略损坏的 package.json */ }
    }
    return null;
};
const collectEntryDeps = (dir) => {
    try {
        const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        return [...Object.keys(p.dependencies || {}), ...Object.keys(p.optionalDependencies || {})]
            .filter((d) => !ENTRY_EXCLUDE.has(d));
    } catch {
        return [];
    }
};
const runtimeRoots = new Set([
    ...collectEntryDeps(path.join(repositoryRoot, 'backend')),
    ...fs.readdirSync(path.join(repositoryRoot, 'packages')).flatMap((pkg) => collectEntryDeps(path.join(repositoryRoot, 'packages', pkg))),
    // start-all.mjs 用 vite preview 服务前端 dist；而 vite preview 会**读取
    // web-app/vite.config.ts 与 admin/vite.config.ts**，两个 config 都 import
    // '@vitejs/plugin-react'——所以这个包虽属构建期，却是「启动必需」。
    // ⚠️ 实测教训：只把 vite 列入闭包不够，漏掉 plugin-react 会让前端 preview
    // 报 UNRESOLVED_IMPORT 并返回 HTTP 000（后端却是好的，容易误判）。
    'vite',
    '@vitejs/plugin-react',
]);
const runtimeKeep = new Set();
{
    const queue = [...runtimeRoots];
    while (queue.length) {
        const name = queue.shift();
        if (runtimeKeep.has(name)) continue;
        runtimeKeep.add(name);
        const found = readInstalledPkg(name, repositoryRoot);
        if (!found) continue;
        for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
            for (const dep of Object.keys(found.json[key] || {})) {
                if (!runtimeKeep.has(dep)) queue.push(dep);
            }
        }
    }
}
log(`  运行期闭包：${runtimeKeep.size} 个包（入口 ${runtimeRoots.size} 个）`);
copyInto('node_modules', (rel) => {
    const segments = rel.split(path.sep);
    if (segments[0] === '.cache') return true;
    // ⚠️ 作用域容器目录（只有一段且以 @ 开头，如 `@colors`、`@juting`）必须放行：
    // 它的名字不是任何真实包名，若不显式放行会落到闭包判定被排除 →
    // 整棵子树被切掉（实测踩过两次：@juting/domain 缺失、@colors/colors 缺失）。
    if (segments.length === 1 && segments[0].startsWith('@')) return false;
    const top = segments[0].startsWith('@')
        ? segments.slice(0, 2).join(path.sep)
        : segments[0];
    const topName = top.split(path.sep).join('/');
    // ⚠️ 本过滤器语义 =「返回 true 即排除」（copyDirFiltered 内部取反）。
    // @juting/admin 与 @juting/web-app 是构建期用的（其 dist/src 由上方 copyInto 单独复制），
    // 且在 node_modules 里是符号链接，dereference 会展开成 187MB / 93MB 的整棵子树 → 排除。
    if (topName === '@juting/admin' || topName === '@juting/web-app') return true;
    // 其余工作区包（@juting/domain 等）运行期要用，保留。
    if (topName.startsWith('@juting/')) return false;
    // 闭包外的包一律排除（白名单制）。
    return !runtimeKeep.has(topName);
});

// 便携 MySQL：裁掉调试符号、C 开发库、日文 mecab 词典、debug 插件与头文件，
// 以及发行目录自带的空 data/（实际数据目录独立在 temp/runtime/mysql-data）。
log('复制便携 MySQL（裁剪）…');
copyInto('temp/runtime/mysql', (rel) => {
    const normalized = rel.split(path.sep).join('/');
    if (/^bin\/.*\.pdb$/i.test(normalized)) return true;
    if (/^bin\/.*-debug\.dll$/i.test(normalized)) return true;
    if (/^lib\/mecab\//.test(normalized)) return true;
    if (/^lib\/plugin\/debug\//.test(normalized)) return true;
    if (/^lib\/.*\.lib$/i.test(normalized)) return true;
    if (/^(include|docs|mysql-test|sql-bench|data)\//.test(normalized)) return true;
    return false;
});

// 便携 Node（仅 node.exe，运行时不需要 npm/npx）。
log('复制便携 Node…');
copyFile('temp/runtime/node/node.exe');

// 占位：让解压后的包带上空的运行时目录骨架（数据目录由启动器创建）。
fs.mkdirSync(path.join(stage, 'temp/runtime/logs'), { recursive: true });

// ── 4/5. 预设复制 + 压缩（--stage-only 时只搭暂存目录，跳过压缩）──────
// 2026-10-02 用户裁定：完整版不再随包本地识别引擎与模型（temp/asr）——ASR 切分后
// 仍需大量人工校准，单机学习用户用不到；需要制课 ASR 时管理后台可一键在线安装
// 引擎（backend 安装器）。历史带引擎的打包方式见 git（v0.4.2 之前）。
//
// 2026-10-14 用户裁定：四级与六级是**两个独立发行版**，各自内置资源。
// 2026-10-14（本版）：--flavor cet6|cet4|both 取代 --no-cet4/--cet4-only（旧旗标仍兼容）：
//   --flavor cet6 → juting-v<版本>-win-full-cet6.7z / -update.zip（六级版）
//   --flavor cet4 → juting-v<版本>-win-cet4.7z      / -update.zip（四级版）
//   --flavor both → juting-v<版本>-win-full-cet6cet4.7z / -update.zip（默认；内部/自用）
const presetSeedExists = (key) => fs.existsSync(path.join(presetsSource, key, 'seed.json'));
const copyPresetsIntoStage = () => {
    // 来源目录：默认仓库 presets/；--presets-from 可指向 temp/opus-presets/presets 等。
    const sourceNote = presetsFromArg ? `（来源 ${path.relative(repositoryRoot, presetsSource) || presetsSource}）` : '';
    if (flavor === 'cet6' || flavor === 'cet4') {
        if (!presetSeedExists(flavor)) {
            throw new Error(`--flavor ${flavor} 需要 ${path.join(presetsSource, flavor, 'seed.json')}，未找到${sourceNote}`);
        }
        log(`复制预设（仅${flavor === 'cet6' ? '六级' : '四级'}）${sourceNote}…`);
        copyDirFiltered(path.join(presetsSource, flavor), path.join(stage, 'presets', flavor));
        return;
    }
    const hasCet6 = presetSeedExists('cet6');
    const hasCet4 = presetSeedExists('cet4');
    if (!hasCet6 && !hasCet4) {
        throw new Error(`--flavor both 但预设来源中没有任何预设：${presetsSource}`);
    }
    if (!hasCet6) log('⚠ 未发现六级预设，本次只打包四级。');
    if (!hasCet4) log('⚠ 未发现四级预设，本次只打包六级。');
    log(`复制预设（${hasCet6 && hasCet4 ? '六级 + 四级' : hasCet6 ? '仅六级' : '仅四级'}）${sourceNote}…`);
    if (hasCet6) copyDirFiltered(path.join(presetsSource, 'cet6'), path.join(stage, 'presets', 'cet6'));
    if (hasCet4) copyDirFiltered(path.join(presetsSource, 'cet4'), path.join(stage, 'presets', 'cet4'));
};
// 归档名（刻意不对称）：
// - cet6 保留 legacy 的 `full` 词元——已发布 v0.5.0 启动器按资产名子串 `full` 选包，
//   六级资产必须仍含 `full` 才能被它命中；
// - cet4 刻意不含 `full`——旧启动器（按 `full` 匹配）只会选中六级包，不会把四级包
//   误当完整包下载；新启动器按各自词元（cet4 / cet6）区分。
const archiveStem = flavor === 'cet6' ? `juting-v${version}-win-full-cet6`
    : flavor === 'cet4' ? `juting-v${version}-win-cet4`
    : `juting-v${version}-win-full-cet6cet4`;

if (stageOnly) {
    // --stage-only：把预设也拷进暂存（便于检查），不压缩、不写校验和。
    if (only === 'all' || only === 'full') copyPresetsIntoStage();
    const sizeMb = (directorySizeBytes(stage) / 1024 / 1024).toFixed(0);
    log('--stage-only：跳过压缩与校验和，仅保留暂存目录供检查。');
    log(`暂存目录：${stage}`);
    log(`暂存体积：${sizeMb} MB`);
    const check = (rel, expected) => {
        const exists = fs.existsSync(path.join(stage, rel));
        log(`  ${rel}：${exists ? (expected ? '存在 ✓' : '存在 ⚠（应已排除）') : (expected ? '缺失 ⚠' : '已排除 ✓')}`);
    };
    check('node_modules/@juting/domain', true);
    check('node_modules/@juting/admin', false);
    check('node_modules/@juting/web-app', false);
    if (only === 'all' || only === 'full') log(`计划产出：${archiveStem}.7z 与 ${archiveStem}-update.zip / -deps.zip / -media.zip`);
} else {
    const artifacts = [];
    // ── 简洁版 ───────────────────────────────────────────────
    if (only === 'all' || only === 'lite') {
        log('压缩简洁版…');
        artifacts.push(compress(`juting-v${version}-win-lite.7z`, stage));
        // 简洁版更新包：此刻 stage 尚未拷入 presets，包内不含预设音频；
        // 三层分包同样适用（媒体层为空，故只出程序包 + 依赖包）。
        artifacts.push(...makeSplitAssets('lite'));
    }
    // ── 完整版 = 简洁版 + 预设课程 ────────────────────────────
    if (only === 'all' || only === 'full') {
        copyPresetsIntoStage();
        log('压缩完整版…');
        artifacts.push(compress(`${archiveStem}.7z`, stage));
        artifacts.push(...makeSplitAssets(archiveStem.replace(`juting-v${version}-win-`, '')));
    }
    // ── 6. 校验和（与已有文件按包名合并，支持分次 --only 打包不丢账）──
    const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
    const existingSums = {};
    if (fs.existsSync(sumsPath)) {
        for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
            // 兼容外部工具写入的行（sha256sum 在二进制模式会写成 `<hash> *<name>`），
            // 否则这些行读不回来、重写时被静默丢弃（曾把已发布的六级两条校验和弄丢）。
            const match = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
            if (match) existingSums[match[2]] = match[1];
        }
    }
    for (const artifact of artifacts) {
        const name = path.basename(artifact);
        existingSums[name] = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
        console.log(`[打包] ${name}  ${(fs.statSync(artifact).size / 1024 / 1024).toFixed(0)} MB`);
    }
    fs.writeFileSync(sumsPath, `${Object.entries(existingSums).map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`, 'utf8');
}

if (stageOnly) {
    log(`完成（--stage-only，未压缩）；暂存目录 ${stageRoot}`);
} else {
    log(`完成，耗时 ${Math.round((Date.now() - startTime) / 1000)}s；产物目录 ${outDir}`);
    log(`暂存目录 ${stageRoot} 体积大，确认产物无误后可手动删除。`);
}
