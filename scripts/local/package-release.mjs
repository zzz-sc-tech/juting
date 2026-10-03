/**
 * 句听发布打包脚本：产出三个可独立分发的 7z 包（默认输出到 ../juting-release/）。
 *
 *   juting-v<版本>-win-lite.7z   简洁版：程序本体 + 便携 Node + 便携 MySQL（裁剪），
 *                                空课程开箱，双击 bat 即用，不内置任何运行环境依赖；
 *   juting-v<版本>-win-full.7z   完整版：= 简洁版 + 六级预设（38 套真题音频与原文）
 *                                + whisper 本地识别引擎与模型，离线全功能；
 *   juting-v<版本>-cet6-pack.7z  六级课程包：仅 presets/cet6 目录。简洁版用户下载后
 *                                解压到安装目录根，下次启动自动导入（对齐完整版内容）。
 *
 * 同时生成 SHA256SUMS.txt。
 *
 * 打包内容要点：
 *   - 不打包含绝对路径的任何 .env（启动器会按当前安装位置现场生成 portable.env）；
 *   - 不打包 mysql-data / media-store / logs：数据库首次启动自动初始化，
 *     六级媒体由预设导入器从 presets/ 硬链/复制进 media-store；
 *   - MySQL 发行目录裁掉调试符号（*.pdb）、C 开发库（lib/*.lib）、日文 mecab 词典、
 *     debug 插件与 include/docs，只留运行所需；
 *   - node_modules 裁掉 .cache 与已移除的 mobile-app 工作区残留依赖（Expo/React Native 系）；
 *   - 打包前必须先 node scripts/local/stop-all.mjs 关掉 MySQL，否则数据文件被锁。
 *
 * 用法：node scripts/local/package-release.mjs [--version 1.0.0] [--skip-build] [--only lite|full|cet6|all] [--no-asr]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

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
const version = argOf('--version') || rootPackage.version || '0.0.0';
const skipBuild = process.argv.includes('--skip-build');
const only = argOf('--only') || 'all';
// --no-asr：完整版剔除本地识别引擎与模型（temp/asr），产出 -win-full-noasr.7z。
// 制课需要 ASR 时管理台可一键在线安装引擎（backend 的安装器），纯学习的用户省 ~200MB。
// 该开关只影响完整版分支，且跳过 cet6-pack 重建（数据相同，避免无谓的重传）。
const noAsr = process.argv.includes('--no-asr');

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
if (!sevenZip) {
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

// ── 1. 清理旧暂存 ───────────────────────────────────────────
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const stage = path.join(stageRoot, 'juting');
fs.mkdirSync(stage, { recursive: true });

// ── 2. 复制文件 ─────────────────────────────────────────────
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
const copyFile = (rel) => {
    const src = path.join(repositoryRoot, rel);
    if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(stage, rel));
    }
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

log('复制构建产物…');
copyInto('backend/dist');
copyInto('web-app/dist');
copyInto('admin/dist');

// node_modules：裁掉缓存与 mobile-app 残留依赖（工作区已移除，仅安装现场残留）。
// 注意 exponential-backoff 是后端在用的通用退避库，不在 Expo 前缀误伤范围内（正则用 (-|/) 收边）。
log('复制 node_modules（裁剪）…');
const staleMobilePatterns = [
    /^expo(-|\/|$)/, /^@expo\//, /^react-native(-|\/|$)/, /^@react-native\//,
    /^metro(-|\/|$)/, /^hermes-(compiler|parser|estree)$/,
];
const staleMobileExact = new Set(['babel-preset-expo', 'babel-plugin-react-native-web', 'react-devtools-core']);
const isStaleMobileDep = (topSegment) => {
    const name = topSegment.split(path.sep).join('/');
    return staleMobileExact.has(name) || staleMobilePatterns.some((pattern) => pattern.test(name));
};
copyInto('node_modules', (rel) => {
    const segments = rel.split(path.sep);
    if (segments[0] === '.cache') return true;
    const top = segments[0].startsWith('@')
        ? segments.slice(0, 2).join(path.sep)
        : segments[0];
    return isStaleMobileDep(top);
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

// ── 3. 简洁版 ───────────────────────────────────────────────
const artifacts = [];
if (only === 'all' || only === 'lite') {
    log('压缩简洁版…');
    artifacts.push(compress(`juting-v${version}-win-lite.7z`, stage));
}

// ── 4. 完整版 = 简洁版 + 六级预设 + whisper 引擎与模型 ──────
if (only === 'all' || only === 'full') {
    log('复制六级预设与 whisper…');
    copyInto('presets/cet6');
    // temp/asr 只带引擎与模型；过滤约定见 copyDirFiltered 注释（true=排除）：
    // duolinting-asr-* 是 ASR 任务的临时工作目录（运行时会重新生成），打进去会把
    // 当次的音频碎片一起发出去（v0.4.2 首版踩过）。--no-asr 时整个目录都不带。
    if (!noAsr) copyInto('temp/asr', (rel) => rel.startsWith('duolinting-asr-'));
    const archiveName = noAsr ? `juting-v${version}-win-full-noasr.7z` : `juting-v${version}-win-full.7z`;
    log(noAsr ? '压缩完整版（无本地识别）…' : '压缩完整版…');
    artifacts.push(compress(archiveName, stage));
}
if (!noAsr && (only === 'all' || only === 'cet6' || only === 'full')) {
    // 六级课程包：独立暂存，压缩目录名必须是 presets，
    // 这样用户解压到句听安装目录根正好落成 presets/cet6（自动导入的前提）。
    const cet6Stage = path.join(stageRoot, 'presets');
    copyDirFiltered(path.join(repositoryRoot, 'presets'), cet6Stage);
    log('压缩六级课程包…');
    artifacts.push(compress(`juting-v${version}-cet6-pack.7z`, cet6Stage));
}

// ── 5. 校验和（与已有文件按包名合并，支持分次 --only 打包不丢账）──
const sumsPath = path.join(outDir, 'SHA256SUMS.txt');
const existingSums = {};
if (fs.existsSync(sumsPath)) {
    for (const line of fs.readFileSync(sumsPath, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/);
        if (match) existingSums[match[2]] = match[1];
    }
}
for (const artifact of artifacts) {
    const name = path.basename(artifact);
    existingSums[name] = createHash('sha256').update(fs.readFileSync(artifact)).digest('hex');
    console.log(`[打包] ${name}  ${(fs.statSync(artifact).size / 1024 / 1024).toFixed(0)} MB`);
}
fs.writeFileSync(sumsPath, `${Object.entries(existingSums).map(([name, hash]) => `${hash}  ${name}`).join('\n')}\n`, 'utf8');

log(`完成，耗时 ${Math.round((Date.now() - startTime) / 1000)}s；产物目录 ${outDir}`);
log(`暂存目录 ${stageRoot} 体积大，确认产物无误后可手动删除。`);
