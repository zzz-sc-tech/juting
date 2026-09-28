import Sequelize, { Model, ModelAttributes } from 'sequelize';
import { Defaultconfig, sequelize } from '../db-config-mysql';

/**
 * 媒体自动语音识别任务（见 V202609230001__media_asr_jobs.sql）。
 * 一行 = 一个「媒体对象 × 模型 × 语言」的识别结果缓存；succeeded 后同键请求直接复用。
 */
const MediaAsrJobSchema: ModelAttributes = {
    id: {
        type: Sequelize.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
    },
    bucket: {
        type: Sequelize.STRING(191),
        allowNull: false,
    },
    object_name: {
        type: Sequelize.STRING(512),
        allowNull: false,
    },
    media_etag: {
        type: Sequelize.STRING(128),
        allowNull: true,
    },
    media_size_bytes: {
        type: Sequelize.BIGINT,
        allowNull: true,
    },
    model_name: {
        type: Sequelize.STRING(191),
        allowNull: false,
    },
    language: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'auto',
    },
    status: {
        type: Sequelize.ENUM('pending', 'running', 'succeeded', 'failed'),
        allowNull: false,
        defaultValue: 'pending',
    },
    progress: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
    },
    result_json: {
        type: Sequelize.TEXT('medium'),
        allowNull: true,
    },
    srt_text: {
        type: Sequelize.TEXT('medium'),
        allowNull: true,
    },
    segment_count: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
    },
    duration_ms: {
        type: Sequelize.BIGINT,
        allowNull: true,
    },
    error_message: {
        type: Sequelize.STRING(1000),
        allowNull: true,
    },
    requested_by_admin_id: {
        type: Sequelize.BIGINT.UNSIGNED,
        allowNull: true,
    },
    created_at: {
        type: Sequelize.DATE,
    },
    updated_at: {
        type: Sequelize.DATE,
    },
};

export interface MediaAsrJobDb {
    /** 自增主键；create 时由数据库生成，因此类型上允许缺省。 */
    id?: number;
    bucket: string;
    object_name: string;
    media_etag?: string | null;
    media_size_bytes?: number | null;
    model_name: string;
    language: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    progress: number;
    result_json?: string | null;
    srt_text?: string | null;
    segment_count?: number | null;
    duration_ms?: number | null;
    error_message?: string | null;
    requested_by_admin_id?: number | null;
    created_at?: Date | null;
    updated_at?: Date | null;
}

/**
 * 注意：不要在这个类上声明 public 字段——TS 的 class 字段会遮蔽 Sequelize
 * 挂在原型上的属性 getter，导致 row.status 之类的直接读取全部变成 undefined
 * （行数据请统一走 get({ plain: true })）。字段类型由 MediaAsrJobDb 泛型提供。
 */
export class MediaAsrJobModel extends Model<MediaAsrJobDb> {}

MediaAsrJobModel.init(MediaAsrJobSchema, {
    ...Defaultconfig,
    sequelize,
    tableName: 'media_asr_jobs',
});
