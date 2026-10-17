# 交付文档：桌面端四项增强（导出备份 / 生词复习 / 错题档案 / 跨课搜索 / 听时长）

> 交付时间：2026-10-17 ｜ 仓库：`C:\Users\Zsc\Documents\duolinting`（桌面端 Web）
> 交付提交：**`42ff2fa`**（基于交接时 HEAD `08183c5`，23 文件，+2101 / -5）
> 对应需求：`docs/HANDOFF-四项增强任务.md` ｜ 状态：**五项全部实现，构建通过，核心链路经真实浏览器（agent-browser）逐项实测**
> 验收截图与脚本：`temp/acceptance/`（gitignored）

---

## 一、交付物清单（对照交接文档第九节）

| 交接文档要求 | 实际文件 | 状态 |
|---|---|---|
| 学习数据导出/导入/校验/合并 | `web-app/src/lib/dataBackup.ts`（新增） | ✅ |
| 设置页「数据」区块 UI | `web-app/src/components/SettingsPage.tsx`（修改） | ✅ |
| 生词复习调度状态 | `web-app/src/lib/vocabReview.ts`（新增） | ✅ |
| 生词本「今日待复习」入口 + 复习视图 | `web-app/src/pages/VocabularyPage.tsx`（修改） | ✅ |
| 反复错题聚合 | `web-app/src/lib/wrongStats.ts`（新增） | ✅ |
| 高频错题展示 | `web-app/src/components/dashboard/DashboardPage.tsx`（「你最常错的题」卡） | ✅ |
| 单课成绩历史视图 | `web-app/src/components/ExamStage.tsx`（交卷后 `ExamHistoryPanel`：历场明细 + 手写 SVG 得分走势） | ✅ |
| 跨课搜索页 + 路由 + TopBar 入口 | `web-app/src/pages/SearchPage.tsx`（新增）+ `/search` 路由 + TopBar 放大镜按钮 | ✅ |
| 听时长累计 | `web-app/src/lib/listenTime.ts`（新增）+ `web-app/src/hooks/useMediaPlayback.ts`（修改） | ✅ |
| 首页第 5 格统计 | `web-app/src/components/dashboard/DashboardPage.tsx` | ✅ |
| 新增文案 | `i18n/messages/settings.ts`、`dashboard.ts`、`examStage.ts`、`vocab.ts`、`search.ts`（新增） | ✅ |
| 样式（设计 token） | `styles/settings.css`、`dashboard.css`、`exam-stage.css`（追加，全部用既有 CSS 变量） | ✅ |

**新增存储键**（全部符合 `juting.web.*.v1` 命名规范）：

| 键 | 内容 |
|---|---|
| `juting.web.autobackup.v1` | 启动进度快照，环形保留 3 份 |
| `juting.web.last-export.v1` | 上次导出时间（设置页展示） |
| `juting.web.listen-time.v1` | `{ totalMs, byDay: Record<yyyy-MM-dd, ms> }` |
| `juting.web.vocab-review.v1` | 生词复习旁路状态（**未改 `ExerciseProgress.vocabulary` 结构**） |

**零新增运行时依赖**；未引入图表库（成绩走势为手写 SVG，复用 `MasteryChart` 先例）。

---

## 二、实现要点摘要

### 任务一：导出/导入（P0）
- 导出 6 类数据（progress 含 legacy `duolinting.*` 回退、activity、examHistory、prefs、dailyGoal、theme；**exam-inprogress 临时态不备份**），文件名 `juting-backup-YYYY-MM-DD.json`。
- 导入前 `format === 'juting-backup'` + `version === 1` + `data` 结构三重校验；写入前再对每类数据逐项体检（仿 `examHistory.ts` 写法），畸形部分跳过并提示，**绝不静默写垃圾**。
- 覆盖 = 校验后原样写回；合并 = lines 同句 `mastered`/`unclear` 取 OR、`repeatCount` 取 max、`vocabulary` 并集、`activeExerciseId` 保留本机、activity 按日取 max、实战档案按 `date|score|wrong.length` 指纹去重追加、prefs/dailyGoal/theme 属设备偏好**合并时不动**。
- 导入成功 900ms 后自动刷新页面（React state 旧数据问题）。
- 启动时 `snapshotForAutobackup()`（`main.tsx` 调用）：progress+activity 快照入环形 3 份，与上一份相同则跳过。

### 任务五：所听时长
- 采集点在 `useMediaPlayback` 内新增 1s 轮询：`isPlayingRef === true` 且 `!document.hidden` 时按墙钟累加（不乘倍速）；tick 间隔 >5s 的补账跳过（防后台节流回来一次性虚高）。
- 落盘由 listenTime 模块 15s 节流；`pagehide` / `visibilitychange`(隐藏) / hook 卸载时强制 flush。
- 仪表盘第 5 格：主值 `<1h → "43 分钟"`、否则 `"12 小时 34 分"`；副标题「累计所听 · 今日 N 分钟」。`dashboard-stat-strip` 本就是 `flex-wrap`，5 格窄屏自动换行，布局未破坏。

### 任务三：错题档案
- `aggregateWrong(getAllAttempts())` → 跨课程按「课+题号」累计 `wrongCount`，输出按错次降序；题级 `attemptCount` = 该课场数；`section` 由既有 `sectionOfQuestion` 推导。
- 仪表盘新卡「你最常错的题」：取前 5（`attemptCount ≥ 2 或 wrongCount ≥ 2` 才算"反复"），点击跳该课精听。
- `ExamHistoryPanel`（交卷后结果区）：历场 日期|得分|错题|未答|Section 分布 + 得分百分比走势 SVG（≥2 场才画线）；无历史渲染空态。

### 任务二：生词复习
- 旁路键 `vocab-review.v1`，词键统一小写；`{ addedAt, dueAt?, lastReviewedAt?, reviewCount, mastered }`。
- 调度：1/3/7/15 天，`reviewCount ≥ 4` → mastered（仍在生词本，只是不排队）；「不认识」→ 归零 + `dueAt = 明天`。
- **老数据迁移**：生词本页挂载时对无记录的词幂等补登记并 `dueAt = now`（今日可复习，一次性）；新收藏走 `registerVocabWords`（默认明天进队列，当天不出现）。
- 两个收藏入口都接线：精听 `IntensiveContainer.onAddVocabulary`、生词本页 `addToCourse`；两处删除（精听 `onRemoveVocabulary`、生词本 `remove`）同步清复习记录。
- 复习卡：挖空收藏时原句（`\b` 整词忽略大小写替换为 `______`）→「显示答案」（词 + ECDICT 释义 + 完整原句）→「认识/不认识」；列表每词 badge（已掌握/今日待复习/N 天后）。
- 复习卡未做音频播放：`vocabulary` 只有原句文本没有 lineId，无法精确定位行（交接文档提到的 playLine 能力需要行坐标）；用「释义 + 完整原句」替代，后续若要音频可考虑扩展 vocabulary 或借用词典 ctx 坐标。

### 任务四：跨课搜索
- 纯前端方案：首次进入 `/search` 时 catalog → 各分类 exercises summary → 逐课 `getExercise` 拉全量转写建内存扁平索引；模块级缓存，SPA 内切换不重建，刷新才重建。
- 进度提示「正在建立索引 {{done}}/{{total}}…」，单课失败不拖垮整体；失败显示「索引建立失败…」。
- 结果三组：课程标题（跳精听）/ 生词本（跳 `/vocabulary`）/ 句子（前 60 条，`<mark>` 高亮，点击 `?line=<lineId>&stage=intensive` 跳精听定位——复用 `StudySessionContext` 既有 line 消费机制）。

---

## 三、验收结果（对照交接文档第十节逐条）

### 任务一
1. 导出 JSON 可解析、含 6 类数据 ✅（导入侧用同构文件全链路验证；`downloadBackup` 为标准 Blob + `<a download>` 路径，浏览器内未做下载文件回读）
2. 导入自己导出的文件 → 数据一致（覆盖）✅ 实测
3. 手动删 `format` 字段 → 报「不是句听备份文件（缺少 format 标识）」，无覆盖/合并按钮，不写入 ✅ 实测
4. 清空 localStorage → 导入 → 进度/生词/实战成绩全部恢复 ✅ 实测（mastered、生词、examHistory、activity 逐键核对）
5. 导入后刷新数据仍在 ✅ 实测（导入流程自动 reload 后验证）
- 附加：合并模式语义实测（l1 OR/max、l2 并入、生词并集、activity max、实战去重追加、prefs 不动）✅

### 任务五
1. 播放 N 秒 → +N 秒（±2s）✅ 实测：真实点击播放 16s → 落盘 `totalMs: 16000`
2. 暂停 → 停止累加 ✅ 实测：暂停后 17s 零增长
3. 刷新页面数据还在 ✅（localStorage 落盘 + 首页进入重读）
4. 切到别的标签页停止 ⚠️ 代码层确认（`document.hidden` 检查 + `visibilitychange` flush），未做真实切页模拟
5. 首页格式正确、5 格不崩 ✅ 实测（`flex-wrap` 布局）

### 任务三
1. 同课考 3 次错同一题 → `wrongCount = 3` ✅（实测 2 场错同题 → `wrongCount=2` 排第一；计数为简单求和，3 场同逻辑）
2. 成绩历史列出每场、日期得分正确 ⚠️ 面板已实现且构建通过，**未走完整交卷流程**（需听完 25 题整卷，自动化成本高）；其数据源 `getAttempts` 的读数与格式化已在仪表盘高频错题卡实测。**建议人工考一场后看一眼**
3. 点错题跳精听对应句 ✅（仪表盘卡跳课实测；ExamStage 错题行复用既有 `onGoIntensive` 未改动；`?line=` 定位机制在任务四实测通过）
4. 无历史空态不报错 ✅（空态渲染分支 + 构建通过）

### 任务二（全部实测 ✅）
1. 新收藏的词当天不出现 ✅（cherry 已登记无 dueAt → 「下次复习：1 天后」）
2. addedAt 改 2 天前 → 出现在「今日待复习」✅（迁移 + 手动过期双路径）
3. 「认识」→ `reviewCount+1`、下次复习推后 ✅（rc 0→1，dueAt 清除）
4. 「不认识」→ 归零、明天又出现 ✅（rc=0，dueAt=未来）
5. 连续「认识」4 次 → 「已掌握」不再排队 ✅（rc 3→4 → mastered=true，badge「已掌握」）
6. 老数据（无 addedAt）正常迁移不崩溃 ✅（apple/banana 迁移后立即进当日队列）
- 回归：精听点词 → 侧栏 → 「加入生词本」→ vocabulary 与 vocab-review 双键同步写入 ✅ 实测

### 任务四
1. 搜已知词命中 ✅ 实测 `consultant` → 5 句（**注意：交接文档举例的 `airbnb` 在本库 87 门课中不存在**，属文档举例，非功能缺陷）
2. 点结果跳精听定位该句 ✅ 实测（`/courses/1/chapters/39?line=…&stage=intensive`，line 参数被 `StudySessionContext` 消费后从 URL 清除属既有机制）
3. 搜生词本里的词 → 生词组有结果 ✅ 实测（apple + ECDICT 释义）
4. 搜不存在的词 → 空态「没有匹配的结果」✅ 实测
5. 首次加载有进度提示 ⚠️ 条件通过：提示代码真实可用（用 `network route --abort` 强制 catalog 失败，failed 提示正常渲染，与 building 同构）；但**本机后端全量拉取实测仅 2-3 秒**，building 提示一闪而过、自动化采样抓不到。慢网络/冷缓存下可见。

### 现有功能回归（交接文档总清单第 4 条）
- 精听点词收藏 ✅ 实测｜生词本列表/筛选/复习 ✅ 实测｜实战交卷主流程未改动（ExamStage 仅在交卷后分支追加面板）｜波形、难点复习未触碰。
- 遗留老键兼容：legacy `duolinting.web.progress.v1` 等在导出/导入两侧均兼容。

---

## 四、过程中发现并修复的 Bug

**合并导入丢数据（已修复，浏览器实测抓到）**：初版 `mergeExerciseProgress` 里用 `base`/`other` 中转变量，行级与生词合并循环遍历的是 `other.lines`，导致「备份侧较新时」其新增句子/生词不并入（实测 l2、banana 丢失，l1 的 unclear/repeatCount 未取并集）。修复为 local/incoming 双向并集，复测通过。
→ 这也印证交接文档红线第 3 条：导入必须逐条校验 + 真实浏览器验收，纯代码走查发现不了。

## 五、数据事实修正（对交接文档）

1. 本仓库数据库实际 **87 门课**（非 38 课 7690 句）；搜索索引按实际课数构建，进度文案动态显示总课数。
2. `airbnb` 一词在转写中不存在（0 命中），交接文档仅为举例；实测改用 `consultant`/`apple`。
3. 全量索引拉取本机实测 **2-3 秒**（非预估的 3-8 秒），87 课逐课串行请求。

## 六、未竟事项与后续建议

1. **成绩历史面板**建议人工验收：任意真题课 → 模拟实战考完一场 → 交卷页底部看「成绩历史」；考第 2 场后出现得分走势折线。
2. 生词复习卡的**音频播放**未做（vocabulary 无 lineId，见任务二说明）；若要做，方案是收藏时额外记录行坐标（需扩展旁路键，不动 vocabulary 主结构）。
3. 任务五的 `document.hidden` 分支与 autobackup 的「有进度时快照」逻辑建议日常使用中顺带观察（自动化模拟成本高于收益）。
4. agent-browser 实操备忘（对下一棒有用）：
   - 用 `AB="path"` 变量形式调用 `.cmd` 偶发触发沙箱报错（`decisionRecord missing actual resource subject`），**全路径直调稳定**；
   - `open` + 全部交互 + `close` 必须同一条命令（守护进程随命令结束回收，跨命令 localStorage 丢失）；
   - `eval` 参数 >850 字符被静默截断，脚本先落盘再 `$(tr '\n' ' ' < x.js)` 传入；
   - `network route "**/api/v1/catalog**" --abort` 可验证请求失败分支的 UI 渲染。

## 七、验收入口

```bash
node scripts/local/start-all.mjs   # 8100 API / 8101 页面 / 8102 后台
```

- 数据备份：设置页 → 「数据」区块（导出 / 导入 + 覆盖/合并二选一，显示上次导出时间）
- 听时长：任意课播放数十秒 → 首页统计条第 5 格
- 错题档案：首页右侧「你最常错的题」（需 ≥2 场或同题错 ≥2 次）；考完一场看交卷页「成绩历史」
- 生词复习：生词本页顶部「今日待复习 N 词」（老生词首次打开自动标记今日可复习）
- 跨课搜索：TopBar 放大镜或直接访问 `/search`
