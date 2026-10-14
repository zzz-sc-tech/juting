// scripts/local/prepare-opus-presets.mjs
// 通用版（替代 package-cet6-opus.mjs 的转码部分）：把 presets/<exam>/media 下的源音频
// （.mp3 / .m4a）转码为单声道 Opus（.ogg），输出可直接打包的 presets 树：
//   temp/opus-presets/presets/<exam>/
//     - seed.json        （audio_object_name / audio_url / source 改写为 .ogg）
//     - media/audio/<yyyy/mm/dd>/<name>.ogg 及其 <name>.ogg.dlt-meta.json
//     - manifest.json
//
// 用法：node scripts/local/prepare-opus-presets.mjs --preset cet6|cet4|all [--bitrate 32k] [--force]
//   --preset   默认 all
//   --bitrate  默认 32k；也读取环境变量 JUTING_OPUS_BITRATE（命令行优先）
//   --force    已存在的输出也重新转码；默认跳过已存在且大小 > 0 的输出（可续跑）
//
// 注意：只读取 presets/ 源目录，绝不修改；输出全部写在 temp/opus-presets/ 下。
// 可续跑：已存在的输出先校验（ffprobe + 与源时长对比），不合格自动重转；
// 中断留下的半截文件不会被误判为“已完成”。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const outputRoot = path.join(root, 'temp', 'opus-presets');
const EXAMS = ['cet6', 'cet4'];
const SOURCE_EXT_RE = /\.(mp3|m4a)$/i;

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const ffprobe = (file) => JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', file]));
const ffprobeDuration = (file) => { const probe = ffprobe(file); return Number(probe.format?.duration) || 0; };

// 读取输出文件并校验（opus / 单声道 / 时长 > 0）；不合格返回 null
const readValidOutput = (file) => {
    const probe = ffprobe(file);
    const stream = probe.streams?.[0] ?? {};
    if (stream.codec_name !== 'opus' || Number(stream.channels) !== 1 || !(Number(probe.format?.duration) > 0)) return null;
    return { probe, stream };
};
const probeOrThrow = (file, label) => {
    let result = null;
    try { result = readValidOutput(file); } catch (error) { throw new Error(`${label}：ffprobe 读取失败（${error.message}）`); }
    ensure(result, `${label}：输出校验失败（要求 opus / 单声道 / 时长 > 0）`);
    return result;
};

const parseCli = () => {
    const argv = process.argv.slice(2);
    let preset = 'all';
    let cliBitrate = null;
    let force = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const takeValue = () => { if (i + 1 >= argv.length) throw new Error(`参数 ${arg} 缺少取值`); i += 1; return argv[i]; };
        if (arg === '--preset') preset = takeValue();
        else if (arg.startsWith('--preset=')) preset = arg.slice('--preset='.length);
        else if (arg === '--bitrate') cliBitrate = takeValue();
        else if (arg.startsWith('--bitrate=')) cliBitrate = arg.slice('--bitrate='.length);
        else if (arg === '--force') force = true;
        else if (arg === '--help' || arg === '-h') { console.log('用法：node scripts/local/prepare-opus-presets.mjs --preset cet6|cet4|all [--bitrate 32k] [--force]'); process.exit(0); }
        else throw new Error(`未知参数：${arg}`);
    }
    if (preset !== 'all' && !EXAMS.includes(preset)) throw new Error(`--preset 必须是 cet6、cet4 或 all，收到：${preset}`);
    const bitrate = cliBitrate || process.env.JUTING_OPUS_BITRATE || '32k';
    if (!/^\d+(\.\d+)?[kKmM]?$/.test(bitrate)) throw new Error(`--bitrate 取值无效：${bitrate}`);
    return { selectedExams: preset === 'all' ? EXAMS : [preset], bitrate, force };
};

const prepareExam = ({ exam, bitrate, force }) => {
    const presetDir = path.join(root, 'presets', exam);
    const sourceMedia = path.join(presetDir, 'media');
    const seedPath = path.join(presetDir, 'seed.json');
    const outPreset = path.join(outputRoot, 'presets', exam);
    const outMedia = path.join(outPreset, 'media');

    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    ensure(Array.isArray(seed.exercises) && seed.exercises.length > 0, `${exam}：seed 缺少 exercises`);

    // 先整体校验每个课程都能解析到源文件，缺任何一个直接失败（避免转码到一半才报错）
    const problems = [];
    for (const exercise of seed.exercises) {
        const objectName = exercise.audio_object_name;
        if (typeof objectName !== 'string' || !SOURCE_EXT_RE.test(objectName)) {
            problems.push(`课程 ${exercise.id}：audio_object_name 不是 .mp3/.m4a（${objectName}）`);
            continue;
        }
        const source = path.join(sourceMedia, objectName);
        if (!fs.existsSync(source)) problems.push(`课程 ${exercise.id}：缺少源音频 presets/${exam}/media/${objectName}`);
    }
    if (problems.length > 0) {
        console.error(`[失败] ${exam} 有 ${problems.length} 个课程无法解析源文件：`);
        for (const problem of problems) console.error(`  - ${problem}`);
        throw new Error(`${exam} 源文件校验未通过（共 ${problems.length} 个问题）`);
    }

    fs.mkdirSync(outMedia, { recursive: true });

    console.log(`[开始] ${exam}：${seed.exercises.length} 门课程，输出 ${path.relative(root, outPreset)}`);
    const entries = [];
    const stats = { transcoded: 0, skipped: 0, healed: 0 };

    for (const [index, exercise] of seed.exercises.entries()) {
        const objectName = exercise.audio_object_name;
        const source = path.join(sourceMedia, objectName);
        const opusName = objectName.replace(SOURCE_EXT_RE, '.ogg');
        const target = path.join(outMedia, opusName);
        const label = `${exam} 课程 ${exercise.id}`;
        const counter = `${index + 1}/${seed.exercises.length}`;
        fs.mkdirSync(path.dirname(target), { recursive: true });

        let result = null;
        let action = 'transcode';
        if (!force && fs.existsSync(target) && fs.statSync(target).size > 0) {
            try {
                result = readValidOutput(target);
                // 与源时长对比：输出明显短于源 = 上次中断留下的半截文件 → 重转
                if (result) {
                    const sourceDuration = ffprobeDuration(source);
                    const outputDuration = Number(result.probe.format.duration);
                    if (sourceDuration > 0 && outputDuration < sourceDuration - Math.max(2, sourceDuration * 0.005)) result = null;
                }
            } catch { result = null; }
            action = result ? 'skip' : 'heal';
        }

        if (action === 'skip') {
            console.log(`[跳过] ${counter} ${exam} ${opusName}`);
            stats.skipped += 1;
        } else {
            const tag = action === 'heal' ? '重转' : '转码';
            console.log(`[${tag}] ${counter} ${exam} ${objectName}`);
            try {
                run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map_metadata', '-1', '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', bitrate, '-application', 'voip', target]);
            } catch (error) {
                try { fs.rmSync(target, { force: true }); } catch { /* 清理失败忽略 */ }
                throw new Error(`${label}：ffmpeg 转码失败\n${String(error.stderr || error.message).trim()}`);
            }
            result = probeOrThrow(target, label);
            if (action === 'heal') stats.healed += 1; else stats.transcoded += 1;
        }

        const { probe, stream } = result;
        fs.writeFileSync(`${target}.dlt-meta.json`, JSON.stringify({ contentType: 'audio/ogg' }, null, 2) + '\n');
        entries.push({
            id: exercise.id,
            title: exercise.title,
            sourceObjectName: objectName,
            objectName: opusName,
            size: fs.statSync(target).size,
            sha256: sha256(target),
            durationSec: Number(Number(probe.format.duration).toFixed(3)),
            codec: stream.codec_name,
            sampleRate: Number(stream.sample_rate),
            channels: Number(stream.channels),
            bitrate,
        });
    }

    const opusSeed = JSON.parse(JSON.stringify(seed));
    for (const exercise of opusSeed.exercises) {
        const entry = entries.find((item) => item.id === exercise.id);
        exercise.audio_object_name = entry.objectName;
        exercise.audio_url = `/api/v1/media/objects?key=${encodeURIComponent(entry.objectName)}`;
        exercise.source = String(exercise.source ?? '').replace(SOURCE_EXT_RE, '.ogg');
    }
    fs.writeFileSync(path.join(outPreset, 'seed.json'), JSON.stringify(opusSeed, null, 2) + '\n');

    const totalBytes = entries.reduce((sum, item) => sum + item.size, 0);
    const totalDurationSec = entries.reduce((sum, item) => sum + item.durationSec, 0);
    const sourceExts = [...new Set(entries.map((item) => path.extname(item.sourceObjectName).slice(1).toLowerCase()))].sort();
    const sourceGlob = sourceExts.length === 1 ? `*.${sourceExts[0]}` : `*.{${sourceExts.join(',')}}`;
    const manifest = {
        package: `juting-v${packageVersion}-${exam}-opus-pack`,
        format: 'ogg-opus',
        contentType: 'audio/ogg',
        bitrate,
        channels: 1,
        courses: entries.length,
        totalBytes,
        totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
        totalDurationSec: Number(totalDurationSec.toFixed(3)),
        source: `presets/${exam}/media/audio/${sourceGlob}`,
        originalPreserved: true,
        entries,
    };
    fs.writeFileSync(path.join(outPreset, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const summary = {
        exam,
        courses: entries.length,
        transcoded: stats.transcoded,
        skipped: stats.skipped,
        healed: stats.healed,
        totalBytes,
        totalMiB: manifest.totalMiB,
        totalDurationSec: manifest.totalDurationSec,
        durationHours: Number((totalDurationSec / 3600).toFixed(2)),
        outDir: path.relative(root, outPreset),
    };
    console.log(`[完成] ${exam}：${entries.length} 门课程，转码 ${stats.transcoded} / 跳过 ${stats.skipped} / 修复 ${stats.healed}，${manifest.totalMiB} MiB，${summary.durationHours} 小时`);
    return summary;
};

const main = () => {
    const { selectedExams, bitrate, force } = parseCli();
    console.log(`[准备] 输出根目录 ${path.relative(root, outputRoot)}，bitrate=${bitrate}，preset=${selectedExams.join(',')}，force=${force}`);
    const results = [];
    for (const exam of selectedExams) results.push(prepareExam({ exam, bitrate, force }));
    const totalBytes = results.reduce((sum, item) => sum + item.totalBytes, 0);
    const totalDurationSec = results.reduce((sum, item) => sum + item.totalDurationSec, 0);
    console.log(JSON.stringify({
        exams: results,
        totalBytes,
        totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
        totalDurationSec: Number(totalDurationSec.toFixed(3)),
        durationHours: Number((totalDurationSec / 3600).toFixed(2)),
    }, null, 2));
};

try { main(); } catch (error) { console.error(`[错误] ${error.stack || error.message}`); process.exitCode = 1; }
