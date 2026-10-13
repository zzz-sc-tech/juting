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
const stopEverything = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopRequested = true;
    log(`开始停止（${reason}）`);
    setStatus({ state: 'stopping', tooltip: '句听 · 正在停止…', message: '正在安全关停数据库与后台服务' });
    if (orchestrator) {
        try { orchestrator.send({ cmd: 'shutdown' }); } catch { /* 已断开 */ }
        const exited = await waitOrchestratorExit(35000);
        if (!exited && orchestrator) killTree(orchestrator.pid);
    }
    // 编排器已退出时 stop-all 是幂等的端口级清扫；接管模式下它是唯一停止手段。
    await runStopScript();
    setStatus({ state: 'stopped', tooltip: '句听 · 已停止', message: '可以安全关闭或从托盘重新启动', balloon: { id: `b${++balloonSeq}`, title: '句听已停止', text: '数据库已安全关停，数据未丢失。' } });
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

// ── 主流程 ──────────────────────────────────────────────────
const main = async () => {
    if (hasFlag('--selfcheck')) {
        console.log(`OK node ${process.version}`);
        return;
    }
    fs.mkdirSync(logDir, { recursive: true });
    log(`启动器启动：安装目录 ${repoRoot}；nodeExe=${paths.nodeExe}；exe=${selfExe || '(开发态未构建)'}`);

    if (!fs.existsSync(paths.startScript)) {
        setStatus({ state: 'error', tooltip: '句听 · 安装不完整', error: { message: `未找到 ${START_SCRIPT_REL}`, hint: '请把压缩包内全部文件解压到同一文件夹再运行' } });
        balloon('句听安装不完整', '请把压缩包内全部文件解压到同一文件夹后再运行。');
        // 无编排器可管：挂托盘显示错误，用户可在托盘里退出
        spawnTray();
        setInterval(() => { void consumeCommand(); }, 500);
        return;
    }

    // 单实例：已有实例在跑 → 转发 focus 后退出
    const prev = readJson(paths.statusPath);
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
