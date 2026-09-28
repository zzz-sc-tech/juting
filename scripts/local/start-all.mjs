/**
 * 句听本地一键启动编排器（免 Docker）：
 *
 *   mysqld(3307) + minio(9000/9001) → 建库建用户 → 迁移 → 首个超管
 *   → backend(node dist/app.js, 8100) → vite preview(8101/8102) → 打开浏览器
 *
 * 所有运行时数据在 temp/runtime 下；关闭本窗口（或 Ctrl+C）即全部停止。
 * 用法：node scripts/local/start-all.mjs
 */
import { spawn, execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, openSync, appendFileSync, writeFileSync } from 'node:fs';
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
const cleanup = async (exitCode) => {
    if (stopping) {
        return;
    }
    stopping = true;
    log('正在停止所有服务...');
    // mysqld 尽量走 mysqladmin 优雅关停（保数据页干净），其余直接结束进程。
    try {
        execSync(`"${path.join(mysqlBinDir, 'mysqladmin.exe')}" --port=${MYSQL_PORT} --user=root shutdown`, { stdio: 'ignore', timeout: 15000 });
    } catch {
        // 已停止或未启动则忽略
    }
    try {
        execSync('taskkill /IM minio.exe /F', { stdio: 'ignore', timeout: 10000 });
    } catch {
        // 未启动则忽略
    }
    try {
        execSync('taskkill /IM mysqld.exe /F', { stdio: 'ignore', timeout: 10000 });
    } catch {
        // 优雅关停成功时这里会失败（进程已不在），忽略
    }
    process.exit(exitCode ?? 0);
};

process.on('SIGINT', () => void cleanup(0));
process.on('SIGHUP', () => void cleanup(0));
process.on('SIGBREAK', () => void cleanup(0));

// ── 0. 前置检查 ──────────────────────────────────────────────
mkdirSync(logDir, { recursive: true });
if (!existsSync(path.join(mysqlBinDir, 'mysqld.exe'))) {
    throw new Error('未找到便携版 MySQL：请先解压 mysql.zip 到 temp/runtime/mysql（bin 目录需存在）');
}

// ── 1. 首次运行：初始化 MySQL 数据目录 ────────────────────────
if (!existsSync(path.join(mysqlDataDir, 'mysql'))) {
    log('首次运行：初始化 MySQL 数据目录（约半分钟）...');
    execSync(
        `"${path.join(mysqlBinDir, 'mysqld.exe')}" --initialize-insecure --basedir="${path.join(runtimeDir, 'mysql')}" --datadir="${mysqlDataDir}"`,
        { stdio: 'ignore', timeout: 120000 },
    );
    log('MySQL 数据目录初始化完成。');
}
// 配置文件独立于初始化：每次启动都确保存在（改端口/参数后重装也能生效）。
writeFileSync(
    path.join(runtimeDir, 'my.ini'),
    [
        '[mysqld]',
        `basedir=${path.join(runtimeDir, 'mysql').replace(/\\/g, '/')}`,
        `datadir=${mysqlDataDir.replace(/\\/g, '/')}`,
        `port=${MYSQL_PORT}`,
        'bind-address=127.0.0.1',
        'character-set-server=utf8mb4',
        'collation-server=utf8mb4_0900_ai_ci',
        'innodb_buffer_pool_size=256M',
        'max_connections=100',
        'default-time-zone=+08:00',
        '',
    ].join('\n'),
);

// ── 2. 启动 MySQL ───────────────────────────────────────────
log('启动 MySQL（端口 3307）...');
await spawnLogged('mysql.log', path.join(mysqlBinDir, 'mysqld.exe'), [
    `--defaults-file=${path.join(runtimeDir, 'my.ini')}`,
    '--console',
]);

await waitForPort(MYSQL_PORT, 60000, 'MySQL');
log('MySQL 已就绪。');

// ── 3. 建库建用户（幂等）────────────────────────────────────
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

// ── 4. 迁移 + 首个超管（幂等）────────────────────────────────
log('应用数据库迁移...');
execSync('node scripts/local/migrate-local.mjs', { cwd: repositoryRoot, stdio: 'inherit' });
log('确保本地超级管理员存在...');
execSync('node scripts/local/bootstrap-admin.mjs', { cwd: repositoryRoot, stdio: 'inherit' });

// ── 5. 启动后端 ─────────────────────────────────────────────
log('启动后端（端口 8100）...');
await spawnLogged('backend.log', process.execPath, ['dist/app.js'], { cwd: path.join(repositoryRoot, 'backend') });
await waitForPort(BACKEND_PORT, 60000, '后端');
{
    const health = await fetch(`http://127.0.0.1:${BACKEND_PORT}/api/health`).then((r) => r.text()).catch(() => 'FAIL');
    log(`后端健康检查：${health}`);
}

// ── 6. 启动两个前端（生产构建 preview）───────────────────────
log('启动学习端与管理后台（生产构建）...');
await spawnLogged('web-app.log', process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview'], { cwd: path.join(repositoryRoot, 'web-app') });
await spawnLogged('admin.log', process.execPath, [path.join(repositoryRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview'], { cwd: path.join(repositoryRoot, 'admin') });
await waitForPort(WEB_PORT, 60000, '学习端');
await waitForPort(ADMIN_PORT, 60000, '管理后台');

// ── 7. 打开浏览器 ───────────────────────────────────────────
execSync('start "" "http://127.0.0.1:8101"', { shell: 'cmd.exe', stdio: 'ignore' });

log('──────────────────────────────────────────────');
log('句听已全部启动：');
log(`  学习端     http://127.0.0.1:${WEB_PORT}   （已自动打开）`);
log(`  管理后台   http://127.0.0.1:${ADMIN_PORT}   账号 admin@duolinting.local / duolinting2026`);
log(`  数据库     MySQL :${MYSQL_PORT}（root 无密码，仅本机）`);
log('  媒体存储   本地磁盘 temp/runtime/media-store（单机模式，无需 MinIO）');
log('自动切分（本地语音识别）已启用，制课台上传音频后可直接使用。');
log('停止：按 Ctrl+C 或直接关闭本窗口。');
log('──────────────────────────────────────────────');

// 保活：编排器退出（窗口关闭/Ctrl+C）时统一清理。
setInterval(() => undefined, 1 << 30);
void cleanup;
