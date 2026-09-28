import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { env } from '../../../env';

/**
 * 本地 ASR 的硬件探测与方案推荐。
 *
 * 目的：新用户不必读安装文档、也不必手工试出线程数——打开制课台就能看到
 * 「你的机器适合哪套方案」，并据此一键准备。
 *
 * 说明：这里只做「探测 + 给建议」，不改运行参数。真正生效的参数仍由 .env 决定
 * （ASR_THREADS / ASR_WHISPER_MODEL），安装器会在用户点「一键准备」后代为写入。
 */

export type AsrModelTier = 'base' | 'small' | 'medium';

export type AsrGpuVendor = 'nvidia' | 'amd' | 'intel' | 'none';

export type AsrHardwareProfile = {
    platform: string;
    arch: string;
    cpuModel: string;
    cpuCores: number;
    totalMemoryGb: number;
    gpuVendor: AsrGpuVendor;
    gpuName: string;
    /** ffmpeg 是否可用（whisper 需要它把任意音频转成 16k 单声道 wav）。 */
    ffmpegAvailable: boolean;
    /** 当前 .env 指向的可执行文件/模型是否真的在磁盘上。 */
    install: {
        binaryConfigured: boolean;
        binaryFound: boolean;
        binaryPath: string;
        modelConfigured: boolean;
        modelFound: boolean;
        modelPath: string;
    };
};

/** 推荐方案：给出线程数、模型档位与理由（理由用 i18n key，界面自行翻译）。 */
export type AsrRecommendation = {
    threads: number;
    modelTier: AsrModelTier;
    modelFileName: string;
    /** 该模型的大致体积（MB），用于在按钮上提示下载量。 */
    estimatedDownloadMb: number;
    reasonCodes: string[];
    gpuAdviceCode: string;
};

/** 可下载的模型清单。体积为实测近似值，仅用于界面提示。 */
export const ASR_MODEL_CATALOG: Record<AsrModelTier, { fileName: string; sizeMb: number }> = {
    base: { fileName: 'ggml-base-q5_1.bin', sizeMb: 57 },
    small: { fileName: 'ggml-small-q5_1.bin', sizeMb: 181 },
    medium: { fileName: 'ggml-medium-q5_0.bin', sizeMb: 514 },
};

const toGb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;

const readCpuModel = () => {
    const cpus = os.cpus();
    return cpus[0]?.model?.trim() ?? '';
};

/**
 * 探测显卡。只认能实际加速 whisper.cpp 的厂商：
 * - NVIDIA：CUDA 版是官方主力预编译产物，收益明确；
 * - AMD/Intel：Vulkan 版存在但兼容性参差，仅作提示不建议自动切换。
 */
const detectGpu = (): { vendor: AsrGpuVendor; name: string } => {
    try {
        const out = execFileSync(
            'nvidia-smi',
            ['--query-gpu=name', '--format=csv,noheader'],
            { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        const first = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
        if (first) {
            return { vendor: 'nvidia', name: first };
        }
    } catch {
        // 没有 nvidia-smi：继续探测其它厂商
    }

    // Windows 下用 WMI 兜底识别集显/独显型号，仅用于提示，不参与自动决策。
    if (process.platform === 'win32') {
        try {
            const out = execFileSync(
                'powershell',
                ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController).Name'],
                { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] },
            );
            const names = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
            const nvidia = names.find((name) => /nvidia|geforce|rtx|gtx/i.test(name));
            if (nvidia) return { vendor: 'nvidia', name: nvidia };
            const amd = names.find((name) => /amd|radeon/i.test(name));
            if (amd) return { vendor: 'amd', name: amd };
            const intel = names.find((name) => /intel/i.test(name));
            if (intel) return { vendor: 'intel', name: intel };
        } catch {
            // 探测失败按无独显处理
        }
    }
    return { vendor: 'none', name: '' };
};

const fileExists = (target: string) => {
    if (!target) return false;
    try {
        return fs.existsSync(target);
    } catch {
        return false;
    }
};

const commandAvailable = (command: string) => {
    try {
        execFileSync(command, ['-version'], { timeout: 4000, stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
};

export const detectHardwareProfile = (): AsrHardwareProfile => {
    const cpus = os.cpus();
    const cpuCores = Math.max(1, cpus.length);
    const gpu = detectGpu();

    const binaryPath = env.asr.whisperBin.trim();
    const modelPath = env.asr.whisperModel.trim();

    return {
        platform: process.platform,
        arch: process.arch,
        cpuModel: readCpuModel(),
        cpuCores,
        totalMemoryGb: toGb(os.totalmem()),
        gpuVendor: gpu.vendor,
        gpuName: gpu.name,
        ffmpegAvailable: commandAvailable(env.asr.ffmpegBin),
        install: {
            binaryConfigured: Boolean(binaryPath),
            binaryFound: fileExists(binaryPath),
            binaryPath,
            modelConfigured: Boolean(modelPath),
            modelFound: fileExists(modelPath),
            modelPath,
        },
    };
};

/**
 * 推荐线程数：whisper.cpp 自带默认 4 线程偏保守，实测 8 核机器用满物理核最优、
 * 超过物理核反而回落（超线程争抢）。因此按物理核估算并封顶 16。
 */
export const recommendThreads = (cpuCores: number) => {
    const physical = Math.max(2, Math.floor(cpuCores / 2));
    return Math.min(16, physical);
};

/**
 * 推荐模型档位：
 * - 低核或小内存机器用 base（够用且跑得动）；
 * - 主流机器用 small-q5_1（本项目实测的性价比档，中英混听够准、CPU 可跑）；
 * - 高核大内存可选 medium，但只作为「可升级」提示，默认仍给 small。
 */
export const recommendAsrPlan = (profile: AsrHardwareProfile): AsrRecommendation => {
    const { cpuCores, totalMemoryGb, gpuVendor } = profile;
    const reasonCodes: string[] = [];

    let tier: AsrModelTier = 'small';
    if (cpuCores <= 4 || totalMemoryGb < 4) {
        tier = 'base';
        reasonCodes.push('asr.reason.lowSpec');
    } else {
        reasonCodes.push('asr.reason.mainstream');
    }
    if (cpuCores >= 12 && totalMemoryGb >= 16) {
        reasonCodes.push('asr.reason.canUpgradeMedium');
    }

    const threads = recommendThreads(cpuCores);
    reasonCodes.push('asr.reason.threadsFromCores');

    let gpuAdviceCode = 'asr.gpuAdvice.cpuOnly';
    if (gpuVendor === 'nvidia') {
        gpuAdviceCode = 'asr.gpuAdvice.nvidiaCuda';
    } else if (gpuVendor === 'amd' || gpuVendor === 'intel') {
        gpuAdviceCode = 'asr.gpuAdvice.igpuNotWorth';
    }

    const entry = ASR_MODEL_CATALOG[tier];
    return {
        threads,
        modelTier: tier,
        modelFileName: entry.fileName,
        estimatedDownloadMb: entry.sizeMb,
        reasonCodes,
        gpuAdviceCode,
    };
};

/** 模型下载完成后要落到的目录：与项目现有约定一致（temp/asr）。 */
export const asrAssetDir = () => {
    const workDir = env.asr.workDir.trim();
    return workDir || path.resolve(process.cwd(), 'temp', 'asr');
};
