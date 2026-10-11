import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const presetDir = path.join(root, 'presets', 'cet6');
const sourceMedia = path.join(presetDir, 'media');
const seedPath = path.join(presetDir, 'seed.json');
const releaseDir = path.join(root, '..', 'juting-release');
const stageRoot = path.join(root, '..', 'juting-opus-package');
const stagePreset = path.join(stageRoot, 'presets', 'cet6');
const stageMedia = path.join(stagePreset, 'media');
const outputName = `juting-v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}-cet6-opus-pack`;
const bitrate = process.env.JUTING_OPUS_BITRATE || '32k';

const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };
const ffprobe = (file) => JSON.parse(run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels,bit_rate', '-of', 'json', file]));
const sevenZip = (() => {
    const configured = process.env.JUTING_7Z;
    if (configured && fs.existsSync(configured)) return configured;
    return run('where.exe', ['7z']).trim().split(/\r?\n/)[0];
})();

fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageMedia, { recursive: true });
fs.mkdirSync(releaseDir, { recursive: true });

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
ensure(Array.isArray(seed.exercises) && seed.exercises.length === 38, 'seed 必须包含 38 门课程');
const entries = [];
const sourcePaths = [];

for (const exercise of seed.exercises) {
    const objectName = exercise.audio_object_name;
    ensure(typeof objectName === 'string' && objectName.endsWith('.mp3'), `课程 ${exercise.id} 缺少 MP3 audio_object_name`);
    const source = path.join(sourceMedia, objectName);
    ensure(fs.existsSync(source), `缺少源音频：${source}`);
    const opusName = objectName.replace(/\.mp3$/i, '.ogg');
    const target = path.join(stageMedia, opusName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    console.log(`[转码] ${exercise.id} ${objectName}`);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-map_metadata', '-1', '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', bitrate, '-application', 'voip', target]);
    const probe = ffprobe(target);
    const stream = probe.streams?.[0] ?? {};
    ensure(stream.codec_name === 'opus', `${exercise.id} 编码不是 opus`);
    ensure(Number(stream.channels) === 1, `${exercise.id} 不是单声道`);
    ensure(Number(probe.format?.duration) > 0, `${exercise.id} 时长无效`);
    const sidecar = `${target}.dlt-meta.json`;
    fs.writeFileSync(sidecar, JSON.stringify({ contentType: 'audio/ogg' }, null, 2) + '\n');
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
    sourcePaths.push(source);
}

const opusSeed = JSON.parse(JSON.stringify(seed));
for (const exercise of opusSeed.exercises) {
    const entry = entries.find((item) => item.id === exercise.id);
    exercise.audio_object_name = entry.objectName;
    exercise.audio_url = `/api/v1/media/objects?key=${encodeURIComponent(entry.objectName)}`;
    exercise.source = String(exercise.source ?? '').replace(/\.mp3$/i, '.ogg');
}
fs.writeFileSync(path.join(stagePreset, 'seed.json'), JSON.stringify(opusSeed, null, 2) + '\n');

const totalBytes = entries.reduce((sum, item) => sum + item.size, 0);
const totalDurationSec = entries.reduce((sum, item) => sum + item.durationSec, 0);
const manifest = {
    package: outputName,
    format: 'ogg-opus',
    contentType: 'audio/ogg',
    bitrate,
    channels: 1,
    courses: entries.length,
    totalBytes,
    totalMiB: Number((totalBytes / 1024 / 1024).toFixed(2)),
    totalDurationSec: Number(totalDurationSec.toFixed(3)),
    source: 'presets/cet6/media/audio/*.mp3',
    originalPreserved: true,
    entries,
};
fs.writeFileSync(path.join(stagePreset, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const archivePath = path.join(releaseDir, `${outputName}.7z`);
fs.rmSync(archivePath, { force: true });
console.log(`[打包] ${archivePath}`);
execSync(`"${sevenZip}" a -t7z -mx=7 -mmt=on "${archivePath}" "${path.join(stageRoot, 'presets')}" -y`, { stdio: 'inherit', timeout: 1800_000 });
const archiveHash = sha256(archivePath);
fs.writeFileSync(path.join(releaseDir, `${outputName}.manifest.json`), JSON.stringify({ ...manifest, archive: { file: path.basename(archivePath), bytes: fs.statSync(archivePath).size, sha256: archiveHash } }, null, 2) + '\n');
fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), `${archiveHash}  ${path.basename(archivePath)}\n`, 'utf8');
console.log(JSON.stringify({ archivePath, archiveBytes: fs.statSync(archivePath).size, archiveMiB: Number((fs.statSync(archivePath).size / 1024 / 1024).toFixed(2)), archiveHash, audioBytes: totalBytes, audioMiB: manifest.totalMiB, durationHours: Number((totalDurationSec / 3600).toFixed(2)), sourceCount: sourcePaths.length }, null, 2));
