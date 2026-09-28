import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { env } from '../../../env';
import { Logger } from '../../../lib/logger';
import { ASR_MODEL_CATALOG, asrAssetDir, type AsrModelTier } from './hardware-profile';
import { invalidateAsrProviderStatus } from '../asr-service';

/**
 * 本地 ASR 资源的一键准备：下载模型（必需）、下载 whisper 可执行文件（可选）。
 *
 * 设计要点：
 * - 断点续传：用 Range 头从已下载字节处续传。模型动辄数百 MB，而国内直连
 *   GitHub/HuggingFace 常中途断流，不能续传就等于不可用。
 * - 重试：失败后按退避重试，累计成功写满文件才判定完成。
 * - 装完自动写 .env：把路径与推荐线程数落盘，用户不必手工编辑配置。
 * - 任务状态放内存：这是一次性的装机动作，不落库；后端重启即清空。
 */

const logger = new Logger(__filename);

export type AsrInstallKind = 'model' | 'binary';
export type AsrInstallStatus = 'downloading' | 'extracting' | 'done' | 'failed';

export type AsrInstallTask = {
    id: string;
    kind: AsrInstallKind;
    /** 展示名：模型文件名或压缩包名。 */
    label: string;
    status: AsrInstallStatus;
    receivedBytes: number;
    totalBytes: number;
    percent: number;
    /** 失败原因或阶段性说明（原始文本，界面按状态给文案）。 */
    message: string;
    targetPath: string;
    startedAt: string;
    finishedAt?: string;
};

const tasks = new Map<string, AsrInstallTask>();
let taskSeq = 0;

export const getAsrInstallTask = (id: string) => tasks.get(id) ?? null;
export const listAsrInstallTasks = () => [...tasks.values()];

const updateTask = (id: string, patch: Partial<AsrInstallTask>) => {
    const current = tasks.get(id);
    if (!current) return;
    tasks.set(id, { ...current, ...patch });
};

/** 模型下载源：默认 hf-mirror（国内可达），可用 ASR_MODEL_BASE_URL 覆盖为官方源。 */
const modelUrl = (fileName: string) =>
    `${env.asr.modelBaseUrl.replace(/\/+$/, '')}/ggerganov/whisper.cpp/resolve/main/${fileName}`;

/** 备用源：主源失败时自动回退，避免单一镜像挂掉就装不上。 */
const modelFallbackUrl = (fileName: string) =>
    `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${fileName}`;

const fetchToFile = async (
    url: string,
    destPath: string,
    onProgress: (received: number, total: number) => void,
    redirectDepth = 0,
): Promise<void> => {
    if (redirectDepth > 5) {
        throw new Error('下载重定向次数过多');
    }

    await fsp.mkdir(path.dirname(destPath), { recursive: true });
    const existing = fs.existsSync(destPath) ? fs.statSync(destPath).size : 0;

    await new Promise<void>((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const request = client.get(
            url,
            {
                headers: {
                    // 已下载部分用 Range 续传，避免断流后从头再来。
                    ...(existing > 0 ? { Range: `bytes=${existing}-` } : {}),
                    'user-agent': 'juting-asr-installer',
                },
                timeout: 60_000,
            },
            (response) => {
                const status = response.statusCode ?? 0;
                if (status >= 300 && status < 400 && response.headers.location) {
                    response.resume();
                    const next = new URL(response.headers.location, url).toString();
                    void fetchToFile(next, destPath, onProgress, redirectDepth + 1).then(resolve, reject);
                    return;
                }
                if (status !== 200 && status !== 206) {
                    response.resume();
                    reject(new Error(`下载失败：HTTP ${status}`));
                    return;
                }

                // 206 = 服务端接受了续传；200 表示服务端不支持 Range，需要从头写。
                const resumed = status === 206;
                const alreadyHave = resumed ? existing : 0;
                const chunkLength = Number(response.headers['content-length'] ?? 0);
                const total = resumed ? alreadyHave + chunkLength : chunkLength;

                const stream = fs.createWriteStream(destPath, resumed ? { flags: 'a' } : { flags: 'w' });
                let received = alreadyHave;
                response.on('data', (chunk: Buffer) => {
                    received += chunk.length;
                    onProgress(received, total);
                });
                response.pipe(stream);
                stream.on('finish', () => {
                    stream.close();
                    resolve();
                });
                stream.on('error', reject);
                response.on('error', reject);
            },
        );
        request.on('timeout', () => request.destroy(new Error('下载超时')));
        request.on('error', reject);
    });
};

/** 带重试与续传的下载：中断后从已下载字节继续，最多尝试 maxAttempts 轮。 */
const downloadWithRetry = async (
    urls: string[],
    destPath: string,
    onProgress: (received: number, total: number) => void,
    maxAttempts = 4,
) => {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        for (const url of urls) {
            try {
                await fetchToFile(url, destPath, onProgress);
                // 内容完整性：模型文件至少要有若干 MB，几十字节的多半是错误页
                const size = fs.statSync(destPath).size;
                if (size < 1024 * 1024) {
                    throw new Error(`下载内容异常（仅 ${size} 字节）`);
                }
                return;
            } catch (error) {
                lastError = error;
                logger.warn(`[ASR 安装] 第 ${attempt} 轮下载失败 ${url}：${error instanceof Error ? error.message : error}`);
            }
        }
        await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    throw lastError instanceof Error ? lastError : new Error('下载失败');
};

/** 解压 zip：Windows 用 PowerShell，类 Unix 用 unzip。 */
const extractZip = (zipPath: string, destDir: string) => {
    if (process.platform === 'win32') {
        execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${destDir}" -Force`],
            { timeout: 120_000, stdio: 'ignore' },
        );
        return;
    }
    execFileSync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120_000, stdio: 'ignore' });
};

/** 在解压目录里递归找 whisper 可执行文件（各平台/各版本命名不一）。 */
const findWhisperBinary = (dir: string): string => {
    const candidates: string[] = [];
    const walk = (current: string, depth: number) => {
        if (depth > 4) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                walk(full, depth + 1);
                continue;
            }
            if (/^(whisper-cli|main|whisper)(\.exe)?$/i.test(entry.name)) {
                candidates.push(full);
            }
        }
    };
    walk(dir, 0);
    // 优先 whisper-cli（新版正式入口），main.exe 在新版里已弃用。
    return candidates.find((item) => /whisper-cli/i.test(item)) ?? candidates[0] ?? '';
};

/**
 * 把安装结果写进 backend/.env，并同步到当前进程环境变量。
 * 这样用户点完「一键准备」就能直接用，不必手工编辑配置文件。
 */
const persistEnv = (updates: Record<string, string>) => {
    const envPath = path.resolve(process.cwd(), '.env');
    let content: string;
    try {
        content = fs.readFileSync(envPath, 'utf8');
    } catch {
        content = '';
    }

    for (const [key, value] of Object.entries(updates)) {
        const line = `${key}=${value}`;
        const pattern = new RegExp(`^${key}=.*$`, 'm');
        if (pattern.test(content)) {
            content = content.replace(pattern, line);
        } else {
            content = `${content.replace(/\s*$/, '')}\n${line}\n`;
        }
        // 同步当前进程：本次运行立即生效，无需重启后端。
        process.env[key] = value;
    }

    fs.writeFileSync(envPath, content, 'utf8');
};

/** 安装完成后的收尾：写 .env + 让状态缓存失效（下一次查询重新探测）。 */
const finalizeInstall = async (kind: AsrInstallKind, targetPath: string, threads: number) => {
    if (kind === 'model') {
        persistEnv({
            ASR_ENABLED: 'true',
            ASR_WHISPER_MODEL: targetPath,
            ASR_THREADS: String(threads),
        });
    } else {
        persistEnv({
            ASR_ENABLED: 'true',
            ASR_WHISPER_BIN: targetPath,
        });
    }
    invalidateAsrProviderStatus();
};

export type StartInstallOptions = {
    kind: AsrInstallKind;
    /** 模型档位；kind=binary 时忽略。 */
    tier?: AsrModelTier;
    /** 推荐线程数，随模型一起写进 .env。 */
    threads?: number;
};

/**
 * 启动一次安装任务（异步执行，立即返回任务句柄供轮询）。
 * 同一时刻只允许一个任务在跑，避免并发下载打满带宽。
 */
export const startAsrInstall = ({ kind, tier = 'small', threads = 8 }: StartInstallOptions): AsrInstallTask => {
    const running = [...tasks.values()].find(
        (task) => task.status === 'downloading' || task.status === 'extracting',
    );
    if (running) {
        throw new Error('已有安装任务正在进行，请等待其完成');
    }

    const id = `asr-install-${Date.now()}-${(taskSeq += 1)}`;
    const assetDir = asrAssetDir();

    const isModel = kind === 'model';
    const entry = ASR_MODEL_CATALOG[tier];
    const label = isModel ? entry.fileName : path.basename(env.asr.binaryUrl) || 'whisper-bin.zip';
    const targetPath = isModel
        ? path.join(assetDir, entry.fileName)
        : path.join(assetDir, 'whisper-bin');

    const task: AsrInstallTask = {
        id,
        kind,
        label,
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: 0,
        percent: 0,
        message: '',
        targetPath,
        startedAt: new Date().toISOString(),
    };
    tasks.set(id, task);

    void (async () => {
        try {
            const onProgress = (received: number, total: number) => {
                const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
                updateTask(id, { receivedBytes: received, totalBytes: total, percent });
            };

            if (isModel) {
                const fileName = entry.fileName;
                await downloadWithRetry(
                    [modelUrl(fileName), modelFallbackUrl(fileName)],
                    targetPath,
                    onProgress,
                );
                await finalizeInstall('model', targetPath, threads);
            } else {
                const zipPath = path.join(assetDir, label);
                await downloadWithRetry([env.asr.binaryUrl], zipPath, onProgress);
                updateTask(id, { status: 'extracting', percent: 100 });
                await fsp.mkdir(targetPath, { recursive: true });
                extractZip(zipPath, targetPath);
                const binary = findWhisperBinary(targetPath);
                if (!binary) {
                    throw new Error('解压后未找到 whisper 可执行文件');
                }
                await finalizeInstall('binary', binary, threads);
            }

            updateTask(id, {
                status: 'done',
                percent: 100,
                finishedAt: new Date().toISOString(),
            });
            logger.info(`[ASR 安装] ${kind} 完成：${targetPath}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            updateTask(id, {
                status: 'failed',
                message,
                finishedAt: new Date().toISOString(),
            });
            logger.error(`[ASR 安装] ${kind} 失败：${message}`);
        }
    })();

    return task;
};
