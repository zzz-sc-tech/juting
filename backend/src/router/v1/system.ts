import express from 'express';
import {
    getUpdateState,
    requestLauncherAction,
} from '../../general/system/update-bridge';

/**
 * 更新相关接口（学习端「设置 → 关于句听」用）：
 *   GET  /system/update        读取当前版本 / 更新状态 / 下载安装进度（轮询）
 *   POST /system/update/check  请求启动器去 GitHub 检查更新
 *   POST /system/update/apply  请求启动器下载并覆盖安装（会重启句听）
 *
 * 真正的下载与安装由 句听.exe（启动器）执行——它需要停掉服务再覆盖自身，
 * 后端只做信使：写命令文件、读状态文件。
 */
const router = express.Router();

router.get('/update', (_req, res) => {
    res.send(getUpdateState());
});

router.post('/update/check', async (_req, res) => {
    const consumed = await requestLauncherAction('check-update');
    if (!consumed) {
        res.status(409).send({
            ok: false,
            reason: 'launcher-unavailable',
            message: '当前句听不是用 句听.exe 启动的（可能是 bat），无法在页面内检查更新。请改用 句听.exe 启动，或到 Releases 页手动下载。',
        });
        return;
    }
    res.send({ ok: true });
});

router.post('/update/apply', async (_req, res) => {
    const state = getUpdateState();
    if (!state.update?.available) {
        res.status(400).send({ ok: false, message: '当前没有可安装的新版本，请先点「检查更新」。' });
        return;
    }
    const consumed = await requestLauncherAction('update');
    if (!consumed) {
        res.status(409).send({
            ok: false,
            reason: 'launcher-unavailable',
            message: '当前句听不是用 句听.exe 启动的，无法在页面内一键更新。请改用 句听.exe 启动，或到 Releases 页手动下载覆盖解压。',
        });
        return;
    }
    // 启动器接下来会下载 → 解压 → 停服 → 覆盖安装 → 自动重启，
    // 期间本后端会被停掉，前端应预期「连接中断」并按重启处理。
    res.send({ ok: true, willRestart: true });
});

export default router;
