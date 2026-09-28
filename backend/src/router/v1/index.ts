import express from 'express';
import adminRouter from './admin';
import catalogRouter from './catalog';
import exercisesRouter from './exercises';
import mediaRouter from './media';

// 单机版：只保留目录、课程、媒体与后台管理四组路由。
// 学习者登录/进度/排行/反馈/开放内容等社区路由已随多人协同功能一并移除。
const router = express.Router();

router.use('/catalog', catalogRouter);
router.use('/exercises', exercisesRouter);
router.use('/admin', adminRouter);
router.use('/media', mediaRouter);

export default router;
