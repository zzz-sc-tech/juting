import express from 'express';
import { getExercise, parseContentLocale } from '../../general/catalog/catalog-service';

// 单机版学习端免登录：不再解析学习者会话，也没有“预览志愿者”草稿可见逻辑。
const router = express.Router();
const toId = (value: string) => Number.parseInt(value, 10);

router.get('/:exerciseId', async (req: any, res) => {
    const exerciseId = toId(req.params.exerciseId);
    if (!Number.isInteger(exerciseId) || exerciseId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid exercise id' });
    }

    // 不带 contentLocale 就不传 locale（而不是兜底 en-US）：管理后台/导出
    // 需要完整的 translations 对象逐语种编辑，兜底默认值会让它被当成
    // 「学习者请求」而省掉该字段（C3）。学习者侧始终显式带 zh-CN。
    const exercise = await getExercise(
        exerciseId,
        false,
        parseContentLocale(req.query.contentLocale),
        [],
        undefined,
    );
    if (!exercise) {
        return res.status(404).send({ success: false, message: 'Exercise not found' });
    }

    res.status(200).send(exercise);
});

export default router;
