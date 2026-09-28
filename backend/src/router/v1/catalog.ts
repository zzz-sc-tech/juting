import express from 'express';
import { listCatalog, listCategoryExercises, parseContentLocale } from '../../general/catalog/catalog-service';

// 单机版学习端免登录：不再解析学习者会话，也没有“预览志愿者”草稿可见逻辑。
const router = express.Router();
const toId = (value: string) => Number.parseInt(value, 10);

router.get('/', async (_req: any, res) => {
    res.status(200).send(await listCatalog(false, false, (parseContentLocale(_req.query.contentLocale) ?? 'en-US'), []));
});

router.get('/category/:categoryId/exercises', async (req: any, res) => {
    const categoryId = toId(req.params.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).send({ success: false, message: 'Invalid category id' });
    }

    const exercises = await listCategoryExercises(categoryId, false, (parseContentLocale(req.query.contentLocale) ?? 'en-US'), []);
    res.status(200).send(exercises);
});

export default router;
