<p align="center">
  <img src="docs/images/juting-logo.png" alt="句听 JuTing" width="220" />
</p>

# 句听 JuTing

> 真题听力 + 官方原文，一键变成精听课程。离线运行，数据全在本机。

基于 [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting)（Apache-2.0）二次开发，面向大学英语四/六级听力备考深度定制。

## 功能

- **三阶段精听**：泛听热身 → 逐句学习（按句播放/变速/标记难点）→ 难点复习
- **六级真题内置**：2017—2026 共 38 套真题，音频 + 官方原文 + 句级锚点 + 全量中文译文 + 25 题选择题与答案钥匙
- **四级真题内置**：2015—2026 共 49 套真题，音频 + 官方原文 + 句级锚点 + 译文 + 25 题选择题与答案钥匙
- **真题锚点**：Section / Conversation / Passage / Recording / 题组标签，点击跳转
- **波形自由听**：整段音频波形，拖到哪播到哪
- **全量中文译文**：泛听歌词式滚动字幕、逐句精听卡均带译文（可随时关闭）
- **模拟实战**：整卷连播、按听力部分开窗作答、交卷评分、错题一键跳回句听（各套真题选择题全内置）
- **对答案**：每套真题 25 题答案钥匙内置，题组标签一键显示
- **学习仪表盘**：每日目标、掌握趋势、章节按"进行中/未开始/已完成"分类
- **零依赖部署**：运行环境已随包内置（Node + 便携 MySQL + 本地磁盘存储），解压后双击发布包根目录的 `句听.exe` 即用（托盘常驻，`启动句听.bat` 保留作开发者/排障备用），无需 Docker、无需自行安装任何环境
- **内置一键更新**：托盘右键 →「检查更新」，检测到新版本后一键下载覆盖安装，学习数据留在本机不受影响（网络受限时也可到 Releases 手动下载覆盖）
- **中文界面**：界面与译文固定简体中文；播放倍速、字幕/译文默认状态可按习惯设置

## 下载安装（Windows）

到 [Releases](https://github.com/zzz-sc-tech/juting/releases) 下载：

| 包 | 内容 | 适合 |
| --- | --- | --- |
| `juting-vX-win-full-cet6.7z`（六级版） | 程序 + 38 套六级真题（音频/原文/译文/选择题与答案） | 备考六级、开箱即练 |
| `juting-vX-win-cet4.7z`（四级版） | 程序 + 49 套四级真题（音频/原文/译文/选择题与答案） | 备考四级、开箱即练 |

解压到任意文件夹 → 双击 `句听.exe` → 首次运行自动初始化并导入课程，随后浏览器自动打开学习端。日常操作用托盘图标（左键开学习端，右键菜单停止并退出）；`启动句听.bat` / `停止句听.bat` 保留作备用。两个版本各自独立、各带一份运行环境与学习数据，请分别解压到不同文件夹，且不要同时运行（服务端口固定）。详见[使用说明](使用说明.md)。

## 开发运行

需要 Node.js 20+。数据库两条路任选：Windows 本机直接双击 `启动句听.bat` 拉起便携 MySQL（3307，账号 duolinting/duolinting）；或走 Docker（`npm run infra:up`，见 AGENTS.md）。

```bash
npm install
cp .env.example .env
npm run dev          # backend 读 backend/.env，首次参考 AGENTS.md 的初始化步骤
```

Windows 本机全栈也可双击 `启动句听.bat`（自动拉起 MySQL、后端、学习端、管理端，无需 Docker）。


## 预设课程机制

`presets/cet6/seed.json`（六级 38 套）与 `presets/cet4/seed.json`（四级 49 套）保存课程元数据与官方原文（入 git）；
音频媒体只随发布包分发（二进制不进 git）。首次启动时
`scripts/local/import-preset.mjs` 自动把种子写入数据库并把媒体硬链进 media-store；
内容更新用 `scripts/local/export-preset.mjs` 重新导出并递增版本号。

## 批量建课

后台「课程管理 → 批量上传」支持音频与字幕文件（srt 等）按文件名自动配对建课；
文字稿质量的内容推荐用官方原文/字幕导入，不依赖语音识别。

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `web-app` | 浏览器学习端 |
| `admin` | 内容管理后台 |
| `backend` | 后端 API |
| `packages/*` | 共享类型与工具包 |
| `presets/*` | 内置预设课程（六级/四级真题种子与媒体） |
| `scripts/local` | 单机启动器、预设导入导出、发布打包 |
| `scripts/content` | 内容生产线脚本 |

## 文档

- [使用说明](使用说明.md)
- [与上游的差异](docs/upstream-differences.md)

## 致谢

- [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting) —— 本项目基于其早期版本构建
- [YouZack](https://www.youzack.com/) —— 灵感来源
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) —— 离线语音识别引擎（内容管线内部依赖）

## 许可

[Apache License 2.0](LICENSE)
