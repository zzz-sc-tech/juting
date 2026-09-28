/**
 * 直调 whisper 修复（绕过后端任务管线）：
 * 后端任务管线对课程 41/50 的音频会稳定挂死（三次复现，内存充裕非 OOM，
 * 疑为后端 ffmpeg/任务框架 bug），故用命令行直接复刻 whisper-runner 的参数：
 *   ffmpeg 转 16k 单声道 → whisper-cli(-t 8 -l auto -osrt) → 解析 SRT 为分段
 * 识别结果写入 media_asr_jobs（succeeded），随后 reconcile-transcript.mjs
 * 会像读正常缓存一样取用。
 *
 * 用法：node scripts/local/direct-whisper-repair.mjs --ids 41,50
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const idsIndex = process.argv.indexOf('--ids');
const IDS = idsIndex >= 0 ? process.argv[idsIndex + 1].split(',').map(Number).filter(Number.isInteger) : [];

const WHISPER = path.join(root, 'temp', 'asr', 'whisper-bin', 'Release', 'whisper-cli.exe');
const MODEL = path.join(root, 'temp', 'asr', 'ggml-small-q5_1.bin');
const FFMPEG = 'ffmpeg';
const WORK = path.join(root, 'temp', 'direct-asr');
fs.mkdirSync(WORK, { recursive: true });

const fileEnvironment = {};
dotenv.config({ path: path.join(root, 'temp', 'runtime', 'portable.env'), processEnv: fileEnvironment, quiet: true });
const env = { ...fileEnvironment, ...process.env };

const c = await mysql.createConnection({
    host: (env.MYSQL_HOST || '127.0.0.1').trim(),
    port: Number(env.MYSQL_PORT || '3306'),
    user: (env.MYSQL_USER || env.MYSQL_USERNAME || 'root').trim(),
    password: env.MYSQL_PASSWORD || '',
    database: (env.MYSQL_DATABASE || 'duolinting_app_dev').trim(),
});

/** SRT 时间戳 00:01:02,345 → 秒 */
const srtTime = (stamp) => {
    const [hms, ms] = stamp.split(',');
    const [h, m, s] = hms.split(':').map(Number);
    return h * 3600 + m * 60 + s + Number(ms) / 1000;
};
const parseSrt = (content) => {
    const segments = [];
    for (const block of content.replace(/\r\n/g, '\n').split('\n\n')) {
        const lines = block.split('\n').filter(Boolean);
        if (lines.length < 2) continue;
        const timeLine = lines.find((l) => l.includes('-->'));
        if (!timeLine) continue;
        const [from, to] = timeLine.split('-->').map((x) => srtTime(x.trim()));
        const text = lines.filter((l) => l !== timeLine && !/^\d+$/.test(l.trim())).join(' ').trim();
        if (text && Number.isFinite(from) && Number.isFinite(to)) {
            segments.push({ start: from, end: to, text });
        }
    }
    return segments;
};

for (const id of IDS) {
    const [rows] = await c.query('select audio_object_name, title from exercises where id = ?', [id]);
    const objectName = rows[0].audio_object_name;
    console.log(`[${id}] ${rows[0].title}`);
    const mp3 = path.join(root, 'temp', 'runtime', 'media-store', env.MINIO_BUCKET ?? 'duolinting-media', objectName);
    const wav = path.join(WORK, `course-${id}-16k.wav`);
    const srtPrefix = path.join(WORK, `course-${id}`);

    console.log('  ffmpeg 转 16k...');
    execFileSync(FFMPEG, ['-y', '-i', mp3, '-ar', '16000', '-ac', '1', wav], { stdio: 'ignore', timeout: 300000 });

    console.log('  whisper 识别中（约 4-6 分钟）...');
    execFileSync(WHISPER, [
        '-m', MODEL,
        '-f', wav,
        '-t', '8',
        '-l', 'auto',
        '-osrt', srtPrefix,
    ], { stdio: 'ignore', timeout: 1200000 });

    const srt = fs.readFileSync(`${srtPrefix}.srt`, 'utf8');
    const segments = parseSrt(srt);
    console.log(`  识别完成：${segments.length} 段`);
    if (segments.length === 0) {
        console.log('  ✗ 无分段，跳过');
        continue;
    }

    // 写入 ASR 缓存（与后端成功的任务同形态），reconcile 即可正常取用
    const [mediaRow] = await c.query('select media_size_bytes from media_asr_jobs where object_name = ? limit 1', [objectName]);
    const size = mediaRow.length > 0 ? mediaRow[0].media_size_bytes : fs.statSync(mp3).size;
    await c.query(
        `insert into media_asr_jobs (bucket, object_name, media_etag, media_size_bytes, model_name, language, status, progress, result_json, segment_count, duration_ms)
         values (?, ?, 'manual-direct', ?, 'ggml-small-q5_1', 'auto', 'succeeded', 100, ?, ?, 0)
         on duplicate key update result_json = values(result_json), segment_count = values(segment_count), status = 'succeeded'`,
        ['duolinting-media', objectName, size, JSON.stringify(segments), segments.length],
    );
    console.log(`  ✓ 已写入缓存（供 reconcile 使用）`);
}
await c.end();
console.log('完成。下一步：node scripts/local/reconcile-transcript.mjs --ids ' + IDS.join(','));
