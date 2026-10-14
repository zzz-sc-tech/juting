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
 *     会回退 application/octet-stream（兜底内容类型按扩展名推导）；
 *   - 简洁版没有 presets 目录时静默跳过，不影响空库启动；
 *   - 换编码升级（.mp3/.m4a → .ogg）后自动清理旧文件：媒体是硬链接落位的，
 *     「presets 侧」与「媒体库侧」是同一份数据的两个目录项，必须两侧都删才
 *     真正释放磁盘（只删一侧释放 0 字节）。
 *
 * 用法：node scripts/local/import-preset.mjs [--env-file <file>] [--preset cet6]
 *   [--cleanup-only] [--cleanup-dry-run] [--presets-root <dir>]
 *
 * 清理开关（默认在「本次实际导入」后自动执行；版本快速跳过路径不执行）：
 *   --cleanup-only     跳过导入，只执行清理（不加 dry-run 时会实际删除文件）；
 *   --cleanup-dry-run  预演：只报告将删除什么、不实际删除（可单独使用，只读）；
 *   --presets-root     高级/测试：覆盖预设根目录（默认 <仓库>/presets），
 *                      便于对 temp/opus-presets/presets 等目录树做预演。
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
const cleanupDryRun = process.argv.includes('--cleanup-dry-run');
const cleanupOnly = process.argv.includes('--cleanup-only');
const presetsRootArg = argOf('--presets-root');
const presetsRoot = presetsRootArg
    ? path.resolve(repositoryRoot, presetsRootArg)
    : path.join(repositoryRoot, 'presets');

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
const presetDir = path.join(presetsRoot, presetKey);
const seedPath = path.join(presetDir, 'seed.json');
if (!fs.existsSync(seedPath)) {
    console.log(`[preset] 未发现预设 ${presetKey}（简洁版即正常状态）：${cleanupOnly ? '缺少 seed.json，无法执行清理。' : '跳过导入。'}`);
    process.exit(0);
}
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));

// ── 种子引用的媒体对象名（媒体落位与旧文件清理共用同一集合）──
// 收集规则与导出端对称：audio_object_name 直接收集；audio_url / cover_image_url
// 的托管形态里 key= 参数解析后收集（URL 解码）。对象名统一按「正斜杠 + 小写」
// 归一（Windows 文件系统不区分大小写），避免大小写/分隔符差异造成清理误判。
const presetMediaDir = path.join(presetDir, 'media');
const normalizeObjectName = (value) => String(value).split('\\').join('/').toLowerCase();
const safeDecode = (value) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};
const objectNames = new Set();      // 全部引用对象（音频 + 封面）
const audioObjectNames = new Set(); // 仅音频对象（清理时用于确定「音频前缀」与「当前编码」）
const collectFromUrl = (value, audioTarget) => {
    const match = String(value ?? '').match(/\/api\/v1\/media\/objects\?key=([^&]+)/);
    if (!match) return;
    const normalized = normalizeObjectName(safeDecode(match[1]));
    objectNames.add(normalized);
    if (audioTarget) audioTarget.add(normalized);
};
for (const ex of seed.exercises) {
    if (ex.audio_object_name) {
        const normalized = normalizeObjectName(ex.audio_object_name);
        objectNames.add(normalized);
        audioObjectNames.add(normalized);
    }
    // 与导出端对称：audio_url 托管形态里同样携带对象名，两类来源都收集。
    collectFromUrl(ex.audio_url, audioObjectNames);
    collectFromUrl(ex.cover_image_url, null);
}

// 内容类型兜底：旁车缺失时按扩展名推导（写死 audio/mpeg 会让 .m4a/.ogg
// 的播放端拿到错误类型）。
const CONTENT_TYPES_BY_EXTENSION = new Map([
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
    ['.ogg', 'audio/ogg'],
    ['.wav', 'audio/wav'],
]);
const contentTypeForObject = (objectName) =>
    CONTENT_TYPES_BY_EXTENSION.get(path.extname(objectName).toLowerCase()) ?? 'application/octet-stream';

const connection = await mysql.createConnection({
    host: dbHost, port: dbPort, user: dbUser, password: dbPassword, database, multipleStatements: false,
});

// ── 导入流程（--cleanup-only 时整段跳过，保持纯清理路径零写入）──
let importedNow = false;
if (!cleanupOnly) {
    // 导入标记表（独立于 Flyway 历史表，属于本地预设机制自己的账本）
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
    } else {
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
                const answerKey = ex.answer_key_json == null ? null : JSON.stringify(ex.answer_key_json);
                const questions = ex.questions_json == null ? null : JSON.stringify(ex.questions_json);
                await connection.query(
                    `insert into exercises (id, category_id, title, source, source_url, difficulty, duration_label,
                        media_type, audio_object_name, audio_url, cover_image_url, summary, localizations_json,
                        answer_key_json, questions_json, transcript_json, status, claim_blocked, sort_order)
                     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     on duplicate key update category_id = values(category_id), title = values(title),
                       source = values(source), source_url = values(source_url), difficulty = values(difficulty),
                       duration_label = values(duration_label), media_type = values(media_type),
                       audio_object_name = values(audio_object_name), audio_url = values(audio_url),
                       cover_image_url = values(cover_image_url), summary = values(summary),
                       localizations_json = values(localizations_json), answer_key_json = values(answer_key_json),
                       questions_json = values(questions_json),
                       transcript_json = values(transcript_json),
                       status = values(status), claim_blocked = values(claim_blocked), sort_order = values(sort_order)`,
                    [ex.id, ex.category_id, ex.title, ex.source, ex.source_url ?? null, ex.difficulty,
                        ex.duration_label, ex.media_type, ex.audio_object_name ?? null, ex.audio_url,
                        ex.cover_image_url ?? null, ex.summary ?? '', localizations, answerKey, questions, transcript,
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
            importedNow = true;
        } catch (error) {
            await connection.rollback();
            await connection.end();
            throw error;
        }
    }
}

// ── 媒体落位（硬链优先、已存在跳过）——仅本次实际导入时执行 ──
if (importedNow) {
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
        // 优先沿用源旁车；都没有时按扩展名推导（.mp3→audio/mpeg、.m4a→audio/mp4、
        // .ogg→audio/ogg、.wav→audio/wav，其余 octet-stream）。
        if (!fs.existsSync(sidecarTarget) && fs.existsSync(sidecarSource)) {
            fs.copyFileSync(sidecarSource, sidecarTarget);
        } else if (!fs.existsSync(sidecarTarget)) {
            fs.mkdirSync(path.dirname(sidecarTarget), { recursive: true });
            fs.writeFileSync(sidecarTarget, JSON.stringify({ contentType: contentTypeForObject(objectName) }));
        }
    }

    console.log(`[preset] 预设 ${presetKey} 导入完成（版本 ${seed.version}）：`);
    console.log(`  课程 ${seed.exercises.length} 门（分组「${seed.group.name}」）`);
    if (objectNames.size === 0) {
        console.log('  媒体：种子未引用任何对象。');
    } else {
        console.log(`  媒体 ${objectNames.size} 个：硬链 ${linked} / 复制 ${copied} / 已就位 ${skipped}` +
            (missing > 0 ? ` / ⚠ 缺失 ${missing}（对应课程将无法播放，请用完整版或对应媒体包补齐）` : ''));
    }
}

// ── 旧编码媒体清理 ──────────────────────────────────────────
// 背景：媒体落位用硬链接（fs.linkSync，降级复制）——同一份数据在「presets 侧」
// 与「媒体库侧」各有一个目录项，只删一侧释放 0 磁盘；换编码（.mp3/.m4a → .ogg）
// 后必须两侧一起清。清理只在「本次实际导入成功」后自动执行（版本快速跳过路径
// 不执行）；--cleanup-only / --cleanup-dry-run 可随时手动触发检查。
//
// 规则：
//   1. presets/<key>/media 下：不被当前种子引用的文件一律删除（含 .dlt-meta.json
//      旁车）—— 预设目录是随包分发的产品内容，seed.json 即权威；
//   2. 媒体库 <mediaRoot>/<bucket> 下：只考虑「本预设音频前缀内 + 不被当前种子
//      引用 + 扩展名与当前种子音频编码不同」的对象，且必须不被任何数据库行引用
//      （exercises.audio_object_name / audio_url / cover_image_url、categories 与
//      category_groups 的 cover_image_url、media_asr_jobs.object_name）—— 媒体库
//      与用户数据共享，数据库行是权威：宁可漏删，绝不误删用户的东西；
//   3. 删除媒体对象时同步删除其 .dlt-meta.json 旁车；
//   4. dryRun 只报告不删除；实际删除前再做一次「必须位于允许目录内」的防御检查。

const SIDECAR_SUFFIX = '.dlt-meta.json';

// 递归收集目录下的真实文件（不跟随符号链接；硬链接是普通文件，会被收集）。
const walkFilesRecursively = (rootDir) => {
    const files = [];
    const walk = (dir) => {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return; // 目录不可读：跳过（优雅降级）
        }
        for (const entry of entries) {
            const absolute = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(absolute);
            } else if (entry.isFile()) {
                files.push(absolute);
            }
        }
    };
    walk(rootDir);
    return files;
};

const relativePosix = (rootDir, absolute) => path.relative(rootDir, absolute).split(path.sep).join('/');

// 防御：确保待删除路径确实位于允许的根目录内（绝不越界删除）。
const isInsideDirectory = (rootDir, absolute) => {
    const relative = path.relative(rootDir, absolute);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

async function cleanupOldMedia({ connection: db, dryRun }) {
    const formatMb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const presetCandidates = []; // { absolute, rel, size }
    const storeCandidates = [];
    let presetSkippedReason = null;
    let storeSkippedReason = null;
    let storeBlockedByDb = 0;

    // ── 1. presets/<key>/media：不被当前种子引用的文件（含旁车）──
    if (!fs.existsSync(presetMediaDir)) {
        presetSkippedReason = '目录不存在';
    } else {
        for (const absolute of walkFilesRecursively(presetMediaDir)) {
            const rel = relativePosix(presetMediaDir, absolute);
            const relKey = rel.toLowerCase();
            const isSidecar = relKey.endsWith(SIDECAR_SUFFIX);
            const baseKey = isSidecar ? relKey.slice(0, -SIDECAR_SUFFIX.length) : relKey;
            // 保留判定：媒体文件本身被当前种子引用，或其旁车对应的媒体文件被引用。
            if (objectNames.has(relKey) || (isSidecar && objectNames.has(baseKey))) continue;
            let size = 0;
            try {
                size = fs.statSync(absolute).size;
            } catch {
                continue;
            }
            presetCandidates.push({ absolute, rel, size });
        }
    }

    // ── 2. 媒体库：本预设音频前缀内、旧编码、无数据库引用的对象 ──
    const storeBucketDir = path.join(mediaRoot, mediaBucket);
    // 音频前缀 = 当前种子全部音频对象所在目录的最长公共前缀（同预设新旧文件共享
    // 同一批目录；把清理范围压到「本预设的地盘」上，避免扫到无关对象）。
    const audioDirs = [...new Set([...audioObjectNames].map((name) => path.posix.dirname(name)))];
    const audioExtensions = new Set([...audioObjectNames].map((name) => path.posix.extname(name)));
    let audioPrefix = '';
    if (audioDirs.length > 0) {
        const segmentLists = audioDirs.map((dir) => (dir === '.' ? [] : dir.split('/').filter(Boolean)));
        let commonLength = segmentLists[0].length;
        for (const segments of segmentLists) {
            commonLength = Math.min(commonLength, segments.length);
            for (let i = 0; i < commonLength; i += 1) {
                if (segments[i] !== segmentLists[0][i]) {
                    commonLength = i;
                    break;
                }
            }
        }
        audioPrefix = segmentLists[0].slice(0, commonLength).join('/');
    }
    if (audioObjectNames.size === 0) {
        storeSkippedReason = '当前种子未引用音频对象';
    } else if (audioPrefix === '') {
        storeSkippedReason = '无法确定预设音频前缀（对象分散在多个根目录，保守跳过）';
    } else if (!fs.existsSync(storeBucketDir)) {
        storeSkippedReason = '媒体库目录不存在';
    } else {
        // 数据库引用集：这些对象一个都不能删。
        const referencedByDb = new Set();
        const addUrlReference = (value) => {
            const match = String(value ?? '').match(/\/api\/v1\/media\/objects\?key=([^&]+)/);
            if (match) referencedByDb.add(normalizeObjectName(safeDecode(match[1])));
        };
        const [exerciseRows] = await db.query(
            'select audio_object_name, audio_url, cover_image_url from exercises',
        );
        for (const row of exerciseRows) {
            if (row.audio_object_name) referencedByDb.add(normalizeObjectName(row.audio_object_name));
            addUrlReference(row.audio_url);
            addUrlReference(row.cover_image_url);
        }
        const [categoryRows] = await db.query('select cover_image_url from categories');
        for (const row of categoryRows) addUrlReference(row.cover_image_url);
        const [groupRows] = await db.query('select cover_image_url from category_groups');
        for (const row of groupRows) addUrlReference(row.cover_image_url);
        const [asrRows] = await db.query('select object_name from media_asr_jobs');
        for (const row of asrRows) {
            if (row.object_name) referencedByDb.add(normalizeObjectName(row.object_name));
        }

        const decided = new Set(); // 基文件名去重：旁车与其媒体文件成对处理
        for (const absolute of walkFilesRecursively(storeBucketDir)) {
            const rel = relativePosix(storeBucketDir, absolute);
            const relKey = rel.toLowerCase();
            const isSidecar = relKey.endsWith(SIDECAR_SUFFIX);
            const baseRel = isSidecar ? rel.slice(0, -SIDECAR_SUFFIX.length) : rel;
            const baseKey = baseRel.toLowerCase();
            if (!baseKey || decided.has(baseKey)) continue;
            decided.add(baseKey);
            if (objectNames.has(baseKey)) continue;                        // 当前种子引用 → 保留
            if (audioExtensions.has(path.posix.extname(baseKey))) continue; // 与当前编码相同 → 保留
            if (!(baseKey === audioPrefix || baseKey.startsWith(`${audioPrefix}/`))) continue; // 不在预设前缀内 → 保留
            if (referencedByDb.has(baseKey)) {                             // 被数据库行引用 → 保留
                storeBlockedByDb += 1;
                continue;
            }
            // 旧编码孤儿：基文件 + 旁车一起删除（基文件可能已不存在，旁车单独处理）。
            for (const candidate of [baseRel, `${baseRel}${SIDECAR_SUFFIX}`]) {
                const candidateAbsolute = path.join(storeBucketDir, candidate);
                if (!fs.existsSync(candidateAbsolute)) continue;
                let size = 0;
                try {
                    size = fs.statSync(candidateAbsolute).size;
                } catch {
                    continue;
                }
                storeCandidates.push({ absolute: candidateAbsolute, rel: candidate, size });
            }
        }
    }

    // ── 3. 合计实际释放（硬链接两侧都删才算真释放）──
    const presetKeys = new Set(presetCandidates.map((item) => item.rel.toLowerCase()));
    const storeKeys = new Set(storeCandidates.map((item) => item.rel.toLowerCase()));
    const unionKeys = new Set([...presetKeys, ...storeKeys]);
    let combinedFreedBytes = 0;
    for (const key of unionKeys) {
        const presetRemoved = presetKeys.has(key) || !fs.existsSync(path.join(presetMediaDir, key));
        const storeRemoved = storeKeys.has(key) || !fs.existsSync(path.join(storeBucketDir, key));
        if (!presetRemoved || !storeRemoved) continue;
        const entry = presetCandidates.find((item) => item.rel.toLowerCase() === key)
            ?? storeCandidates.find((item) => item.rel.toLowerCase() === key);
        combinedFreedBytes += entry?.size ?? 0;
    }

    // ── 4. 执行删除（dry-run 跳过；逐文件容错）──
    if (!dryRun) {
        const removeAll = (rootDir, candidates) => {
            for (const item of candidates) {
                if (!isInsideDirectory(rootDir, item.absolute)) {
                    item.failed = '路径越界，已拦截';
                    continue;
                }
                try {
                    fs.rmSync(item.absolute, { force: true });
                } catch (error) {
                    item.failed = error.message;
                }
            }
        };
        removeAll(presetMediaDir, presetCandidates);
        removeAll(storeBucketDir, storeCandidates);
    }
    const presetOk = presetCandidates.filter((item) => !item.failed);
    const storeOk = storeCandidates.filter((item) => !item.failed);
    const presetBytes = presetOk.reduce((sum, item) => sum + item.size, 0);
    const storeBytes = storeOk.reduce((sum, item) => sum + item.size, 0);
    const failed = [...presetCandidates, ...storeCandidates].filter((item) => item.failed);

    // ── 5. 汇总输出 ──
    if (dryRun) {
        console.log('[清理] 预演模式（--cleanup-dry-run）：只报告，不删除任何文件。');
    }
    const presetLabelRaw = path.relative(repositoryRoot, presetMediaDir);
    const presetLabel = presetLabelRaw && !presetLabelRaw.startsWith('..')
        ? presetLabelRaw.split(path.sep).join('/')
        : presetMediaDir;
    const printPhase = (title, skippedReason, candidates, okList, bytes) => {
        if (skippedReason) {
            console.log(`[清理] ${title}：跳过（${skippedReason}）。`);
            return;
        }
        if (candidates.length === 0) {
            console.log(`[清理] ${title}：无需删除（0 个文件）。`);
            return;
        }
        const verb = dryRun ? '将删除' : '删除';
        const freedWord = dryRun ? '预计释放' : '释放';
        const failedCount = candidates.length - okList.length;
        console.log(`[清理] ${title}：${verb} ${okList.length} 个文件，${freedWord} ${formatMb(bytes)}` +
            (dryRun ? '（预演，未实际删除）' : '') +
            (failedCount > 0 ? `（${failedCount} 个删除失败）` : ''));
        if (dryRun) {
            for (const item of candidates.slice(0, 10)) console.log(`         ${item.rel}`);
            if (candidates.length > 10) console.log(`         … 其余 ${candidates.length - 10} 个`);
        }
    };
    printPhase(`预设目录 ${presetLabel}`, presetSkippedReason, presetCandidates, presetOk, presetBytes);
    printPhase(`媒体库 ${mediaBucket}`, storeSkippedReason, storeCandidates, storeOk, storeBytes);
    if (storeBlockedByDb > 0) {
        console.log(`[清理] 媒体库另有 ${storeBlockedByDb} 个旧编码对象仍被数据库行引用，已保留（数据库引用优先）。`);
    }
    if (combinedFreedBytes > 0) {
        console.log(`[清理] 合计${dryRun ? '预计' : ''}释放约 ${formatMb(combinedFreedBytes)}` +
            '（预设媒体与媒体库为硬链接：两侧目录项都删除才真正释放磁盘）。');
    }
    if (failed.length > 0) {
        console.log(`[清理] ⚠ ${failed.length} 个文件删除失败：`);
        for (const item of failed.slice(0, 5)) console.log(`         ${item.rel}（${item.failed}）`);
        if (failed.length > 5) console.log(`         … 其余 ${failed.length - 5} 个`);
    }
    return {
        preset: { candidates: presetCandidates.length, deleted: presetOk.length, bytes: presetBytes },
        store: { candidates: storeCandidates.length, deleted: storeOk.length, bytes: storeBytes, blockedByDb: storeBlockedByDb },
        combinedFreedBytes,
        failures: failed.length,
    };
}

// ── 清理执行：导入成功后自动；显式旗标可随时触发 ──────────────
if (importedNow || cleanupOnly || cleanupDryRun) {
    await cleanupOldMedia({ connection, dryRun: cleanupDryRun });
}
await connection.end();
