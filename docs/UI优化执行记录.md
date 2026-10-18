# 执行记录：桌面端界面优化（U1–U4）

> 执行时间：2026-10-18 ｜ 分支：`feat/data-safety-and-perf`（基线 `d424b55`，未提交）
> 依据：`docs/HANDOFF-界面优化任务.md`
> 范围：只改 `web-app/src` 的样式、结构类名与文案；未触碰数据层、存储格式、后端。
> 改动规模：36 个文件，+1121 / −218

---

## 0. 一句话结论

**U1（9/9）、U2（6/6）全部完成；U3 完成 7/9；U4 完成 5/7。**
自建 35 项界面断言全绿；单测 78 例、lint 0 error、构建通过、SPA 导航 18 PASS / 1 FAIL（仍是已知的 mp3 `ERR_ABORTED`）、边界兜底 6/6。

---

## 1. U1 可用性缺陷（9/9）

| # | 修法 | 落点 |
|---|---|---|
| U1-1 | 零数据首页主 CTA 改「开始第一课」→ `/courses`；`/review` 空态区分「从未标记」与「已全部攻克」；右侧「开始复习」在无在学课程时降为描边 | `dashboard/DashboardPage.tsx`、`pages/GlobalReviewPage.tsx`、`dashboard.css`、`settings.css`（新增 `.page-empty`） |
| U1-2 | 字幕按钮按 `sentenceVisible` 切 `icon-button[/reveal]` + `aria-pressed`；未揭晓时给 15px 占位提示；**难点复习页同一个 bug 一并修**（并把 `onReveal` 改成可回切） | `IntensiveStage.tsx`、`DifficultReviewStage.tsx`、`intensive-stage.css` |
| U1-3 | 生词本 / 全局复习传 `active="vocabulary" / "review"`；搜索页给放大镜加 `active` 态 + `aria-current="page"` | `TopBar.tsx`、三个页面、`shell.css` |
| U1-4 | 0 答时交卷降为描边（32px / 透明底）；播放器移到题号与选项之间（44px 高）；不可作答时选项组上方加一行说明；进度改 14px + 4px 进度条；删掉顶栏重复的「准备开始」 | `ExamStage.tsx`、`exam-stage.css`、`examStage.ts` |
| U1-5 | 「在学」统一用 `progressByExercise` 中有非空 `lines` 的课程；0 值统计（累计掌握 / 在学 / 所听）直接隐藏；开发期加不变量 `console.warn` | `DashboardPage.tsx` |
| U1-6 | 章节状态槽：未开始不画框、进行中 6px 圆点、已完成 14px 对勾，位宽仍 18px | `CourseMap.tsx`、`catalog.css` |
| U1-7 | `.status-actions` 允许换行；≤720 走 2×2，>720 单行（`flex: 1 1 auto`） | `intensive-stage.css`、`responsive.css` |
| U1-8 | placeholder 改 `research`（语料正文行命中 217）；加 6 个真实示例词 chip，空结果时也复现 4 个 | `SearchPage.tsx`、`search.ts`、`settings.css` |
| U1-9 | 波形句数标「共 197 句（正文 187）」；首页分母改用 `contentLineCount`（与进度条口径一致） | `WaveformStage.tsx`、`DashboardPage.tsx`、`waveformStage.ts` |

**U1-9 补充说明**：`lineCount` 是全量行（含指令行），`contentLineCount` 是精听口径。改动只统一「展示口径」，`calculateChapterProgress` 未动。

---

## 2. U2 手机可用性（6/6）

| # | 结果 |
|---|---|
| U2-1 | ≤1120 重置 `.listen-visual / .listen-progress-card` 的 `grid-column`，390 下媒体区 **100 → 310px**，无横向滚动 |
| U2-2 | `.workspace` 显式两行 + `.library-pane` 限高（1120 断点 28vh / 720 断点 30vh）；390 正文区 **485 → 502px**（占视口 59.5%） |
| U2-3 | ≤560 顶栏换行：品牌 + 操作一行、导航独占一行、44px 高、无竖排；320 下 `scrollWidth 320 = clientWidth 320` |
| U2-4 | ≤720 阶段导航改横向滚动条：**350 → 52px** |
| U2-5 | ≤1120 题号导航进第 2 行并吸顶（限高 148px 自身滚动），题卡第 3 行；1024 下题卡 top **706 → 723 但导航 top 1117 → 572** |
| U2-6 | `@media (pointer: coarse)` 统一 44px；`@media (hover: none)` 让章节 kebab / 歌词插旗常驻 |

**额外顺手修的一条（不在原文档）**：390 下 25 个对话锚点 chip 会折成 6 行、把媒体区挤出首屏，改成单行横向滚动（55px / 单行）。

---

## 3. U3 视觉层级（7/9）

- **U3-1 灰字对比度**：四套主题 `--ink-3` 全部重算并实测——paper 4.95:1、gazette 5.23:1、minimal 5.28:1、exam 4.98:1（均 ≥ AA）。行号从 `--ink-4`（1.2:1）提到 `--ink-3`。
- **U3-3 精听层级**：媒体卡字幕区 `flex:1 + 居中`，当前句 21px 衬线；面板标题 12→13px/ink-2；选中行提示色 ink-3→ink-2。
- **U3-4 首页层级**：今日进度做成 28px 主数字 + 4px 进度条占首屏第一视觉位；「继续学习」提到趋势图上方；删掉目标环卡（同一个 4 不再出现三次）；右栏收敛为 4 卡。
- **U3-5 空态**：全局复习 / 生词本 / 搜索统一徽标 + 标题 + 说明 + 主次按钮的居中空态；搜索框 38→52px、字号 16px、图标 20px。
- **U3-6 状态三通道**：阶段卡「当前」= 左侧 3px 竖条 + 实心编号；「已完成」= 右上角对勾角标（minimal 主题改文字 ✓）；句列表难点/掌握改感叹号/对勾图标并带 `sr-only` 文本；开关关闭态不再用虚线。
- **U3-7 单实心主按钮**：泛听「跳到逐句学习」在播放进度 <80% 前为描边，≥80% 才实心。
- **U3-8 主题选择器**：改成 2×2 主题卡（纸底/墨色/主色三色块），`role="radiogroup"` + `aria-checked`；下拉框不再用于主题（其余 3 个下拉保留）。
- **U3-9 搜索焦点环**：焦点环从内层 `input` 移到 `.search-box:focus-within`。

### 与原文档的偏差（两处，均已验证）

1. **U3-8 没有保留「视觉隐藏的 select」**：隐身但可聚焦的控件是不可见焦点陷阱；改用 radiogroup 原生键盘可达，语义更正确。
2. **U1-1 #3「空态右侧 36px 描边去选课」** 与 #1「主 CTA 开始第一课」合并为一枚实心「开始第一课」——零数据首页只允许一个主按钮，两枚指向同一目的地没有意义。

---

## 4. U4（5/7）

| # | 状态 |
|---|---|
| 1 A 标记 | ✅ 改为贯穿波形高度的 2px 竖线 + 顶部 A 角标（实测 2×156px） |
| 2 波形高度 | ✅ 132 → 156px（**时间尺未做**） |
| 3 趋势图 | ✅ 3 条基线 + 卡头「近 14 天共 N 句」（**未加 Y 轴数字**：SVG 用 `preserveAspectRatio="none"`，文字会被横向拉伸） |
| 4 选项字母 | ✅ 30px 方块 → 24px 圆形 |
| 5 快捷键提示 | ⬜ 未做 |
| 6 1920 限宽 | ✅ `≥1600` 时 `.study-pane` 限宽 1440 居中 |
| 7 列表渐隐 | ✅ `.library-pane::after` 24px 纸色渐变 + 列表底部留 14px |

---

## 5. 明确未做的两项（连同原因）

- **U3-2 字号阶梯（13 档 → 7 档）**：需要全站逐个文件改 `font-size` 与 `font-weight`，属于「改完必须四主题逐页复核」的高遗漏风险项；本批已把最刺眼的 0.5px 差值（行号、面板标题、字幕）处理掉，全量收敛建议单独立项并配截图 diff。
- **U4-5 快捷键发现性**：一次性提示条需要新增「已看过」的本地状态，属于行为改动而非纯样式；建议与「可操作项超载」一起评估。

---

## 6. 验收结果（2026-10-18）

```bash
npm test --workspace @juting/web-app     # 78 passed / 5 files
npx eslint web-app/src                   # 0 error / 1 warning（ExamStage answerableForRef，已知误报）
npx tsc -b && npm run build --workspace @juting/web-app
                                         # ✓ built，主包 303.51 KB / gzip 98.77 KB，CSS 118.26 KB
node temp/verify-spa-nav.mjs             # 18 PASS / 1 FAIL（mp3 ERR_ABORTED，与基线一致）
node temp/verify-boundary.mjs            # 6 PASS / 0 FAIL
node temp/ui-verify.mjs                  # 35 PASS / 0 FAIL  ← 本批新增
```

`temp/ui-verify.mjs` 覆盖：零数据首页 CTA 与实心按钮计数、`/review` 两种空态、精听字幕按钮三态、1440 动作条单行、波形 A 标记、考试播放器/交卷层级、顶栏三处高亮、主题卡、390 泛听媒体宽与锚点单行、390/320 顶栏与横向滚动、390 正文区占比、阶段导航高度、触控目标、1024/768 考试首屏。
截图落在 `temp/ui-verify/`（含四主题 home/intensive 与 1024/768/390/320 各页）。

---

## 7. 环境注意事项（给下一棒）

1. **8101 跑的是 `vite preview`，不是 dev server**：改完源码必须 `npm run build --workspace @juting/web-app` 才看得到效果，HMR 不生效。本批第一次排查就栽在这上面（改了 CSS 但测量值一点没变）。
2. 四主题截图仍要 `goto` 之后再设 `dataset.theme`；`ui-verify.mjs` 里已按这个顺序写。
3. `temp/` 已 gitignore：本记录在 `docs/`，截图与脚本仍在 `temp/`，需要留档得单独拷出。
4. 仍未做真机验证：`100vh` 动态工具栏、iOS Safari 的 `position: sticky` 表现都属于模拟器结论。
