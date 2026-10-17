# 交付文档：桌面端工程优化（性能 / 健壮性 / 可维护性）

> 交付时间：2026-10-17 ｜ 仓库：`C:\Users\Zsc\Documents\duolinting`（桌面端 Web）
> 对应需求：`docs/HANDOFF-工程优化任务.md`
> 范围：P0-1 代码分割 → P1-1 ErrorBoundary → P1-2 搜索索引并发化 → P1-3 vitest
> 构建：`npm run build --workspace @juting/web-app` 通过（tsc -b + vite build）
> 单测：`npm test --workspace @juting/web-app` → **4 文件 / 61 例全通过**
> 验证：真实 Chromium（Playwright）+ 真实鼠标点击，非估算
> 依赖：**生产依赖零新增**；vitest 只进 devDependencies

---

## 一、交付物清单（对照交接文档第十节）

| 要求 | 实现 | 状态 |
|---|---|---|
| `App.tsx` 路由懒加载 + Suspense | 5 个页面改 `lazy()`，命名导出转 default；首页保持静态 import；`<ErrorBoundary><Suspense fallback={<RouteLoading/>}>` 两层 | ✅ |
| `ErrorBoundary.tsx`（新增）+ 样式 | `components/ErrorBoundary.tsx`（class 组件，含 scope 属性）+ `styles/route-states.css`（route-loading + error-boundary，全 token 化） | ✅ |
| `main.tsx` 包一层 | `<StrictMode>` 内最外层再包一个 `scope="界面"` 的边界（覆盖 App/Provider 自身崩） | ✅ |
| `SearchPage.tsx` 索引并发化 | 分批并发 `INDEX_CONCURRENCY = 8`，`Promise.all` 保序，单课 try/catch 容错保留，`onProgress` 按批推进 | ✅ |
| `package.json` + `vitest.config.ts` | `test` / `test:watch` 脚本；node 环境、只 include `src/**/*.test.ts` | ✅ |
| `src/lib/*.test.ts`（约 34 例） | 实际 **61 例**：dataBackup 21 / vocabReview 24 / wrongStats 7 / clickableText 9 | ✅ |
| 复测报告（前后对比） | 本文第二节 + 第六节复测脚本 | ✅ |

为可测性做的两处**无行为变化**调整：

1. `dataBackup.ts` 的 `mergeProgress` / `mergeActivity` / `mergeExamHistory` 由 `const` 改为 `export const`——纯函数，导出只为让单测直接覆盖。
2. `vocabReview.ts` 的 `ensureVocabEntries` 增加可选 `options.now`——不传仍取 `Date.now()`，测试可注入固定时间。

---

## 二、实测前后对比

**方法**：同一套 `temp/measure-perf.mjs`，同一台机器、同一个后端（8100）、同一台 Chromium（headless），
先伺服「改动前」的已发布产物（`C:\Users\Zsc\Documents\juting\web-app\dist`，入口 `index-D3dXsjrO.js`，即 v0.7.2），
再伺服本次构建，各跑 2-3 次取稳定值。

| 指标 | 改动前 | 改动后 | 变化 |
|---|---|---|---|
| 首屏 JS 传输量（/home） | **593 KB**（1 个文件） | **93 KB**（1 个文件） | **−84%** |
| 首屏 JS 解码量 | 1788 KB | 287 KB | −84% |
| DOMContentLoaded | 199 / 219 ms | 55 / 59 / 65 ms | **−72%** |
| networkidle | 863 / 925 ms | 710 / 757 ms | −18% |
| CSS 传输 | 16 KB | 17 KB | 持平 |
| 构建产物 JS 文件数 | **1** | **14** | 代码分割生效 |
| 搜索：进页到索引就绪 | 733 / 821 ms | 647 / 659 ms | −13% |
| 搜索：索引抓取窗口（首请求→末请求） | **370 ms** | **172 ms** | **−53%** |
| 搜索：页面内构建阶段（就绪 − 挂载） | 438 ms | 256 ms | −42% |
| 搜索：输入到首条结果 | 299 / 303 ms | 297 / 300 ms | 持平 |
| 学习页首进（首页点「学习」→ 章节+阶段栏） | 295 / 303 / 324 ms | 361 / 409 / 440 ms | **+60~110 ms（权衡，见第四节）** |
| 点词查词典（首次） | 225 / 239 / 326 ms | 233 / 247 / 330 ms | 持平（噪声内） |
| 点词查词典（缓存后） | 95 / 104 ms | 91 / 101 ms | 持平（含固定 60 ms 等待） |
| 搜索结果条数（query=`the`） | 60 行 | 60 行 | 一致 |

构建产物明细（改动后）：

| chunk | 原始 | gzip |
|---|---|---|
| `index-*.js`（主包：首页 + 框架 + 通用） | 293.86 kB | 95.48 kB |
| `StudyPage-*.js` | 228.11 kB | 72.86 kB |
| `vocabDict-*.js`（词典数据块，三页共享） | 1179.59 kB | 404.32 kB |
| `SettingsPage-*.js` | 32.30 kB | 10.28 kB |
| `DifficultReviewStage-*.js` | 20.85 kB | 6.74 kB |
| `Combination-*.js` | 16.26 kB | 6.25 kB |
| `VocabularyPage-*.js` | 9.05 kB | 3.09 kB |
| `vocabReview-*.js` | 6.24 kB | 2.49 kB |
| `SearchPage-*.js` | 5.41 kB | 1.86 kB |
| `GlobalReviewPage-*.js` | 5.16 kB | 2.03 kB |
| `dist-*.js`（第三方） | 39.42 kB | 14.55 kB |
| CSS `index-*.css` | 109.79 kB | 16.74 kB |

---

## 三、逐项验收（对照交接文档）

### P0-1 代码分割

1. dist 出现多个 js ✅ —— 1 → **14 个**
2. 首屏 JS 传输 ≤ 300 KB ✅ —— **93 KB**
3. 六个路由全部正常渲染 ✅ —— `/home` `/courses` `/review` `/vocabulary` `/search` `/settings`
   逐页实访：都有实际文本（22925 / 232 / 43 / 63 / 47 / 293 字符的对应页面内容），
   无 `Element type is invalid`、无 boundary 触发、无 pageerror。
4. 首页点学习页不白屏 ✅ —— 两点实测：
   - **SPA 导航**：React Router 的 `navigate` 走 transition，旧页面保持可见直到新 chunk 就绪，**全程无空白帧**（`.route-loading` 未被观察到，属预期更优行为）；
   - **深链接首进**（直接开 `/courses`）：`.route-loading` 正常出现，文案「载入中…」，随后渲染学习页（实测 `loadingVisible=true`，`readyMs≈935ms`）。
5. 深链接 `/search` 正常 ✅ —— 直达可用，索引完成后可搜索。

> 词典确实被拆走：`vocabDict-*.js` 独立成块（1.18 MB），只在生词本/学习页/搜索页的 chunk 组里加载，首页不再付这笔钱。

### P1-1 ErrorBoundary

1. 正常使用无影响 ✅ —— 全回归流程中边界从未触发。
2. 人为制造错误 ✅ —— 临时在 `DashboardPage` 注入 `throw new Error('boundary-test')` 后重新构建：
   - 显示错误页而非白屏（标题「这一页出问题了」、安抚文案「你的学习进度没有丢失（存在本机）」、两个按钮、技术详情默认折叠且在 `<pre>` 里显示 `boundary-test`）；
   - 「重新加载」→ 页面重新渲染（同一 throw 仍在，故再次显示兜底页，证明不是崩溃而是可恢复的错误态）；
   - 「回到首页」→ 导航到 `/home` 并再次走兜底页，URL 正确。
   - 验证完成后已撤销注入并重新构建（`git diff` 中该文件无残留）。
3. 四套主题样式正常 ✅ —— 兜底页背景/文字/按钮全部走 token，实测：
   - paper `rgb(247,245,241)` / 墨 `rgb(29,27,22)` / 主按钮 `rgb(36,88,74)`
   - gazette `rgb(244,240,230)` / `rgb(23,21,18)`（按钮沿用晨报主题的油墨描边样式）
   - minimal `rgb(255,255,255)` / `rgb(24,24,27)`
   - exam `rgb(242,241,234)` / `rgb(46,49,83)`

> 边界只兜渲染期异常，事件处理器与 Promise 异常仍需各自 catch——本次未改这部分既有处理（搜索页已有 catch）。

### P1-2 搜索索引并发化

1. 索引耗时 ⚠️ **未达「200 ms 以内」**，但并发收益实测成立：
   - 抓取窗口（首个 exercise 请求开始 → 最后一个结束）：**370 → 172 ms（−53%）**
   - 页面内构建阶段（就绪 − 挂载）：**438 → 256 ms（−42%）**
   - 端到端（进页 → 索引就绪）：733 → 647 ms
   - 根因与取舍见第四节第 1 条；`onProgress` 按批推进的语义也已按文档实现。
2. 搜索结果与改动前完全一致 ✅ —— 同一 query（`the`）都是 60 行、分组标题「句子（60+ 条）」、顺序一致（`Promise.all` 保序，索引课程序不变）。
3. 单课失败仍不影响其他课 ✅ —— 用 Playwright 拦截 `/api/v1/exercises/13` 返回 500：
   索引照常建成（进度提示正常消失）、结果仍 60 行、13 课命中数为 0、无 pageerror。
4. 进度提示正常递增 ✅ —— 每批 8 课一跳，总数与完成态不变（UI 文案 `search.building` 的 done/total 语义未变）。

### P1-3 vitest

1. `npm test` 可跑、全部通过 ✅ —— `vitest run`：4 文件 / **61 例** / 约 0.7 s。
2. 故意改坏逻辑测试应失败 ✅ —— 把 `mergeLine` 的 `mastered: local || incoming` 改成 `&&`，`dataBackup.test.ts` 立即 **2 例失败**（含「备份侧较新的新增句子要并入（曾丢数据）」）；改回后全绿。
3. 测试不依赖网络和浏览器 ✅ —— `environment: 'node'`，无 jsdom；`dataBackup` 的 `importAll` 用内存 `localStorage` 桩，其余全是纯函数。

覆盖要点：

| 模块 | 例数 | 覆盖 |
|---|---|---|
| `dataBackup` | 21 | `parseBackup` 七类畸形拒绝；合并 OR/max/并集/去重/偏好基底；`activeExerciseId` 保留本机；`importAll` replace 与 merge 分支；skipped 语义 |
| `vocabReview` | 24 | 间隔 1/3/7/15 天；显式 `dueAt` 优先；认识/不认识状态转移；满 4 次掌握；`dueWords` 过滤去重；老数据 dueNow 迁移；角标 today/later/mastered；`blankContext` 挖空 |
| `wrongStats` | 7 | 跨场次计数、最近错期、Section 归属、排序稳定、老数据（无 `wrong`）、脏条目容错 |
| `clickableText` | 9 | 空串/纯标点/中英混排/连字符/撇号/首尾标点/连续空格；**每例都校验拼回原文逐字相等** |

> 交接文档建议的 `@vitest/ui` 未安装：它只是本地可视化面板，会额外带一批依赖；`vitest run` / `vitest`（watch）已满足需要。后续要用再加 `npm i -D @vitest/ui` 即可。

---

## 四、已知权衡与未达成项

1. **搜索索引 200 ms 目标未达成（实测 172 ms 抓取 / 256 ms 构建 / 647 ms 端到端）**。
   瓶颈不是请求延迟而是**数据量**：38 课全量转写 **2.86 MB**（网络面板实测），
   并发 8 已把串行 370 ms 压到 172 ms；把并发提到 16 / 32 反而没有进一步收益
   （后端 Node 单进程 + 连接池，实测 196 / 207 ms，见 `temp/measure-api.mjs`）。
   端到端剩下的时间花在两处：2.86 MB JSON 传输+解析、以及搜索页 chunk 组的加载（含 404 KB 词典）。
   真要进 200 ms，需要动后端（批量接口 / 只传必要字段）或做索引持久化（P2-1），不属于 P1-2 的范围。
2. **学习页首进变慢 60~110 ms**。拆分后学习页要拉 8 个 chunk（StudyPage 228 KB + 词典 1.18 MB + 若干小块的合计约 600 KB gzip），
   而旧版这 594 KB 早已在主包里随首页一起下完。权衡是划算的（首页 −500 KB），
   但**若要追平**，可把 `VocabSidebar` 再懒加载一层：把 404 KB 词典推迟到首次点词，代价是首次点词多一次下载。本次未做（超出 P0-1 范围，且改动点词这一主线功能）。
3. **搜索页首进会为「生词命中释义」付 404 KB 词典**（`lookupVocab`）。旧版这笔钱已经在主包里，拆分后被单列出来，属于同一笔成本换了付款时点。
4. **vite 的 `>500 kB` 警告**针对 `vocabDict-*.js`：它是数据块（1.18 MB 词条表），不是代码，警告属预期。
5. `SearchPage.tsx:176` 的 `useMemo(loadStoredStudyStore, [])` 有一条**预存在的 lint 错误**（`react-hooks/use-memo` 要求内联函数），本次未动（不在任务范围）。

---

## 五、回归验证（真实浏览器，逐项实测）

| 功能 | 方法 | 结果 |
|---|---|---|
| 点词查词典 | 首页 → 学习 → 章节 → 精听（第 2 步）→ 点「字幕」→ 点第一个词 | `aside.vocab-sidebar` 弹出，释义/音标/本库例句完整（College …）✅ |
| 生词本 | 预置 3 个生词 + 复习记录后打开 `/vocabulary` | 3 行词条、复习卡（`.vocab-review-entry`）、点「开始复习」进入卡片流程 ✅ |
| 难点复习台 | 预置 2 句 `unclear` 后打开 `/review` | 队列 1 课、角标「待攻克 2 句」，非空态 ✅ |
| 备份导出/导入 | 设置页导出 → 下载落盘 → 清空 localStorage → 重新载入 → 选文件 → 替换导入 | 导出提示「已导出备份文件」、解析提示「备份读取成功（导出于 2026-10-17 16:53）」、导入后 `note: 笔记` 与生词 `college` 均恢复 ✅ |
| 搜索 | `/search` 深链接 + 输入 `the` | 60 行结果，点第一条跳 `/courses/1/chapters/13?stage=intensive` 且学习页正常 ✅ |
| 实战舞台 | `/courses/1/chapters/13?stage=exam` | 「第 1 题」4 个选项、「已答 0/25 题」、「交卷」按钮；选项在音频窗口未到时为 `disabled`（既有的按部分开窗设计），无报错 ✅ |
| 四套主题 | 设置页在 paper/gazette/minimal/exam 下逐一加载 | `data-theme` 与背景色正确，`settings-card` 各 5 张，备份区存在 ✅ |
| 精听页刷新 | 精听页 F5 | 阶段栏与内容正常恢复 ✅ |
| 全路由无异常 | 六路由逐页收集 `pageerror` / `console.error` | 0 条 ✅ |

---

## 六、复测方法（脚本都在 `temp/`，未入库）

```bash
# 1) 构建
npm run build --workspace @juting/web-app

# 2) 首屏/搜索指标（自带 preview 服务，跑完自动关）
node temp/measure-perf.mjs 4183
#    与旧产物对比：把第 3 个参数换成已安装实例的 dist
node temp/measure-perf.mjs 4184 "C:/Users/Zsc/Documents/juting/web-app/dist"

# 3) 功能回归（懒加载/点词/生词本/复习台/四主题/深链接）
node temp/verify-functions.mjs 4186

# 4) 错误兜底页四主题（需先临时注入 throw 并重新构建）
node temp/verify-error-boundary.mjs 4188

# 5) 备份导出导入 + 实战舞台
node temp/verify-backup-exam.mjs 4189
node temp/verify-exam.mjs 4190

# 6) 单课失败容错
node temp/verify-index-fault.mjs 4191

# 7) 后端串行 vs 并发的下限（判断并发常量是否还有调整空间）
node temp/measure-api.mjs
```

> 所有脚本都用「起 preview → 跑 Chromium → 关服务」的一条命令内闭环（本机守护进程会被回收，不能跨命令复用）。
