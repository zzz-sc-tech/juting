#!/usr/bin/env node
'use strict';
/**
 * 句听启动器（单文件 exe 入口 / SEA 主脚本）
 *
 * 用户双击 句听.exe → 本进程负责：
 *   1. 派生并监管服务编排器（scripts/local/start-all.mjs，便携 Node + IPC）；
 *   2. 拉起托盘 UI（scripts/local/tray-ui.ps1，PowerShell NotifyIcon）——
 *      两者只用两个 JSON 文件协作：launcher-status.json（本进程写、托盘读）
 *      / launcher-cmd.json（托盘写、本进程读后删除），不握手、不起服务；
 *   3. 单实例检测（已在运行则转发 focus，让托盘弹「已在运行」）；
 *   4. 接管模式（端口上已有服务在跑——例如用 bat 起的——则只挂托盘托管，退出时统一停）；
 *   5. 首次运行自动创建桌面快捷方式、开机自启开关（HKCU，免管理员）；
 *   6. 停止：向编排器发 shutdown → 等退出 → 兜底跑 stop-all 清扫端口 → 通知托盘退出。
 *
 * SEA 约束：本文件必须是自包含单文件（快照里没有别的模块），因此只用 node 内置模块。
 * 开发态也可直接用 node 运行：node scripts/local/launcher-app.cjs
 *
 * 调试开关：
 *   --selfcheck   打印 OK + node 版本后退出（构建自检用）
 *   --no-tray     不拉托盘（无头测试用）
 *   --verbose     把监督过程打到控制台
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const STATUS_FILE_NAME = 'launcher-status.json';
const CMD_FILE_NAME = 'launcher-cmd.json';
const PREFS_FILE_NAME = 'launcher-prefs.json';
const START_SCRIPT_REL = path.join('scripts', 'local', 'start-all.mjs');
const STOP_SCRIPT_REL = path.join('scripts', 'local', 'stop-all.mjs');
const TRAY_SCRIPT_REL = path.join('scripts', 'local', 'tray-ui.ps1');
const AUTOSTART_VALUE_NAME = '句听';
const PORTS = { mysql: 3307, backend: 8100, web: 8101, admin: 8102 };
const WEB_URL = `http://127.0.0.1:${PORTS.web}`;

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const VERBOSE = hasFlag('--verbose');
const NO_TRAY = hasFlag('--no-tray');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message) => {
    const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
    if (VERBOSE) console.log(line);
    try {
        fs.appendFileSync(paths.logPath, `${line}\n`);
    } catch {
        // 日志目录不可写时静默
    }
};

// ── 路径解析 ────────────────────────────────────────────────
// SEA 运行时 process.execPath 是 exe 本身（安装目录根）；源码态回退到 __dirname/../..
const firstExisting = (list) => list.find((item) => item && fs.existsSync(item)) || null;
const resolveRepoRoot = () => {
    const candidates = [path.dirname(process.execPath), path.resolve(__dirname, '..', '..')];
    for (const dir of candidates) {
        try {
            if (fs.existsSync(path.join(dir, START_SCRIPT_REL))) return dir;
        } catch {
            // 忽略
        }
    }
    return candidates[candidates.length - 1];
};
const repoRoot = resolveRepoRoot();
const runtimeDir = path.join(repoRoot, 'temp', 'runtime');
const logDir = path.join(runtimeDir, 'logs');
const paths = {
    repoRoot,
    runtimeDir,
    logDir,
    statusPath: path.join(runtimeDir, STATUS_FILE_NAME),
    cmdPath: path.join(runtimeDir, CMD_FILE_NAME),
    prefsPath: path.join(runtimeDir, PREFS_FILE_NAME),
    logPath: path.join(logDir, 'launcher.log'),
    trayLogPath: path.join(logDir, 'tray.log'),
    trayStdioPath: path.join(logDir, 'tray-stdio.log'),
    startScript: path.join(repoRoot, START_SCRIPT_REL),
    stopScript: path.join(repoRoot, STOP_SCRIPT_REL),
    trayScript: path.join(repoRoot, TRAY_SCRIPT_REL),
    iconPath: firstExisting([path.join(repoRoot, 'juting.ico'), path.join(repoRoot, 'docs', 'images', 'juting.ico')]),
    nodeExe: firstExisting([path.join(runtimeDir, 'node', 'node.exe')]) || process.execPath,
    builtExe: firstExisting([path.join(repoRoot, 'temp', 'launcher-build', '句听.exe')]),
};
// 自启/快捷方式指向的可执行体：SEA 下就是自己；源码态用构建产物兜底。
const selfExe = /node(\.exe)?$/i.test(path.basename(process.execPath)) ? paths.builtExe : process.execPath;

// ── 原子 JSON 读写 ─────────────────────────────────────────
const readJson = (file) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
};
const writeJsonAtomic = (file, data) => {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
        fs.renameSync(tmp, file);
        return true;
    } catch (error) {
        log(`写 ${path.basename(file)} 失败：${error.message}`);
        return false;
    }
};

// ── 状态对象（唯一写者）────────────────────────────────────
const prefs = readJson(paths.prefsPath) || { autostart: false, shortcutCreated: false };
const savePrefs = () => writeJsonAtomic(paths.prefsPath, prefs);
let status = {
    state: 'starting',
    step: 0,
    total: 6,
    tooltip: '句听 · 启动中…',
    message: '',
    error: null,
    balloon: null,
    pid: process.pid,
    exePath: selfExe || '',
    autostart: Boolean(prefs.autostart),
    ports: PORTS,
};
let balloonSeq = 0;
const setStatus = (patch) => {
    status = { ...status, ...patch, pid: process.pid, exePath: selfExe || '', updatedAt: new Date().toISOString() };
    writeJsonAtomic(paths.statusPath, status);
};
const balloon = (title, text) => {
    balloonSeq += 1;
    setStatus({ balloon: { id: `b${balloonSeq}`, title, text } });
};

// ── PowerShell（-EncodedCommand 规避非 ASCII 参数编码问题）──
const runPowerShell = (script, { timeout = 30000, capture = false } = {}) => {
    const encoded = Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8;\n${script}`, 'utf16le').toString('base64');
    return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
        encoding: 'utf8',
        windowsHide: true,
        timeout,
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
};

// ── 开机自启（HKCU Run；走 PowerShell 而非 reg.exe：reg 在部分安全策略下被拉黑）──
const RUN_KEY_PS = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const normalizePath = (value) => String(value || '').trim().replace(/^"|"$/g, '');
const readAutostartValue = () => {
    const result = runPowerShell(`(Get-ItemProperty -Path '${RUN_KEY_PS}' -Name '${AUTOSTART_VALUE_NAME}' -ErrorAction SilentlyContinue).'${AUTOSTART_VALUE_NAME}'`, { capture: true, timeout: 15000 });
    return normalizePath(result.stdout);
};
const setAutostart = (enabled, { silent = false } = {}) => {
    if (enabled && !selfExe) {
        balloon('无法设置开机自启', '未找到 句听.exe，请先构建或使用发布包。');
        return false;
    }
    // 路径可能含空格：按 Windows 惯例带引号写入，回读时两侧一并去引号比较。
    const script = enabled
        ? `Set-ItemProperty -Path '${RUN_KEY_PS}' -Name '${AUTOSTART_VALUE_NAME}' -Value ${psQuote(`"${selfExe}"`)} -Type String`
        : `Remove-ItemProperty -Path '${RUN_KEY_PS}' -Name '${AUTOSTART_VALUE_NAME}' -ErrorAction SilentlyContinue`;
    const write = runPowerShell(script, { capture: true, timeout: 15000 });
    if (write.status !== 0) {
        log(`写注册表失败（exit=${write.status}）：${(write.stderr || '').trim().slice(0, 200)}`);
    }
    // 以「回读验证过的真实值」为准，不盲目乐观
    const readback = readAutostartValue();
    const verified = enabled ? readback === normalizePath(selfExe) : readback === '';
    log(`开机自启 → ${enabled ? '开' : '关'}（回读：${readback || '(空)'}，判定 ${verified ? '成功' : '失败'}）`);
    if (!verified) {
        if (!silent) balloon('设置开机自启失败', '详情见 temp\\runtime\\logs\\launcher.log');
        return false;
    }
    prefs.autostart = enabled;
    savePrefs();
    setStatus({ autostart: enabled });
    if (!silent) {
        balloon(enabled ? '已开启开机自启' : '已关闭开机自启', enabled ? '下次开机句听会自动在托盘运行。' : '下次开机不再自动启动。');
    }
    return true;
};
// 启动时与注册表对账：安装目录被移动/复制后，把 Run 键指回当前 exe（自愈），
// 并让 status.autostart 反映注册表实际状态，而不是历史偏好。
const reconcileAutostart = () => {
    if (!selfExe) {
        setStatus({ autostart: false });
        return;
    }
    const current = readAutostartValue();
    if (!current) {
        if (prefs.autostart) { prefs.autostart = false; savePrefs(); }
        setStatus({ autostart: false });
        return;
    }
    if (current === normalizePath(selfExe)) {
        if (!prefs.autostart) { prefs.autostart = true; savePrefs(); }
        setStatus({ autostart: true });
        return;
    }
    log(`注册表自启指向旧路径（${current}），自愈重写为当前安装路径`);
    setAutostart(true, { silent: true });
};

// ── 桌面快捷方式 ────────────────────────────────────────────
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const desktopShortcutPath = () => {
    const result = runPowerShell('[Environment]::GetFolderPath("Desktop")', { capture: true, timeout: 10000 });
    const dir = (result.stdout || '').trim();
    return dir ? path.join(dir, '句听.lnk') : null;
};
const ensureDesktopShortcut = ({ silent = false } = {}) => {
    if (!selfExe) return false;
    const lnk = desktopShortcutPath();
    if (!lnk) return false;
    if (fs.existsSync(lnk)) {
        prefs.shortcutCreated = true;
        savePrefs();
        if (!silent) balloon('桌面快捷方式已存在', '双击桌面的「句听」即可启动。');
        return true;
    }
    const script = [
        '$W = New-Object -ComObject WScript.Shell',
        `$s = $W.CreateShortcut(${psQuote(lnk)})`,
        `$s.TargetPath = ${psQuote(selfExe)}`,
        `$s.WorkingDirectory = ${psQuote(repoRoot)}`,
        paths.iconPath ? `$s.IconLocation = ${psQuote(`${paths.iconPath},0`)}` : '',
        `$s.Description = ${psQuote('句听 · 本地听力精听')}`,
        '$s.Save()',
    ].filter(Boolean).join('\n');
    const result = runPowerShell(script, { capture: true });
    const ok = result.status === 0 && fs.existsSync(lnk);
    if (ok) {
        prefs.shortcutCreated = true;
        savePrefs();
        balloon('已创建桌面快捷方式', '以后双击桌面的「句听」即可启动。');
        log('桌面快捷方式已创建');
    } else {
        log(`创建桌面快捷方式失败：${(result.stderr || '').trim().slice(0, 200)}`);
    }
    return ok;
};

// ── 进程/端口工具 ───────────────────────────────────────────
const isAlive = (pid) => {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM'; // 存在但不属于当前用户
    }
};
const portOpen = (port, timeout = 600) => new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* 忽略 */ }
        resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
});
const killTree = (pid) => {
    if (!pid) return;
    try {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 });
    } catch {
        // 已退出
    }
};

// ── 编排器监督 ──────────────────────────────────────────────
let orchestrator = null;
let stopRequested = false;
let tailLines = [];
const pushTail = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        tailLines.push(trimmed);
        if (tailLines.length > 30) tailLines.shift();
    }
};
const lastErrorLine = () => {
    for (let i = tailLines.length - 1; i >= 0; i -= 1) {
        const line = tailLines[i];
        if (/Error|错误|失败|未找到|拒绝|超时/.test(line) && !/^\s*at /.test(line)) return line;
    }
    return tailLines[tailLines.length - 1] || '';
};

const spawnOrchestrator = () => {
    log(`派生编排器：${paths.nodeExe} ${paths.startScript}`);
    orchestrator = spawn(paths.nodeExe, [paths.startScript], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        // 必须 detached：Windows 上非 detached 的子进程会随父进程一起被系统回收，
        // 那样启动器一旦崩溃，编排器被带走而 mysqld/后端会孤儿化（无人清理）。
        // detached 后编排器可存活，靠 IPC 断开 + ppid 看门狗自行优雅清理。
        detached: true,
    });
    orchestrator.stdout.on('data', pushTail);
    orchestrator.stderr.on('data', pushTail);
    orchestrator.on('message', (msg) => {
        if (!msg) return;
        if (msg.type === 'progress') {
            const tooltip = `句听 · 启动中… ${msg.step}/${msg.total}`;
            setStatus({ state: 'starting', step: msg.step, total: msg.total, tooltip, message: msg.message || '' });
        } else if (msg.type === 'ready') {
            setStatus({ state: 'running', step: status.total, tooltip: '句听 · 运行中', message: '服务已就绪', error: null, ports: msg.ports || PORTS });
            balloon('句听已启动', '学习端已在浏览器打开；左键单击托盘图标可随时回来。');
            log('编排器就绪（running）');
            if (!prefs.shortcutCreated) setTimeout(() => ensureDesktopShortcut(), 1500);
            // 启动后台静默查更新（24 小时内查过就跳过），不阻塞任何流程
            const lastCheck = Number(prefs.lastUpdateCheck || 0);
            if (Date.now() - lastCheck > UPDATE_CACHE_MS) {
                setTimeout(() => { void checkForUpdate({ silent: true }); }, 6000);
            } else {
                log(`跳过更新检查（${Math.round((Date.now() - lastCheck) / 3600000)} 小时前查过）`);
            }
        }
    });
    orchestrator.on('exit', (code, signal) => {
        const wasStopping = stopRequested || status.state === 'stopping';
        log(`编排器退出 code=${code} signal=${signal}（stopRequested=${stopRequested}）`);
        orchestrator = null;
        if (wasStopping) return; // 停止流程自行收尾
        // 非停止请求的退出 = 启动失败或服务意外停止
        setStatus({
            state: 'error',
            tooltip: '句听 · 启动失败',
            error: { message: lastErrorLine() || `服务进程退出（代码 ${code}）`, hint: '详情见 temp\\runtime\\logs\\start-all-rerun.log 与 backend.log' },
        });
        balloon('句听启动失败', `${lastErrorLine() || `服务进程退出（代码 ${code}）`}\n右键托盘图标可查看日志或重试。`);
    });
    orchestrator.on('error', (error) => {
        log(`编排器派生失败：${error.message}`);
        setStatus({ state: 'error', tooltip: '句听 · 启动失败', error: { message: error.message, hint: '请确认安装目录完整、未被杀软拦截' } });
    });
};
const waitOrchestratorExit = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (orchestrator && Date.now() < deadline) await sleep(200);
    return !orchestrator;
};

// ── 停止流程 ────────────────────────────────────────────────
const runStopScript = async () => {
    log('兜底清扫：执行 stop-all.mjs');
    try {
        const child = spawn(paths.nodeExe, [paths.stopScript], { cwd: repoRoot, windowsHide: true, stdio: 'ignore' });
        await new Promise((resolve) => {
            const timer = setTimeout(() => { killTree(child.pid); resolve(); }, 25000);
            child.on('exit', () => { clearTimeout(timer); resolve(); });
            child.on('error', () => { clearTimeout(timer); resolve(); });
        });
    } catch (error) {
        log(`兜底清扫失败：${error.message}`);
    }
};
let stopping = false;
const stopEverything = async (reason, options = {}) => {
    if (stopping) return;
    stopping = true;
    stopRequested = true;
    log(`开始停止（${reason}）`);
    setStatus({ state: 'stopping', tooltip: options.tooltip || '句听 · 正在停止…', message: '正在安全关停数据库与后台服务' });
    if (orchestrator) {
        try { orchestrator.send({ cmd: 'shutdown' }); } catch { /* 已断开 */ }
        const exited = await waitOrchestratorExit(35000);
        if (!exited && orchestrator) killTree(orchestrator.pid);
    }
    // 编排器已退出时 stop-all 是幂等的端口级清扫；接管模式下它是唯一停止手段。
    await runStopScript();
    const finalBalloon = options.balloon
        ? { id: `b${++balloonSeq}`, ...options.balloon }
        : { id: `b${++balloonSeq}`, title: '句听已停止', text: '数据库已安全关停，数据未丢失。' };
    setStatus({
        state: 'stopped',
        tooltip: options.tooltip || '句听 · 已停止',
        message: options.balloon ? '正在安装更新，句听会自动重新打开' : '可以安全关闭或从托盘重新启动',
        balloon: finalBalloon,
    });
    log('已停止');
    await sleep(1500); // 给托盘读取 stopped 并自行退出的时间
    if (trayProcess) { try { trayProcess.kill(); } catch { /* 忽略 */ } }
    process.exit(0);
};

// ── 托盘 ────────────────────────────────────────────────────
let trayProcess = null;
const spawnTray = () => {
    if (NO_TRAY) { log('跳过托盘（--no-tray）'); return; }
    if (!fs.existsSync(paths.trayScript)) { log('未找到 tray-ui.ps1，跳过托盘'); return; }
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', paths.trayScript,
        '-StatusPath', paths.statusPath, '-CmdPath', paths.cmdPath,
        ...(paths.iconPath ? ['-IconPath', paths.iconPath] : []),
        '-LogPath', paths.trayLogPath];
    trayProcess = spawn('powershell.exe', args, {
        windowsHide: true,
        // 注意：托盘不能 detached（实测 detached 下 PowerShell 5.1 无控制台会立刻静默退出，
        // 连日志都不写）。托盘随启动器同生共死；启动器若崩溃，服务由编排器的
        // ppid 看门狗自清理，不留孤儿进程。
        stdio: ['ignore', fs.openSync(paths.trayStdioPath, 'a'), fs.openSync(paths.trayStdioPath, 'a')],
    });
    trayProcess.on('exit', (code) => log(`托盘退出 code=${code}`));
    trayProcess.on('error', (error) => log(`托盘启动失败：${error.message}`));
    log('托盘已拉起');
};

// ── 命令消费 ────────────────────────────────────────────────
const consumeCommand = async () => {
    const cmd = readJson(paths.cmdPath);
    if (!cmd || !cmd.action) return;
    try { fs.unlinkSync(paths.cmdPath); } catch { /* 已被消费 */ }
    log(`收到托盘指令：${cmd.action}`);
    switch (cmd.action) {
        case 'stop':
            await stopEverything('托盘请求');
            break;
        case 'autostart':
            setAutostart(Boolean(cmd.value));
            break;
        case 'shortcut':
            ensureDesktopShortcut();
            break;
        case 'check-update':
            await checkForUpdate();
            break;
        case 'update':
            await startUpdate();
            break;
        case 'focus':
            balloon('句听已在运行', '左键单击托盘图标即可打开学习端。');
            break;
        case 'restart':
            if (status.state === 'error') {
                log('按托盘请求重启服务');
                tailLines = [];
                setStatus({ state: 'starting', step: 0, tooltip: '句听 · 启动中…', error: null, message: '正在重新启动' });
                await runStopScript();
                spawnOrchestrator();
            }
            break;
        default:
            log(`未知指令：${cmd.action}`);
    }
};

// ════════════════════════════════════════════════════════════
// 更新检测与一键覆盖安装
//
// 流程：查 GitHub Release（可用 JUTING_UPDATE_API 覆盖为测试源）
//   → 比对版本 → 托盘菜单出现「更新到 vX.Y.Z」
//   → 下载（优先 *-update.zip，Node 原生解压；回退 .7z 需本机 7-Zip）
//   → 校验（SHA256SUMS.txt / 体积）+ 解压到 temp/runtime/update/staging
//   → 复制自身为「更新器」并以 --apply-update 派生（detached）
//   → 停止服务并退出；更新器等本进程消失后覆盖安装目录（跳过 temp 用户数据）→ 重新启动句听
// ════════════════════════════════════════════════════════════
const UPDATE_API = process.env.JUTING_UPDATE_API || 'https://api.github.com/repos/zzz-sc-tech/juting/releases/latest';
const UPDATE_REPO_URL = 'https://github.com/zzz-sc-tech/juting/releases';
const UPDATE_CACHE_MS = 24 * 60 * 60 * 1000;
const UPDATE_DIR = path.join(runtimeDir, 'update');
const UPDATE_STAGING = path.join(UPDATE_DIR, 'staging');
// 覆盖安装时永不触碰的路径（用户数据与运行时现场）
const UPDATE_PROTECTED = ['temp'];
// 应用更新时必须存在于新包里的锚点文件（防止下载残缺包把程序打坏）
const UPDATE_ANCHORS = ['package.json', '句听.exe', path.join('scripts', 'local', 'start-all.mjs')];

const currentVersion = () => {
    try {
        return JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version || '0.0.0';
    } catch {
        return '0.0.0';
    }
};
const parseVersion = (value) => String(value || '').replace(/^v/i, '').split(/[.\-+]/).map((part) => parseInt(part, 10) || 0);
const isNewerVersion = (remote, local) => {
    const a = parseVersion(remote);
    const b = parseVersion(local);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] || 0) > (b[i] || 0)) return true;
        if ((a[i] || 0) < (b[i] || 0)) return false;
    }
    return false;
};
const updatePatch = (patch) => {
    const next = { ...(status.update || {}), ...patch };
    setStatus({ update: next });
    return next;
};

// ── HTTP：GET（自动跟随跳转）与下载（带进度/哈希）────────────
const httpGet = (url, { headers = {}, onResponse, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
    const lib = /^http:/.test(url) ? http : https;
    const request = lib.get(url, { headers: { 'User-Agent': 'juting-launcher', Accept: 'application/vnd.github+json', ...headers }, timeout }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            res.resume();
            const next = new URL(res.headers.location, url).toString();
            resolve(httpGet(next, { headers, onResponse, timeout }));
            return;
        }
        if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
        }
        if (onResponse) {
            log(`收到响应 ${res.statusCode} ← ${url}（content-length=${res.headers['content-length'] || '未知'}）`);
            // 把响应流交给调用方消费（下载场景需要流式落盘），本 promise 就此结束。
            // 注意：必须真的调用 onResponse——只 resolve 流的话监听器永远挂不上，
            // 响应会一直悬着（socket 暂停、进程空等），表现为下载 0% 卡死。
            try {
                onResponse(res);
                resolve();
            } catch (error) {
                reject(error);
            }
            return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body));
    });
    request.on('timeout', () => {
        log(`请求超时（${timeout}ms）：${url}`);
        request.destroy(new Error('请求超时'));
    });
    request.on('error', reject);
});
const downloadToFile = (url, dest, { onProgress, timeout = 120000 } = {}) => new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let failed = false;
    const fail = (error) => {
        if (failed) return;
        failed = true;
        try { out.destroy(); } catch { /* 忽略 */ }
        try { fs.rmSync(tmp, { force: true }); } catch { /* 忽略 */ }
        reject(error);
    };
    httpGet(url, {
        timeout,
        onResponse: (res) => {
            const total = Number(res.headers['content-length']) || 0;
            res.once('data', () => log('下载已开始，收到首个数据块'));
            res.on('data', (chunk) => {
                received += chunk.length;
                hash.update(chunk);
                if (!out.write(chunk)) res.pause();
                if (onProgress) onProgress(received, total);
            });
            out.on('drain', () => res.resume());
            res.on('end', () => {
                log(`下载响应结束，累计 ${(received / 1048576).toFixed(1)} MB`);
                out.end(() => {
                    if (failed) return;
                    try {
                        fs.renameSync(tmp, dest);
                        resolve({ bytes: received, sha256: hash.digest('hex'), total });
                    } catch (error) {
                        fail(error);
                    }
                });
            });
            res.on('error', fail);
        },
    }).catch(fail);
    out.on('error', fail);
});

// ── ZIP 解压（纯 Node：中央目录 + inflateRaw，无需外部工具）──
const extractZip = (zipPath, destDir, { onProgress, skip } = {}) => {
    const fd = fs.openSync(zipPath, 'r');
    try {
        const total = fs.fstatSync(fd).size;
        const tailLen = Math.min(total, 66_000);
        const tail = Buffer.alloc(tailLen);
        fs.readSync(fd, tail, 0, tailLen, total - tailLen);
        const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
        if (eocd < 0) throw new Error('不是有效的 ZIP（未找到 EOCD）');
        const entryCount = tail.readUInt16LE(eocd + 10);
        if (entryCount === 0xffff) throw new Error('ZIP64 不受支持');
        const cdSize = tail.readUInt32LE(eocd + 12);
        const cdOffset = tail.readUInt32LE(eocd + 16);
        const cd = Buffer.alloc(cdSize);
        fs.readSync(fd, cd, 0, cdSize, cdOffset);

        let cursor = 0;
        let written = 0;
        const useCrc = typeof zlib.crc32 === 'function';
        for (let index = 0; index < entryCount; index += 1) {
            if (cd.readUInt32LE(cursor) !== 0x02014b50) throw new Error(`中央目录损坏（第 ${index + 1} 项）`);
            const flags = cd.readUInt16LE(cursor + 8);
            const method = cd.readUInt16LE(cursor + 10);
            const crc = cd.readUInt32LE(cursor + 16);
            const compSize = cd.readUInt32LE(cursor + 20);
            const nameLen = cd.readUInt16LE(cursor + 28);
            const extraLen = cd.readUInt16LE(cursor + 30);
            const commentLen = cd.readUInt16LE(cursor + 32);
            const localOffset = cd.readUInt32LE(cursor + 42);
            const rawName = cd.subarray(cursor + 46, cursor + 46 + nameLen);
            // bit 11 = UTF-8 文件名；否则按 CP437/GBK 兜底
            const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
            cursor += 46 + nameLen + extraLen + commentLen;

            const normalized = name.replace(/\\/g, '/');
            if (!normalized || normalized.startsWith('__MACOSX')) continue;
            if (skip && skip(normalized)) continue;
            const target = path.join(destDir, normalized);
            if (!target.startsWith(path.resolve(destDir))) continue; // 防目录穿越
            if (normalized.endsWith('/')) {
                fs.mkdirSync(target, { recursive: true });
                continue;
            }
            // 本地头：取数据区真实起点（extra 长度可能与中央目录不同）
            const head = Buffer.alloc(30);
            fs.readSync(fd, head, 0, 30, localOffset);
            if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`本地头损坏：${normalized}`);
            const dataStart = localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
            const compressed = Buffer.alloc(compSize);
            if (compSize > 0) fs.readSync(fd, compressed, 0, compSize, dataStart);
            let data;
            if (method === 0) data = compressed;
            else if (method === 8) data = zlib.inflateRawSync(compressed);
            else throw new Error(`不支持的压缩方式 ${method}（${normalized}）`);
            if (useCrc && crc !== 0 && zlib.crc32(data) !== crc) throw new Error(`CRC 校验失败：${normalized}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, data);
            written += 1;
            if (onProgress && written % 500 === 0) onProgress(written, entryCount);
        }
        if (onProgress) onProgress(written, entryCount);
        return { files: written, entries: entryCount };
    } finally {
        fs.closeSync(fd);
    }
};

// ── 检查更新 ────────────────────────────────────────────────
let updateBusy = false;
const checkForUpdate = async () => {
    if (updateBusy) return;
    updateBusy = true;
    updatePatch({ phase: 'checking', message: '正在检查更新…', error: null });
    log(`检查更新：${UPDATE_API}`);
    try {
        const body = await httpGet(UPDATE_API);
        const release = JSON.parse(body);
        const local = currentVersion();
        const remote = String(release.tag_name || release.name || '').trim();
        const assets = Array.isArray(release.assets) ? release.assets : [];
        const edition = fs.existsSync(path.join(repoRoot, 'presets', 'cet6', 'seed.json')) ? 'full' : 'lite';
        const pick = assets.find((a) => /-update\.zip$/i.test(a.name) && a.name.includes(edition))
            || assets.find((a) => /\.zip$/i.test(a.name) && a.name.includes(edition))
            || assets.find((a) => /-update\.zip$/i.test(a.name))
            || assets.find((a) => /\.7z$/i.test(a.name) && a.name.includes(edition))
            || assets.find((a) => /\.(zip|7z)$/i.test(a.name));
        const available = Boolean(pick) && isNewerVersion(remote, local);
        const sizeMb = pick ? Math.round(pick.size / 1048576) : 0;
        updatePatch({
            available,
            version: String(remote).replace(/^v/i, ''),
            current: local,
            assetName: pick ? pick.name : '',
            assetUrl: pick ? pick.browser_download_url : '',
            assetSize: pick ? pick.size : 0,
            needs7z: Boolean(pick && /\.7z$/i.test(pick.name)),
            sizeMb,
            releaseUrl: release.html_url || UPDATE_REPO_URL,
            phase: available ? 'available' : 'uptodate',
            progress: 0,
            message: available ? `发现新版本 v${String(remote).replace(/^v/i, '')}（约 ${sizeMb} MB）` : '已是最新版本',
            error: null,
            checkedAt: Date.now(),
        });
        prefs.lastUpdateCheck = Date.now();
        savePrefs();
        log(`检查更新结果：本地 v${local}，远端 ${remote || '(未知)'}，${available ? '有新版本' : '无需更新'}`);
        // 更新一律不弹系统气泡：设置页「关于句听」是唯一入口与进度展示处，
        // 托盘菜单项文字 + 图标提示同步反映状态。
        if (available) {
            log(`发现新版本 v${String(remote).replace(/^v/i, '')}（约 ${sizeMb} MB），可在设置页或托盘菜单更新`);
        }
    } catch (error) {
        log(`检查更新失败：${error.message}`);
        updatePatch({ phase: 'error', error: error.message, message: '检查更新失败' });
    } finally {
        updateBusy = false;
    }
};

// ── 下载 + 解压 + 校验 ──────────────────────────────────────
const prepareUpdate = async () => {
    const info = status.update || {};
    if (!info.available || !info.assetUrl) throw new Error('没有可用的更新资产，请先检查更新');
    const edition = fs.existsSync(path.join(repoRoot, 'presets', 'cet6', 'seed.json')) ? 'full' : 'lite';
    if (info.needs7z && !locate7z()) {
        throw new Error('该版本只提供 .7z 更新包，且本机未找到 7-Zip；请到 Releases 页手动下载覆盖解压');
    }
    log("准备下载目录：" + UPDATE_DIR);
    fs.rmSync(UPDATE_DIR, { recursive: true, force: true });
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
    const archive = path.join(UPDATE_DIR, info.assetName || `update-${Date.now()}.bin`);

    log("开始下载：" + info.assetUrl + " -> " + archive);
    updatePatch({ phase: 'downloading', progress: 0, message: '正在下载更新…' });
    setStatus({ tooltip: '句听 · 正在下载更新…' });
    const started = Date.now();
    let lastTick = 0;
    const result = await downloadToFile(info.assetUrl, archive, {
        onProgress: (received, total) => {
            // 节流：进度回调可能每秒上千次，状态文件写入压到 ~2 次/秒
            const now = Date.now();
            if (now - lastTick < 500) return;
            lastTick = now;
            const expected = total || info.assetSize || 0;
            const percent = expected ? Math.min(99, Math.round((received / expected) * 100)) : 0;
            const speed = received / Math.max(1, (now - started) / 1000);
            const speedText = speed > 1048576 ? `${(speed / 1048576).toFixed(1)} MB/s` : `${Math.round(speed / 1024)} KB/s`;
            updatePatch({ phase: 'downloading', progress: percent, message: `正在下载更新… ${percent}%（${speedText}）` });
            setStatus({ tooltip: `句听 · 正在下载更新 ${percent}%` });
        },
    });
    log(`下载完成：${(result.bytes / 1048576).toFixed(1)} MB，sha256=${result.sha256.slice(0, 16)}…`);
    if (info.assetSize && Math.abs(result.bytes - info.assetSize) > 1024) {
        throw new Error(`下载体积与发布信息不符（${result.bytes} vs ${info.assetSize}），已中止`);
    }
    log("下载校验阶段，开始读取 SHA256SUMS.txt");
    // SHA256SUMS.txt 若在发布资产里，逐字校验
    try {
        const assets = (await httpGet(UPDATE_API)).length ? JSON.parse(await httpGet(UPDATE_API)).assets : [];
        const sums = (assets || []).find((a) => /sha256sums/i.test(a.name));
        if (sums) {
            const text = await httpGet(sums.browser_download_url);
            const line = text.split(/\r?\n/).find((l) => l.includes(info.assetName));
            const expect = line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
            if (expect && expect !== result.sha256.toLowerCase()) {
                throw new Error('SHA256 校验失败，文件可能损坏，已中止更新');
            }
            if (expect) log('SHA256 校验通过');
        }
    } catch (error) {
        if (/校验失败/.test(error.message)) throw error;
        log(`SHA256 校验跳过：${error.message}`);
    }

    log("开始解压更新包");
    const archiveIsZip = /\.zip$/i.test(archive) || (fs.readFileSync(archive).subarray(0, 2).toString('latin1') === 'PK');
    updatePatch({ phase: 'extracting', message: '正在解压更新包…' });
    setStatus({ tooltip: '句听 · 正在解压更新包…' });
    fs.rmSync(UPDATE_STAGING, { recursive: true, force: true });
    fs.mkdirSync(UPDATE_STAGING, { recursive: true });
    let extractedRoot = UPDATE_STAGING;
    if (archiveIsZip) {
        const stats = extractZip(archive, UPDATE_STAGING, {
            skip: (rel) => /^(temp\/runtime\/(mysql-data|media-store|logs)|\.git)/i.test(rel),
            onProgress: (done, all) => updatePatch({ message: `正在解压更新包… ${done}/${all}` }),
        });
        log(`解压完成：${stats.files} 个文件`);
    } else {
        const sevenZip = locate7z();
        log(`解压 .7z（${sevenZip}）…`);
        const run = spawnSync(sevenZip, ['x', archive, `-o${UPDATE_STAGING}`, '-y'], { windowsHide: true, timeout: 30 * 60000 });
        if (run.status !== 0) throw new Error(`7-Zip 解压失败（exit=${run.status}）`);
    }
    // 兼容包内多一层同名目录的情况
    const inner = fs.readdirSync(extractedRoot).filter((n) => !n.startsWith('.'));
    if (inner.length === 1 && fs.statSync(path.join(extractedRoot, inner[0])).isDirectory()
        && fs.existsSync(path.join(extractedRoot, inner[0], 'package.json')) && !fs.existsSync(path.join(extractedRoot, 'package.json'))) {
        extractedRoot = path.join(extractedRoot, inner[0]);
        log(`更新包为嵌套目录结构，使用 ${inner[0]}/ 作为根`);
    }
    for (const anchor of UPDATE_ANCHORS) {
        if (!fs.existsSync(path.join(extractedRoot, anchor))) {
            throw new Error(`更新包内容不完整（缺少 ${anchor}），已中止更新`);
        }
    }
    log(`更新包已就绪：${extractedRoot}（版本 ${(() => { try { return JSON.parse(fs.readFileSync(path.join(extractedRoot, 'package.json'), 'utf8')).version; } catch { return '?'; } })()}）`);
    return { staging: extractedRoot, archive, edition };
};

const locate7z = () => {
    const candidates = [
        process.env.JUTING_7Z,
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Programs', '7-Zip', '7z.exe'),
    ].filter(Boolean);
    for (const candidate of candidates) {
        try { if (fs.existsSync(candidate)) return candidate; } catch { /* 忽略 */ }
    }
    const found = spawnSync('where', ['7z'], { encoding: 'utf8', windowsHide: true });
    const first = (found.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    return first && fs.existsSync(first) ? first : null;
};

// ── 一键更新：准备 → 派生更新器 → 停服退出 ──────────────────
const startUpdate = async () => {
    if (updateBusy) {
        log("更新流程已在进行中，忽略本次请求");
        return;
    }
    updateBusy = true;
    log("开始一键更新流程");
    try {
        const { staging } = await prepareUpdate();
        updatePatch({ phase: 'applying', message: '正在安装更新…', progress: 100 });
        setStatus({ tooltip: '句听 · 正在安装更新…' });
        log('开始安装更新：完成后句听会自动重新打开（页面内可见进度）');
        // 复制自身为独立更新器：运行中的 exe 无法覆盖自己，必须换一个副本执行
        if (!selfExe) {
            throw new Error('开发态未构建 句听.exe，无法执行一键更新（请先构建或使用发布包）');
        }
        const runnerDir = path.join(runtimeDir, 'update-runner');
        fs.rmSync(runnerDir, { recursive: true, force: true });
        fs.mkdirSync(runnerDir, { recursive: true });
        const runner = path.join(runnerDir, '句听-更新器.exe');
        fs.copyFileSync(selfExe, runner);
        const child = spawn(runner, ['--apply-update', staging, '--install-dir', repoRoot, '--wait-pid', String(process.pid)], {
            cwd: repoRoot,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
        });
        child.unref();
        log(`更新器已派生（pid=${child.pid}），即将停止服务并退出`);
        await sleep(800);
        await stopEverything('安装更新', {
            balloon: { title: '正在安装更新', text: '覆盖安装完成后句听会自动重新打开。' },
            tooltip: '句听 · 正在安装更新…',
        });
    } catch (error) {
        log(`更新失败：${error.message}`);
        updatePatch({ phase: 'error', error: error.message, message: `更新失败：${error.message}` });
        updateBusy = false;
    }
};

// ── 更新器模式（--apply-update）：等旧进程退出后覆盖安装并重启 ──
const runApplyUpdate = async () => {
    const staging = argv[argv.indexOf('--apply-update') + 1];
    const installDir = argv[argv.indexOf('--install-dir') + 1] || repoRoot;
    const waitPid = Number(argv[argv.indexOf('--wait-pid') + 1] || 0);
    const logFile = path.join(installDir, 'temp', 'runtime', 'logs', 'update.log');
    const write = (message) => {
        const line = `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`;
        try {
            fs.mkdirSync(path.dirname(logFile), { recursive: true });
            fs.appendFileSync(logFile, `${line}\n`);
        } catch { /* 忽略 */ }
    };
    write(`更新器启动：staging=${staging} install=${installDir} waitPid=${waitPid}`);
    if (!staging || !fs.existsSync(staging)) {
        write('更新包目录不存在，退出');
        return;
    }
    // 1. 等旧启动器退出（它要先停掉 MySQL/后端/前端）
    for (let i = 0; i < 240 && waitPid; i += 1) {
        let alive = true;
        try { process.kill(waitPid, 0); } catch (error) { alive = error.code === 'EPERM'; }
        if (!alive) break;
        await sleep(500);
    }
    write('旧进程已退出，开始覆盖安装');
    // 2. 覆盖拷贝（跳过 temp：用户数据与便携运行时现场）
    let copied = 0;
    try {
        fs.cpSync(staging, installDir, {
            recursive: true,
            force: true,
            dereference: true,
            filter: (src) => {
                const rel = path.relative(staging, src).replace(/\\/g, '/');
                if (!rel) return true;
                const top = rel.split('/')[0];
                if (UPDATE_PROTECTED.includes(top)) return false;
                return true;
            },
        });
        copied = 1;
    } catch (error) {
        write(`覆盖安装失败：${error.message}`);
    }
    if (copied) write('覆盖安装完成');
    // 3. 重启句听
    const exe = path.join(installDir, '句听.exe');
    try {
        if (fs.existsSync(exe)) {
            const child = spawn(exe, [], { cwd: installDir, detached: true, stdio: 'ignore', windowsHide: true });
            child.unref();
            write(`已重新启动 ${exe}`);
        } else {
            write('未找到 句听.exe，请手动启动');
        }
    } catch (error) {
        write(`重启失败：${error.message}`);
    }
    // 4. 清理更新临时文件（保留日志）
    try { fs.rmSync(path.join(installDir, 'temp', 'runtime', 'update'), { recursive: true, force: true }); } catch { /* 忽略 */ }
    write('更新器结束');
};

// ── 主流程 ──────────────────────────────────────────────────
const main = async () => {
    if (hasFlag('--selfcheck')) {
        console.log(`OK node ${process.version}`);
        return;
    }
    // 更新器模式：不拉托盘、不管服务，只等旧进程退出后覆盖安装并重启
    if (hasFlag('--apply-update')) {
        await runApplyUpdate();
        return;
    }
    fs.mkdirSync(logDir, { recursive: true });
    // 单实例检测必须先于任何 setStatus：setStatus 会把本进程 pid 写进状态文件，
    // 先写再读会读到自己的 pid，导致「已有实例在跑」永远判不出来（实测踩过）。
    const prev = readJson(paths.statusPath);
    setStatus({ version: currentVersion() });
    log(`启动器启动：安装目录 ${repoRoot}；nodeExe=${paths.nodeExe}；exe=${selfExe || '(开发态未构建)'}`);

    if (!fs.existsSync(paths.startScript)) {
        setStatus({ state: 'error', tooltip: '句听 · 安装不完整', error: { message: `未找到 ${START_SCRIPT_REL}`, hint: '请把压缩包内全部文件解压到同一文件夹再运行' } });
        balloon('句听安装不完整', '请把压缩包内全部文件解压到同一文件夹后再运行。');
        // 无编排器可管：挂托盘显示错误，用户可在托盘里退出
        spawnTray();
        setInterval(() => { void consumeCommand(); }, 500);
        return;
    }

    // 单实例：已有实例在跑 → 转发 focus 后退出（prev 已在 setStatus 之前读取）
    if (prev && ['starting', 'running', 'stopping'].includes(prev.state) && isAlive(prev.pid) && prev.pid !== process.pid) {
        log(`检测到已在运行的实例（pid=${prev.pid}），转发 focus`);
        writeJsonAtomic(paths.cmdPath, { action: 'focus', ts: new Date().toISOString() });
        return;
    }

    // 接管模式：端口上已有服务（例如用 bat 启动过）→ 不复用编排器，只挂托盘托管
    reconcileAutostart();
    const adopt = (await portOpen(PORTS.web)) || (await portOpen(PORTS.backend));
    setStatus({
        state: adopt ? 'running' : 'starting',
        tooltip: adopt ? '句听 · 运行中（已接管）' : '句听 · 启动中…',
        message: adopt ? '检测到已在运行的服务，已在托盘托管' : '',
    });
    if (adopt) log('检测到端口上已有服务，进入接管模式（停止将走 stop-all 清扫）');

    spawnTray();
    if (!adopt) spawnOrchestrator();

    // 命令轮询：托盘 → 本进程
    setInterval(() => { void consumeCommand(); }, 300);

    // 退出保护：进程被杀时尽量带走服务
    const emergency = () => {
        if (stopping) return;
        try { if (orchestrator) orchestrator.send({ cmd: 'shutdown' }); } catch { /* 忽略 */ }
    };
    process.on('SIGINT', () => { emergency(); void stopEverything('控制台中断'); });
    process.on('SIGTERM', () => { emergency(); void stopEverything('外部终止'); });
    process.on('SIGBREAK', () => { emergency(); void stopEverything('控制台中断'); });
};

main().catch((error) => {
    log(`启动器异常：${error && error.stack ? error.stack : error}`);
    setStatus({ state: 'error', tooltip: '句听 · 启动失败', error: { message: String(error && error.message ? error.message : error), hint: '详情见 temp\\runtime\\logs\\launcher.log' } });
    balloon('句听启动失败', '详情见 temp\\runtime\\logs\\launcher.log');
    spawnTray();
});
