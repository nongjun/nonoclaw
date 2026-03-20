# MEMORY.md - 长期记忆

_这是你的长期记忆。记录重要的决策、偏好、持久的事实。_
_每日笔记在 `.cursor/memory/YYYY-MM-DD.md`。这里是提炼后的精华。_

---

## 身份

### 2026-03-20 维护虾
- 用户给 AI 起名为「维护虾」，专门负责管理测试开发服务器（120.79.242.43）
- 身份已写入 `.cursor/IDENTITY.md`

## 项目决策

### 2026-03-20 STT 架构：Node.js 子进程方案
- **决策**：语音识别（火山引擎 STT）从 server.ts 内联 WebSocket 改为独立脚本 `volc-stt.cjs`，用 Node.js 运行
- **原因**：Bun 的 WebSocket 客户端在此服务器网络环境下无法连接火山引擎 API（Mihomo/Clash 代理干扰），而 Node.js 的 `ws` 库正常工作
- **附带收益**：火山引擎 STT API 原生支持 OGG/Opus 格式，去掉了 ffmpeg 依赖，链路更简单

### 2026-03-20 代码合并策略：远程为基础 + 本地修复叠加
- 合并 GitHub 远程代码时，策略为「用远程版本为基础（含钉钉多渠道等新功能），在上面叠加本地的 STT 修复」
- `backfill-embeddings.ts` 保留本地版（有 SQLite 路径修复）

### 2026-03-20 钉钉渠道支持已合入但未启用
- 远程仓库包含完整的钉钉渠道支持（AsyncLocalStorage + 多 IM 路由 + dingtalk/ 目录），代码已合入本地
- `dingtalk-stream` 依赖在此服务器上安装失败，钉钉功能暂不可用但代码结构保留

## 偏好和习惯

### 2026-03-20 用户沟通方式
- 用户通过飞书发消息（含语音），语音自动转文字
- 用户会发指令让 AI 对比文件差异、逐步合并代码，喜欢先看分析再决定方案
- 用户偏好「先策略后执行」——让 AI 先分析差异和方案，确认后再动手

### 2026-03-20 用户技术参与度
- 用户不写代码但能看懂技术摘要，会主动要求对比文件、指定合并策略
- 用户会直接给出具体的技术方案选项（如 SSH vs Node 代理 vs 其他），让 AI 评估和执行

## 经验教训

### 2026-03-20 Bun WebSocket 在代理环境下不可靠
- Bun 替换了 `ws` 库的实现，其 WebSocket 客户端在有 Mihomo/Clash 代理的环境下可能无法正常连接外部 WebSocket 服务
- **对策**：涉及 WebSocket 外部连接的功能，如果 Bun 下不工作，考虑用 Node.js 子进程执行

### 2026-03-20 Git HTTPS 经 Clash 代理时 SSL 握手失败
- 服务器上 git 走 Clash HTTP 代理（127.0.0.1:7897）时，OpenSSL 在 CONNECT 隧道内握手出现 `SSL_ERROR_SYSCALL`
- 直连 GitHub HTTPS 反而正常
- **解决**：在 `.git/config` 中为 GitHub 单独禁用 HTTP 代理 `[http "https://github.com/"] proxy =`

### 2026-03-20 语音文件删除时机
- 旧代码在语音识别失败后也删除音频文件，导致 Agent 拿到的路径指向已删除的文件
- **正确做法**：只在语音识别成功后才删除音频文件；失败时保留，让 Agent 可以回退处理

## 服务器环境备忘

### 2026-03-20 网络特征
- 服务器有 Mihomo/Clash 代理（127.0.0.1:7897），部分场景会干扰 TLS
- `gh` CLI 通过代理可正常访问 GitHub API
- Git HTTPS 直连 GitHub 正常，经代理则 SSL 失败（已在 .git/config 中配置绕过）
- SSH 到 GitHub TCP 可通（含 proxychains4），但无可用 SSH 密钥
- ffmpeg 未安装，且当前方案已不需要
