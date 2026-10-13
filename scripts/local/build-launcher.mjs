/**
 * 构建「句听」启动器单文件 exe（Node SEA：单可执行应用）。
 *
 *   scripts/local/launcher-app.cjs（自包含启动器主脚本）
 *     └─ 以 temp/runtime/node/node.exe 为底座（保证与运行环境同版本）
 *          └─ 注入 SEA blob（postject）→ temp/launcher-build/句听.exe
 *
 * 用法：node scripts/local/build-launcher.mjs [--force]
 *   --force  覆盖已存在的产物（默认也会覆盖，但运行中的 exe 会被文件锁挡住）
 *
 * 依赖：postject（SEA blob 注入器）。缺失时执行：
 *   npm install --save-dev postject
 *
 * 产物：temp/launcher-build/句听.exe（发布打包脚本会把它拷到包根）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const log = (msg) => console.log(`[构建启动器] ${msg}`);

const outDir = path.join(repositoryRoot, 'temp', 'launcher-build');
const exePath = path.join(outDir, '句听.exe');
const blobPath = path.join(outDir, 'sea-prep.blob');
const configPath = path.join(outDir, 'sea-config.json');
const mainRel = path.join('scripts', 'local', 'launcher-app.cjs');
const mainPath = path.join(repositoryRoot, mainRel);
const baseNodeExe = path.join(repositoryRoot, 'temp', 'runtime', 'node', 'node.exe');
// Node SEA 官方哨兵（Node 20+ 二进制内置的 fuse，形如 NODE_SEA_FUSE_<hash>:0；
// 这里给到冒号前的部分——postject 会在二进制里定位它并改写成 SEA 段标记）。
// 优先从底座二进制里现场探测，避免 Node 升级后 hash 变化导致构建失败。
const SENTINEL_FUSE_FALLBACK = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const detectSentinelFuse = () => {
    const sample = fs.readFileSync(baseNodeExe).toString('latin1');
    const marker = 'NODE_SEA_FUSE_';
    const index = sample.indexOf(marker);
    if (index < 0) return SENTINEL_FUSE_FALLBACK;
    const match = sample.slice(index, index + marker.length + 32).match(/^NODE_SEA_FUSE_[0-9a-f]{32}/);
    return match ? match[0] : SENTINEL_FUSE_FALLBACK;
};

// ── 0. 前置检查 ─────────────────────────────────────────────
if (!fs.existsSync(baseNodeExe)) {
    throw new Error(`未找到便携版 Node：${path.relative(repositoryRoot, baseNodeExe)}（发布包应自带；开发机可先跑一次 启动句听.bat 生成）`);
}
if (!fs.existsSync(mainPath)) {
    throw new Error(`未找到启动器主脚本：${mainRel}`);
}
let postject;
try {
    postject = require('postject');
} catch {
    throw new Error('未找到 postject（SEA blob 注入器）。请先在仓库根执行：npm install --save-dev postject');
}
if (typeof postject.inject !== 'function') {
    throw new Error('postject 版本不兼容：缺少 inject()。请安装 postject@1.0.0-alpha.6 或更新版本。');
}

fs.mkdirSync(outDir, { recursive: true });

// 便携 Node 版本自检：SEA 要求 blob 生成方与底座二进制为同一版本，
// 因此这一步强制用便携 Node 自己来生成（开发和发布同源）。
const baseVersion = execFileSync(baseNodeExe, ['--version'], { encoding: 'utf8' }).trim();
log(`底座 Node：${baseVersion}（${path.relative(repositoryRoot, baseNodeExe)}）`);
const [major] = baseVersion.replace(/^v/, '').split('.').map(Number);
if (major < 20) {
    throw new Error(`Node ${baseVersion} 不支持 SEA（需要 ≥ 20）。`);
}

// ── 1. 生成 SEA blob ────────────────────────────────────────
const seaConfig = {
    main: mainRel.split(path.sep).join('/'),
    output: path.relative(repositoryRoot, blobPath).split(path.sep).join('/'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
};
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
log(`生成 SEA blob（${path.relative(repositoryRoot, configPath)}）…`);
execFileSync(baseNodeExe, ['--experimental-sea-config', path.relative(repositoryRoot, configPath)], {
    cwd: repositoryRoot,
    stdio: 'inherit',
});
if (!fs.existsSync(blobPath)) {
    throw new Error('blob 生成失败：未产出 sea-prep.blob');
}

// ── 2. 拷贝底座 → 句听.exe ──────────────────────────────────
if (fs.existsSync(exePath)) {
    try {
        fs.unlinkSync(exePath);
    } catch (error) {
        throw new Error(`无法覆盖 ${path.relative(repositoryRoot, exePath)}（${error.code}）：请先从托盘退出正在运行的句听，再重试`);
    }
}
fs.copyFileSync(baseNodeExe, exePath);
log('已拷贝底座二进制 → 句听.exe');

// ── 3. 注入 blob（postject）─────────────────────────────────
const sentinelFuse = detectSentinelFuse();
log(`注入 SEA blob（哨兵 ${sentinelFuse.slice(0, 24)}…）…`);
try {
    await postject.inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
        sentinelFuse,
        overwrite: true,
    });
} catch (error) {
    // 注入失败时清理半成品，避免误用
    try { fs.unlinkSync(exePath); } catch { /* 忽略 */ }
    throw new Error(`注入失败：${error && error.message ? error.message : error}`);
}

// ── 4. PE 子系统 Console → GUI（双击 exe 不弹黑窗）──────────
// Node 底座是控制台程序（子系统=3），双击会闪一个 cmd 窗口。
// 改成 GUI（子系统=2）后：exe 本体不再弹窗，stdout/stderr 仍可被
// spawn 重定向（编排器/更新器不受影响），但进程不再持有可见控制台。
{
    const fd = fs.openSync(exePath, 'r+');
    const peOffBuf = Buffer.alloc(4);
    fs.readSync(fd, peOffBuf, 0, 4, 0x3C);
    const peOff = peOffBuf.readUInt32LE(0);
    const subOff = peOff + 0x5C;  // COFF(20)+PE sig(4) 之后的 OptionalHeader 里 offset 68
    const subBuf = Buffer.alloc(2);
    fs.readSync(fd, subBuf, 0, 2, subOff);
    const cur = subBuf.readUInt16LE(0);
    if (cur === 3) {
        subBuf.writeUInt16LE(2, 0);  // 3=Console → 2=GUI
        fs.writeSync(fd, subBuf, 0, 2, subOff);
        log(`PE 子系统：Console(3) → GUI(2)（offset ${subOff.toString(16)}h）`);
    } else if (cur === 2) {
        log('PE 子系统已是 GUI(2)，跳过');
    } else {
        log(`⚠ PE 子系统值异常（${cur}），不修改`);
    }
    fs.closeSync(fd);
}

// ── 5. 自检 ─────────────────────────────────────────────────
log('自检（运行 --selfcheck）…');
const check = spawnSync(exePath, ['--selfcheck'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
const output = `${check.stdout || ''}${check.stderr || ''}`.trim();
if (check.status !== 0 || !/^OK node/.test(output)) {
    throw new Error(`自检失败（exit=${check.status}）：${output.slice(0, 400)}`);
}

const sizeMb = (fs.statSync(exePath).size / 1024 / 1024).toFixed(1);
log(`完成：${path.relative(repositoryRoot, exePath)}（${sizeMb} MB，自检 ${output.split('\n')[0]}）`);
