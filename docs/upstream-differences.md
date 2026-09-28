# 与上游的差异清单

本仓库基于 [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting) 二次开发，更名为句听，
面向单机单人听力备考场景。

## 学习端（web-app）

| 差异 | 说明 | 位置 |
| --- | --- | --- |
| 免登录 | 移除登录/注册入口，学习进度存 localStorage（`duolinting.web.progress.v1`） | `web-app/src/lib/progressStore.ts` |
| 真题锚点系统 | 字幕指令句（Section/Conversation/Passage/Recording/题干）自动提取为分组标签，点击跳转该段 | `packages/domain/src/dialogueAnchors.ts` |
| 手风琴句列表 | 精听句列表按锚点分组折叠，默认收起、点击展开；指令行作为组介绍文本 | `web-app/src/components/TranscriptPanel.tsx` |
| 仪表盘首页 | `/home` 学习概览（今日掌握/连续天数/趋势图/每日目标/继续学习） | `web-app/src/components/dashboard/` |
| 管理端直达按钮 | 学习端顶栏「管理后台」跳 8102 | `web-app/src/components/TopBar.tsx` |
| 默认简体中文 | 界面与内容语言默认 zh-CN（上游默认 en-US）；设置页可切换 | `web-app/src/i18n/LanguageProvider.tsx` |

## 管理端（admin）

| 差异 | 说明 | 位置 |
| --- | --- | --- |
| 侧栏只有两项 | 目录结构 + 课程管理（多协作板块组件已删除） | `admin/src/components/admin/AdminWorkspaceNav.tsx` |
| 直接发布/下架 | 课程列表每行「发布/下架」按钮直接切换状态，不经校对/二审工作流 | `admin/src/components/admin/CourseManager.tsx` |
| 管理端免登录 | 无会话时自动以本地管理员登录（默认 `admin@duolinting.local`，可用 VITE_LOCAL_ADMIN_* 覆盖）；会话 401 静默续登不弹窗 | `admin/src/App.tsx` |
| 中文默认 | 管理端界面语言默认简体中文 | `admin/src/i18n/AdminLanguageProvider.tsx` |

## 后端（backend）

| 差异 | 说明 | 位置 |
| --- | --- | --- |
| 后端精简 | 仅保留目录、课程、字幕、ASR、媒体五组路由，其余已删 | `backend/src/router/v1/` |
| 直接发布 | 课程在管理后台一键发布/下架，不需要审核流程 | `admin/src/components/admin/CourseManager.tsx` |

| 本地磁盘存储 | `MEDIA_STORAGE=local`：媒体落本地磁盘目录，无需 MinIO；默认仍为 minio | `backend/src/general/media/local-object-store.ts` |
| 本地 ASR 排队 | `ASR_ENABLED=true` 时课程创建可排队本地 whisper.cpp 识别 | `backend/src/general/media/asr/` |
| whisper 线程/提示词 | `ASR_THREADS`、`ASR_INITIAL_PROMPT` 透传给 whisper-cli | `backend/src/env.ts` |

说明：上游的协作数据表（exercise_contributor_assignments、exercise_subtitle_drafts 等）
未做删除迁移，留在库里不影响单机运行；`mobile-app` 与 `official-site` 工作区已
整体移除（移动端引用的 learners API 已不存在，如需移动端要另行适配）。

## 内容管线脚本（scripts/content/）

- `yuanwen-lib.mjs` + `yuanwen-apply.mjs` —— 听力原文 md + ASR 时间轴词级对齐，批量校对/建课
- `batch-asr-publish.mjs` —— 批量排队 ASR + 断句 + 直接发布（幂等可重跑，单机版无工作流）
