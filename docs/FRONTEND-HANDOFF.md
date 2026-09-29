# 句听 JuTing · 前端重构交接文档

> 交接对象：负责前端重构的 AI 代理 / 开发者
> 日期：2026-09-29 ｜ 基线：main 分支 32dbb3d ｜ 发布基线：v0.3.0（tag）
> 原仓库上下文：github.com/zzz-sc-tech/juting（Apache-2.0），本地 C:\Users\Zsc\Documents\duolinting

---

## 0. 你接手的是什么

一个**已发布、用户在用**的本地优先听力精练工具（Windows 便携包 + 浏览器 Web 界面）。
产品形态：MonoRepo（npm workspaces），你只动两个前端：

- `web-app`（学习端，端口 8101，React 19 + Vite + Radix UI，**重构主对象**）
- `admin`（管理端，8102，Ant Design，功能精简，**基本不用动**）

后端 `backend`（Express 5 + Sequelize + MySQL）**不在重构范围**，但前端消费它的
API，改数据展示前必读 §3。

**不可协商的约束**（用户已验收的体验红线）：

1. 三阶段精听流程：泛听热身 → 逐句学习（默认落点）→ 难点复习，外加"波形自由听"工具阶段
2. 数据全在本机，学习进度存浏览器 localStorage（无账号体系，用户端免登录）
3. 全库 7955 句中文译文与 38×25 答案钥匙刚花大力气补齐，**任何重构不得丢失这两个数据面的展示**
4. 界面刚做过"去 AI 味"改版：靛蓝令牌、紧凑统计条、无 emoji、无教练腔文案——**别改回去**

---

## 1. 快速上手

```bash
# 启动（首次会初始化便携 MySQL 并自动导入 38 门课+译文+答案）
双击 启动句听.bat          # 或 cmd: node scripts/local/start-all.mjs
# 学习端 http://127.0.0.1:8101 ｜ 管理端 http://127.0.0.1:8102
# 管理端免登录（VITE_LOCAL_ADMIN_* 自动登录，见 §6）

# 前端构建（改完 src 必须重新 build，vite preview 服务的是 dist）
npm run build --workspace @juting/web-app
npm run build --workspace @juting/admin
npm run typecheck          # 根目录，全 workspace 类型检查
```

改前端**不需要重启后端**（vite preview 直接服务 dist，刷新即生效）；
但动后端代码要重启（停止窗口 → 重开 bat）。

---

## 2. 前端结构地图（web-app/src）

```
App.tsx                      全局编排：路由/阶段切换/stageRailItems/studySections 派生
components/
  CourseMap.tsx              侧栏课程树（已按 进行中/未开始/已完成 分组，状态框 UI）
  StageRail.tsx              阶段卡（tool 字段=无序号虚线卡；title 无说明文字）
  ExtensiveStage.tsx         泛听：歌词式滚动字幕（memo 子组件 ExtensiveLyrics）+ 字幕/翻译开关
  IntensiveStage.tsx         逐句精听：字幕卡（翻译开关）+ 控制栏（上句/播放/重播/字幕/下句）
  TranscriptPanel.tsx        章节句子手风琴：锚点分组、对答案开关（anchor-section-answers）、
                             纯指令组固化不可点击（static class）、答案字母渲染
  DifficultReviewStage.tsx   难点复习（独立句表，不走锚点分组）
  WaveformStage.tsx          波形自由听（wavesurfer v7，独立实现，注意 §5 的坑）
  StudyStates.tsx            空状态/错误/加载（lucide 图标）
  dashboard/DashboardPage.tsx 首页：学习概览 + 紧凑统计条 + 掌握趋势 + 继续学习 + 目标环
  TopBar.tsx                 顶栏（首页/学习/管理后台/设置）
hooks/
  useCatalog.ts              目录（categoryGroups+categories+exercises 摘要）
  useCategoryExercises.ts    按系列懒加载课程摘要（GET /catalog/category/:id/exercises）
  useExerciseDetail.ts       单课完整数据（含 lines）
  useStudyProgress.ts        学习进度核心（localStorage 持久化 + 选句/移动/掌握/难点）
  useMediaPlayback.ts        音频播放（currentTime 4Hz 驱动全 UI）
lib/
  progressStore.ts           localStorage 持久化（键 juting.web.*，旧 duolinting.* 键回退读取）
  studySections.ts           buildStudySections：正文句按锚点归组（手风琴数据源）
  lineTranslation.ts         resolveLineTranslation：译文解析（§4 关键）
  apiClient.ts               API 基址与媒体 URL 解析
i18n/
  LanguageProvider.tsx       useLanguage() → { t, contentLocale, uiLocale }；t 支持 {{var}} 插值
  messages/*.ts              按模块拆分的六语言文案表（zh-CN/en-US/th-TH/ja-JP/fr-FR/es-ES）
styles/*.css                 按页面/组件拆分；设计令牌在 index.css :root
```

路由：`/home`（仪表盘）、`/courses`（学习页，query `stage=intensive|waveform`）、
`/courses/:categoryId/chapters/:exerciseId?stage=`、`/settings`。

---

## 3. 数据契约（重构最容易踩的三个坑）

### 3.1 译文字段：权威在 `translations[contentLocale]`，不在 `line.translation`

后端把中文译文放在每行的 `translations: { "zh-CN": "..." }`（catalog-service 会把
legacy `translation` 提升进去），而 `line.translation` 对新导入的数据是**空的**。
**必须用 `lib/lineTranslation.ts` 的 `resolveLineTranslation(line, contentLocale)`**，
别直接读 `line.translation`——ExtensiveStage/IntensiveStage 已接入，重构时保留该调用。

### 3.2 学习句表 = `studyExercise.lines`（过滤后正文），不是 `activeExercise.lines`（全量）

App.tsx 用 `studyExercise = useMemo(...)` 派生"指令行已过滤"的正文列表喂给精听链路。
历史上 `moveSelectedLineAndPlay` 误用全量表导致"下一句越按越往前"的严重 bug（已修）。
**任何涉及"上一句/下一句/第 N 句"的逻辑都必须基于 `studyExercise.lines`**，
与 `useStudyProgress` 内部的 selectedLineIndex 同源。

### 3.3 锚点（DialogueAnchor）是运行时推导的，不落库

`packages/domain/src/dialogueAnchors.ts` 的 `extractDialogueAnchors(lines)` 从指令句
实时提取（Section A / Conversation 1 / Q1–4 / 第8–11题 等标签）。**纯指令组**
（无正文句的组，如开场、Section 播报）在句列表里固化为不可点击标签；带正文的组可
折叠。锚点标签正则匹配"Q1–4 / Q19 / 第8–11题"时注意 en-dash（–）与连字符两种形态。

### 3.4 学习端的课程摘要接口不含 lines

`GET /catalog/category/:id/exercises` 返回摘要（含 lineCount / answerKey / translation 无）；
完整 lines 走 `useExerciseDetail`。progressStore 存的 lineId 与库中 `l1..lN` 对应——
**20 门课 2026-09-29 字幕重建后行数变了，用户旧进度已错位（已知且已告知用户）**；
重构不要改 id 生成规则（`l${index+1}`），否则 18 门未重建课的进度也会失效。

---

## 4. 刚做完的功能（重构时保行为，可换实现）

| 功能 | 位置 | 行为要点 |
| --- | --- | --- |
| 泛听歌词式滚动字幕 | ExtensiveStage + ExtensiveLyrics(memo) | activeLine=最后一句 start≤currentTime（句间空档沿用上一句）；当前句居中自动滚动（首帧瞬时、后续 smooth）；点击任意句 onSeek(line.start) 跳播；当前句下显示译文；「字幕」关=回退条纹背景 |
| 精听翻译开关 | IntensiveStage 字幕卡顶栏 subtitle-chip | translationOn 默认 true；关闭后译文层不渲染（字幕区保留 min-height 防塌陷） |
| 对答案 | TranscriptPanel `.answer-toggle` | 仅 exercise.answerKey 存在时渲染开关；开关打开后题组标签显示 `1B 2C` 式字母（静态标签分支也要渲染——曾漏过一次，已修）；questionRangeOf 支持 Q1–4/Q19/第8–11题 |
| 章节状态分组 | CourseMap chapterGroups | 进行中(percent>0 且<100) → 未开始 → 已完成(≥100)，组内保持时间顺序，quest-badge 用原 index（全系列连续编号，banner 的 chapterIndex 与之同源——别改成组内序号，会破坏"第 N 章/共 38 章"语义） |
| 仪表盘 | DashboardPage | 标题"学习概览"+副标题"今日目标 X 句，已完成 Y 句"（dashboard.goal.line 插值）；统计条无图标；勿恢复问候语/emoji |

---

## 5. 高危坑清单（前人踩过，别再踩）

1. **wavesurfer v7 缩放**：必须 `ws.zoom(pxPerSec)`，`setOptions({minPxPerSec})` 无效；
   滚动容器在 shadow DOM 内 `(ws as any).renderer.scrollContainer`，外层量程恒 0；
   任何 wavesurfer 容器必须有带 overflow 裁剪的定宽祖先。
2. **换肤/重构删 CSS 前先 grep 全部使用者**（`.modal-backdrop` 曾被误删导致弹窗崩版；
   `.icon-wrapper`、`.stage-step small` 同类教训）。
3. **i18n 是六语言硬约束**：messages/*.ts 每个文件六个 locale 块 key 集合必须一致
   （zh 块用单引号键，fr/es 含撇号值用双引号键，解析时引号无关）；动态键（stage.*.title、
   状态 label 等）脚本收集不到，**新增文案必须六语言手工补齐**。
4. **admin i18n 另有校验器** `npm run check:admin-i18n`；admin 侧"多余 key"也会被当
   UI 键收集（statusLabels 等动态查键的表不要裁剪）。
5. **CSS 令牌**：主色 --accent #5b5fef、底色 --bg #eef0f8，圆角/阴影用 var()——去 AI 味
   改版后的基线，别引入渐变横幅/emoji/教练腔文案（用户明确反感）。
6. **多行 TS/正则修改禁用 python heredoc 内联**（转义静默失败前科多次）——用 Edit 工具
   或写临时 .cjs 文件执行后 grep 验证真的写入了。
7. **bat 脚本**（如需动启动器）：必须 CRLF（.gitattributes 已锁）、控制流纯 ASCII、
   中文只能在裸 echo 行。
8. **后端重启会把内存中的 ASR 任务队列清掉**；管理端 token 失效会闪一条
   "Admin session is not valid"（自动重登，非 bug）。

---

## 6. 凭据与环境

- 学习端免登录；管理端自动登录默认 `admin@juting.local` / `juting2026`
  （可用 VITE_LOCAL_ADMIN_EMAIL/PASSWORD 覆盖；2026-09-29 已从旧 duolinting.local 迁移）
- 便携 MySQL 3307（root 无密码 / 业务账号 duolinting:duolinting，库名 duolinting_app_dev——
  **数据层标识符有意保留旧名，兼容历史数据，不要"顺手"改名**）
- 媒体：本地磁盘 `temp/runtime/media-store/duolinting-media/`（桶目录结构）
- 全局 git 身份含隐私，本仓库 local config 已覆盖为 juting@users.noreply.github.com，勿 unset
- `temp/` 全部 gitignore（含 3GB 运行时数据）；`presets/cet6/seed.json` 是发布数据真源
  （v20260928.4：38 门修复后字幕+全量译文+答案钥匙），**改数据管线时它是比对基线**

---

## 7. 重构建议的优先方向（产品视角，供参考）

按用户已表达的不满与现状，收益排序：

1. **信息架构**：App.tsx 已 800+ 行（全局状态+编排全在一起），阶段组件间通过
   props 深传；可拆 stage 容器/将 useStudyProgress 相关状态收拢
2. **样式体系**：styles/*.css 按页面拆分但有重复（多处 radius/阴影硬编码），令牌化
   收尾；catalog.css 仍残留 quest/游戏化命名
3. **性能**：currentTime 4Hz 驱动整树 re-render（泛听已 memo 歌词区，精听卡未做）；
   useExerciseDetail 拉全量 lines 后每次渲染 map
4. **文案层**：i18n 值里还有上游痕迹可再清理；六语言中 th/ja/fr/es 依赖机器翻译
   质量一般（中文优先的产品可考虑降级为中文+英文两语言维护）
5. **测试**：前端零测试；packages/domain 的纯函数（dialogueAnchors/studyStages）
   最适合先补单测

---

## 8. 已知残余问题（重构不必修，但别当成新 bug）

- 官方原文无标点的长句仍是整行（音频固有，无法按句拆）
- 部分课程 >15s 空档为读选项/静音区（两轮 whisper 均未出字，v1 亦无字幕）
- 20 门重建课用户旧进度错位（id 重排，已告知用户）；41/50 两门的音频会使
  后端 ASR 任务管线挂死（已用直调 whisper 绕过，后端任务框架 bug 未修）
- dashboard 趋势图在无数据时是一条直线（数据问题非渲染问题）

---

## 9. 验证清单（重构完成的自查项）

- [ ] `npm run typecheck` 全绿
- [ ] `npm run build --workspace @juting/web-app` + admin 构建零错误
- [ ] 泛听：歌词滚动/点击跳播/字幕翻译开关/翻译显示
- [ ] 精听：下一句单调前进（曾在某课倒退）、译文开关、对答案字母渲染（含静态题组）
- [ ] 换课：折叠态/答案开关重置；课程分组正确
- [ ] 六语言切换无英文裸键
- [ ] `git status` 无误提交大文件（temp/ 应全被忽略）
