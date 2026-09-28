import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../env';

/**
 * 本地磁盘对象存储（免 MinIO 的单机模式）。
 *
 * 设计约束：
 * - 只覆盖后端真正用到的 S3 面：put / stat / get（含 Range） / remove / bucket 探测。
 *   预签名上传（upload-intents）没有客户端在用，本地模式直接拒绝并给出清晰提示。
 * - 对象名是后端生成的受控键（audio/yyyy/mm/dd/xxx.ext），这里仍做路径逃逸防护，
 *   保证拼出来的路径不会越出存储根目录。
 * - etag 用 size+mtime 派生：同一对象内容不变时保持稳定（ASR 缓存键依赖它），
 *   代价是零额外哈希开销——媒体每次播放都要 stat，不能用全文件 md5。
 * - Content-Type 存在旁车 JSON（<对象路径>.dlt-meta.json），不依赖扩展名反推。
 */

export const isLocalStorageEnabled = () => env.media.storage === 'local';

const storageRoot = () => env.media.localDir;

const resolveObjectPath = (bucket: string, objectName: string) => {
    const root = path.resolve(storageRoot(), bucket);
    const target = path.resolve(root, objectName);
    if (!target.startsWith(path.resolve(root) + path.sep)) {
        throw new Error(`非法的媒体对象键：${objectName}`);
    }
    return target;
};

const metaPath = (objectPath: string) => `${objectPath}.dlt-meta.json`;

const readContentType = (objectPath: string) => {
    try {
        const meta = JSON.parse(fs.readFileSync(metaPath(objectPath), 'utf8'));
        if (typeof meta.contentType === 'string' && meta.contentType) {
            return meta.contentType;
        }
    } catch {
        // 旁车缺失时回退为通用类型
    }
    return 'application/octet-stream';
};

export const localEnsureBucket = (bucket: string) => {
    mkdirSync(path.resolve(storageRoot(), bucket), { recursive: true });
};

export const localBucketExists = (bucket: string) =>
    existsSync(path.resolve(storageRoot(), bucket));

export const localPutObject = (
    bucket: string,
    objectName: string,
    buffer: Buffer,
    contentType: string,
) => {
    const objectPath = resolveObjectPath(bucket, objectName);
    mkdirSync(path.dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, buffer);
    writeFileSync(metaPath(objectPath), JSON.stringify({ contentType }));
};

export const localStatObject = (bucket: string, objectName: string) => {
    const objectPath = resolveObjectPath(bucket, objectName);
    if (!existsSync(objectPath)) {
        const error: NodeJS.ErrnoException = new Error('The specified key does not exist.');
        error.code = 'NoSuchKey';
        throw error;
    }
    const stat = statSync(objectPath);
    return {
        contentType: readContentType(objectPath),
        size: stat.size,
        // 稳定派生 etag：对象被替换（mtime/size 变化）后必然改变。
        etag: createHash('md5').update(`${stat.size}:${stat.mtimeMs}`).digest('hex'),
    };
};

export const localGetObject = (
    bucket: string,
    objectName: string,
    range?: { start: number; end: number },
) => {
    const objectPath = resolveObjectPath(bucket, objectName);
    if (!existsSync(objectPath)) {
        const error: NodeJS.ErrnoException = new Error('The specified key does not exist.');
        error.code = 'NoSuchKey';
        throw error;
    }
    const stream = range
        ? fs.createReadStream(objectPath, { start: range.start, end: range.end })
        : fs.createReadStream(objectPath);
    return stream;
};

export const localRemoveObject = (bucket: string, objectName: string) => {
    const objectPath = resolveObjectPath(bucket, objectName);
    if (existsSync(objectPath)) {
        unlinkSync(objectPath);
    }
    if (existsSync(metaPath(objectPath))) {
        unlinkSync(metaPath(objectPath));
    }
};

/** 本地模式启动时确保根目录存在。 */
export const prepareLocalStorage = () => {
    mkdirSync(storageRoot(), { recursive: true });
};
