/**
 * 预设课程导入器：把 presets/<preset>/seed.json + media/ 还原进当前数据库，
 * 供 start-all.mjs 在「全新安装」或「种子版本升级」时自动调用。
 *
 * 幂等规则：
 *   - 导入标记表 local_preset_imports(preset_key, seed_version, ...) 记录已导入版本；
 *   - 标记版本 == seed.json 版本 → 直接跳过（日常启动零开销，只读两行）；
 *   - 版本不同或首次 → 按显式 id upsert 分组/分类/课程（重跑与升级都安全），
 *     并把媒体对象硬链/复制进 media-store（已存在的对象跳过，不重复占盘）。
 *
 * 设计要点：
 *   - 课程行保留导出时的显式 id，MySQL 在显式插入更大 id 后会自动抬高
 *     AUTO_INCREMENT 计数器，因此不会与用户后续自建课程的主键冲突；
 *   - 媒体落位沿用本地对象存储的 <MEDIA_LOCAL_DIR>/<桶>/<对象名> 结构，
 *     优先硬链接（安装目录内同卷，零额外磁盘），失败降级复制；
 *     <对象名>.dlt-meta.json 内容类型旁车必须随媒体一起写，否则播放接口
 *     会回退 application/octet-stream；
 *   - 简洁版没有 presets 目录时静默跳过，不影响空库启动。
 *
 * 用法：node scripts/local/import-preset.mjs [--env-file <file>] [--preset cet6]
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);
const mysql = require('mysql2/promise');

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── 参数与环境（与 migrate-local.mjs 同一套约定）────────────
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
const mediaBucket = (environment.MINIO_BUCKET || 'duolinting-media').trim();

// ── 种子文件 ───────────────────────────────────────────────
const presetDir = path.join(repositoryRoot, 'presets', presetKey);
const seedPath = path.join(presetDir, 'seed.json');
if (!fs.existsSync(seedPath)) {
    console.log(`[preset] 未发现预设 ${presetKey}（简洁版即正常状态），跳过导入。`);
    process.exit(0);
}
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

const connection = await mysql.createConnection({
    host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database, multipleStatements: false,
});

// ── 导入标记表（独立于 Flyway 历史表，属于本地预设机制自己的账本）──
await connection.query(`create table if not exists local_preset_imports (
  preset_key varchar(64) primary key,
  seed_version varchar(32) not null,
  courses int not null default 0,
  imported_at timestamp not null default current_timestamp,
  updated_at timestamp not null default current_timestamp on update current_timestamp
)`);
const [markers] = await connection.query(
    'select seed_version from local_preset_imports where preset_key = ?',
    [presetKey],
);
if (markers.length > 0 && markers[0].seed_version === seed.version) {
    console.log(`[preset] 预设 ${presetKey} 已是版本 ${seed.version}，无需导入。`);
    await connection.end();
    process.exit(0);
}

// ── 首次导入前的准备：预留预设 id 空间 + 冲突防护 ─────────────
// 简洁版用户在导入六级包之前往往已自建内容：迁移固定占用分组 id 1-7，
// 用户第一个分组必然拿到 id 8、第一个分类拿到 id 1——恰与预设的显式 id
// 相撞。因此在「还没有本预设的导入标记」时把三张表的自增起点抬到 100，
// 保证用户后续自建内容永远落在 100+，与预设 id（≤52）互不相扰。
// MySQL 语义：alter 的目标值低于现有 max(id) 时会被自动抬高，不会报错。
if (markers.length === 0) {
    for (const table of ['category_groups', 'categories', 'exercises']) {
        await connection.query(`alter table ${table} auto_increment = 100`);
    }
    // 防护历史遗留（预留机制引入前已自建内容的库）：预设 id 已被占用时
    // 静默 upsert 会改写用户数据，必须拒绝导入并明确告知。
    const exerciseIds = seed.exercises.map((row) => row.id);
    const [clashRows] = await connection.query(
        'select count(*) as total from exercises where id in (?)',
        [exerciseIds],
    );
    const [clashCategory] = await connection.query(
        'select count(*) as total from categories where id in (?)',
        [seed.categories.map((row) => row.id)],
    );
    if (clashRows[0].total > 0 || clashCategory[0].total > 0) {
        await connection.end();
        console.error(`[preset] ⚠ 检测到数据库中已有课程占用了预设 ${presetKey} 的课程编号，`);
        console.error('    为避免覆盖你自建的内容，已跳过导入。');
        console.error('    解决办法：在管理后台把自建课程导出备份，重置数据库后再导入本预设。');
        process.exit(1);
    }
}

// ── 课程数据 upsert（显式 id，按主键幂等）───────────────────
await connection.beginTransaction();
try {
    // 分组：category_groups 无 source_url 列，字段以 seed 为准。
    const g = seed.group;
    await connection.query(
        `insert into category_groups (id, name, description, accent, cover_image_url, sort_order)
         values (?, ?, ?, ?, ?, ?)
         on duplicate key update name = values(name), description = values(description),
           accent = values(accent), cover_image_url = values(cover_image_url), sort_order = values(sort_order)`,
        [g.id, g.name, g.description, g.accent, g.cover_image_url ?? null, g.sort_order ?? 0],
    );

    for (const cat of seed.categories) {
        await connection.query(
            `insert into categories (id, group_id, name, description, accent, cover_image_url, source_url, sort_order)
             values (?, ?, ?, ?, ?, ?, ?, ?)
             on duplicate key update group_id = values(group_id), name = values(name),
               description = values(description), accent = values(accent),
               cover_image_url = values(cover_image_url), source_url = values(source_url),
               sort_order = values(sort_order)`,
            [cat.id, g.id, cat.name, cat.description, cat.accent,
                cat.cover_image_url ?? null, cat.source_url ?? null, cat.sort_order ?? 0],
        );
    }

    for (const ex of seed.exercises) {
        // JSON 列以参数化字符串写入，避免预处理模式下对象序列化差异。
        const transcript = ex.transcript_json == null ? null : JSON.stringify(ex.transcript_json);
        const localizations = ex.localizations_json == null ? null : JSON.stringify(ex.localizations_json);
        await connection.query(
            `insert into exercises (id, category_id, title, source, source_url, difficulty, duration_label,
                media_type, audio_object_name, audio_url, cover_image_url, summary, localizations_json,
                transcript_json, status, claim_blocked, sort_order)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             on duplicate key update category_id = values(category_id), title = values(title),
               source = values(source), source_url = values(source_url), difficulty = values(difficulty),
               duration_label = values(duration_label), media_type = values(media_type),
               audio_object_name = values(audio_object_name), audio_url = values(audio_url),
               cover_image_url = values(cover_image_url), summary = values(summary),
               localizations_json = values(localizations_json), transcript_json = values(transcript_json),
               status = values(status), claim_blocked = values(claim_blocked), sort_order = values(sort_order)`,
            [ex.id, ex.category_id, ex.title, ex.source, ex.source_url ?? null, ex.difficulty,
                ex.duration_label, ex.media_type, ex.audio_object_name ?? null, ex.audio_url,
                ex.cover_image_url ?? null, ex.summary ?? '', localizations, transcript,
                ex.status, ex.claim_blocked ?? 0, ex.sort_order ?? 0],
        );
    }

    await connection.query(
        `insert into local_preset_imports (preset_key, seed_version, courses)
         values (?, ?, ?)
         on duplicate key update seed_version = values(seed_version), courses = values(courses)`,
        [presetKey, seed.version, seed.exercises.length],
    );
    await connection.commit();
} catch (error) {
    await connection.rollback();
    await connection.end();
    throw error;
}
await connection.end();

// ── 媒体落位（硬链优先、已存在跳过）────────────────────────
const presetMediaDir = path.join(presetDir, 'media');
const objectNames = new Set();
const safeDecode = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
for (const ex of seed.exercises) {
    if (ex.audio_object_name) objectNames.add(ex.audio_object_name);
    // 与导出端对称：audio_url 托管形态里同样携带对象名，两类来源都收集。
    const fromUrl = String(ex.audio_url ?? '').match(/\/api\/v1\/media\/objects\?key=([^&]+)/);
    if (fromUrl) objectNames.add(safeDecode(fromUrl[1]));
    for (const field of ['cover_image_url']) {
        const match = String(ex[field] ?? '').match(/\/api\/v1\/media\/objects\?key=([^&]+)/);
        if (match) objectNames.add(safeDecode(match[1]));
    }
}
let linked = 0;
let copied = 0;
let skipped = 0;
let missing = 0;
for (const objectName of objectNames) {
    const source = path.join(presetMediaDir, objectName);
    const target = path.join(mediaRoot, mediaBucket, objectName);
    const sidecarSource = `${source}.dlt-meta.json`;
    const sidecarTarget = `${target}.dlt-meta.json`;
    if (!fs.existsSync(source)) {
        missing += 1;
        continue;
    }
    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        try {
            fs.linkSync(source, target);
            linked += 1;
        } catch {
            fs.copyFileSync(source, target);
            copied += 1;
        }
    } else {
        skipped += 1;
    }
    // 内容类型旁车：读取端在每次播放 stat 时都会看它，缺失则回退 octet-stream。
    if (!fs.existsSync(sidecarTarget) && fs.existsSync(sidecarSource)) {
        fs.copyFileSync(sidecarSource, sidecarTarget);
    } else if (!fs.existsSync(sidecarTarget)) {
        fs.mkdirSync(path.dirname(sidecarTarget), { recursive: true });
        fs.writeFileSync(sidecarTarget, JSON.stringify({ contentType: 'audio/mpeg' }));
    }
}

console.log(`[preset] 预设 ${presetKey} 导入完成（版本 ${seed.version}）：`);
console.log(`  课程 ${seed.exercises.length} 门（分组「${seed.group.name}」）`);
if (objectNames.size === 0) {
    console.log('  媒体：种子未引用任何对象。');
} else {
    console.log(`  媒体 ${objectNames.size} 个：硬链 ${linked} / 复制 ${copied} / 已就位 ${skipped}` +
        (missing > 0 ? ` / ⚠ 缺失 ${missing}（对应课程将无法播放，请用完整版或六级媒体包补齐）` : ''));
}
