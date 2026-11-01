# exam-import —— 2015/2016 缺题十门的补题工具链（一次性，已执行完）

> 2026-11-01 迁入。**产物已固化在 `presets/cet6/seed.json` v20261101.1（commit 06da628）**，
> 重跑这些脚本不会再改变什么——留在这里是为了可复现与溯源，不是因为还要跑。

## 背景

48 门六级真题里有 10 门（53–62：2015 年 6/12 月各 3 套、2016 年 6/12 月各 2 套）原本只有
字幕没有题目，不能开考、不进刷题题池。本目录脚本把它们补齐到 25 题/门 + 答案钥匙。

## 各文件

| 脚本 | 作用 | 素材 |
|---|---|---|
| `match-papers.cjs` | 用录音文字稿 40 字片段重合率判定「课程 ↔ 试卷」对应（比标题可靠，6 门全命中，次高 0.1–1.8%） | `materials/papers/*.txt` + 库内 transcript |
| `parse-cet-paper.cjs` | 从 pdftotext 的试卷文本解析题干/选项 | `materials/papers/*.txt` |
| `verify-answers.cjs` | 用选项文本反查校验「答案库 ↔ 试卷」同卷（2016 四套 20/20、16/16、17/17、12/12 逐字对上） | 同上 |
| `import-papers.cjs` | 2016 四套（59–62）写库：题目/选项取试卷 PDF，答案取 GitHub `1837620622/cet6-hearing-prediction-system` 题库 | `materials/papers/` |
| `lazynote-import.cjs` | 2015 六套（53–58）写库：题目/选项取懒笔记卷面页，答案取同套解析页「逐题给出答案」摘要 | `materials/lazynote*.html`、`materials/lazynote/` |

题干行重建（411 条 stemLineId）不在这里——已迁为正式脚本 `scripts/content/rebuild-question-stems.mjs`。

## ⚠️ 2015 六套的版本口径（HANDOFF-2026-11-01 §2.3）

这 6 门音频**不是官方旧题型原卷的原样**（官方 2015 卷 = 8 短对话 + 2 长对话 + 3 短文 + 听写；
这 6 门 = 2 长对话 + 2 短文 + 3 讲座，题号整体重排且多 1 题），但卷子本身是官方的
（课 53 第 1–7 题 = 官方第 9–15 题，答案逐题一致）。准确说法是
**「与官方旧题型原卷结构不同的版本」**——不要写「重录」（无实证）。
后果：这 6 门题号与网上流传的官方答案编号**对不上**，核对只能按内容对。

## 素材出处

- `papers/*.pdf`：用户提供的真题试卷 PDF（pdftotext 产出的 .txt 同目录）。
- 懒笔记 HTML：公开网页存档（卷面 + 解析页）。
- GitHub 题库：`1837620622/cet6-hearing-prediction-system`（2016 答案来源，经选项反查校验）。

## 运行注意（如确要重跑）

- 连接 `127.0.0.1:3307` 的 MySQL——**先确认 3307 上是谁**（dev 栈或现役实例栈，两套库同 schema），
  写错过库就要重来。写库前脚本自动落 `temp/exam-mode/questions-backup-*.json`（含旧值）。
- 写的是 `questions_json` / `answer_key_json`，**不碰 transcript**（transcript 必须走
  `scripts/audit/data-contract.mjs` 的 `saveTranscript`，见译文冲掉事故）。
- 改完库要固化：`node scripts/local/export-preset.mjs --env-file <对应 portable.env> --preset cet6 --version <新版本>`。
