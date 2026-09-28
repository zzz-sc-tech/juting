import type {
    AdminRole,
    CourseContributor,
    CourseWorkflowCredits,
    ExerciseSubtitleVersion,
    SubtitleVersionSource,
    TranscriptLine,
} from '../../domain';
import { doRawQuery } from '../../models';

// 单机版说明：上游的多人协同体系（任务广场认领、字幕校对/二审工作流、
// 贡献者分工与署名、协作动态与站内通知、开放内容 API）已整体移除。
// 本文件只保留 catalog-service 与 admin 路由仍依赖的最小函数面：
// - 角色判定（AdminActor / isSuperAdmin / normalizeAdminRole）
// - 字幕编辑权限（超级管理员全量可编辑；历史遗留的贡献者账号仍按指派表判定）
// - 字幕版本历史查询
// 其余对外函数按「无协作数据」返回空结果，保持 catalog-service 的调用形状不变。

export type AdminActor = {
    id: number;
    role: AdminRole;
    mustChangePassword?: boolean;
};

export const normalizeAdminRole = (role: unknown): AdminRole =>
    role === 'subtitle_contributor' ? 'subtitle_contributor' : 'super_admin';

export const isSuperAdmin = (admin: AdminActor | undefined | null) =>
    admin?.role === 'super_admin';

export async function canEditExerciseSubtitles(admin: AdminActor, exerciseId: number) {
    if (isSuperAdmin(admin)) return true;
    const rows = await doRawQuery<{ id: number | string }>({
        query: `select id
                from exercise_contributor_assignments
                where admin_user_id = ? and exercise_id = ?
                limit 1`,
        params: [admin.id, exerciseId],
    });
    return rows.length > 0;
}

const parseSubtitleLines = (value: unknown): TranscriptLine[] => {
    if (Array.isArray(value)) return value as TranscriptLine[];
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed as TranscriptLine[] : [];
    } catch {
        return [];
    }
};

/** 字幕版本历史，供制课工作台回溯每一版。 */
export async function listExerciseSubtitleVersions(exerciseId: number): Promise<ExerciseSubtitleVersion[]> {
    const rows = await doRawQuery<{
        id: number | string;
        exercise_id: number | string;
        subtitle_draft_id: number | string | null;
        version_no: number | string;
        transcript_json: unknown;
        source: SubtitleVersionSource;
        admin_user_id: number | string;
        display_name: string | null;
        note: string | null;
        created_at: Date | string;
    }>({
        query: `select versions.id, versions.exercise_id, versions.subtitle_draft_id,
                       versions.version_no, versions.transcript_json, versions.source,
                       versions.admin_user_id, admins.display_name, versions.note, versions.created_at
                from exercise_subtitle_versions versions
                left join admin_users admins on admins.id = versions.admin_user_id
                where versions.exercise_id = :exerciseId
                order by versions.version_no desc, versions.id desc`,
        params: { exerciseId },
    });
    return rows.map((row) => ({
        id: Number(row.id),
        exerciseId: Number(row.exercise_id),
        subtitleDraftId: row.subtitle_draft_id ? Number(row.subtitle_draft_id) : undefined,
        versionNo: Number(row.version_no),
        lines: parseSubtitleLines(row.transcript_json),
        source: row.source,
        adminUserId: Number(row.admin_user_id),
        adminDisplayName: row.display_name || '系统',
        note: row.note || undefined,
        createdAt: new Date(row.created_at).toISOString(),
    }));
}

// ── 以下为 catalog-service 调用形状兼容桩：单机版没有协作署名数据 ──

export async function listExerciseContributors(exerciseId: number): Promise<CourseContributor[]> {
    void exerciseId
    return [];
}

export async function getExerciseWorkflowCredits(exerciseId: number): Promise<CourseWorkflowCredits | undefined> {
    void exerciseId
    return undefined;
}

export async function listExerciseSubtitleDrafts(
    exerciseId: number,
    admin: AdminActor,
    options?: { submittedOnly?: boolean },
): Promise<undefined> {
    void exerciseId
    void admin
    void options
    return undefined;
}

export async function getPreviewSubtitleDraftForLearner(
    exerciseId: number,
    learnerUserId: number | undefined,
): Promise<undefined> {
    void exerciseId
    void learnerUserId
    return undefined;
}
