import * as dotenv from 'dotenv';
import * as os from 'os';
import * as path from 'path';
import { getOsEnvOptional, normalizePort, toBool, toNumber } from './lib/env';

dotenv.config({
    path: path.join(
        process.cwd(),
        `.env${process.env.NODE_ENV === 'test' ? '.test' : ''}`,
    ),
});

const optional = (key: string, fallback: string) =>
    getOsEnvOptional(key) ?? fallback;
const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = optional(
    'SECRET_JWT',
    optional('AUTH_TOKEN_SECRET', 'dev-auth-token-secret'),
).trim();
const localUploadThrottleKbps = Number(
    getOsEnvOptional('LOCAL_UPLOAD_THROTTLE_KBPS') ?? '0',
);
const localUploadConfirmationDelayMs = Number(
    getOsEnvOptional('LOCAL_UPLOAD_CONFIRMATION_DELAY_MS') ?? '0',
);

// 媒体 CDN 地址可以带一个固定路径前缀（例如 https://learner.example.com/media）。
// 只接受无凭据、无 query/hash 的 HTTP(S) URL，避免把错误的 URL 配置写进课程响应。
const normalizeOptionalPublicUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
        return '';
    }

    const parsed = new URL(trimmed);
    if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
    ) {
        throw new Error(
            'MEDIA_PUBLIC_BASE_URL must be a plain HTTP(S) URL without credentials, query, or hash.',
        );
    }

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
};

// 这两个开关仅服务于本机开发时观察前端上传反馈。无效值与负数都回退为关闭，
// 路由层还会验证请求来自环回地址，避免 development 配置被远程访问时意外限速。
const toLocalUploadTestingNumber = (value: number) =>
    Number.isFinite(value) && value > 0 ? value : 0;

// 生产环境不能带着公开的开发密钥或空密钥启动，否则所有学习者 JWT 都失去可信根。
if (
    nodeEnv === 'production' &&
    (jwtSecret.length < 32 || jwtSecret === 'dev-auth-token-secret')
) {
    throw new Error(
        'SECRET_JWT must be a non-default secret of at least 32 characters in production.',
    );
}

export const env = {
    node: nodeEnv,
    isProduction: nodeEnv === 'production',
    isTest: nodeEnv === 'test',
    isDevelopment: nodeEnv === 'development',
    app: {
        name: optional('APP_NAME', '句听后端'),
        version: '0.1.0',
        description: '句听统一后端服务',
        host: optional('APP_HOST', '127.0.0.1'),
        schema: optional('APP_SCHEMA', 'http'),
        routePrefix: optional('APP_ROUTE_PREFIX', '/api'),
        port: normalizePort(process.env.PORT || optional('APP_PORT', '8100')),
        banner: toBool(optional('APP_BANNER', 'true')),
        env: optional('APP_ENV', 'development'),
        backend_url: optional('APP_BACKEND_URL', 'http://127.0.0.1:8100'),
    },
    trustProxy: toBool(optional('TRUST_PROXY', 'false')),
    cors: {
        origins: optional(
            'CORS_ORIGINS',
            'http://127.0.0.1:8101,http://localhost:8101,http://127.0.0.1:8102,http://localhost:8102',
        ),
    },
    log: {
        level: optional('LOG_LEVEL', 'info'),
        json: toBool(optional('LOG_JSON', 'false')),
        output: optional('LOG_OUTPUT', 'dev'),
    },
    monitor: {
        enabled: toBool(optional('MONITOR_ENABLED', 'false')),
        route: optional('MONITOR_ROUTE', '/status'),
        username: optional('MONITOR_USERNAME', 'admin'),
        password: optional('MONITOR_PASSWORD', 'admin'),
    },
    secret: {
        jwt: jwtSecret,
    },
    mysql: {
        host: optional('MYSQL_HOST', '127.0.0.1'),
        port: toNumber(optional('MYSQL_PORT', '3306')),
        database: optional('MYSQL_DATABASE', 'duolinting_app_dev'),
        username: optional('MYSQL_USERNAME', optional('MYSQL_USER', 'root')),
        password: getOsEnvOptional('MYSQL_PASSWORD') ?? '',
        logging: toBool(optional('MYSQL_LOGGING', 'false')),
    },
    minio: {
        endpoint: optional('MINIO_ENDPOINT', 'localhost'),
        port: toNumber(optional('MINIO_PORT', '9000')),
        useSSL: toBool(optional('MINIO_USE_SSL', 'false')),
        accessKey: optional('MINIO_ACCESS_KEY', 'minioadmin'),
        secretKey: optional('MINIO_SECRET_KEY', 'minioadmin'),
        bucket: optional('MINIO_BUCKET', 'duolinting-media'),
        region: optional('MINIO_REGION', 'us-east-1'),
    },
    media: {
        // 留空时保持历史 /api/v1/media/objects?key=... 路径；配置后课程 API
        // 返回 CDN 直连地址，媒体流不再经过 Express。
        publicBaseUrl: normalizeOptionalPublicUrl(
            optional('MEDIA_PUBLIC_BASE_URL', ''),
        ),
        // 存储后端：minio（默认，生产）或 local（单机免 MinIO，媒体落本地磁盘）。
        storage: optional('MEDIA_STORAGE', 'minio') === 'local' ? 'local' : 'minio',
        // local 模式的存储根目录。
        localDir: path.resolve(optional('MEDIA_LOCAL_DIR', path.join(process.cwd(), 'temp', 'media-store'))),
    },
    asr: {
        // 总开关：未配置 whisper 可执行文件与模型时保持 false，制课工作台显示未启用。
        // 启用需同时提供 ASR_WHISPER_BIN 与 ASR_WHISPER_MODEL，音频只在本地识别，不经任何第三方。
        enabled: toBool(optional('ASR_ENABLED', 'false')),
        // whisper.cpp 的命令行可执行文件（whisper-cli / main）绝对路径。
        whisperBin: optional('ASR_WHISPER_BIN', ''),
        // ggml 模型文件路径；推荐多语种 small 模型（中英混听的四六级音频够用，CPU 可跑）。
        whisperModel: optional('ASR_WHISPER_MODEL', ''),
        // 默认识别语言：auto 由 whisper 自行判断；四六级音频也可显式填 zh 或 en。
        language: optional('ASR_LANGUAGE', 'auto'),
        // whisper 初始提示词：传给 --prompt。whisper 的中文输出常是繁体，
        // 官方惯用法是给简体提示词把输出偏置成简体；留空则不传该参数。
        initialPrompt: optional('ASR_INITIAL_PROMPT', ''),
        // ffmpeg 用于把任意音频/视频统一转成 16kHz 单声道 WAV（whisper.cpp 要求的输入格式）。
        ffmpegBin: optional('ASR_FFMPEG_BIN', 'ffmpeg'),
        // whisper 线程数：显式配置优先；未配置时按物理核自动推导——whisper.cpp 自带的
        // 默认 4 线程偏保守，实测 8 核机器用满物理核最优、超过物理核反而回落（超线程争抢）。
        threads: (() => {
            const configured = optional('ASR_THREADS', '').trim();
            if (configured) {
                return Math.max(1, toNumber(configured));
            }
            const physicalCores = Math.max(2, Math.floor(os.cpus().length / 2));
            return Math.min(16, physicalCores);
        })(),
        // whisper 的 max-context（-mc N）。默认 -1 保持 whisper 自带行为（把前文当解码条件）。
        // 实测在长音频上保留前文会诱发「注入式幻觉」：凭空生成 "Conversation 12-However,…"、
        // "Questions 17. …" 之类的句子，并把同一段说明揉成 20～30 秒的巨段。
        // 英文考试音频建议设 0（每段独立解码）：幻觉消失，分段粒度也更贴近句子边界。
        maxContext: Math.max(-1, toNumber(optional('ASR_MAX_CONTEXT', '-1'))),
        // 同时运行的本地识别进程数；whisper 是 CPU 密集型，默认串行排队，保护制课机器。
        maxConcurrency: Math.max(1, toNumber(optional('ASR_MAX_CONCURRENCY', '1'))),
        // 单个待识别媒体的大小上限（MB），超过直接拒绝，避免无意中启动超长转写。
        maxMediaMb: Math.max(1, toNumber(optional('ASR_MAX_MEDIA_MB', '200'))),
        // 下载媒体与转换 WAV 的工作目录；默认用系统临时目录，任务结束即清理。
        workDir: optional('ASR_WORK_DIR', ''),
        // 模型下载源基址：默认走 hf-mirror（国内可达），可改回官方 huggingface.co。
        modelBaseUrl: optional('ASR_MODEL_BASE_URL', 'https://hf-mirror.com'),
        // whisper.cpp 预编译包下载地址（一键准备可执行文件时使用）。
        binaryUrl: optional(
            'ASR_BINARY_URL',
            'https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.6/whisper-bin-x64.zip',
        ),
    },
    resend: {
        API_KEY: getOsEnvOptional('RESEND_API_KEY') ?? '',
    },
    localUploadTesting: {
        // 以 KB/s 配置而不是 bytes，便于手动调节；生产环境始终强制为 0。
        throttleBytesPerSecond:
            nodeEnv === 'development'
                ? toLocalUploadTestingNumber(localUploadThrottleKbps) * 1024
                : 0,
        // 在服务端已经写入媒体后延迟响应，用于验证前端“等待服务器确认”状态。
        confirmationDelayMs:
            nodeEnv === 'development'
                ? toLocalUploadTestingNumber(localUploadConfirmationDelayMs)
                : 0,
    },
};
