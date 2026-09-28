<p align="center">
  <img src="docs/images/juting-logo.png" alt="句听 JuTing" width="220" />
</p>

# 句听 JuTing

> 真题听力 + 官方原文，一键变成精听课程。离线运行，数据全在本机。

基于 [多邻听 DuolinTing](https://github.com/VeejaLiu/duolinting)（Apache-2.0）二次开发，面向大学英语四/六级听力备考深度定制。

## 功能

- **三阶段精听**：泛听热身 → 逐句学习（按句播放/变速/标记难点）→ 难点复习
- **真题批量建课**：音频文件夹 + 官方听力原文，自动建课并发布，已实测 38 门连续处理
- **本地 ASR 转写**：whisper.cpp 离线识别，自动断句，硬件探测 + 一键准备
- **真题锚点**：Section / Conversation / Passage / Recording / 题组标签，点击跳转
- **波形自由听**：整段音频波形，拖到哪播到哪
- **零依赖部署**：便携 MySQL + 本地磁盘存储，双击 .bat 启动，无需 Docker
- **中文优先**：默认简体中文，可切换语言

## 快速开始

需要 Node.js 20+。

```bash
npm install
cp .env.example .env
npm run dev
```

Windows 推荐双击 `启动句听.bat`（自动拉起 MySQL、后端、学习端、管理端）。

首次使用自动切分需要安装 [whisper.cpp](docs/asr-auto-segmentation.md)，装好后制课台会自动检测并提示下载模型。

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
| `scripts/local` | 单机启动器 |
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
