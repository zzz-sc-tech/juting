<p align="center">
  <img src="docs/images/juting-logo.png" alt="句听 JuTing" width="220" />
</p>

# 句听 JuTing

> 真题听力 + 官方原文，一键变成精听课程。离线运行，数据全在本机。

基于 [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting)（Apache-2.0）二次开发，面向大学英语四/六级听力备考深度定制。

## 功能

- **三阶段精听**：泛听热身 → 逐句学习（按句播放/变速/标记难点）→ 难点复习
- **六级真题内置**：2017—2026 共 38 套真题，音频 + 官方原文 + 句级锚点 + 全量中文译文 + 25 题答案钥匙，完整版开箱即练
- **真题批量建课**：音频文件夹 + 官方听力原文，自动建课并发布，已实测 38 门连续处理
- **本地 ASR 转写**：whisper.cpp 离线识别，自动断句，硬件探测 + 一键准备
- **真题锚点**：Section / Conversation / Passage / Recording / 题组标签，点击跳转
- **波形自由听**：整段音频波形，拖到哪播到哪
- **全量中文译文**：泛听歌词式滚动字幕、逐句精听卡均带译文（可随时关闭）
- **对答案**：每套真题 25 题答案钥匙内置，题组标签一键显示
- **学习仪表盘**：每日目标、掌握趋势、章节按"进行中/未开始/已完成"分类
- **零依赖部署**：安装包自带 Node 与便携 MySQL + 本地磁盘存储，解压后双击 .bat 即用，无需 Docker、无需安装任何环境
- **中文优先**：默认简体中文，可切换语言

## 下载安装（Windows）

到 [Releases](https://github.com/zzz-sc-tech/juting/releases) 下载：

| 包 | 内容 | 适合 |
| --- | --- | --- |
| `juting-vX-win-full.7z` | 程序 + 38 套六级真题（音频/原文/锚点）+ whisper 本地识别 | 备考六级、开箱即练 |
| `juting-vX-win-lite.7z` | 仅程序本体 | 自己导课、体积敏感 |
| `juting-vX-cet6-pack.7z` | 六级真题包 | 简洁版事后补真题 |

解压到任意文件夹 → 双击 `启动句听.bat` → 浏览器自动打开学习端。详见[使用说明](使用说明.md)。

## 开发运行

需要 Node.js 20+。数据库两条路任选：Windows 本机直接双击 `启动句听.bat` 拉起便携 MySQL（3307，账号 duolinting/duolinting）；或走 Docker（`npm run infra:up`，见 AGENTS.md）。

```bash
npm install
cp .env.example .env
npm run dev          # backend 读 backend/.env，首次参考 AGENTS.md 的初始化步骤
```

Windows 本机全栈也可双击 `启动句听.bat`（自动拉起 MySQL、后端、学习端、管理端，无需 Docker）。

自动切分（ASR）：完整版随包自带 whisper.cpp；简洁版在制课台点「一键准备」自动下载引擎与模型。开发机手动部署见 [ASR 配置与排障](docs/asr-auto-segmentation.md)。

## 预设课程机制

`presets/cet6/seed.json` 保存 38 套真题的课程元数据与官方原文（入 git）；
音频媒体只随发布包分发（818 MB 二进制不进 git）。首次启动时
`scripts/local/import-preset.mjs` 自动把种子写入数据库并把媒体硬链进 media-store；
内容更新用 `scripts/local/export-preset.mjs` 重新导出并递增版本号。

## 批量建课

```bash
# 1) 后台 课程管理 → 批量上传 → 选择音频文件夹
# 2) 排队本地 ASR 自动切分
node scripts/content/batch-asr-publish.mjs
# 3) 用官方原文校对升级（文本 100% 准确）
node scripts/content/yuanwen-apply.mjs
```

## 项目结构

| 目录 | 用途 |
| --- | --- |
| `web-app` | 浏览器学习端 |
| `admin` | 内容管理后台 |
| `backend` | 后端 API |
| `packages/*` | 共享类型与工具包 |
| `presets/*` | 内置预设课程（六级真题种子与媒体） |
| `scripts/local` | 单机启动器、预设导入导出、发布打包 |
| `scripts/content` | 内容生产线脚本 |

## 文档

- [使用说明](使用说明.md)
- [ASR 配置与排障](docs/asr-auto-segmentation.md)
- [与上游的差异](docs/upstream-differences.md)

## 致谢

- [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting) —— 本项目基于其早期版本构建
- [YouZack](https://www.youzack.com/) —— 灵感来源
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) —— 离线语音识别引擎

## 许可

[Apache License 2.0](LICENSE)
