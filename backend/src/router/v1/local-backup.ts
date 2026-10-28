import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 学习端本地存档自动镜像（2026-10-28 立）。
 *
 * 背景：单机版的学习进度/生词/考试记录只存在浏览器 localStorage（免登录模式），
 * 浏览器配置一丢就全没。web 端定期把 exportAll() 的完整存档 POST 到这里，
 * 后端落盘到 temp/runtime/local-backups/，一天一份、滚动保留 [KEEP_DAYS] 份。
 * 文件格式与「设置 → 数据备份」手动导出完全一致，导入恢复走同一通道。
 *
 * 无鉴权说明：与 catalog/media 同级的本机接口，监听 127.0.0.1 的单用户应用，
 * 请求体限制 [MAX_BYTES] 防误发大文件。
 */
const router = express.Router();

const KEEP_DAYS = 30;
const MAX_BYTES = 8 * 1024 * 1024;

const backupsDir = (): string => {
    // 与 update-bridge 同款解析：便携模式从 MEDIA_LOCAL_DIR 反推安装根下的 temp/runtime
    const mediaLocalDir = process.env.MEDIA_LOCAL_DIR;
    const runtimeDir = mediaLocalDir
        ? path.resolve(mediaLocalDir, '..')
        : path.resolve(process.cwd(), '..', 'temp', 'runtime');
    return path.join(runtimeDir, 'local-backups');
};

const rotate = (dir: string): void => {
    const files = fs
        .readdirSync(dir)
        .filter((f) => /^juting-mirror-\d{8}\.json$/.test(f))
        .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
        fs.rmSync(path.join(dir, stale), { force: true });
    }
};

router.post('/local-backup', (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || body.format !== 'juting-backup') {
        res.status(400).send({ ok: false, message: '不是 juting-backup 格式的存档' });
        return;
    }
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) {
        res.status(413).send({ ok: false, message: '存档超过 8MB 上限' });
        return;
    }

    const dir = backupsDir();
    fs.mkdirSync(dir, { recursive: true });
    // 一天一份：同日多次镜像覆盖（数据只在使用中变化，末次即最新）
    const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const file = path.join(dir, `juting-mirror-${day}.json`);
    fs.writeFileSync(`${file}.tmp`, json, 'utf8');
    fs.renameSync(`${file}.tmp`, file);
    rotate(dir);

    res.send({ ok: true, file: path.basename(file) });
});

export default router;
