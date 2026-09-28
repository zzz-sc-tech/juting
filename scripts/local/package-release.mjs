/**
 * 句听打包脚本：产出一个 zip，解压后双击 启动句听.bat 即可用。
 *
 * 包含：源码 + node_modules + 预构建 dist + 便携 MySQL + whisper 引擎与模型
 *      + 已导入的 38 门课程数据 + 启动器 + 预配置 .env
 *
 * 用法：node scripts/local/package-release.mjs
 * 产出：../juting-release.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w):/, '$1:')), '..', '..');
const stage = path.join(root, '..', 'juting-package');
const zipOut = path.join(root, '..', 'juting-release.zip');

const startTime = Date.now();
const log = (msg) => console.log(`[打包] ${msg}`);

// ── 0. 确保 dist 都是最新的 ──
log('构建所有产物…');
execSync('npm run build', { cwd: path.join(root, 'backend'), stdio: 'pipe' });
for (const pkg of ['domain', 'app-config', 'ui-tokens', 'api-client', 'shared']) {
    execSync(`npm run build --workspace @juting/${pkg}`, { cwd: root, stdio: 'pipe' });
}
for (const app of ['web-app', 'admin']) {
    execSync(`npm run build --workspace @juting/${app}`, { cwd: root, stdio: 'pipe' });
}

// ── 1. 清理旧暂存 ──
if (fs.existsSync(stage)) {
    fs.rmSync(stage, { recursive: true, force: true });
}
fs.mkdirSync(stage, { recursive: true });

// ── 2. 复制文件 ──
const copyDir = (src, dest, filter) => {
    if (!fs.existsSync(src)) return;
    fs.cpSync(src, dest, { recursive: true, filter: (src2) => {
        const rel = path.relative(src, src2);
        if (filter && filter(rel)) return false;
        return true;
    }});
};

log('复制源码与配置…');
const copyFile = (rel) => {
    const src = path.join(root, rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(stage, rel));
};
const copyDirTo = (rel, dest = rel, filter) => copyDir(path.join(root, rel), path.join(stage, dest), filter);

// 源码
for (const dir of ['backend/src', 'web-app/src', 'admin/src', 'scripts']) {
    copyDirTo(dir);
}
for (const dir of ['backend/src', 'web-app/src', 'admin/src']) {
    copyDirTo(dir.replace('/', '/'), dir);
}
for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
    const src = path.join(root, 'packages', pkg, 'src');
    if (fs.existsSync(src)) copyDirTo(`packages/${pkg}/src`);
}
for (const f of ['package.json', 'package-lock.json', '.env.example', '.gitignore', '.npmrc',
    'README.md', 'LICENSE', 'NOTICE', '使用说明.md', 'AGENTS.md',
    '启动句听.bat', '停止句听.bat',
    'backend/tsconfig.json', 'backend/Dockerfile',
    'web-app/tsconfig.json', 'web-app/vite.config.ts', 'web-app/index.html', 'web-app/Dockerfile',
    'admin/tsconfig.json', 'admin/vite.config.ts', 'admin/index.html', 'admin/Dockerfile']) {
    copyFile(f);
}
for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
    copyFile(`packages/${pkg}/package.json`);
    copyFile(`packages/${pkg}/tsconfig.json`);
}
for (const dir of ['docs', 'infra']) {
    copyDirTo(dir);
}

// 预构建产物
log('复制构建产物…');
copyDirTo('backend/dist');
for (const pkg of fs.readdirSync(path.join(root, 'packages'))) {
    const distDir = path.join(root, 'packages', pkg, 'dist');
    if (fs.existsSync(distDir)) copyDirTo(`packages/${pkg}/dist`);
}
copyDirTo('web-app/dist');
copyDirTo('admin/dist');

// node_modules
log('复制 node_modules…');
copyDirTo('node_modules');

// 便携 MySQL（不含 data——用户首次运行自动初始化）
log('复制便携 MySQL…');
copyDirTo('temp/runtime/mysql');

// whisper 引擎与模型
log('复制 whisper 引擎与模型…');
copyDirTo('temp/asr');

// 已导入的课程音频数据
log('复制课程媒体数据…');
copyDirTo('temp/runtime/media-store');

// .env（预配置）
copyFile('.env');

// 首次运行引导文件
fs.writeFileSync(
    path.join(stage, 'temp/runtime/mysql-data', '.gitkeep'),
    '', { recursive: true },
);

// ── 3. 打 zip ──
log('压缩 zip…');
const sevenZip = 'C:/Users/Zsc/scoop/shims/7z';
if (fs.existsSync(sevenZip)) {
    execSync(`"${sevenZip}" a -tzip -mx=5 "${zipOut}" "${stage}/*" -y`, { stdio: 'pipe', timeout: 600_000 });
} else {
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipOut}' -Force"`, { timeout: 600_000, stdio: 'pipe' });
}

const zipSize = fs.statSync(zipOut).size;
const elapsed = Math.round((Date.now() - startTime) / 1000);
log(`完成！${zipOut} (${(zipSize / 1024 / 1024).toFixed(0)} MB, 耗时 ${elapsed}s)`);
log(`清理暂存目录：rm -rf ${stage}`);
// 暂存目录很大，让调用方决定是否清理
console.log(`[提示] 暂存目录 ${stage} 可手动删除`);
