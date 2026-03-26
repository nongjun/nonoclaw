# nonoclaw

> Autonomous AI agent with persistent memory, heartbeat monitoring, scheduled tasks, and soul identity — powered by Cursor CLI, controlled via IM.

An AI agent that lives on your machine, remembers everything, checks in on its own, runs scheduled tasks, and grows a persistent identity. IM adapters (Feishu/Lark today, DingTalk and WeCom planned) are just the input channel — the core is the closed-loop agent system.

**[中文文档](#中文文档)** · **[服务器版安装指南](文档/安装帮助-服务器版.md)**

---

## Why

Cursor Agent CLI is powerful but ephemeral — every session starts from scratch with no memory of the last one. **nonoclaw** wraps it with persistent closed-loop systems:

- **Memory** — long-term recall across sessions, daily logs, semantic search, conversation distillation
- **Heartbeat** — periodic self-check and background maintenance
- **Scheduler** — AI-created cron jobs that execute autonomously
- **Soul & Identity** — persistent personality that evolves over time
- **Development Loop** — requirements → code → self-review → quality assessment
- **Knowledge Sediment** — lessons learned → auto-written rules → AI keeps evolving

IM (Feishu today, DingTalk/WeCom planned) is just one input adapter. The agent can also run headlessly via CLI or API bridge.

## Architecture

```
Phone (IM) ──WebSocket──→ Gateway ──HTTP──→ Worker ──Cursor CLI──→ Agent Systems
                          (gateway.ts)      (server.ts)                    │
                          │                 │                    --resume (continuity)
                     Feishu WS         ┌────┼──────┐
                     Dedup/Parse       │    │      │
                     Worker Mgmt    Text  Image  Voice
                     Feishu API                    │
                                       Volcengine STT / whisper
                                              │
                                       ┌──────┴──────┐
                                    Scheduler    Heartbeat
```

## Features

- **Multi-modal input**: text, images, voice messages, files, rich text
- **Session continuity**: auto-resume conversations per workspace
- **Voice-to-text**: Volcengine Doubao STT (primary, high-accuracy Chinese) → local whisper-cpp (fallback)
- **Live progress**: real-time streaming of thinking / tool calls / responses via Feishu cards
- **Elapsed time**: completion cards show total execution time
- **Session-level concurrency**: same session serializes; different sessions run in parallel — no global limits, Cursor CLI manages its own lifecycle
- **Project routing**: prefix messages with `project:` to target different workspaces
- **Hot reload**: edit `.env` to change API keys, models, STT config — no restart needed
- **Bilingual commands**: all Feishu commands support both English and Chinese
- **Security**: sensitive commands (like API key changes) are blocked in group chats
- **Smart error guidance**: auth failures auto-display fix steps with dashboard links
- **Model fallback**: billing errors auto-downgrade to `auto` model with notification
- **Memory system v2**: OpenClaw-style identity + memory with embedding cache, incremental indexing, FTS5 BM25 keyword search, and vector hybrid search
- **Autonomous memory**: Cursor decides when to search memories via `memory-tool.ts` (no server-side injection — the AI is in control)
- **Rules-based context**: all identity, personality, and workspace rules are loaded via `.cursor/rules/*.mdc` — no extra tool calls needed at session start
- **Scheduled tasks**: AI-created cron jobs via `cron-jobs.json` — supports one-shot, interval, and cron expressions
- **Heartbeat system**: periodic AI check-in via `.cursor/HEARTBEAT.md` with active hours, background maintenance, AI auto-management of checklist, and state tracking via `.cursor/memory/heartbeat-state.json`
- **Boot checklist**: `.cursor/BOOT.md` runs once on every server start for self-checks and online notifications
- **First-run ceremony**: `.cursor/BOOTSTRAP.md` guides the AI through its "birth" — choosing a name, personality, and getting to know its owner
- **Safety guardrails**: anti-manipulation, anti-power-seeking, and human-oversight-first rules baked into workspace rules
- **Memory recall protocol**: mandatory memory search before answering questions about past work, decisions, or preferences
- **Memory flush**: proactive memory persistence during long conversations to prevent context window overflow data loss
- **No mental notes**: strict rule enforcing file-based persistence over ephemeral "I'll remember that"
- **Auto workspace init**: first run auto-copies identity/memory templates to your workspace

## Quick Start

### 1. Prerequisites

- macOS with [Bun](https://bun.sh) installed
- [Cursor IDE](https://cursor.com) with Agent CLI (`~/.local/bin/agent`)
- A [Feishu](https://open.feishu.cn) bot app (WebSocket mode, no public URL needed)

### 2. Install & Configure

```bash
git clone https://github.com/nongjun/nonoclaw.git
cd nonoclaw
bun install

cp .env.example .env
# Edit .env with your credentials
```

### 3. Run

```bash
bun run start.ts              # Gateway mode (recommended)
# or
bun run server.ts             # Standalone mode (debugging)
```

You should see:

```
飞书长连接已启动，等待消息...
```

Send a message to your Feishu bot and watch Cursor work.

### 4. Auto-Start on Boot (Recommended)

```bash
bash service.sh install    # install + start via macOS launchd
bash service.sh status     # check if running
bash service.sh logs       # follow live logs
```

The service auto-restarts on crash and starts on boot — no manual intervention needed.

| Command | Description |
|---------|-------------|
| `bash service.sh install` | Install auto-start and launch now |
| `bash service.sh uninstall` | Remove auto-start and stop |
| `bash service.sh start` | Start the service |
| `bash service.sh stop` | Stop the service |
| `bash service.sh restart` | Restart the service |
| `bash service.sh status` | Show running status |
| `bash service.sh logs` | Tail live logs |

## Feishu Commands

All commands support Chinese aliases:

| Command | Chinese | Description |
|---------|---------|-------------|
| `/help` | `/帮助` `/指令` | Show help |
| `/status` | `/状态` | Service status (model, key, STT, sessions) |
| `/new` | `/新对话` `/新会话` | Reset workspace session |
| `/model name` | `/模型 name` `/切换模型 name` | Switch model |
| `/apikey key` | `/密钥 key` `/换key key` | Update API key (DM only) |
| `/stop` | `/终止` `/停止` | Kill running agent task |
| `/memory` | `/记忆` | Memory system status |
| `/memory query` | `/记忆 关键词` | Semantic search memories |
| `/log text` | `/记录 内容` | Write to today's daily log |
| `/reindex` | `/整理记忆` | Rebuild memory index |
| `/task` | `/任务` `/cron` `/定时` | View/manage scheduled tasks |
| `/heartbeat` | `/心跳` | View/manage heartbeat system |

**Project routing**: `projectname: your message` routes to a specific workspace.

## Voice Recognition

Two-tier STT with automatic fallback:

| Engine | Quality | Notes |
|--------|---------|-------|
| **Volcengine Doubao** | Excellent (Chinese) | Primary. Requires [Volcengine](https://console.volcengine.com/speech/app) account |
| **Local whisper-cpp** | Basic | Fallback. Install via `brew install whisper-cpp` |

Volcengine uses the [streaming speech recognition API](https://www.volcengine.com/docs/6561/1354869) via WebSocket binary protocol — optimized for short voice messages (5-60s).

## Configuration

Copy `.env.example` to `.env` and fill in your values:

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes | [Cursor Dashboard](https://cursor.com/dashboard) → Integrations → User API Keys |
| `FEISHU_APP_ID` | Yes | Feishu app ID |
| `FEISHU_APP_SECRET` | Yes | Feishu app secret |
| `CURSOR_MODEL` | No | Default: `claude-4.6-opus-high-thinking`（`agent models` 查看可用列表） |
| `VOLC_STT_APP_ID` | No | Volcengine app ID (skip to disable cloud STT) |
| `VOLC_STT_ACCESS_TOKEN` | No | Volcengine access token |
| `VOLC_EMBEDDING_API_KEY` | No | Volcengine embedding API key (for memory vector search) |
| `VOLC_EMBEDDING_MODEL` | No | Default: `doubao-embedding-vision-250615` |

### Feishu Bot Setup

1. Create an app at [Feishu Open Platform](https://open.feishu.cn)
2. Add **Bot** capability
3. Permissions: `im:message`, `im:message.group_at_msg`, `im:resource`
4. Events: subscribe to `im.message.receive_v1` via **WebSocket mode** (long connection)

### Project Routing

Create `../projects.json` (one level up from the bot directory):

```json
{
  "projects": {
    "mycode": { "path": "/path/to/code/project", "description": "Code project" },
    "strategy": { "path": "/path/to/strategy/docs", "description": "Strategy workspace" }
  },
  "default_project": "mycode"
}
```

Then in Feishu: `strategy: 帮我审阅这份季度规划` routes to the strategy workspace.

## Memory & Identity System

Inspired by [OpenClaw](https://github.com/openclaw/openclaw), the bot includes a full identity + memory framework that gives your AI persistent personality and long-term memory.

### Architecture

Like OpenClaw, all identity/personality/rules are injected at session start. In our case, Cursor's `.mdc` rules with `alwaysApply: true` serve as the injection mechanism — no server-side prompt manipulation needed.

```
templates/                        Shipped with the repo (factory defaults)
├── AGENTS.md                     Workspace instructions (Cursor auto-loads)
└── .cursor/
    ├── SOUL.md                   AI personality and principles
    ├── IDENTITY.md               Name, emoji, temperament
    ├── USER.md                   Owner profile and preferences
    ├── BOOTSTRAP.md              First-run ceremony (deleted after completion)
    ├── BOOT.md                   Startup self-check (runs on every server start)
    ├── MEMORY.md                 Long-term memory skeleton
    ├── HEARTBEAT.md              Heartbeat checklist template
    ├── TASKS.md                  Scheduled tasks documentation
    ├── TOOLS.md                  Capability list and tool notes
    └── rules/                    Cursor rules (auto-loaded every session)
        ├── soul.mdc              Personality, principles, style
        ├── agent-identity.mdc    Identity metadata + Feishu output limits
        └── ...                   (8 more rule files)

~/your-workspace/                 User's actual workspace (auto-initialized)
├── AGENTS.md                     Workspace instructions (Cursor auto-loads from root)
├── .cursor/
│   ├── SOUL.md                   Customized personality
│   ├── IDENTITY.md               AI's chosen identity
│   ├── USER.md                   Owner's real info
│   ├── MEMORY.md                 Real memories (AI-maintained)
│   ├── HEARTBEAT.md              Heartbeat checklist (AI auto-managed)
│   ├── BOOT.md                   Startup checklist
│   ├── TASKS.md                  Task documentation
│   ├── TOOLS.md                  Capability notes
│   ├── memory/                   Daily logs (YYYY-MM-DD.md)
│   │   └── heartbeat-state.json  Heartbeat check history
│   ├── sessions/                 Conversation transcripts (YYYY-MM-DD.jsonl)
│   └── rules/*.mdc              Customized rules (auto-loaded)
├── .memory.sqlite                Vector embeddings database
└── cron-jobs.json                Scheduled tasks (AI-writable)
```

### How It Works

1. **First run**: `server.ts` auto-copies rule templates + `.cursor/BOOTSTRAP.md` to workspace; first conversation triggers the "birth ceremony" where AI chooses its name and personality
2. **Every server start**: `.cursor/BOOT.md` runs once for self-checks and optional online notification
3. **Every session**: Cursor CLI auto-loads all `.mdc` rules — identity, personality, safety, tools, and constraints in context from the start
4. **Memory recall**: before answering about past work/decisions/preferences, AI searches `.cursor/MEMORY.md` + `.cursor/memory/*.md` (enforced by `memory-protocol.mdc`)
5. **Memory flush**: during long conversations, AI proactively saves key info to files before context overflow
6. **After each reply**: user message + assistant reply logged to session history
7. **Incremental indexing**: only re-embeds files that have actually changed (tracked by content hash)
8. **Full workspace indexing**: all text files in the workspace are indexed (`.md`, `.txt`, `.html`, `.json`, `.mdc`, etc.)
9. **Heartbeat state**: `.cursor/memory/heartbeat-state.json` tracks check history to avoid redundant work
10. **Feishu commands**: `/memory`, `/log`, `/reindex` for manual memory operations

### Customization

Edit the `.cursor/rules/*.mdc` files in your workspace to personalize:

- **`agent-identity.mdc`** — give your AI a name, emoji, and personality
- **`user-context.mdc`** — fill in your info so the AI serves you better
- **`soul.mdc`** — adjust core principles and behavioral boundaries
- **`tools.mdc`** — add servers, tools, and capability notes
- **`.cursor/MEMORY.md`** — the AI maintains this automatically, but you can edit it too

### Updating

`git pull` is safe for deployed instances:

- **Source code** updates normally — all instances share the same running code
- **Product templates** (`templates/`) update, but `ensureWorkspace()` never overwrites existing files
- **Instance data** (`.cursor/MEMORY.md`, `cron-jobs.json`, `.env`, etc.) is `.gitignore`d — untouched by upstream changes

The repo uses a four-layer architecture: **product** (`templates/` — what users get), **source** (running code), **harness** (`.cursor/`, `文档/`, `AGENTS.md` — dev tooling), and **instance data** (gitignored runtime data). See `AGENTS.md` for details.

## Roadmap

```
Phase 1: Bridge ✅ (current)
  ✅ Feishu ↔ Cursor CLI bridge
  ✅ Voice recognition (Volcengine + whisper fallback)
  ✅ Bilingual command system
  ✅ Streaming progress + session-level concurrency + session continuity
  ✅ Security (group chat protection, smart error guidance)

Phase 2: Smart Agent
  ✅ Persistent memory v2 (embedding cache, incremental indexing, FTS5 BM25, full workspace indexing)
  ✅ Autonomous memory (Cursor calls memory-tool.ts on demand — no server-side injection)
  ✅ Rules-based context (OpenClaw-style bootstrap via .cursor/rules/*.mdc — auto-loaded every session)
  ✅ Heartbeat monitoring (.cursor/HEARTBEAT.md + configurable intervals + active hours + state tracking)
  ✅ Scheduled tasks (AI-created cron jobs via cron-jobs.json file watching)
  ✅ First-run ceremony (.cursor/BOOTSTRAP.md — AI birth ritual)
  ✅ Boot checklist (.cursor/BOOT.md — startup self-checks)
  ✅ Safety guardrails (anti-manipulation, human-oversight-first)
  ✅ Memory recall protocol (mandatory search before answering about past)
  ✅ Memory flush (proactive persistence during long conversations)
  ✅ No mental notes (strict file-based persistence enforcement)
  🔲 Multi-user isolation (Feishu user_id → independent workspace/session)
  🔲 More IM support (Slack / Discord / Telegram / WeChat)

Phase 3: Platform
  🔲 Pluggable IM adapter architecture
  🔲 Web dashboard (task history, analytics, configuration)
  🔲 Webhook triggers (GitHub Events → auto agent execution)
  🔲 Team collaboration (shared agent resource pool)
```

## License

[MIT](LICENSE)

---

# 中文文档

## 这是什么

**nonoclaw** 是一个自主 AI Agent 系统，核心是六大闭环体系：

- **记忆闭环** — 跨会话长期记忆、每日日记、语义搜索、对话蒸馏，AI 不再"失忆"
- **心跳闭环** — 定期自检和后台维护，AI 自主管理检查清单
- **调度闭环** — AI 创建和执行定时任务，到期自动运行并通知
- **灵魂与身份** — 持久人格、原则、与主人的关系，跨会话一致
- **开发闭环** — 需求 → 编码 → 自验证 → 质量评估
- **知识沉淀闭环** — 踩坑经验 → 自动写入规则 → AI 持续进化

IM（目前支持飞书，钉钉和企微计划中）只是输入通道——在手机上发消息，你的服务器或 Mac 就自动执行任务。也支持 CLI 和 API 桥接模式。

## 快速开始

### 前置条件

| 项目 | 要求 |
|------|------|
| 系统 | macOS (Apple Silicon) |
| 运行时 | [Bun](https://bun.sh) |
| IDE | [Cursor](https://cursor.com) 已安装并登录 |
| CLI | Cursor Agent CLI (`~/.local/bin/agent`) |
| 语音(可选) | `brew install ffmpeg whisper-cpp` |

### 安装

```bash
git clone https://github.com/nongjun/nonoclaw.git
cd nonoclaw
bun install
cp .env.example .env
# 编辑 .env 填入你的凭据
```

### 启动

```bash
bun run start.ts             # 手动启动，Gateway 模式（推荐）
bun run server.ts            # 独立模式（调试用）
bash service.sh install      # 安装开机自启动（推荐）
```

安装自启动后，重启电脑会自动运行，崩溃也会自动恢复。管理命令见「日常运维」。

### 飞书机器人配置

1. 在[飞书开放平台](https://open.feishu.cn)创建企业自建应用
2. 添加**机器人**能力
3. 权限：`im:message`、`im:message.group_at_msg`、`im:resource`
4. 事件订阅：选择**长连接模式**，订阅 `im.message.receive_v1`
5. 将 App ID 和 App Secret 填入 `.env`

### 飞书指令

| 指令 | 中文别名 | 说明 |
|------|----------|------|
| `/help` | `/帮助` `/指令` | 显示帮助 |
| `/status` | `/状态` | 查看服务状态 |
| `/new` | `/新对话` `/新会话` | 重置当前工作区会话 |
| `/model 名称` | `/模型 名称` `/切换模型 名称` | 切换模型 |
| `/apikey key` | `/密钥 key` `/换key key` | 更换 API Key（仅限私聊） |
| `/stop` | `/终止` `/停止` | 终止当前运行的任务 |
| `/memory` | `/记忆` | 查看记忆系统状态 |
| `/memory 关键词` | `/记忆 关键词` | 语义搜索记忆 |
| `/log 内容` | `/记录 内容` | 写入今日日记 |
| `/reindex` | `/整理记忆` | 重建记忆索引 |
| `/任务` | `/cron` `/定时` | 查看/管理定时任务 |
| `/心跳` | `/heartbeat` | 查看/管理心跳系统 |

## 记忆与身份体系

灵感来自 [OpenClaw](https://github.com/openclaw/openclaw)，为你的 AI 赋予持久人格和长期记忆。

### 规则文件（每次会话自动加载）

和 OpenClaw 一样，所有身份/人格/规范在会话开始时自动注入上下文。Cursor 的 `.mdc` 规则（`alwaysApply: true`）就是注入机制——中继服务不做任何提示词拼接。

| 规则文件 | 用途 | 是否需要定制 |
|---------|------|------------|
| `soul.mdc` | AI 的灵魂、人格、原则 | 可选（默认已有不错的通用人格） |
| `agent-identity.mdc` | 身份元数据 + 飞书输出限制 | **推荐**（给 AI 起个名字） |
| `user-context.mdc` | 你的个人信息和偏好 | **推荐**（帮 AI 更好地服务你） |
| `workspace-rules.mdc` | 安全规则、操作边界 | 可选 |
| `tools.mdc` | 完整能力清单、服务器 | 按需添加 |
| `memory-protocol.mdc` | 记忆工具使用方法 | 一般不用改 |
| `scheduler-protocol.mdc` | 定时任务协议 | 一般不用改 |
| `heartbeat-protocol.mdc` | 心跳协议（触发、后台工作、自动管理） | 一般不用改 |
| `cursor-capabilities.mdc` | 能力决策树 | 一般不用改 |

### 数据文件

| 文件 | 用途 |
|------|------|
| `.cursor/MEMORY.md` | 长期记忆（AI 自动维护，也可手动编辑） |
| `.cursor/HEARTBEAT.md` | 心跳检查清单（AI 自主管理和更新） |
| `.cursor/BOOT.md` | 启动自检清单（每次服务启动执行） |
| `.cursor/memory/*.md` | 每日日记（自动生成） |
| `.cursor/memory/heartbeat-state.json` | 心跳检查历史（自动维护） |
| `.cursor/projects/root/agent-transcripts/` | 会话转录（Cursor CLI 自动记录） |
| `.memory.sqlite` | 向量嵌入数据库 |
| `cron-jobs.json` | 定时任务（AI 可写入） |

### 工作原理

1. **首次启动**：自动复制模板 + `.cursor/BOOTSTRAP.md`（出生仪式），AI 首次对话会自我介绍并与主人建立关系
2. **每次服务启动**：执行 `.cursor/BOOT.md` 启动自检，检查配置完整性并可选发送上线通知
3. **每次会话**：Cursor CLI 自动加载所有 `.mdc` 规则——身份、人格、安全、工具、约束从一开始就在上下文中
4. **记忆召回**：回答关于过去工作/决策/偏好的问题前，AI 必须先搜索记忆（由 `memory-protocol.mdc` 强制执行）
5. **记忆防丢失**：长对话中 AI 主动将关键信息写入文件，防止上下文窗口溢出导致数据丢失
6. **每条消息**：直接传给 Cursor，不拼接任何东西；完整对话记录由 Cursor CLI 自动保存到 `agent-transcripts/`
7. **全工作区索引**：工作区中所有文本文件都被索引（`.md` `.txt` `.html` `.json` `.mdc` 等）
8. **增量索引**：仅对变化的文件重新嵌入（按内容 hash 追踪），相同文本永不重复调 API
9. **定时任务**：AI 写入 `cron-jobs.json` 创建定时任务，到期自动执行并飞书通知
10. **心跳系统**：定期触发 AI 执行 `.cursor/HEARTBEAT.md` 清单，通过 `.cursor/memory/heartbeat-state.json` 追踪检查历史，AI 自主管理检查清单
11. **安全守则**：反操纵、反权力寻求、人类监督优先的安全规则内置于工作区规范中

### 定制

编辑 `.cursor/rules/` 下的 `.mdc` 文件即可个性化：

- `agent-identity.mdc` — 给你的 AI 起个名字
- `user-context.mdc` — 填入你的信息
- `soul.mdc` — 调整核心原则和行为边界
- `tools.mdc` — 添加服务器、工具备忘

### 更新安全

部署的实例可以放心执行 `git pull`：

- **源码**正常更新 — 所有实例共享运行代码
- **产品模板**（`templates/`）更新，但 `ensureWorkspace()` 不会覆盖已有文件
- **实例数据**（`.cursor/MEMORY.md`、`cron-jobs.json`、`.env` 等）已被 `.gitignore` 排除 — 不受上游更新影响

项目采用四层架构：**产品**（`templates/` — nonoclaw 本体）、**源码**（运行代码）、**马鞍工程**（`.cursor/`、`文档/`、`AGENTS.md` — 开发工具链）、**实例数据**（gitignored）。详见 `AGENTS.md`。

## 定时任务与心跳

### 定时任务

在飞书对话中告诉 AI 创建定时任务，AI 会自动写入 `cron-jobs.json`：

- "每天早上9点检查邮件" → cron 表达式
- "每小时检查服务状态" → 固定间隔
- "明天下午3点提醒我开会" → 一次性任务

管理指令：

| 指令 | 说明 |
|------|------|
| `/任务` | 查看所有定时任务 |
| `/任务 暂停 ID` | 暂停任务 |
| `/任务 恢复 ID` | 恢复任务 |
| `/任务 删除 ID` | 删除任务 |
| `/任务 执行 ID` | 手动触发 |

### 心跳系统

心跳系统每 30 分钟自动触发 AI 执行检查和后台维护。AI 会：

- 读取 `.cursor/HEARTBEAT.md` 检查清单，逐项执行
- 做后台工作（整理记忆、检查项目状态、更新文档）
- 自主管理 `.cursor/HEARTBEAT.md`（清单过时时自动更新）
- 无事回复 `HEARTBEAT_OK`，有值得告知的事通过飞书通知

| 指令 | 说明 |
|------|------|
| `/心跳 开启` | 启动心跳检查 |
| `/心跳 关闭` | 停止 |
| `/心跳 间隔 30` | 设为每 30 分钟 |
| `/心跳 执行` | 立即检查一次 |

详细的心跳协议见 `.cursor/rules/heartbeat-protocol.mdc`。

## 语音识别配置

**推荐开通[火山引擎](https://console.volcengine.com/speech/app)**：

1. 创建应用，获取 APP ID 和 Access Token
2. 开通「大模型流式语音识别」服务（资源 ID：`volc.bigasr.sauc.duration`）
3. 填入 `.env` 中的 `VOLC_STT_APP_ID` 和 `VOLC_STT_ACCESS_TOKEN`

不配置火山引擎时自动使用本地 whisper-tiny（质量较低但可离线工作）。

**降级链路**：火山引擎豆包大模型 → 本地 whisper-cpp → 告知用户

### 向量记忆搜索（可选）

配置火山引擎向量嵌入 API 启用语义记忆搜索：

1. 在 `.env` 中设置 `VOLC_EMBEDDING_API_KEY`
2. 默认模型：`doubao-embedding-vision-250615`（无需修改）
3. 首次启动自动索引工作区全部文本文件（`.md` `.txt` `.html` `.json` `.mdc` `.csv` `.xml` `.yaml` `.toml` 等，自动跳过 `.git`、`node_modules`、超大文件等）

## 项目路由

在上层目录创建 `projects.json`：

```json
{
  "projects": {
    "code": { "path": "/Users/你/Projects/myapp", "description": "代码项目" },
    "strategy": { "path": "/Users/你/Documents/战略", "description": "战略文档" }
  },
  "default_project": "code"
}
```

飞书中发送 `strategy: 帮我审阅季度规划` → 路由到战略文档工作区。

## 日常运维

### 服务管理（推荐）

使用 `service.sh` 管理服务，基于 macOS launchd，开机自启 + 崩溃自动恢复：

```bash
bash service.sh install    # 安装自启动并立即启动
bash service.sh status     # 查看运行状态
bash service.sh restart    # 重启服务
bash service.sh logs       # 查看实时日志
bash service.sh uninstall  # 卸载自启动
```

### 手动运行（调试用）

```bash
bun run start.ts                                         # 前台运行（Gateway 模式）
nohup bun run start.ts > /tmp/nonoclaw.log 2>&1 &   # 后台运行
bun run server.ts                                        # 独立模式（调试用）
```

### 其他

- **换 Key / 换模型**：飞书发 `/密钥 key_xxx...` 或 `/模型 sonnet-4`，无需重启
- **查看日志**：`bash service.sh logs` 或 `tail -f /tmp/nonoclaw.log`
- **API Key 失效**：飞书卡片会自动提示修复步骤 + Dashboard 链接

## 故障排查

| 问题 | 解决 |
|------|------|
| 飞书无响应 | `bash service.sh status` 检查进程；`bash service.sh restart` 重启；node_modules 损坏时删除后重新 `bun install` |
| API Key 无效 | 飞书发 `/密钥 新的key`，或编辑 .env |
| 语音识别出繁体/乱码 | 火山引擎配置有误，正在用 whisper 兜底，检查 VOLC_STT 配置 |
| `resource not granted` | 火山引擎控制台开通「大模型流式语音识别」 |
| 模型欠费 | 自动降级 auto，充值后恢复 |
| 群聊里发了 Key | 系统自动拦截，不会执行；建议到 Dashboard 轮换 Key |
