import express from 'express';
import { body } from 'express-validator';
import { requireAdminPasswordChanged, requireAdminToken, requireSuperAdmin } from '../../general/admin/admin-auth';
import { changeAdminPassword, getAdminInfo, loginAdmin, logoutAdmin } from '../../general/admin/admin-service';
import { canEditExerciseSubtitles, listExerciseSubtitleVersions } from '../../general/admin/collaboration-service';
import {
    deleteExercise,
    deleteCategory,
    deleteCategoryGroup,
    getExercise,
    listAllExercises,
    listAdminExercisesPage,
    listCatalog,
    replaceTranscriptLines,
    upsertCategory,
    upsertCategoryGroup,
    upsertExercise,
    updateExerciseMedia,
} from '../../general/catalog/catalog-service';
import {
    getAsrJob,
    getAsrProviderStatus,
    normalizeAsrLanguage,
    startAsrJob,
} from '../../general/media/asr-service';
import { getAsrInstallTask, startAsrInstall } from '../../general/media/asr/installer';
import { getManagedMediaObjectName } from '../../general/media/media-service';
import { env } from '../../env';
import { validateErrorCheck } from '../../lib/express-validator/express-validator-middleware';
import { doRawQuery } from '../../models';
import { authenticationRateLimitKeys, createRateLimit } from '../../lib/rate-limit';

// 单机版后台路由：认证、目录结构、课程管理（含直接发布/下架）、字幕与本地 ASR。
// 上游的多人协同端点（任务广场、字幕二审工作流、贡献者分工、协作动态与通知、
// 增长分析、反馈中心、开放内容 API Key）已随协同体系一并移除。

const router = express.Router();
const adminLoginRateLimit = createRateLimit({
    namespace: 'admin-login',
    windowMs: 15 * 60 * 1000,
    maxAttempts: 5,
    keys: authenticationRateLimitKeys('email'),
});

const isStoredAssetUrl = (value: unknown) => {
    if (typeof value !== 'string') {
        return false;
    }

    if (value.startsWith('/api/v1/media/objects')) {
        return true;
    }

    try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

// 来源链接指向外部公开页面，不能复用媒体地址校验：媒体字段允许站内对象 URL，
// 而这里必须是可被运营人员和学习者直接访问的 http(s) 页面。
const isExternalHttpUrl = (value: unknown) => {
    if (typeof value !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
};

// optional() 在清理空格之前判断空值；因此单独接受全空白输入，
// 服务层会把它规范化为 NULL，避免可选字段因误输空格而无法保存。
const isOptionalExternalHttpUrl = (value: unknown) =>
    typeof value === 'string' &&
    (!value.trim() || isExternalHttpUrl(value));
// Express 5 route params may be typed as string arrays for repeated parameters; IDs use the first value.
const toId = (value: string | string[]) => Number.parseInt(Array.isArray(value) ? value[0] : value, 10);

router.post(
    '/auth/login',
    adminLoginRateLimit,
    body('email').isString().trim().isLength({ min: 1, max: 255 }),
    body('password').isString().isLength({ min: 1 }),
    validateErrorCheck,
    async (req, res) => {
        const result = await loginAdmin(req.body);
        res.status(result.success ? 200 : 401).send(result);
    },
);

router.get('/auth/me', requireAdminToken, async (req, res) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
    const result = await getAdminInfo(token);
    res.status(result.success ? 200 : 401).send(result);
});

router.post('/auth/logout', requireAdminToken, async (req, res) => {
    await logoutAdmin((req as any).admin.id);
    res.status(200).send({ success: true, message: 'success' });
});

router.put(
    '/auth/password',
    requireAdminToken,
    body('currentPassword').isString().isLength({ min: 1, max: 200 }),
    body('newPassword').isString().isLength({ min: 8, max: 200 }),
    validateErrorCheck,
    async (req: any, res) => {
        const result = await changeAdminPassword({
            adminId: req.admin.id,
            currentPassword: req.body.currentPassword,
            newPassword: req.body.newPassword,
        });
        res.status(result.success ? 200 : 400).send(result);
    },
);

// 除了认证资料和改密接口外，所有后台能力都要求成员完成初始密码修改。
router.use(requireAdminToken, requireAdminPasswordChanged);

router.get('/catalog', async (_req: any, res) => {
    res.status(200).send(await listCatalog(true, true));
});

router.get('/exercises', async (req: any, res) => {
    const page = Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, Number.parseInt(String(req.query.pageSize ?? '20'), 10) || 20));
    const groupId = Number.parseInt(String(req.query.groupId ?? ''), 10);
    const categoryId = Number.parseInt(String(req.query.categoryId ?? ''), 10);
    const status = ['draft', 'proofread', 'published', 'archived'].includes(String(req.query.status))
        ? String(req.query.status) as 'draft' | 'proofread' | 'published' | 'archived'
        : undefined;
    const search = String(req.query.search ?? '').trim().slice(0, 200);
    if (req.query.page !== undefined || req.query.pageSize !== undefined) {
        return res.status(200).send(await listAdminExercisesPage({
            page,
            pageSize,
            ...(Number.isInteger(groupId) && groupId > 0 ? { groupId } : {}),
            ...(Number.isInteger(categoryId) && categoryId > 0 ? { categoryId } : {}),
            ...(status ? { status } : {}),
            ...(search ? { search } : {}),
        }));
    }
    res.status(200).send(await listAllExercises());
});

router.get('/exercises/:exerciseId', async (req: any, res) => {
    const exerciseId = toId(req.params.exerciseId);
    if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid exercise id' });
    }

    const exercise = await getExercise(exerciseId, true, undefined, [], req.admin);
    if (!exercise) {
        return res.status(404).send({ success: false, message: 'Exercise not found' });
    }

    res.status(200).send(exercise);
});

router.post(
    '/category-groups',
    requireSuperAdmin,
    body('id').optional().isInt({ min: 1 }),
    body('name').isString().isLength({ min: 1 }),
    body('description').optional().isString(),
    body('accent').isString().matches(/^#[0-9a-fA-F]{6}$/),
    body('coverImageUrl').optional({ values: 'falsy' }).custom(isStoredAssetUrl),
    body('sortOrder').isInt({ min: 0 }),
    validateErrorCheck,
    async (req, res) => {
        await upsertCategoryGroup(req.body);
        res.status(201).send({ ok: true });
    },
);

router.delete('/category-groups/:groupId', requireSuperAdmin, async (req, res) => {
    try {
        const groupId = toId(req.params.groupId);
        if (!Number.isInteger(groupId) || groupId <= 0) {
            return res.status(400).send({ ok: false, message: '无效的分类 ID' });
        }

        await deleteCategoryGroup(groupId);
        res.status(200).send({ ok: true });
    } catch (error) {
        res.status(409).send({
            ok: false,
            message: error instanceof Error ? error.message : '分类删除失败',
        });
    }
});

router.post(
    '/categories',
    requireSuperAdmin,
    body('id').optional().isInt({ min: 1 }),
    body('groupId').isInt({ min: 1 }),
    body('name').isString().isLength({ min: 1 }),
    body('description').optional().isString(),
    body('accent').isString().matches(/^#[0-9a-fA-F]{6}$/),
    body('coverImageUrl').optional({ values: 'falsy' }).custom(isStoredAssetUrl),
    body('sourceUrl')
        .optional({ values: 'falsy' })
        .isString()
        .trim()
        .isLength({ max: 2048 })
        .bail()
        .custom(isOptionalExternalHttpUrl)
        .withMessage('来源链接必须是有效的 http:// 或 https:// 地址'),
    body('sortOrder').isInt({ min: 0 }),
    validateErrorCheck,
    async (req, res) => {
        await upsertCategory(req.body);
        res.status(201).send({ ok: true });
    },
);

router.delete('/categories/:categoryId', requireSuperAdmin, async (req, res) => {
    try {
        const categoryId = toId(req.params.categoryId);
        if (!Number.isInteger(categoryId) || categoryId <= 0) {
            return res.status(400).send({ ok: false, message: '无效的系列 ID' });
        }

        await deleteCategory(categoryId);
        res.status(200).send({ ok: true });
    } catch (error) {
        res.status(409).send({
            ok: false,
            message: error instanceof Error ? error.message : '学习系列删除失败',
        });
    }
});

router.delete('/exercises/:exerciseId', requireSuperAdmin, async (req, res) => {
    try {
        const exerciseId = toId(req.params.exerciseId);
        if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
            return res.status(400).send({ ok: false, message: '无效的课程 ID' });
        }

        await deleteExercise(exerciseId);
        res.status(200).send({ ok: true });
    } catch (error) {
        res.status(409).send({
            ok: false,
            message: error instanceof Error ? error.message : '课程删除失败',
        });
    }
});

router.post(
    '/exercises',
    requireSuperAdmin,
    body('id').optional().isInt({ min: 1 }),
    body('categoryId').isInt({ min: 1 }),
    body('title').isString().isLength({ min: 1, max: 180 }),
    body('source').optional({ values: 'falsy' }).isString().isLength({ max: 180 }),
    body('difficulty').isIn(['beginner', 'intermediate', 'advanced']),
    // 上传媒体后可先保存课程；时长尚未解析完成时允许为空字符串，后续由媒体元数据补全。
    body('durationLabel').optional({ values: 'falsy' }).isString().isLength({ max: 32 }),
    body('mediaType').isIn(['audio', 'video']),
    body('audioUrl').custom(isStoredAssetUrl),
    body('coverImageUrl').optional({ values: 'falsy' }).custom(isStoredAssetUrl),
    body('sourceUrl')
        .optional({ values: 'falsy' })
        .isString()
        .trim()
        .isLength({ max: 2048 })
        .bail()
        .custom(isOptionalExternalHttpUrl)
        .withMessage('来源链接必须是有效的 http:// 或 https:// 地址'),
    body('summary').optional({ values: 'falsy' }).isString().isLength({ max: 2000 }),
    body('sortOrder').isInt({ min: 0 }),
    body('status').isIn(['draft', 'proofread', 'published', 'archived']),
    validateErrorCheck,
    async (req, res) => {
        // 单机版：发布/下架由超级管理员在课程管理里直接切换，
        // 不再经过上游的「校对提交 → 二次审核」工作流门禁。
        const id = await upsertExercise(req.body);
        res.status(201).send({ ok: true, id });
    },
);

router.put(
    '/exercises/:exerciseId/media',
    requireSuperAdmin,
    body('mediaType').isIn(['audio', 'video']),
    body('audioUrl').custom(isStoredAssetUrl),
    validateErrorCheck,
    async (req, res) => {
        const exerciseId = toId(req.params.exerciseId);
        if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
            return res.status(400).send({ ok: false, message: '无效的课程 ID' });
        }

        await updateExerciseMedia(exerciseId, req.body.mediaType, req.body.audioUrl);
        res.status(200).send({ ok: true, id: exerciseId });
    },
);

router.put('/exercises/:exerciseId/transcript', async (req: any, res) => {
    const exerciseId = toId(req.params.exerciseId);
    if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid exercise id' });
    }
    if (!(await canEditExerciseSubtitles(req.admin, exerciseId))) {
        return res.status(403).send({ success: false, message: 'This course is not assigned to you' });
    }

    const lines = req.body?.lines;
    if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).send({ success: false, message: 'Invalid transcript payload' });
    }

    // 显式校验每行：start/end 必须是有限数且 end > start（Number(...) 对 NaN 会放行），text 非空
    const invalidRange = lines.find((line) => {
        const start = Number(line.start);
        const end = Number(line.end);
        return !Number.isFinite(start)
            || !Number.isFinite(end)
            || end <= start
            || !String(line.text ?? '').trim();
    });
    if (invalidRange) {
        return res.status(400).send({ success: false, message: `Line ${invalidRange.id} must end after it starts and have non-empty text` });
    }

    try {
        // 单机版统一写课程正式字幕（上游贡献者的“个人工作稿”路径已移除）。
        await replaceTranscriptLines(exerciseId, lines);
        res.status(200).send({ ok: true });
    } catch (error) {
        // service 层在课程不存在（update 影响 0 行）时抛出「课程不存在」
        if (error instanceof Error && error.message === '课程不存在') {
            return res.status(404).send({ success: false, message: error.message });
        }
        throw error;
    }
});

// ── 自动切分（本地离线语音识别）────────────────────────────────
// 制课工作台在字幕导入抽屉里发起识别；音频只在后端本机经 whisper.cpp 转写，
// 结果（分段 + SRT）缓存在 media_asr_jobs，同一音频同一参数只识别一次。

/** 引擎状态：界面据此展示「自动切分」是否可用、本机硬件与推荐方案；不暴露绝对路径。 */
router.get('/asr/status', async (_req, res) => {
    res.status(200).send(getAsrProviderStatus());
});

/**
 * 一键准备本地识别资源：kind=model 下载 ggml 模型（按硬件推荐档位），
 * kind=binary 下载 whisper.cpp 预编译包并解压。完成后自动写入 .env。
 * 下载在后台进行，本接口立即返回任务句柄，界面轮询 asr/install/:taskId。
 */
router.post('/asr/install', requireSuperAdmin, async (req, res) => {
    const kind = req.body?.kind;
    if (kind !== 'model' && kind !== 'binary') {
        return res.status(400).send({ success: false, message: 'kind 仅支持 model 或 binary' });
    }
    const tier = req.body?.tier;
    if (tier !== undefined && !['base', 'small', 'medium'].includes(tier)) {
        return res.status(400).send({ success: false, message: 'tier 仅支持 base、small、medium' });
    }
    try {
        const task = startAsrInstall({ kind, tier, threads: getAsrProviderStatus().recommendation.threads });
        res.status(202).send(task);
    } catch (error) {
        res.status(409).send({
            success: false,
            message: error instanceof Error ? error.message : '安装任务启动失败',
        });
    }
});

/** 轮询一键准备进度。 */
router.get('/asr/install/:taskId', requireSuperAdmin, async (req, res) => {
    const task = getAsrInstallTask(String(req.params.taskId));
    if (!task) {
        return res.status(404).send({ success: false, message: '任务不存在' });
    }
    res.status(200).send(task);
});

/**
 * 为课程媒体发起一次识别。可用媒体来源二选一：
 * - 请求体 audioUrl：系统上传生成的媒体地址（换媒体后立即识别新音频）；
 * - 缺省时取课程当前绑定的媒体对象。
 * 权限与字幕编辑一致：超级管理员或被指派校对该课程的贡献者。
 */
router.post('/exercises/:exerciseId/asr-jobs', async (req: any, res) => {
    const exerciseId = toId(req.params.exerciseId);
    if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid exercise id' });
    }
    if (!(await canEditExerciseSubtitles(req.admin, exerciseId))) {
        return res.status(403).send({ success: false, message: 'This course is not assigned to you' });
    }

    try {
        const requestedUrl = typeof req.body?.audioUrl === 'string' ? req.body.audioUrl.trim() : '';
        let objectName = requestedUrl ? getManagedMediaObjectName(requestedUrl) : '';
        if (requestedUrl && !objectName) {
            return res.status(400).send({ success: false, message: '无法从该媒体地址解析系统对象，请使用后台上传的媒体' });
        }

        if (!objectName) {
            const rows = await doRawQuery<{ audio_object_name: string | null; audio_url: string | null }>({
                query: 'select audio_object_name, audio_url from exercises where id = ? limit 1',
                params: [exerciseId],
            });
            const row = rows[0];
            if (!row) {
                return res.status(404).send({ success: false, message: '课程不存在' });
            }
            objectName = (row.audio_object_name || getManagedMediaObjectName(row.audio_url ?? '')).trim();
        }

        if (!objectName) {
            return res.status(400).send({ success: false, message: '课程尚未绑定可识别的音频或视频文件' });
        }

        const language = normalizeAsrLanguage(req.body?.language);
        const result = await startAsrJob({
            bucket: env.minio.bucket,
            objectName,
            language,
            requestedByAdminId: req.admin.id,
        });
        res.status(202).send(result);
    } catch (error) {
        res.status(400).send({
            success: false,
            message: error instanceof Error ? error.message : '自动切分任务创建失败',
        });
    }
});

/** 轮询任务状态；任务 id 只会发放给已通过权限校验的发起方。 */
router.get('/asr-jobs/:jobId', async (req, res) => {
    const jobId = toId(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid job id' });
    }
    const job = await getAsrJob(jobId);
    if (!job) {
        return res.status(404).send({ success: false, message: '任务不存在' });
    }
    res.status(200).send(job);
});

/** 字幕版本历史，供制课工作台回溯每一版。 */
router.get('/exercises/:exerciseId/subtitle-versions', async (req: any, res) => {
    const exerciseId = toId(req.params.exerciseId);
    if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid exercise id' });
    }
    try {
        res.status(200).send({ items: await listExerciseSubtitleVersions(exerciseId) });
    } catch (error) {
        res.status(500).send({
            success: false,
            message: error instanceof Error ? error.message : '字幕版本历史加载失败',
        });
    }
});

export default router;
