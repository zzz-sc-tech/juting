import fs from 'node:fs';
import path from 'node:path';

/**
 * 启动器（句听.exe）桥接层。
 *
 * 学习端的「检查更新 / 一键更新」按钮不能直接操作本机文件，因此由后端代为
 * 与启动器通信——两者的约定只有两个 JSON 文件（与启动器侧完全一致）：
 *   temp/runtime/launcher-status.json  启动器写、后端读（版本、更新状态、进度）
 *   temp/runtime/launcher-cmd.json     后端写、启动器读后删除（check-update / update）
 *
 * 用 bat 启动（没有 句听.exe 常驻）时命令文件不会被消费，这里会据此返回
 * 「启动器不可用」，前端引导用户改用 句听.exe 或到 Releases 手动更新。
 */

const ACTION_TIMEOUT_MS = 4000;

const runtimeDir = (): string => {
    // 便携模式下 MEDIA_LOCAL_DIR = <安装根>/temp/runtime/media-store，反推最稳；
    // 开发态回退到 backend/dist 的上一级布局。
    const mediaLocalDir = process.env.MEDIA_LOCAL_DIR;
    if (mediaLocalDir) {
        return path.resolve(mediaLocalDir, '..');
    }
    return path.resolve(process.cwd(), '..', 'temp', 'runtime');
};

const statusFile = (): string => path.join(runtimeDir(), 'launcher-status.json');
const cmdFile = (): string => path.join(runtimeDir(), 'launcher-cmd.json');
const installRoot = (): string => path.resolve(runtimeDir(), '..', '..');

const readJson = <T>(file: string): T | null => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
        return null;
    }
};

export type LauncherUpdateInfo = {
    available?: boolean;
    version?: string;
    current?: string;
    assetName?: string;
    sizeMb?: number;
    releaseUrl?: string;
    phase?: string;
    progress?: number;
    message?: string;
    error?: string | null;
    checkedAt?: number;
};

export type LauncherStatus = {
    state?: string;
    tooltip?: string;
    pid?: number;
    version?: string;
    update?: LauncherUpdateInfo | null;
    updatedAt?: string;
};

const isProcessAlive = (pid?: number): boolean => {
    if (!pid || !Number.isInteger(pid)) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
};

export const readLauncherStatus = (): LauncherStatus | null => readJson<LauncherStatus>(statusFile());

const readPackageVersion = (): string => {
    const pkg = readJson<{ version?: string }>(path.join(installRoot(), 'package.json'));
    return pkg?.version || '未知';
};

export type UpdateStatePayload = {
    version: string;
    launcherRunning: boolean;
    serviceState: string | null;
    /** 更新状态；null 表示尚未检查过 */
    update: LauncherUpdateInfo | null;
    releaseUrl: string;
    installRoot: string;
};

/** 供 GET /system/update：页面轮询用（含启动器是否常驻、当前版本与更新进度） */
export const getUpdateState = (): UpdateStatePayload => {
    const status = readLauncherStatus();
    const launcherRunning = Boolean(status && isProcessAlive(status.pid));
    return {
        version: readPackageVersion(),
        launcherRunning,
        serviceState: status?.state ?? null,
        update: launcherRunning ? status?.update ?? null : null,
        releaseUrl: 'https://github.com/zzz-sc-tech/juting/releases',
        installRoot: installRoot(),
    };
};

/**
 * 向启动器下发动作。返回 true 表示命令已被消费（启动器在跑）；
 * false 表示超时未被消费——多半是当前不是用 句听.exe 启动的。
 */
export const requestLauncherAction = async (action: 'check-update' | 'update'): Promise<boolean> => {
    try {
        fs.unlinkSync(cmdFile());
    } catch {
        // 没有旧命令，正常
    }
    try {
        fs.mkdirSync(path.dirname(cmdFile()), { recursive: true });
        const tmp = `${cmdFile()}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ action, ts: new Date().toISOString() }));
        fs.renameSync(tmp, cmdFile());
    } catch {
        return false;
    }
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (!fs.existsSync(cmdFile())) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // 超时：清掉自己写的命令，避免启动器稍后启动时误执行
    try {
        fs.unlinkSync(cmdFile());
    } catch {
        // 已被消费
    }
    return false;
};
