import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env';
import type { AsrProviderStatus, AsrSegment, MediaAsrJob } from '../../domain';
import type { MediaAsrJobDb } from '../../models/schema/MediaAsrJobDB';
import { Logger } from '../../lib/logger';
import { MediaAsrJobModel } from '../../models/schema/MediaAsrJobDB';
import { statMediaObject } from './media-service';
import { runWhisperTranscription, segmentsToSrt } from './asr/whisper-runner';
import {
    detectHardwareProfile,
    recommendAsrPlan,
    type AsrHardwareProfile,
    type AsrRecommendation,
} from './asr/hardware-profile';

const logger = new Logger(__filename);

/**
 * 制课工作台的本地 ASR 任务编排：
 * - 缓存：media_asr_jobs 里同一 (bucket, objectName, etag, model, language) 的
 *   succeeded 行直接复用，「同一个音频只识别一次」由这一层保证。
 * - 队列：whisper 是 CPU 密集型本地进程，按 ASR_MAX_CONCURRENCY（默认 1）串行排队。
 *   队列只存在于当前后端进程内存中，重启后未跑完的任务通过 stale 检查（见下）兜底。
 * - 隐私：媒体只从 MinIO 下载到本机临时目录，交给本地 whisper 进程，结束后即删除。
 */

const LANGUAGE_PATTERN = /^(auto|[a-z]{2})$/i;

export const normalizeAsrLanguage = (value: string | undefined | null) => {
    const trimmed = String(value ?? '').trim().toLowerCase();
    if (!trimmed) {
        return env.asr.language.toLowerCase();
    }
    if (!LANGUAGE_PATTERN.test(trimmed)) {
        throw new Error('语言参数仅支持 whisper 语言代码（如 en、zh）或 auto');
    }
    return trimmed;
};

let providerStatusCache: AsrProviderStatus | null = null;

/** 制课界面据此展示「自动切分」是否可用；探测结果进程内缓存，避免频繁 stat 模型文件。 */
export const getAsrProviderStatus = (): AsrProviderStatus => {
    if (providerStatusCache) {
        return providerStatusCache;
    }

    const executable = env.asr.whisperBin.trim();
    const model = env.asr.whisperModel.trim();
    let configured = false;
    if (env.asr.enabled && executable && model) {
        try {
            // 只有本机确实装好了 whisper 与模型才宣称 configured；否则界面引导管理员完成部署。
            configured = fs.existsSync(executable) && fs.existsSync(model);
        } catch {
            configured = false;
        }
    }

    // 硬件探测会起子进程（nvidia-smi / ffmpeg -version），结果与状态一起缓存。
    const hardware = detectHardwareProfile();
    providerStatusCache = {
        configured,
        enabled: env.asr.enabled,
        executable: executable ? path.basename(executable) : '',
        model: model ? path.basename(model) : '',
        defaultLanguage: env.asr.language,
        maxConcurrency: env.asr.maxConcurrency,
        threads: env.asr.threads,
        hardware,
        recommendation: recommendAsrPlan(hardware),
    };
    return providerStatusCache;
};

/** 安装或配置变更后清空探测缓存：下一次查询重新读盘，界面立刻反映新状态。 */
export const invalidateAsrProviderStatus = () => {
    providerStatusCache = null;
};

export type { AsrHardwareProfile, AsrRecommendation };

/** 行 → API DTO；仅成功任务携带结果，避免把中间态的部分数据当真。 */
const toJobDto = (row: MediaAsrJobModel): MediaAsrJob => {
    // 注意：模型类声明了 public class 字段，会遮蔽 Sequelize 的属性 getter，
    // 直接 row.status 读到的是 undefined；必须取 plain 快照。
    const data = row.get({ plain: true }) as MediaAsrJobDb;
    let segments: AsrSegment[] | undefined;
    if (data.status === 'succeeded' && data.result_json) {
        try {
            const parsed = JSON.parse(data.result_json);
            if (Array.isArray(parsed)) {
                segments = parsed.filter(
                    (item): item is AsrSegment =>
                        typeof item?.start === 'number' &&
                        typeof item?.end === 'number' &&
                        typeof item?.text === 'string',
                );
            }
        } catch (error) {
            logger.error(`[asr] corrupted result json jobId=${data.id} message=${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return {
        id: Number(data.id),
        bucket: data.bucket,
        objectName: data.object_name,
        status: data.status,
        progress: data.progress,
        language: data.language,
        model: data.model_name,
        segmentCount: data.segment_count ?? undefined,
        srtText: data.status === 'succeeded' ? data.srt_text ?? undefined : undefined,
        segments,
        errorMessage: data.error_message ?? undefined,
        durationMs: data.duration_ms != null ? Number(data.duration_ms) : undefined,
        createdAt: data.created_at ? new Date(data.created_at).toISOString() : new Date().toISOString(),
        updatedAt: data.updated_at ? new Date(data.updated_at).toISOString() : new Date().toISOString(),
    };
};

// ── 进程内串行队列 ────────────────────────────────────────────────
let activeJobCount = 0;
const waitingJobs: Array<() => void> = [];

const acquireJobSlot = async () => {
    if (activeJobCount < env.asr.maxConcurrency) {
        activeJobCount += 1;
        return;
    }
    await new Promise<void>((resolve) => waitingJobs.push(resolve));
    activeJobCount += 1;
};

const releaseJobSlot = () => {
    activeJobCount -= 1;
    const next = waitingJobs.shift();
    if (next) {
        next();
    }
};

/**
 * 宕机兜底：进程重启会让内存队列消失，停留在 pending/running 的旧行永远不会再推进。
 * 这里把「长时间没有状态更新」的行判死，让下一次请求能创建新任务，而不是永远等它。
 */
const STALE_JOB_MS = 6 * 60 * 60 * 1000;
const isStaleJob = (row: MediaAsrJobModel) => {
    // class 字段遮蔽 getter，取 plain 快照（同 toJobDto）。
    const data = row.get({ plain: true }) as MediaAsrJobDb;
    // 缺失时间戳（理论上不会发生）按未卡死处理，交给人工排查而不是误判重启。
    if (!data.updated_at) {
        return false;
    }
    const updatedAt = new Date(data.updated_at).getTime();
    return Number.isFinite(updatedAt) && Date.now() - updatedAt > STALE_JOB_MS;
};

const executeJob = async (jobId: number) => {
    await acquireJobSlot();
    const startedAt = Date.now();
    try {
        const job = await MediaAsrJobModel.findByPk(jobId);
        if (!job) {
            return;
        }
        const jobData = job.get({ plain: true }) as MediaAsrJobDb;
        if (jobData.status !== 'pending') {
            return;
        }

        await job.update({ status: 'running', progress: 2 });
        logger.info(`[asr] job start jobId=${jobId} object=${jobData.object_name} model=${jobData.model_name} language=${jobData.language}`);

        const segments = await runWhisperTranscription({
            objectName: jobData.object_name,
            language: jobData.language,
            onStage: (_stage, progress) => {
                // 阶段进度只是界面参考，写失败不影响识别本身。
                void job.update({ progress }).catch(() => undefined);
            },
        });

        await job.update({
            status: 'succeeded',
            progress: 100,
            result_json: JSON.stringify(segments),
            srt_text: segmentsToSrt(segments),
            segment_count: segments.length,
            duration_ms: Date.now() - startedAt,
            error_message: null,
        });
        logger.info(`[asr] job done jobId=${jobId} segments=${segments.length} durationMs=${Date.now() - startedAt}`);
    } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
        logger.error(`[asr] job failed jobId=${jobId} message=${message}`);
        try {
            const job = await MediaAsrJobModel.findByPk(jobId);
            await job?.update({
                status: 'failed',
                duration_ms: Date.now() - startedAt,
                error_message: message,
            });
        } catch (updateError) {
            logger.error(`[asr] failed to persist failure jobId=${jobId} message=${updateError instanceof Error ? updateError.message : String(updateError)}`);
        }
    } finally {
        releaseJobSlot();
    }
};

export type StartAsrJobResult = {
    job: MediaAsrJob
    cacheHit: boolean
}

/**
 * 发起（或命中缓存）一次识别。媒体必须已存在于对象存储；
 * 识别在后台异步执行，客户端凭返回的任务 id 轮询 getAsrJob。
 */
export const startAsrJob = async ({
    bucket,
    objectName,
    language,
    requestedByAdminId,
}: {
    bucket: string
    objectName: string
    language: string
    requestedByAdminId: number
}): Promise<StartAsrJobResult> => {
    const provider = getAsrProviderStatus();
    if (!provider.configured) {
        throw new Error('自动切分未启用：请先在后端部署 whisper.cpp 并配置 ASR_ENABLED、ASR_WHISPER_BIN、ASR_WHISPER_MODEL');
    }

    const stat = await statMediaObject(objectName);
    const maxBytes = env.asr.maxMediaMb * 1024 * 1024;
    if (stat.size > maxBytes) {
        throw new Error(`媒体超过自动切分的大小上限（${env.asr.maxMediaMb}MB），请先拆分音频`);
    }

    const modelName = provider.model;
    const where = {
        bucket,
        object_name: objectName,
        model_name: modelName,
        language,
    };

    // 1) 已有成功结果且对象未变（etag 一致）→ 直接命中缓存。
    const cached = await MediaAsrJobModel.findOne({
        where: { ...where, status: 'succeeded' },
        order: [['id', 'DESC']],
    });
    if (cached) {
        // class 字段遮蔽 getter，etag 比较必须走 plain 快照。
        const cachedData = cached.get({ plain: true }) as MediaAsrJobDb;
        if (!cachedData.media_etag || !stat.etag || cachedData.media_etag === stat.etag) {
            return { job: toJobDto(cached), cacheHit: true };
        }
    }

    // 2) 已有进行中的同键任务 → 复用，避免重复排队；卡死行（超过 stale 窗口）除外。
    const inFlight = await MediaAsrJobModel.findOne({
        where: { ...where, status: 'pending' },
        order: [['id', 'DESC']],
    });
    const running = await MediaAsrJobModel.findOne({
        where: { ...where, status: 'running' },
        order: [['id', 'DESC']],
    });
    const reusable = [inFlight, running].find(
        (row): row is MediaAsrJobModel => Boolean(row) && !isStaleJob(row as MediaAsrJobModel),
    );
    if (reusable) {
        return { job: toJobDto(reusable), cacheHit: false };
    }

    // 3) 新建任务。失败的历史行不覆盖：留作排错记录，重跑生成新行。
    const created = await MediaAsrJobModel.create({
        bucket,
        object_name: objectName,
        media_etag: stat.etag || null,
        media_size_bytes: stat.size,
        model_name: modelName,
        language,
        status: 'pending',
        progress: 0,
        requested_by_admin_id: requestedByAdminId,
    });

    // create 返回的实例同样受 class 字段遮蔽影响，id 必须经 getter 读取。
    const jobId = Number(created.get('id'));
    logger.info(`[asr] job queued jobId=${jobId} object=${objectName} etag=${stat.etag || '-'} size=${stat.size}`);
    // 后台执行：请求立即返回 pending 任务，由客户端轮询。
    void executeJob(jobId).catch((error) => {
        logger.error(`[asr] job crashed jobId=${jobId} message=${error instanceof Error ? error.message : String(error)}`);
    });

    return { job: toJobDto(created), cacheHit: false };
};

export const getAsrJob = async (jobId: number): Promise<MediaAsrJob | null> => {
    const row = await MediaAsrJobModel.findByPk(jobId);
    return row ? toJobDto(row) : null;
};
