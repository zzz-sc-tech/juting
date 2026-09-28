import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { env } from '../../../env';
import type { AsrSegment } from '../../../domain';
import { Logger } from '../../../lib/logger';
import { getMediaObject } from '../media-service';

const logger = new Logger(__filename);

/** whisper.cpp 单次转写的兜底超时：超长音频也应在有限时间内结束，避免任务把队列卡死。 */
const WHISPER_TIMEOUT_MS = 4 * 60 * 60 * 1000;

export type WhisperStage =
  | 'downloading'
  | 'converting'
  | 'transcribing'
  | 'parsing';

export type RunWhisperOptions = {
  objectName: string
  /** whisper 语言代码（en/zh/ja...）或 auto；调用方已做格式校验。 */
  language: string
  /** 阶段回调，用于把粗粒度进度写回任务行。 */
  onStage?: (stage: WhisperStage, progress: number) => void
}

export class AsrNotConfiguredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AsrNotConfiguredError';
    }
}

/** 把进程启动失败（ENOENT 等）翻译成可操作的提示，制作者照着改环境变量即可。 */
const describeSpawnError = (bin: string, label: string, error: unknown) => {
    const code = typeof error === 'object' && error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'ENOENT') {
        return `未找到${label}（${bin}）。请确认已安装，并通过 ASR_${label === 'ffmpeg' ? 'FFMPEG_BIN' : 'WHISPER_BIN'} 指向可执行文件。`;
    }
    return error instanceof Error ? error.message : String(error);
};

const execFileWithStderr = (bin: string, args: string[], label: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let stderrTail = '';
        let stdoutTail = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${label} 执行超过 ${Math.round(timeoutMs / 60000)} 分钟，已终止`));
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => {
            stdoutTail = `${stdoutTail}${chunk.toString()}`.slice(-4000);
        });
        child.stderr.on('data', (chunk: Buffer) => {
            stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(describeSpawnError(bin, label, error)));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve();
                return;
            }
            const tail = stderrTail || stdoutTail || '(无输出)';
            reject(new Error(`${label} 退出码 ${code}：${tail.trim()}`));
        });
    });

/**
 * whisper.cpp 要求 16kHz 单声道 PCM WAV；课程媒体可能是 mp3/m4a/mp4 等，
 * 统一用 ffmpeg 转换（视频类剥掉画面轨道，避免解码负担）。
 */
const convertTo16kMonoWav = (sourcePath: string, wavPath: string) =>
    execFileWithStderr(
        env.asr.ffmpegBin,
        ['-y', '-i', sourcePath, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath],
        'ffmpeg',
        30 * 60 * 1000,
    );

const runWhisperCli = (wavPath: string, srtPrefix: string, language: string) => {
    // 初始提示词把中文输出偏置为简体（whisper 默认常出繁体），也用于领域词微调。
    const promptArgs = env.asr.initialPrompt.trim()
        ? ['--prompt', env.asr.initialPrompt.trim()]
        : [];
    // max-context：环境变量显式配置时才传。设 0 表示每段独立解码，可抑制长音频上
    // 凭空生成句子的注入式幻觉（见 env.ts 的说明）。
    const contextArgs = env.asr.maxContext >= 0
        ? ['-mc', String(env.asr.maxContext)]
        : [];
    return execFileWithStderr(
        env.asr.whisperBin,
        [
            '-m', env.asr.whisperModel,
            '-f', wavPath,
            '-t', String(env.asr.threads),
            // 语言参数直接来自服务端常量与白名单校验，args 数组方式也不存在 shell 注入面。
            '-l', language,
            ...promptArgs,
            ...contextArgs,
            '-osrt',
            '-of', srtPrefix,
            // 降低非关键日志量，任务日志里只保留错误信息。
            '-np',
        ],
        'whisper',
        WHISPER_TIMEOUT_MS,
    );
};

/** "00:01:02,345" / "00:01:02.345" → 秒（浮点）。 */
const parseSrtTimestamp = (value: string): number => {
    const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/);
    if (!match) {
        throw new Error(`无法识别的 SRT 时间戳：${value.trim()}`);
    }
    const [, hours, minutes, seconds, milliseconds] = match;
    return (
        Number.parseInt(hours, 10) * 3600 +
        Number.parseInt(minutes, 10) * 60 +
        Number.parseInt(seconds, 10) +
        Number.parseInt(milliseconds.padEnd(3, '0'), 10) / 1000
    );
};

/**
 * 解析标准 SRT 为分段数组。ASR 结果只关心时间与文本：空行分块、找 "-->" 时间行、
 * 其余行按 SRT 规范拼接为单行文本。
 */
export const parseSrtContent = (content: string): AsrSegment[] => {
    const segments: AsrSegment[] = [];
    const blocks = content.replace(/\r/g, '').split(/\n\s*\n/);
    for (const block of blocks) {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const timingIndex = lines.findIndex((line) => line.includes('-->'));
        if (timingIndex < 0) {
            continue;
        }
        const [startText, endText] = lines[timingIndex]
            .split('-->')
            .map((part) => part.trim().split(/\s+/)[0]);
        const text = lines
            .slice(timingIndex + 1)
            .join(' ')
            .trim();
        if (!text) {
            continue;
        }
        const start = parseSrtTimestamp(startText);
        const end = parseSrtTimestamp(endText);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
            continue;
        }
        segments.push({ start, end, text });
    }
    return segments;
};

export const segmentsToSrt = (segments: readonly AsrSegment[]): string => {
    const formatTimestamp = (seconds: number) => {
        const safe = Math.max(0, seconds);
        const totalMs = Math.round(safe * 1000);
        const hours = Math.floor(totalMs / 3600000);
        const minutes = Math.floor((totalMs % 3600000) / 60000);
        const secs = Math.floor((totalMs % 60000) / 1000);
        const ms = totalMs % 1000;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    return segments
        .map((segment, index) =>
            `${index + 1}\n${formatTimestamp(segment.start)} --> ${formatTimestamp(segment.end)}\n${segment.text}`)
        .join('\n\n');
};

const extensionFromObjectName = (objectName: string) => {
    const extension = path.extname(objectName).toLowerCase();
    return /^\.[a-z0-9]{1,5}$/.test(extension) ? extension : '.bin';
};

/**
 * 对一个本地媒体文件执行转写核心：ffmpeg 转 16kHz 单声道 WAV →
 * whisper.cpp 生成 SRT → 解析为分段数组。临时文件在结束时清理。
 * 与媒体下载解耦，便于本地排障时直接对文件调用同一段生产代码。
 */
export const transcribeLocalFile = async (
    sourcePath: string,
    language: string,
    onStage?: RunWhisperOptions['onStage'],
): Promise<AsrSegment[]> => {
    if (!env.asr.whisperBin || !env.asr.whisperModel) {
        throw new AsrNotConfiguredError('ASR 未配置：请设置 ASR_WHISPER_BIN 与 ASR_WHISPER_MODEL');
    }

    const workRoot = env.asr.workDir || os.tmpdir();
    const workDir = await fs.promises.mkdtemp(path.join(workRoot, 'duolinting-asr-'));
    try {
        onStage?.('converting', 15);
        const wavPath = path.join(workDir, 'audio-16k.wav');
        await convertTo16kMonoWav(sourcePath, wavPath);

        onStage?.('transcribing', 30);
        const srtPrefix = path.join(workDir, 'transcript');
        await runWhisperCli(wavPath, srtPrefix, language);

        onStage?.('parsing', 95);
        const srtPath = `${srtPrefix}.srt`;
        const srtContent = await fs.promises.readFile(srtPath, 'utf8');
        const segments = parseSrtContent(srtContent);
        if (segments.length === 0) {
            logger.warn(`[asr] whisper produced no usable segments source=${path.basename(sourcePath)} language=${language}`);
        }
        return segments;
    } finally {
        // 识别音频只在本地临时目录短暂存在，任务结束（含失败）立即删除。
        fs.rm(workDir, { recursive: true, force: true }, () => undefined);
    }
};

/**
 * 执行一次完整的本地识别：MinIO 下载 → transcribeLocalFile 转写核心。
 * 音频不落第三方服务，只在部署本机处理。
 */
export const runWhisperTranscription = async ({
    objectName,
    language,
    onStage,
}: RunWhisperOptions): Promise<AsrSegment[]> => {
    onStage?.('downloading', 5);
    const workRoot = env.asr.workDir || os.tmpdir();
    const downloadDir = await fs.promises.mkdtemp(path.join(workRoot, 'duolinting-asr-dl-'));
    try {
        const sourcePath = path.join(downloadDir, `source${extensionFromObjectName(objectName)}`);
        const media = await getMediaObject(objectName);
        await pipeline(media.stream, createWriteStream(sourcePath));

        return await transcribeLocalFile(sourcePath, language, onStage);
    } finally {
        fs.rm(downloadDir, { recursive: true, force: true }, () => undefined);
    }
};
