/**
 * 句听本地一键启动编排器（免 Docker）：
 *
 *   mysqld(3307) → 建库建用户 → 迁移 → 首个超管 → 预设课程导入
 *   → backend(node dist/app.js, 8100) → vite preview(8101/8102) → 打开浏览器
 *
 * 所有运行时数据在 temp/runtime 下；关闭本窗口（或 Ctrl+C）即全部停止。
 *
 * 可移植性：安装目录解压到任意盘符路径都能运行——每次启动都会生成
 * temp/runtime/portable.env（数据库账号 + 媒体目录均按当前安装位置解析成
 * 绝对路径），迁移/引导/导入脚本统一用 --env-file 读它，后端进程则以显式
 * 环境变量覆盖（优先级高于 backend/.env），不依赖包内任何预置 .env。
 *
 * 用法：node scripts/local/start-all.mjs
 */
import { spawn, execSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, openSync, appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const runtimeDir = path.join(repositoryRoot, 'temp', 'runtime');
const logDir = path.join(runtimeDir, 'logs');
const mysqlBinDir = path.join(runtimeDir, 'mysql', 'bin');
const mysqlDataDir = path.join(runtimeDir, 'mysql-data');

const MYSQL_PORT = 3307;
const BACKEND_PORT = 8100;
const WEB_PORT = 8101;
const ADMIN_PORT = 8102;
const DB_NAME = 'duolinting_app_dev';
const DB_USER = 'duolinting';
const DB_PASSWORD = 'duolinting';

const logFile = (name) => path.join(logDir, name);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = (message) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
    console.log(line);
    appendFileSync(logFile('启动器.log'), `${line}\n`);
};

const waitForPort = async (port, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const open = await new Promise((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => { socket.end(); resolve(true); });
            socket.once('error', () => resolve(false));
        });
        if (open) {
            return;
        }
        await sleep(500);
    }
    throw new Error(`${label}（端口 ${port}）在超时时间内没有就绪，请查看 temp/runtime/logs 下的日志`);
};

const spawnLogged = async (name, command, args, options = {}) => {
    const out = openSync(logFile(name), 'a');
    // Windows 下刚解压/被杀软扫描过的 exe 偶发 spawn EBUSY，重试即可。
    let lastError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
            const child = spawn(command, args, {
                cwd: options.cwd ?? repositoryRoot,
                env: { ...process.env, ...options.env },
                stdio: ['ignore', out, out],
                windowsHide: true,
            });
            spawned.set(name, child);
            child.on('exit', (code) => {
                if (!stopping && code !== 0 && code !== null) {
                    log(`⚠ ${name} 进程退出（代码 ${code}），日志见 temp/runtime/logs/${name}`);
                }
            });
            return child;
        } catch (error) {
            lastError = error;
            if (error.code !== 'EBUSY') {
                throw error;
            }
            await sleep(1000 * attempt);
        }
    }
    throw lastError;
};

let stopping = false;
// 由本编排器拉起的子进程登记表：清理时按 PID 精确回收，
// 绝不用 taskkill /IM（按镜像名全杀会误伤机器上其他 MySQL/MinIO 实例）。
const spawned = new Map();
const killProcessTree = (pid) => {
    if (!pid) return;
    try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    } catch {
        // 已退出则忽略
    }
};
const cleanup = async (exitCode) => {
    if (stopping) {
        return;
    }
    stopping = true;
    log('正在停止所有服务...');
    // mysqld 尽量走 mysqladmin 优雅关停（保数据页干净）。
    try {
        execSync(`"${path.join(mysqlBinDir, 'mysqladmin.exe')}" --port=${MYSQL_PORT} --user=root shutdown`, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } catch {
        // 已停止或未启动则忽略
    }
    // 优雅关停失败（或 mysqld 卡住）时按登记的 PID 强杀整个进程树。
    killProcessTree(spawned.get('mysql.log')?.pid);
    process.exit(exitCode ?? 0);
};

process.on('SIGINT', () => void cleanup(0));
process.on('SIGHUP', () => void cleanup(0));
process.on('SIGBREAK', () => void cleanup(0));

// ── 与启动器（托盘 supervisor）的 IPC 协同 ─────────────────────
// 启动器以 IPC 方式派生本编排器时：
//   - progress 消息把阶段进度报给启动器（写进 launcher-status.json，托盘可见）；
//   - 收到 shutdown 消息或 IPC 断开（启动器退出/崩溃）时自动走 cleanup，
//     不再依赖「关闭控制台窗口」这种不可靠的停止路径。
// bat 直跑（无 IPC）时行为不变：控制台保活，Ctrl+C / 关窗停止。
const TOTAL_STEPS = 6;
const emitProgress = (step, message) => {
    if (!process.send) return;
    try {
        process.send({ type: 'progress', step, total: TOTAL_STEPS, message });
    } catch {
        // IPC 已断开：启动器没了，忽略
    }
};
if (process.send) {
    process.on('message', (msg) => {
        if (msg && msg.cmd === 'shutdown') {
            log('收到启动器停止指令，正在关闭服务...');
            void cleanup(0);
        }
    });
    // 启动器退出（含被任务管理器结束）时 IPC 断开：服务不能孤儿化，跟着清理。
    process.on('disconnect', () => {
        log('启动器已断开连接，正在关闭服务...');
        void cleanup(0);
    });
    // Windows 实测：父进程被强杀时子进程不一定会收到 disconnect（命名管道不立即 EOF），
    // 因此再加一道 ppid 存活看门狗兜底——父进程消失即自行清理，杜绝服务孤儿化。
    const parentPid = process.ppid;
    const parentWatchdog = setInterval(() => {
        if (stopping) {
            clearInterval(parentWatchdog);
            return;
        }
        let alive = true;
        try {
            process.kill(parentPid, 0);
        } catch (error) {
            alive = error.code === 'EPERM'; // 存在但不属于当前用户
        }
        if (!alive) {
            clearInterval(parentWatchdog);
            log('启动器进程已消失，正在关闭服务...');
            void cleanup(0);
        }
    }, 3000);
}

// ── 0. 前置检查 ──────────────────────────────────────────────
emitProgress(1, '检查运行环境…');
mkdirSync(logDir, { recursive: true });
if (!existsSync(path.join(mysqlBinDir, 'mysqld.exe'))) {
    throw new Error('未找到便携版 MySQL：请先解压 mysql.zip 到 temp/runtime/mysql（bin 目录需存在）');
}

// 便携环境文件：路径类配置按「当前安装位置」现场计算，解压到哪都能跑。
// Windows 路径反斜杠统一写成正斜杠，避免被 dotenv/JS 当转义符吃掉。
const portableEnvFile = path.join(runtimeDir, 'portable.env');
const toPosixPath = (value) => value.replace(/\\/g, '/');
const portableEnv = {
    MYSQL_HOST: '127.0.0.1',
    MYSQL_PORT: String(MYSQL_PORT),
    MYSQL_DATABASE: DB_NAME,
    MYSQL_USER: DB_USER,
    MYSQL_PASSWORD: DB_PASSWORD,
    MEDIA_STORAGE: 'local',
    MEDIA_LOCAL_DIR: toPosixPath(path.join(runtimeDir, 'media-store')),
    MINIO_BUCKET: 'duolinting-media',
};

// 本地 ASR 自动装配：扫描 temp/asr，whisper 引擎与模型齐备就自动启用。
// 完整版随包带着两者（开箱即用）；简洁版用户在管理台点「一键准备」后，
// 下载产物也落在 temp/asr，下次启动同样被这里接管——两条路统一，且不依赖
// backend/.env（安装包不带它，ASR_ENABLED 默认是 false）。
{
    const asrDir = path.join(repositoryRoot, 'temp', 'asr');
    portableEnv.ASR_WORK_DIR = toPosixPath(asrDir);
    if (existsSync(asrDir)) {
        const findWhisperCli = (dir) => {
            // 与后端 installer 的探测规则一致：优先 whisper-cli，旧版回退 main.exe。
            const candidates = [];
            const walk = (current, depth) => {
                if (depth > 3) return;
                for (const entry of readdirSync(current, { withFileTypes: true })) {
                    const full = path.join(current, entry.name);
                    if (entry.isDirectory()) {
                        walk(full, depth + 1);
                    } else if (/^(whisper-cli|main)(\.exe)?$/i.test(entry.name)) {
                        candidates.push(full);
                    }
                }
            };
            walk(dir, 0);
            return candidates.find((item) => /whisper-cli/i.test(item)) ?? candidates[0] ?? '';
        };
        const whisperBin = findWhisperCli(asrDir);
        const modelFiles = [];
        for (const entry of readdirSync(asrDir)) {
            if (/^ggml-.*\.bin$/i.test(entry)) {
                modelFiles.push(path.join(asrDir, entry));
            }
        }
        // 多个模型并存时取最大的（一般是完整档位而不是小试模型）。
        const model = modelFiles.sort((a, b) => statSync(b).size - statSync(a).size)[0] ?? '';
        if (whisperBin && model) {
            portableEnv.ASR_ENABLED = 'true';
            portableEnv.ASR_WHISPER_BIN = toPosixPath(whisperBin);
            portableEnv.ASR_WHISPER_MODEL = toPosixPath(model);
            portableEnv.ASR_THREADS = '8';
        }
    }
}
writeFileSync(
    portableEnvFile,
    // 值统一加双引号：dotenv 会剥掉引号；不加的话安装路径里带 # 会被当注释截断。
    `${Object.entries(portableEnv).map(([key, value]) => `${key}="${value}"`).join('\n')}\n`,
);

// ── 1. 首次运行：初始化 MySQL 数据目录 ────────────────────────
// basedir/datadir 一律走命令行参数而非 my.ini：mysqld 8 按系统 ANSI 码页
// 解码 ini 里的路径，安装目录含中文时 UTF-8 写入的 ini 会初始化失败；
// spawn 的参数是 UTF-16 传递，天然支持任意字符的安装路径。
const mysqlBaseArgs = [
    `--basedir=${path.join(runtimeDir, 'mysql')}`,
    `--datadir=${mysqlDataDir}`,
];
if (!existsSync(path.join(mysqlDataDir, 'mysql'))) {
    log('首次运行：初始化 MySQL 数据目录（约半分钟）...');
    execFileSync(
        path.join(mysqlBinDir, 'mysqld.exe'),
        ['--initialize-insecure', ...mysqlBaseArgs],
        { stdio: 'ignore', timeout: 300000 },
    );
    log('MySQL 数据目录初始化完成。');
}
// 配置文件独立于初始化：每次启动都确保存在（改端口/参数后重装也能生效）。
// 只写 ASCII 配置项，路径类配置见上——不放 ini。
//
// 单机自用调优（2026-10-16，省磁盘 ~90MB）：
//   - innodb_redo_log_capacity=32M：MySQL 8.4 默认 100MB redo，而本应用数据库才 16MB。
//     容量在启动时自动调整（8.0.30+ 语义），存量安装下次启动即生效。
//   - skip-log-bin：关闭二进制日志。binlog 是为主从复制/时间点恢复设计的，
//     单机自用无意义，且会随使用持续增长。
//   - innodb_temp_data_file_path 加上限：临时表空间默认无限自动增长，封顶防跑飞。
//   - innodb_buffer_pool_size 降到 128M：库仅 16MB，128M 已远超需求（省的是内存非磁盘）。
writeFileSync(
    path.join(runtimeDir, 'my.ini'),
    [
        '[mysqld]',
        `port=${MYSQL_PORT}`,
        'bind-address=127.0.0.1',
        'character-set-server=utf8mb4',
        'collation-server=utf8mb4_0900_ai_ci',
        'innodb_buffer_pool_size=128M',
        'innodb_redo_log_capacity=32M',
        'innodb_temp_data_file_path=ibtmp1:12M:autoextend:max:64M',
        'skip-log-bin',
        'max_connections=100',
        'default-time-zone=+08:00',
        '',
    ].join('\n'),
);

// ── 2. 启动 MySQL ───────────────────────────────────────────
log('启动 MySQL（端口 3307）...');
emitProgress(2, '启动 MySQL（端口 3307）…');
await spawnLogged('mysql.log', path.join(mysqlBinDir, 'mysqld.exe'), [
    `--defaults-file=${path.join(runtimeDir, 'my.ini')}`,
    ...mysqlBaseArgs,
    '--console',
]);

await waitForPort(MYSQL_PORT, 60000, 'MySQL');
log('MySQL 已就绪。');

// ── 3. 建库建用户（幂等）────────────────────────────────────
emitProgress(3, '初始化数据库与账号…');
{
    const mysql2 = require('mysql2/promise');
    const root = await mysql2.createConnection({ host: '127.0.0.1', port: MYSQL_PORT, user: 'root', password: '' });
    await root.query(`create database if not exists ${DB_NAME} character set utf8mb4 collate utf8mb4_0900_ai_ci`);
    await root.query(`create user if not exists '${DB_USER}'@'127.0.0.1' identified by '${DB_PASSWORD}'`);
    await root.query(`create user if not exists '${DB_USER}'@'localhost' identified by '${DB_PASSWORD}'`);
    await root.query(`grant all privileges on ${DB_NAME}.* to '${DB_USER}'@'127.0.0.1'`);
    await root.query(`grant all privileges on ${DB_NAME}.* to '${DB_USER}'@'localhost'`);
    await root.query('flush privileges');
    await root.end();
    log('数据库与账号已就绪（duolinting_app_dev）。');
}

// ── 4. 迁移 + 首个超管 + 预设课程（幂等）─────────────────────
// 子脚本统一用 process.execPath（bat 可能用的是包内便携 Node，
// 机器上未必装了系统 node，裸写 "node" 会在目标机器上失败）。
emitProgress(4, '应用迁移、创建管理员、导入课程…');
log('应用数据库迁移...');
execFileSync(process.execPath, ['scripts/local/migrate-local.mjs', '--env-file', portableEnvFile], { cwd: repositoryRoot, stdio: 'inherit' });
log('确保本地超级管理员存在...');
execFileSync(process.execPath, ['scripts/local/bootstrap-admin.mjs', '--env-file', portableEnvFile], { cwd: repositoryRoot, stdio: 'inherit' });
log('导入内置预设课程（如有）...');
{
    // 枚举实际存在的预设（presets/<key>/seed.json）逐个导入：import-preset.mjs 的
    // --preset 默认 cet6，只调一次会让 cet4 版安装的课程永远导不进来。
    // import-preset 内部按 preset_key 记录导入版本，逐预设调用幂等、可安全重跑。
    const presetsDir = path.join(repositoryRoot, 'presets');
    const presetKeys = existsSync(presetsDir)
        ? readdirSync(presetsDir).filter((name) => existsSync(path.join(presetsDir, name, 'seed.json'))).sort()
        : [];
    if (presetKeys.length === 0) {
        log('未发现预设目录（简洁版即正常状态），跳过预设导入。');
    } else {
        for (const key of presetKeys) {
            execFileSync(process.execPath, ['scripts/local/import-preset.mjs', '--env-file', portableEnvFile, '--preset', key], { cwd: repositoryRoot, stdio: 'inherit' });
        }
    }
}

// ── 5. 启动后端 ─────────────────────────────────────────────
log('启动后端（端口 8100）...');
emitProgress(5, '启动后端（端口 8100）…');
// 环境变量优先级高于 backend/.env（dotenv 不覆盖已存在的进程变量），
// 便携包里即使残留了开发机的 .env 也不会把端口/媒体目录带偏。
await spawnLogged('backend.log', process.execPath, ['dist/app.js'], {
    cwd: path.join(repositoryRoot, 'backend'),
    env: { ...portableEnv, PORT: String(BACKEND_PORT) },
});
await waitForPort(BACKEND_PORT, 60000, '后端');
{
    const health = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`).then((r) => r.text()).catch(() => 'FAIL');
    if (!health.includes('"ok"')) {
        await cleanup(1);
        throw new Error(`后端健康检查未通过（${health}），完整日志见 temp/runtime/logs/backend.log`);
    }
    log('后端健康检查：通过。');
}

// ── 6. 启动两个前端（生产构建 preview）───────────────────────
log('启动学习端与管理后台（生产构建）...');
emitProgress(6, '启动学习端与管理后台（生产构建）…');
await spawnLogged('web-app.log', process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview'], { cwd: path.join(repositoryRoot, 'web-app') });
await spawnLogged('admin.log', process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview'], { cwd: path.join(repositoryRoot, 'admin') });
await waitForPort(WEB_PORT, 60000, '学习端');
await waitForPort(ADMIN_PORT, 60000, '管理后台');

// ── 7. 打开浏览器 ───────────────────────────────────────────
// 无默认浏览器 / 远程桌面 / 被策略拦截时 start 会失败——绝不能因此把
// 已经起来的服务一起带走，这里吞掉异常；启动器（托盘）侧另有兜底入口。
try {
    execSync('start "" "http://127.0.0.1:8101"', { shell: 'cmd.exe', stdio: 'ignore', windowsHide: true });
} catch {
    log('⚠ 未能自动打开浏览器，请手动访问 http://127.0.0.1:8101');
}

log('──────────────────────────────────────────────');
log('句听已全部启动：');
log(`  学习端     http://127.0.0.1:${WEB_PORT}   （已自动打开）`);
log(`  管理后台   http://127.0.0.1:${ADMIN_PORT}   账号 admin@duolinting.local / duolinting2026`);
log(`  数据库     MySQL :${MYSQL_PORT}（root 无密码，仅本机）`);
log('  媒体存储   本地磁盘 temp/runtime/media-store（单机模式，无需 MinIO）');
if (portableEnv.ASR_ENABLED === 'true') {
    log('自动切分（本地语音识别）已启用，制课台上传音频后可直接使用。');
} else {
    log('自动切分（本地语音识别）未启用：简洁版首次使用请在制课台点「一键准备」。');
}
log('停止：按 Ctrl+C 或直接关闭本窗口。');
log('──────────────────────────────────────────────');

// 就绪上报：启动器据此把状态切到 running 并弹「句听已启动」气泡。
if (process.send) {
    try {
        process.send({ type: 'ready', ports: { mysql: MYSQL_PORT, backend: BACKEND_PORT, web: WEB_PORT, admin: ADMIN_PORT } });
    } catch {
        // 启动器已不在，忽略
    }
}

// 保活：有 IPC 时通道本身维持事件循环（启动器断开即自动清理）；
// 无 IPC（bat 直跑）时保持原来的控制台保活，Ctrl+C / 关窗停止。
setInterval(() => undefined, 1 << 30);
void cleanup;
