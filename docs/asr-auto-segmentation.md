# 自动切分（本地离线语音识别）与对话锚点

句听的制课流程默认是「上传媒体 → 导入字幕 → 在波形上人工校准」。本模块在
「导入字幕」这一步之前补上一个可选的自动化环节：把课程音频交给部署本机的
whisper.cpp 转写成带时间戳的逐句 SRT，一键导入波形编辑器，创作者只需微调。

同时，Web 学习端会从字幕里的**指令句**（四六级真题音频中的「听下面一段对话，
回答第8至11题」等）自动推导**对话锚点**，学习者点击即可跳到对应题组/对话的开头。

## 隐私与边界

- 音频只在后端部署本机处理：MinIO → 本机临时目录 → 本地 whisper 进程，
  任务结束立即删除临时文件。不调用任何云端 ASR，音频不会离开部署机器。
- 识别结果缓存于数据库 `media_asr_jobs` 表。同一个「媒体对象 × 模型 × 语言」
  只识别一次；重复发起会直接命中缓存返回（界面会提示「命中缓存」）。
- 功能默认关闭（`ASR_ENABLED=false`），未部署 whisper 的实例完全不受影响。

## 架构

```text
制课工作台（admin）
  └─ 字幕导入/导出抽屉 →「自动切分（语音识别）」面板
        │  POST /api/v1/admin/exercises/:id/asr-jobs
        ▼
后端（Express）
  ├─ 权限：与字幕编辑一致（超管或被指派贡献者）
  ├─ 缓存：media_asr_jobs 查 (bucket, object, etag, model, language)
  ├─ 队列：进程内串行（ASR_MAX_CONCURRENCY，默认 1）
  └─ 执行：general/media/asr/whisper-runner.ts
        ├─ MinIO 下载媒体到临时目录
        ├─ ffmpeg 转 16kHz 单声道 WAV（whisper.cpp 要求）
        ├─ whisper-cli -l <lang> -osrt 生成 SRT
        └─ 解析 SRT → segments + srt_text 写回任务行
        ▼
Admin 面板轮询 GET /api/v1/admin/asr-jobs/:id
  └─ 成功后「导入为逐句字幕」→ 走既有 parseSubtitleDraft → 波形人工微调
```

数据结构（`packages/domain/src/domain.ts`）：

- `MediaAsrJob`：任务状态（pending/running/succeeded/failed）、进度、
  `segments`（`{start,end,text}[]`，秒）与 `srtText`（可直接导入的 SRT 文本）。
- `DialogueAnchor`：学习端锚点（`label/start/end/lineIds`）。

## 部署 whisper.cpp

### 1. 编译或下载可执行文件

- Windows：从 [whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases)
  下载预编译包（含 `whisper-cli.exe`），或用 Visual Studio/CMake 自行编译。
- Linux/macOS：`git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp && cmake -B build && cmake --build build -j --config Release`
  产物在 `build/bin/whisper-cli`。

### 2. 下载模型

四六级音频是「中文指令 + 英文正文」混听，需要**多语种模型**：

```bash
# 推荐：multilingual small（约 466MB，CPU 可跑，中英准确率均衡）
# faster 选项：multilingual base（约 142MB，准确率略低）
bash ./models/download-ggml-model.sh small
# Windows 手动下载（HuggingFace 直连失败可用 hf-mirror 镜像）：
# https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
# https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

### 3. 配置 backend/.env

```ini
ASR_ENABLED=true
ASR_WHISPER_BIN=/opt/asr/whisper-cli          # Windows 示例：D:/asr/whisper-bin/whisper-cli.exe
ASR_WHISPER_MODEL=/opt/asr/models/ggml-small.bin
ASR_LANGUAGE=auto          # 也可固定 en 或 zh
ASR_INITIAL_PROMPT=        # 见下方「提示词与繁体中文」说明，混合音频保持为空
ASR_FFMPEG_BIN=ffmpeg      # 需要系统装有 ffmpeg
ASR_MAX_CONCURRENCY=1
ASR_MAX_MEDIA_MB=200
ASR_WORK_DIR=              # 留空用系统临时目录
```

> Windows 预编译包里同时有 `main.exe` 与 `whisper-cli.exe`：`main.exe`
> 现在是弃用占位程序（只打印警告即退出），务必把 `ASR_WHISPER_BIN`
> 指向 `whisper-cli.exe`。

### 提示词与繁体中文（实测结论）

whisper 的中文输出常为繁体，官方惯用法是给 `--prompt` 传简体提示词
（如「以下是普通话的句子。」）。但**实测发现：中文提示词在 auto 语言下会把
英文段落整体吞掉**（24 秒中英混听只剩中文 2 段）。因此：

- 中英混合的四六级音频：`ASR_LANGUAGE=auto` 且 `ASR_INITIAL_PROMPT` 留空。
  此时中文指令句可能输出为繁体——这不影响对话锚点，锚点提取内置了指令句
  繁转简兜底（「聽下面一段對話，回答第八至十一題」照样得到「第8–11题」锚点）。
- 纯中文材料：可设 `ASR_LANGUAGE=zh` + `ASR_INITIAL_PROMPT=以下是普通话的句子。`
  获得简体输出。
- 性能参考：24 秒中英混听，small 模型 + 16 核 CPU（无显卡）约 9 秒完成。

重启后端后，管理后台「字幕导入 / 导出」抽屉顶部会出现「自动切分」面板并显示
引擎状态；`configured=false` 时面板会提示缺失的部署步骤。

### 4. 数据库迁移

Flyway 迁移在 `npm run infra:up && npm run db:migrate`（或
`npm run db:migrate:backend`）时自动执行 `V202609230001__media_asr_jobs.sql`，
无需手工建表。

## 制课流程怎么用

1. 在制课工作台上传音频（系统自动创建草稿课程并绑定媒体）。
2. 打开「字幕导入 / 导出」抽屉，在「自动切分」面板选择识别语言（四六级建议
   `自动检测`），点击「开始自动切分」。
3. 等待识别完成（面板显示阶段进度；同一音频再次点击会直接命中缓存）。
4. 「导入为逐句字幕」一键导入波形编辑器；或先「填入字幕草稿框」人工微调后再导入。
5. 在波形上校准时间轴、补充翻译，正常保存/提交课程。

> 建议**保留**音频里的中文指令句字幕（「听下面一段对话，回答第8至11题」）。
> 学习端的对话锚点正是从这些行推导的；删除它们会导致锚点消失。

## 对话锚点（学习端）

`extractDialogueAnchors`（`packages/domain/src/dialogueAnchors.ts`）是纯函数，
泛听/精听阶段实时从课程字幕推导锚点，无需存储：

- 中文指令：「听下面一段对话，回答第8至11题」→ 锚点「第8–11题」；
  「请听下面第一段独白」→「独白 1」；「第一节」→「第1节」。
- 英文指令（六级新题型）：`Text 1` / `Conversation One` / `Section A` → 对应锚点。
- 相邻指令行（如题号句 + 「现在你有10秒钟时间阅读这两小题」）合并为一个锚点，
  点击一次即跳到指令块开头。
- 泛听阶段点击锚点 = 跳转并连续播放该段；精听阶段 = 定位到该段第一句并逐句播放。
- 当前区间锚点在锚点条上高亮。

制作者可以在校波台修正 ASR 识别出的指令句文本，学习端下一次打开课程即得到
修正后的锚点——锚点永远跟随字幕，不存在两份数据漂移。

## 生产部署（Docker）

后端容器需要包含 `ffmpeg` 与 whisper 可执行文件、模型文件。两种做法：

1. **镜像内安装**（推荐）：在 backend 的 Dockerfile 里加
   `apt-get install -y ffmpeg`，并把静态链接的 `whisper-cli` 与 `ggml-*.bin`
   拷贝进镜像（构建阶段下载或用多阶段构建编译）。
2. **卷挂载**：保持镜像不变，在 `docker-compose.prod.yml` 的 backend 服务挂载
   `- /opt/asr:/opt/asr:ro`，环境变量指向 `/opt/asr` 下的可执行文件与模型。

`ASR_ENABLED=false`（默认）时无需任何改动；面板显示未启用，接口拒绝创建任务。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 面板显示「未启用」 | 检查 `ASR_ENABLED` 是否为 `true`，`ASR_WHISPER_BIN`/`ASR_WHISPER_MODEL` 指向的文件是否存在 |
| 任务失败：找不到 ffmpeg | 安装 ffmpeg 或把 `ASR_FFMPEG_BIN` 指向可执行文件 |
| 任务失败：whisper 退出码非 0 | 任务行 `error_message` 保留 stderr 末尾，常见为模型与可执行文件版本不匹配 |
| 任务失败：进程立即退出且无输出 | `ASR_WHISPER_BIN` 指到了 `main.exe`（弃用占位程序），改用 `whisper-cli.exe` |
| 英文段落没被识别 | 检查是否设置了中文 `ASR_INITIAL_PROMPT`——中文提示词在 auto 语言下会抑制英文段落，混合音频应留空 |
| 中文识别效果差 | 换更大的 multilingual 模型（medium/large-v3），或在面板显式选「中文」 |
| 识别为空 | 检查音频是否有效（`ffprobe`），或音频语言与所选语言不符 |

## 本地排障（不依赖数据库）

转写核心与媒体下载解耦为 `transcribeLocalFile`（`backend/src/general/media/asr/whisper-runner.ts`），
对本地文件直接调用同一段生产代码。排障脚本模式：

```js
process.env.ASR_WHISPER_BIN = '<whisper-cli 路径>'
process.env.ASR_WHISPER_MODEL = '<ggml 模型路径>'
const { transcribeLocalFile, segmentsToSrt } = await import(
  '<仓库>/backend/src/general/media/asr/whisper-runner.ts'
)
console.log(await transcribeLocalFile('<音频文件>', 'auto'))
```
