# 任务：逐句 ↔ 锚点对应全量精修（岛审计 + MiMo 钉位 + 区间结构校验）

> 预算：**1 个工作日**（约 8 小时有效工时）
> 前置阅读：`docs/HANDOFF-2026-10-21-语料重建.md` 第 11 节（尤其 11.5–11.8）、`AGENTS.md`
> 主仓库：`C:\Users\Zsc\Documents\duolinting`

## 0. 一句话目标

**四六级全部 97 门课，点任何一个对话锚点，播出的第一声就是该单元的真实开头；锚点区间内的每一句逐句行，逐句播放时开头不截、尾巴不带上一句。**

## 1. 背景：还剩什么没做

前几轮（提交 `d05a3d1`…`998348f`）只精修了**题干行与题组播报行**（cet4 1631 条 + cet6 307 条），
正文行从未做过「行起点 vs 真实语音岛起点」的审计。锚点与逐句的对应还有四块已知空白：

1. **锚点区间首句**（用户点锚点后听到的第一句正文）：从未审计。首句若偏晚，
   点锚点会先听到一段静音/上一单元尾巴；偏早则吞掉播报。
2. **开场报头**（每套的前 1–2 个锚点 "Section A" / "Conversation One"）：交接文档 11.4
   记录过 whisper 对这几秒整段漏转写、行只能插值、**偏 2–3s**，一直没修。
3. **正文行本体**（约 19,000 行）：只有时长门禁（>10 词/s 判压缩），没有起点精度审计。
4. **锚点区间结构**：行是否越界（属 A 区间的行 start 落在 A.start 之前）、区间是否
   无缝（`findDialogueAnchorAtTime` 的活跃高亮依赖它），没有全量校验过。

基线（本轮起点，验收以此为对照）：
- 锚点源行（报头+题组播报）：cet4 1607/1631 = 98.5%（偏晚 18 条 ≤1.7s、偏早 6 条）、
  cet6 304/307 = 99%（偏早 3 条）
- 锚点区间首句 / 开场报头 / 正文行：**无数据**（本任务建立）

## 2. 可复用的资产（不要重造轮子）

| 资产 | 位置 | 说明 |
|---|---|---|
| 岛审计判据 | `temp/audit-island.mjs`（六级版）、`temp/audit-cet4.mjs`（四级版） | 能量岛 → 行起点有向偏差。**本任务要扩展成逐句锚点版** |
| MiMo 逐岛钉位 | `scripts/content/mimo-refine.mjs`（六级）、`mimo-refine-cet4.mjs`（四级） | 逐岛转写 + 文本匹配 + 认领岛 + 标签回溯。缓存目录已存在，重放零调用 |
| 残片修复 | `scripts/content/fix-announcement-fragments.mjs` | 锚定正则 + 题号归一 + 音频优先 |
| 锚点提取 | `packages/domain/src/dialogueAnchors.ts` 的 `extractDialogueAnchors` / `findDialogueAnchorAtTime` | 纯函数，`node` 里 import `packages/domain/dist/index.js` 直接用 |
| 写库契约 | `scripts/audit/data-contract.mjs` 的 `saveTranscript` | 先 dry 后 apply，`expect.lineDelta` 声明行数变化 |
| 门禁全家 | `scripts/audit/check-invariants.mjs`、`check-duration-sanity.mjs`、`check-timeline-speech-overlap.mjs`、`temp/v3.mjs`、`temp/final-check.mjs` | 验收用 |
| MiMo 凭证 | `~/.zcode/asr/mimo.key`，模型 `mimo-v2.5-asr`，`https://token-plan-cn.xiaomimimo.com/v1/chat/completions`，`input_audio` 传 base64 mp3 | 只出纯文本不出时间戳——所以一切定位靠「逐岛切音频 + 岛起点」 |

## 3. 工作分解（时间盒）

### A. 审计器（约 2h）——`temp/audit-anchor-unit.mjs`

对 97 门课逐门：

1. 能量岛重算（阈值 0.004、帧 0.05s、间隙合并 0.35s、滤 <0.12s；**只认 ≥0.5s 的岛做起点**，防答题停顿里的呼吸爆音幻影岛）；
2. 用 `extractDialogueAnchors(lines)` 取锚点序列，逐锚点输出四个指标：
   - `anchorOnset`：锚点源行 start − 最近岛起点（有向）；
   - `firstLineOnset`：区间内第一条**正文行**（非指令行，即不被锚点 lineIds 消费的行）start − 最近岛起点；
   - `boundary`：区间内行是否越界（start < anchor.start − 0.3）、区间首尾是否倒挂；
   - `coverage`：区间 [anchor.start, anchor.end) 是否覆盖区间内全部行的 [start,end)（高亮一致性）。
3. 全库正文行 onset 抽全量（不是抽样——每门音频一次 ffmpeg 解码，逐行查岛，纯本地计算）。
4. 产物：`temp/anchor-audit.json`（结构化，验收的**第一份证据**）+ 控制台汇总。

### B. MiMo 精修（约 4h）——`scripts/content/mimo-refine-lines.mjs`

只修审计超标的行，按优先级：

1. **P0 开场报头**（每套前 2 个锚点，已知偏 2–3s）：±30s 窗口找含 "Section A" / "Conversation One"（数字词归一）的岛，钉岛起点；
2. **P1 锚点区间首句**（`firstLineOnset` 超 ±1.5s）：正文前 4 词在 ±12s 候选岛里找连续命中（最长前缀优先，同分取近；**距离上限 10s** 防通用句式串位）；
3. **P2 锚点源行残留**（基线里 cet4 剩的 18 条晚 + 6 条早、cet6 3 条早）：复用 `mimo-refine-cet4.mjs` 的碰撞细分（同岛多行或正文前另有内容 → 0.18s 间隙细切重转）；
4. **P3 正文行**（onset 超 ±2s 且时长 ≥1.5s 的行）：同 P1 手法，但**只修偏晚**（截开头伤体验）；偏早 ≤3s 不修（多带一点上一句尾巴，风险大于收益）。

铁律（全部是前几轮踩过的坑，注释里都有）：
- 逐岛转写**必须落缓存**（`temp/mimo-refine-cache-lines/`），重跑零调用；
- 标签岛回溯必须排除组播报（"Questions one **to** four" 不是 Q1 的标签）；
- 同一岛被多行命中时按时间序**认领**（先到先得，匹配失败的行也按当前位置占岛）；
- 收尾单调化：重叠时**收回前一行终点**（不得低于其可读时长 词数×0.28s），否则推后本行；时长下限 `max(0.18, need×0.35+0.2)`；最后过一遍严格单调 + 负时长清零；
- 修正后行时长以岛尾为上限的，要补时长下限（否则时长门禁炸）。

### C. 结构校验（约 1h）

修正写库后重跑审计器：越界 0、倒挂 0、锚点区间连续（`next.start ≥ prev.start`，活跃锚点查询
对任意 t∈[0,时长] 命中且仅命中一个区间——用 `findDialogueAnchorAtTime` 抽验每门 20 个等距时刻）。

### D. 验收 + 报告（约 1h）

门禁全家（先 `--rebuild-baseline` 再跑）、幂等复扫、写报告 `temp/REPORT-anchor-refine.md`。

## 4. 验收标准（严格，逐条量化）

> 全部以 `temp/anchor-audit.json` 修正后复扫为准；任何一条不达标 = 任务未完成。

- **A1 覆盖**：97/97 门全部审计，无一门因「无音频/解析失败」跳过。
- **A2 锚点源行**：全库（cet4+cet6 合并统计）±1.2s 对齐率 **≥ 99.5%**；**偏晚 > 0.7s 的行 = 0**（基线 cet4 有 18 条 ≤1.7s，必须清零到 0.7s 以内）；偏早 ≤ 1.2s 的行 ≤ 5 条且全部有「真实起点在岛中部」的转写证据（缓存文件可查）。
- **A3 锚点区间首句**：±1.5s 对齐率 **≥ 97%**；偏晚 > 1s 的行全库 **≤ 3 条**。
- **A4 开场报头**：每门前 2 个锚点 ±1.5s 对齐 **100%**（97×2 = 194 个全对，这是用户第一印象，不容偏）。
- **A5 区间结构**：越界行 0、时间倒挂 0、负时长 0；锚点区间连续无缝隙无重叠；活跃锚点抽验（每门 20 时刻）误命中 0。
- **A6 门禁**：`check-invariants`（基线重建后）97/97 PASS；`check-duration-sanity` **新增违例 0**；`check-timeline-speech-overlap` cet4 与 cet6 双 PASS；`temp/v3.mjs` 缺题 0；`temp/final-check.mjs` 单调/重叠/负时长全 0。
- **A7 幂等**：审计器与精修器各复跑一遍，输出与首轮**完全一致**（缓存命中，MiMo 调用 0 次）。
- **A8 契约**：所有写库走 `saveTranscript` 先 dry 后 apply，`expect.lineDelta` 与实际一致；**禁止任何手拼 UPDATE / 白名单式重建行对象**；seed 版本递增（YYYYMMDD.N）；DB 与 seed 同步写入。
- **A9 MiMo 预算**：总调用 **≤ 2500 次**，失败率 < 1%（429 重试不计失败）；全程缓存落盘；不得为省调用量跳过 P0/P1。
- **A10 交付**：新增/修改脚本可重复执行（不依赖会话状态）；报告含基线→结果对照表、每类修正行数、MiMo 调用与 token 计数、未尽事项；git 提交信息按仓库惯例（中文，`fix(corpus): …` 格式）。

## 5. 红线（违反任何一条即返工）

1. **不得手写 SQL 改库**——唯一写入口是 `saveTranscript` 契约通道。
2. **不得改 `presets/` 下的原始音频与 seed 之外的内容**；不得动 `packages/domain`（锚点提取逻辑有问题就记录到报告，由主会话决定改法）。
3. **不得 `git push`**；提交留在本地分支，推送与发版由主会话复核后执行。
4. **事实源仲裁顺序**：音频词图（岛 + MiMo 转写）> 官方原文 > 现存行文本。题号冲突以音频为准（先例：#16 原文 22-25、音频 23-25），但**必须在报告中逐条列出**。
5. 每轮数据修复后必跑门禁；**警告逐条闭环**，禁止整类 dismiss。
6. MiMo 音频必须先切岛再送（≤60s）；禁止整段音频直传。

## 6. 常见的坑（前几轮全踩过，省你时间）

1. **Python heredoc 改 JS 会吃反斜杠**：正则写进脚本用 Edit 工具或字面量，改完必 `node --check`。
2. **`forEach` 里不能 `await`**：改 for 循环。
3. 数字词要归一（twelve→12、twenty-three→23、连字符去掉）；题干标签 "Question twenty-one." 会被非锚定正则解析成范围 20-21。
4. 幻影岛：答题停顿里的呼吸/爆音形成 0.1–0.3s 的岛，吸附只认 ≥0.5s。
5. 长话短说：`gh` 要在仓库目录跑；`start-all.mjs` 用 `Start-Process` 脱离会话拉起，否则停会话会带走服务。
6. seed 大 diff 若只是 `saveTranscript` 规范化空字段（去掉 `translations:{}` 等），不是内容变更——报告里说明即可。
7. 六级新课音频是 .ogg（不是 mp3/m4a），ffprobe/转码注意扩展名。

## 7. 一页速查

```bash
cd /c/Users/Zsc/Documents/duolinting

# 1) 审计（A）
node temp/audit-anchor-unit.mjs            # 产出 temp/anchor-audit.json

# 2) 精修（B）——先 dry 看 diff，再 apply
node scripts/content/mimo-refine-lines.mjs --dry
node scripts/content/mimo-refine-lines.mjs --apply

# 3) 结构校验（C）
node temp/audit-anchor-unit.mjs            # 复扫

# 4) 门禁（D）
node scripts/audit/check-invariants.mjs --rebuild-baseline
node scripts/audit/check-invariants.mjs
node scripts/audit/check-duration-sanity.mjs
node scripts/audit/check-timeline-speech-overlap.mjs cet4
node scripts/audit/check-timeline-speech-overlap.mjs cet6
node temp/v3.mjs
node temp/final-check.mjs
```

报告模板见 `temp/REPORT-anchor-refine.md`（自己建），至少含：基线/结果对照表、
修正统计（按 P0–P3 分类）、MiMo 调用数与失败数、题号以音频纠正的清单、未尽事项。

## 8. 交回后主会话做什么（供你判断边界）

复核 `temp/anchor-audit.json` 与报告 → 抽验 3 门（含 1 门六级新课）逐锚点人工听感 →
跑门禁确认 → push + 视情况发 v0.7.7。你只做数据与脚本，不做发布。
