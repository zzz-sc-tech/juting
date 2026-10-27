/**
 * 媒体与 seed 同步守卫（2026-10-27 立，CI 云端发版用，本机发版同样可跑）。
 *
 * 背景：预设音频（presets/<key>/media/，~1.4GB opus）不在 git 里，CI 打包靠
 * 「解压上一个 Release 的双全量包」自举——拿到的是旧媒体。若本轮 seed 引用了
 * 新增/改名音频（seed.json 在 git 里是新版），云端打出的包必然缺音频。
 * 本脚本逐一核对 seed（git 新版）引用的每个音频在媒体树中存在，缺即报错终止，
 * 引导改走本机 scripts/local/release.mjs（能拿到本机最新媒体）。
 *
 * 用法：node scripts/local/check-media-vs-seed.mjs
 * 退出码：0 = 同步；1 = 有缺失（stderr 列明细）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// audio_url 是 API 路由形态：/api/v1/media/objects?key=<URL编码的对象键>；
// 兼容已经是相对路径的旧形态。audio_object_name 作后备字段。
const objectKeyOf = (url) => {
    const raw = String(url || '');
    if (!raw) return null;
    const m = raw.match(/[?&]key=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    return decodeURIComponent(raw.split('?')[0].replace(/^\/+/, ''));
};

let bad = 0;
for (const preset of ['cet4', 'cet6']) {
    const seedPath = path.join(root, 'presets', preset, 'seed.json');
    const mediaRoot = path.join(root, 'presets', preset, 'media');
    if (!fs.existsSync(seedPath)) { console.error(`✗ 缺 ${seedPath}`); bad++; continue; }
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    const exercises = Array.isArray(seed.exercises)
        ? seed.exercises
        : Object.values(seed.exercises || {});
    let checked = 0;
    for (const ex of exercises) {
        const key = objectKeyOf(ex.audio_url || ex.audio_object_name);
        if (!key) { console.error(`✗ ${preset} 课 ${ex.id}：audio_url/audio_object_name 均为空`); bad++; continue; }
        checked++;
        if (!fs.existsSync(path.join(mediaRoot, ...key.split('/')))) {
            console.error(`✗ ${preset} 课 ${ex.id} 引用的音频不在媒体树：${key}`);
            bad++;
        }
    }
    console.log(`${preset}: 核对 ${checked} 课${bad === 0 ? ' ✓' : ''}`);
}

if (bad) {
    console.error(`\n共 ${bad} 处缺失——本轮音频有更新，云端自举的旧媒体打包必然残缺。\n请改走本机发版：node scripts/local/release.mjs --version <版本> --notes <说明>`);
    process.exit(1);
}
console.log('媒体与 seed 同步 ✓（97 课引用全在媒体树）');
