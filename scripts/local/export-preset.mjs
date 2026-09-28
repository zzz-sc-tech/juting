/**
 * 预设课程导出器：把当前数据库里的一组课程（默认六级真题）导出成
 * 「种子 JSON + 媒体文件目录」，供 import-preset.mjs 在全新安装时一键还原。
 *
 * 产物（写入 presets/<preset>/）：
 *   - seed.json   课程结构化数据：分组、分类、课程（含 transcript_json 句级原文与锚点）
 *   - media/      课程引用的全部媒体对象，按 media-store 内的相对对象名原样落位
 *
 * seed.json 字段说明：
 *   preset        预设标识（目录名，同时是导入标记表的 key）
 *   version       种子版本号（默认 日期.N；内容有实质变化时用 --version 递增，
 *                 导入端只在版本号不同或首次导入时执行写入）
 *   group         category_groups 一行（保留原 id，导入时按 id upsert）
 *   categories    categories 若干行（保留原 id，group_id 在导入时重写为 group.id）
 *   exercises     exercises 若干行（保留原 id；created_at/updated_at 不导出，
 *                 由导入时刻生成；transcript_json / localizations_json 保持对象形态）
 *
 * 媒体落位规则：audio_object_name 与 cover_image_url 中的托管对象名会被收集，
 * 从 MEDIA_LOCAL_DIR 指向的 media-store 复制（优先硬链接，失败降级复制）到
 * presets/<preset>/media/<对象名>，并生成 <对象名>.dlt-meta.json 内容类型旁车文件。
 *
 * 用法：node scripts/local/export-preset.mjs [--env-file backend/.env] [--preset cet6]
 *       [--group-id 8] [--version 20260928.1]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 参数解析 ────────────────────────────────────────────────
const argOf = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};
const envFileArg = argOf('--env-file');
const envFile = envFileArg
    ? path.resolve(repositoryRoot, envFileArg)
    : [path.join(repositoryRoot, 'backend', '.env'), path.join(repositoryRoot, '.env')]
        .find((candidate) => fs.existsSync(candidate));
if (!envFile) {
    throw new Error('找不到 backend/.env 或根目录 .env，无法确定数据库与媒体目录配置。');
}
const presetKey = argOf('--preset') || 'cet6';
const groupId = Number(argOf('--group-id') || '8');
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const seedVersion = argOf('--version') || `${today}.1`;

// ── 环境解析（与 migrate-local.mjs 同一套约定）──────────────
const fileEnvironment = {};
dotenv.config({ path: envFile, processEnv: fileEnvironment, quiet: true });
const environment = { ...fileEnvironment, ...process.env };
const dbHost = (environment.MYSQL_HOST || '127.0.0.1').trim();
const dbPort = Number(environment.MYSQL_PORT || '3306');
const database = (environment.MYSQL_DATABASE || 'duolinting_app_dev').trim();
const dbUser = (environment.MYSQL_USER || environment.MYSQL_USERNAME || 'root').trim();
const dbPassword = environment.MYSQL_PASSWORD || '';
if (!['127.0.0.1', 'localhost', '::1'].includes(dbHost)) {
    throw new Error(`拒绝连接非本机数据库主机 ${dbHost}`);
}
const mediaRoot = environment.MEDIA_LOCAL_DIR
    ? path.resolve(environment.MEDIA_LOCAL_DIR)
    : path.join(repositoryRoot, 'temp', 'runtime', 'media-store');
// 本地存储模式沿用 MinIO 的桶目录结构：实际文件在 <MEDIA_LOCAL_DIR>/<桶>/<对象名>。
const mediaBucket = (environment.MINIO_BUCKET || 'duolinting-media').trim();
const mediaObjectPath = (objectName) => path.join(mediaRoot, mediaBucket, objectName);

// ── 读取课程数据 ────────────────────────────────────────────
const connection = await mysql.createConnection({
    host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database,
});

// 注意：source_url 列只存在于 categories / exercises，category_groups 没有。
const [groups] = await connection.query(
    'select id, name, description, accent, cover_image_url, sort_order from category_groups where id = ?',
    [groupId],
);
if (groups.length === 0) {
    throw new Error(`分组 id=${groupId} 不存在。`);
}

const [categories] = await connection.query(
    'select id, name, description, accent, cover_image_url, source_url, sort_order from categories where group_id = ? order by id',
    [groupId],
);
if (categories.length === 0) {
    throw new Error(`分组 id=${groupId} 下没有任何分类。`);
}
const categoryIds = categories.map((row) => row.id);

const [exercises] = await connection.query(
    `select id, category_id, title, source, source_url, difficulty, duration_label, media_type,
            audio_object_name, audio_url, cover_image_url, summary, localizations_json,
            transcript_json, status, claim_blocked, sort_order
       from exercises
      where category_id in (?) and status = 'published'
      order by sort_order, id`,
    [categoryIds],
);
if (exercises.length === 0) {
    throw new Error('所选分类下没有已发布课程，无可导出内容。');
}

// 新版 mysql2 的 query() 会把 JSON 列自动解析成对象，旧版返回字符串，两者都兼容。
const parseJsonColumn = (value) => {
    if (typeof value !== 'string') return value ?? null;
    return value ? JSON.parse(value) : null;
};
for (const row of exercises) {
    row.transcript_json = parseJsonColumn(row.transcript_json);
    row.localizations_json = parseJsonColumn(row.localizations_json);
}

// ── 收集需要随包分发的媒体对象名 ────────────────────────────
// 托管媒体的 URL 形如 /api/v1/media/objects?key=<urlencoded 对象名>；
// 这里用与后端一致的「取 key 参数」方式还原对象名，外链原样忽略。
const objectNameFromStoredUrl = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    const match = raw.match(/\/api\/v1\/media\/objects\?key=([^&]+)/);
    if (!match) return '';
    try {
        return decodeURIComponent(match[1]);
    } catch {
        return '';
    }
};
const objectNames = new Set();
for (const row of [groups[0], ...categories, ...exercises]) {
    for (const field of ['cover_image_url']) {
        const name = objectNameFromStoredUrl(row[field]);
        if (name) objectNames.add(name);
    }
}
for (const row of exercises) {
    if (row.audio_object_name) objectNames.add(row.audio_object_name);
    const fromUrl = objectNameFromStoredUrl(row.audio_url);
    if (fromUrl) objectNames.add(fromUrl);
}

// ── 媒体落位（硬链接优先，跨卷/权限失败降级复制）────────────
const presetDir = path.join(repositoryRoot, 'presets', presetKey);
const presetMediaDir = path.join(presetDir, 'media');
fs.mkdirSync(presetMediaDir, { recursive: true });
const placeMedia = (objectName) => {
    const source = mediaObjectPath(objectName);
    const target = path.join(presetMediaDir, objectName);
    if (!fs.existsSync(source)) {
        throw new Error(`media-store 缺少对象 ${objectName}（种子不完整）`);
    }
    if (fs.existsSync(target)) {
        return 'skip';
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
        fs.linkSync(source, target);
        return 'link';
    } catch {
        fs.copyFileSync(source, target);
        return 'copy';
    }
};
const placed = { link: 0, copy: 0, skip: 0 };
for (const objectName of objectNames) {
    placed[placeMedia(objectName)] += 1;
    // 内容类型旁车：照抄 media-store 里的源旁车（音频/封面各得其所），
    // 读端在每次播放 stat 时都会看它；源旁车缺失才回退通用音频类型。
    const sourceSidecar = `${mediaObjectPath(objectName)}.dlt-meta.json`;
    const sidecar = path.join(presetMediaDir, `${objectName}.dlt-meta.json`);
    if (!fs.existsSync(sidecar)) {
        fs.mkdirSync(path.dirname(sidecar), { recursive: true });
        if (fs.existsSync(sourceSidecar)) {
            fs.copyFileSync(sourceSidecar, sidecar);
        } else {
            fs.writeFileSync(sidecar, JSON.stringify({ contentType: 'audio/mpeg' }));
        }
    }
}

// ── 写 seed.json ───────────────────────────────────────────
// cover_image_url 保持库里的存储 URL 形态（/api/v1/media/objects?key=...），
// 与 audio_url 一致；后端只在 URL 形态下能识别托管媒体，裸对象名会导致封面 404。
const seed = {
    preset: presetKey,
    version: seedVersion,
    generatedAt: new Date().toISOString(),
    group: { ...groups[0] },
    categories: categories.map((row) => ({ ...row })),
    exercises,
};
fs.mkdirSync(presetDir, { recursive: true });
const seedPath = path.join(presetDir, 'seed.json');
fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 1)}\n`, 'utf8');

const mediaBytes = [...objectNames].reduce((total, name) => {
    try {
        return total + fs.statSync(path.join(presetMediaDir, name)).size;
    } catch {
        return total;
    }
}, 0);

await connection.end();

console.log(`[export] 预设 ${presetKey} 导出完成：`);
console.log(`  seed.json   ${seedPath}（${(fs.statSync(seedPath).size / 1024).toFixed(0)} KB）`);
console.log(`  分组/分类   ${groups[0].name} / ${categories.map((row) => row.name).join('、')}`);
console.log(`  课程        ${exercises.length} 门（仅 published）`);
console.log(`  媒体对象    ${objectNames.size} 个，共 ${(mediaBytes / 1024 / 1024).toFixed(0)} MB（硬链 ${placed.link} / 复制 ${placed.copy} / 已存在 ${placed.skip}）`);
console.log(`  版本号      ${seedVersion}（内容有变化时用 --version 递增）`);
