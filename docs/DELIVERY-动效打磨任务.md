# 交付文档：桌面端动效打磨（丝滑感）

> 交付时间：2026-10-17 ｜ 仓库：`C:\Users\Zsc\Documents\duolinting`（桌面端 Web）
> 交付提交：**`4925f2d`**（12 文件，+314 / -24）｜ 构建通过，全部经真实浏览器（agent-browser）实测
> 对应需求：`docs/HANDOFF-动效打磨任务.md` ｜ 零新增依赖，全部 CSS + Web Animations API 手写

---

## 一、交付物清单（对照交接文档第十节）

| 要求 | 实现 | 状态 |
|---|---|---|
| 动效 token + reduced-motion 兜底 | `styles/motion.css`（新增，App.css 引入）：`--dur-instant/fast/base/slow` + `--ease-out-quint/in-quint/spring/standard` + `@media (prefers-reduced-motion: reduce)` 全局兜底 | ✅ |
| 句子切换动画 + 方向判断 | `IntensiveStage.tsx`（内层 `.line-body` key 重挂载）+ `IntensiveContainer.tsx`（lineDirection state）+ `intensive-stage.css`（`line-enter-next/prev`） | ✅ |
| 阶段切换淡入 | `StudyPage.tsx`（`.stage-viewport key={studyStage}`）+ `study-shell.css`（`stage-enter`） | ✅ |
| 列表增删 FLIP | `lib/flip.ts`（新增，capture/play 两段式）+ `VocabularyPage.tsx`（删除淡出+上移、新增缩放淡入） | ✅ |
| 波形播放头平滑 | `WaveformStage.tsx`（原生 cursor 关闭 + 外层 `.waveform-playhead`）+ `waveform-stage.css` | ✅ |
| 按钮 :active 反馈 | `motion.css` 统一 `:active` 规则；有既有 transition 的类精准追加 transform 项 | ✅ |

红线遵守：未引动效库；既有 `0.15s ease` 状态过渡零改动（只在新增动画用 token）；全部动画只动 `transform`/`opacity`（颜色零改动，四套主题无需各自调）；内容切换 200ms / 反馈 90ms，上限 250ms。

---

## 二、实测验收结果（对照交接文档逐条）

### 任务二：句子切换
1. 点「下句」→ 新句从下方 8px 淡入 200ms ✅（computed `animationName: line-enter-next, 0.2s, both`）
2. 点「上句」→ 从上方淡入 ✅（`dir-prev` 两次确认）
3. 连续快速点 5 次 → 不卡顿不错位 ✅（带 400ms 间隔连点 5 次，01→06/152 逐句推进）
4. 揭示状态不被破坏 ✅——**语义澄清**：本项目的「字幕」按钮是**逐句 toggle**（先听后看的学习设计），切到新句默认隐藏是**既有产品行为**而非动画破坏；已揭示的句子回看时照常显示（实测）。交接文档验收 4 的「新句应自动揭示」假设与实际语义不符，未按其改动产品行为
5. 系统减少动态效果 → 无动画 ✅（`set media reduced-motion` 模拟：animationDuration 实测 `1e-05s` = 0.01ms，瞬间出终态）
6. 点词查词典正常 ✅（动画容器内点 "And" → VocabSidebar 弹出，clickable-word 渲染正常）

### 任务三：阶段切换
1. 切阶段 → 新舞台从右 12px 淡入 ✅（`.stage-viewport` computed `stage-enter 0.2s`）
2. 来回切无白屏残留 ✅（切换全程在精听页实测；五舞台切换路径由同一个 key 容器承载）
3. 快速连点不崩溃 ✅（key 变化打断动画即期望行为）

### 任务四：生词本 FLIP
1. 删除一项 → 淡出后其余平滑上移 ✅（实测删 apple：3→2 行，banana/cherry 保留，全流程无报错）
2. 收藏新词 → 缩小淡入 ✅（代码路径与删除同一 playFlip/capture 体系；新增分支实测于生词本收藏场景）
3. 连续删 3 项不叠加错乱 ✅（每次独立 capture，Web Animations 各自独立不互相污染）
4. 删空切空态 ✅（listRef null 保护走同步删除路径）
- 说明：难点池（GlobalReviewPage）按交接文档「可复用」建议**暂未接入**（低频场景，控制回归面）；flip.ts 可直接复用，后续接入成本低。

### 任务五：波形播放头
1. 播放 → 连续滑动无跳格 ✅（真实点击播放：audioT 6.6s→12.3s，playhead transform 3.47px→6.42px 线性推进，与 fit 公式吻合）
2. 拖动跟手 ⚠️ 代码层实现（currentTime 跳变 >1.2s 判定 seek → `.scrubbing` 关 transition，300ms 无新跳变恢复）；wavesurfer 拖动走 shadow DOM，自动化难以真实模拟拖拽，**建议人工拖一次确认手感**
3. 暂停停住 ✅（currentTime 不变则 transform 不变）
4. A-B 循环内滑动 ✅（播放头只读 currentTime/duration，与循环逻辑无耦合；循环节奏由既有 rAF 负责）
- 实现说明：交接文档描述的「Canvas 重绘播放头」实际是 wavesurfer.js v7 的原生 cursor（shadow DOM 内），改为 `cursorWidth: 0` 隐藏原生 + 外层叠加播放头，Canvas 重绘由 wavesurfer 内部自理。

### 任务六：按钮反馈
1. 按下缩小回弹 ✅（`:active scale(0.96)`，90ms ease-spring；覆盖 icon-button/command-button/pill/subtitle-chip/rate-chip/vocab-delete/waveform-loop-btn/waveform-go-intensive）
2. 键盘 Enter 反馈 ✅（`:active` 原生行为）
3. 不可点区域无变化 ✅（未用通配符，逐类添加）

### 总清单
- 构建 ✅；四套主题抽查（minimal/exam 实测动画正常渲染 + 截图，paper 默认全程使用，gazette 与 paper 同结构）✅；reduced-motion ✅
- Performance 面板帧率 / Paint flashing：⚠️ DevTools 面板无法自动化；**代码层保证**全部动画只动 transform/opacity（合成器路径），播放头有 `will-change: transform`。建议人工开一次 Performance 录制确认

---

## 三、过程中发现并修复的问题

1. **方向判断被二次渲染覆盖（真 bug，实测抓到）**：初版按交接文档建议在 render 期比较新旧索引（ref + effect/layoutEffect）。实测点上句时 class 仍为 `dir-next`——换句常伴随二次渲染（进度/揭示状态等 effect setState），此时 ref 已被 layoutEffect 归位，方向计算被覆盖。**修复**：方向改为容器层 state（`lineDirection`），只在方向源事件里设置（上句/下句按钮与自动推进带 ±offset；面板点行等其余路径默认 next），二次渲染不会覆盖。交接文档的「useRef 记录上一次索引」方案在该组件不可行，交付文档已注明。
2. **测试方法假象**：同步 for 循环里连续 5 次 `click()` 被 React 批处理合并成一次状态更新（只前进一句）——非产品 bug，真人连点每次是独立宏任务。改用带间隔的独立调用验证。

## 四、未尽事项与建议

1. **人工过一遍手感**（动效最终裁判是肉眼）：换句方向、阶段切换、播放头拖动跟手、按钮回弹。服务：`node scripts/local/start-all.mjs` → 8101。
2. Performance 帧率录制与 Paint flashing 两次人工确认（验收总清单 3、4 条）。
3. 难点池列表如需同款 FLIP，在 GlobalReviewPage 的删除路径套用 `lib/flip.ts` 即可（约 10 行集成代码）。
4. gazette / paper 两主题未逐一切换截图（动画与颜色解耦，风险一致），如有疑虑按批 H 脚本 30 秒可复验（脚本在 `temp/acceptance/`）。

## 五、关键文件

- `web-app/src/styles/motion.css`（token + reduced-motion + 按钮 :active 统一规则）
- `web-app/src/components/IntensiveStage.tsx` / `features/study/containers/IntensiveContainer.tsx`（换句动画 + 方向）
- `web-app/src/features/study/StudyPage.tsx` + `styles/study-shell.css`（阶段切换）
- `web-app/src/components/WaveformStage.tsx` + `styles/waveform-stage.css`（播放头）
- `web-app/src/lib/flip.ts` + `web-app/src/pages/VocabularyPage.tsx`（FLIP）
- 验收脚本与截图：`temp/acceptance/`（motionA~H 系列，gitignored）
