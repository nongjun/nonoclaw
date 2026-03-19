# AGENTS.md — nonoclaw（龙虾军团）

> 本文件是 AI 编码助手理解本项目的入口。信息矛盾时以 `文档/` 目录为准。

## 项目定位

飞书 → Cursor AI 远程遥控桥接服务。用户在飞书发消息，server 转发给本地 Cursor Agent CLI 执行，结果通过飞书卡片回传。

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun 1.x + TypeScript（直接运行，无需编译） |
| 飞书 SDK | @larksuiteoapi/node-sdk（WebSocket 长连接） |
| 数据库 | SQLite（Bun 内置，向量索引 + FTS5） |
| 语音 | 火山引擎豆包 STT → whisper-cpp 兜底 |
| 向量 | 火山引擎豆包 Embedding API |
| 部署 | macOS launchd / Linux systemd（service.sh） |

## 目录结构

```
nonoclaw/
├── start.ts               # 启动入口（launchd/systemd 通过此文件启动）
├── gateway.ts             # Gateway 进程：飞书连接、Worker 管理、HTTP API
├── server.ts              # Worker 进程：Agent 调度、记忆/定时/心跳（可独立运行）
├── bridge.ts              # OpenAI API 桥接（供 OpenClaw 调用）
├── memory.ts              # 记忆管理器 v2（SQLite + 向量 + FTS5）
├── memory-tool.ts         # 记忆 CLI（Agent 通过 shell 调用）
├── scheduler.ts           # 定时任务调度器（cron-jobs.json 驱动）
├── heartbeat.ts           # 心跳系统（定期触发 HEARTBEAT.md 检查）
├── distill-chats.ts       # 对话蒸馏（从 Cursor 会话提取记忆）
├── sync-apple-notes.ts    # Apple Notes 同步
├── backfill-embeddings.ts # 向量嵌入回填工具
├── feishu/                # 飞书集成（17 个 .ts 文件）
├── templates/             # 工作区初始化模板
├── plugins/turix-cua/     # 桌面操控代理（AI 视觉 + 鼠标键盘）
├── .cursor/               # Cursor 配置（规则、agents、skills）
├── 参考代码/              # 参考项目集合（不参与构建）
├── 文档/                  # 结构化知识库（唯一真相源）
├── 架构.md                # 系统架构鸟瞰图
├── .env / .env.example    # 环境变量
├── package.json           # 项目依赖
└── service.sh / setup.sh  # 部署脚本
```

## 模块职责与依赖

Gateway-Worker 双进程架构。`start.ts` 为服务入口，import `gateway.ts`；Gateway spawn `server.ts` 作为 Worker。

- **start.ts** — 服务入口，依赖检查后 import gateway.ts
- **gateway.ts** — Gateway 进程，飞书 WebSocket、消息去重/解析、Worker 管理、飞书 HTTP API
- **server.ts** — Worker 进程，实例化 memory/scheduler/heartbeat（检测 `GATEWAY_URL` 决定 Worker 或独立模式）
- **memory.ts** — 记忆读写引擎，被 server.ts（Worker）实例化
- **memory-tool.ts** — 独立 CLI，供 Agent 通过 shell 调用记忆系统
- **distill-chats.ts** — 独立 CLI，定时从 Cursor 对话库提取记忆
- **scheduler.ts** — 读取 cron-jobs.json 驱动定时任务
- **heartbeat.ts** — 定期触发 HEARTBEAT.md 检查
- **bridge.ts** — 独立服务，OpenAI 兼容 API（供 OpenClaw）
- **feishu/** — 飞书功能集合
- **plugins/turix-cua/** — 独立 Python 进程，AI 桌面操控

## 工程纪律

1. **先策略后执行** — 复杂操作先输出方案，确认后再动手
2. **每次修改后自动审查** — 改完代码立即检查是否引入新问题
3. **对外交付标准** — 不是"能跑"，而是"用户不会踩坑"
4. **文档极简主义** — 详见 `文档策略.mdc`。Git 是唯一变更记录器，文档只记录代码无法表达的信息

## 六大闭环体系

### 1. 开发闭环：需求 → 代码 → 验证

规划（`/规划实施方案`）→ 编码（rules 自动加载）→ 自验证（`/审查刚才的文件与操作`）→ 质量评估（`/评估代码质量`）

### 2. 验证闭环：代码 → 测试 → 修复

报错/异常 → 调试专家 · 变更验证 → 测试专家 · 构建失败 → 构建修复师 · 完整流程 → 端到端测试专家 · 安全相关 → 安全卫士

### 3. 记忆闭环：经历 → 记录 → 蒸馏 → 召回

每次会话都是全新实例，**文件就是记忆**。完整协议见 `memory-protocol.mdc`。

**会话启动** → 读 SOUL.md / USER.md / 今日+昨日日记 / MEMORY.md
**会话中** → 重要决策、教训、偏好立即写入 memory 文件
**每 12h 自动蒸馏** → distill-chats.ts 提取对话 → Agent 提炼到 MEMORY.md

### 4. 心跳闭环：巡检 → 发现 → 处理 → 汇报

heartbeat.ts 每 30 分钟触发 → 读 HEARTBEAT.md 检查清单 → 启动 Agent 会话逐项检查（紧急事项/待跟进/任务阻塞）→ 无事返回 HEARTBEAT_OK / 有事飞书通知 → 定期后台维护（提炼记忆、清理过时信息）

飞书指令：`/心跳` 查看 · `/心跳 开启|关闭|执行` · `/心跳 间隔 N`

AI 拥有 HEARTBEAT.md 完全编辑权，清单过时时自主更新。

### 5. 调度闭环：定时 → 执行 → 反馈

用户飞书发指令 → server.ts 写入 cron-jobs.json → scheduler.ts 热加载 → 到点启动 Agent 执行 → 飞书卡片推送结果

管理：飞书自然语言自动创建 · `/任务` 查看/暂停/删除 · 直接编辑 cron-jobs.json

### 6. 知识沉淀闭环：经验 → 规则 → AI 自动遵循

```
踩坑/发现规律
  → /复盘并沉淀规则 → 直接写入 .cursor/rules/（不生成独立文件）
  → /提取本次经验   → 更新 .cursor/MEMORY.md
  → /从Git提取团队习惯 → 直接写入 .cursor/rules/（不生成团队习惯.md）
  → /更新项目文档   → 仅更新 文档/ 中长期有效的知识

团队用得越久，rules 越丰富，AI 越懂你——这就是飞轮效应。
```

自动提醒：编辑代码后提醒同步文档 · 提交前检测密钥 · 会话结束提醒经验沉淀

## 会话协议

### 首次启动（出生仪式）

若 `.cursor/BOOTSTRAP.md` 存在：弄清自己是谁（→ IDENTITY.md）→ 弄清用户是谁（→ USER.md）→ 聊 SOUL.md 边界 → 删除 BOOTSTRAP.md

### 每次会话启动

依次读取：SOUL.md → USER.md → 今日+昨日日记 → MEMORY.md（主会话）。不需请示，直接做。

## 关键设计决策

1. **零提示词污染** — 飞书消息直传 Cursor CLI，server 不拼接 system prompt
2. **身份/规则自动注入** — `.cursor/rules/*.mdc` 的 alwaysApply 机制
3. **记忆自主调用** — Agent 通过 memory-tool.ts CLI 自主管理，server 不注入
4. **会话连续性** — Cursor CLI `--resume` 参数
5. **热更换** — .env 和 projects.json 运行时热更换，无需重启

## 核心编码约束

**运行时：** 必须使用 Bun（不支持 Node.js 原生模块），包管理用 `bun`，TypeScript 直接运行不编译

**飞书卡片限制：** 详见 `agent-identity.mdc`「飞书输出限制」

**安全红线：** 详见 `安全红线.mdc`

## 文档知识库索引

`文档/` 是唯一真相源。

| 目录 | 内容 |
|------|------|
| [架构.md](架构.md) | 系统架构、模块依赖、部署拓扑 |
| [文档/设计文档/](文档/设计文档/) | 功能设计方案（标注验证状态） |
| [文档/核心信念/](文档/核心信念/) | 工程原则、编码规范 |
| [文档/参考资料/](文档/参考资料/) | API 文档、第三方对接 |
| [文档/质量评分/](文档/质量评分/) | 模块成熟度与改动风险 |
| [文档/凭据与配置/](文档/凭据与配置/) | Token、密码、环境变量 |
| [文档/变更日志/](文档/变更日志/) | 仅重大架构决策或破坏性变更 |

## 部署与运维

运行环境 macOS / Linux · 服务管理 `bash service.sh install/start/stop/restart/logs` · 启动 `bun run start.ts`（Gateway 模式）或 `bun run server.ts`（独立模式，调试用）· inbox/ 自动清理 24h 前临时文件 · 凭据见 [文档/凭据与配置/](文档/凭据与配置/)

## 核心体系保护名录

详见 `核心体系保护.mdc`。合并外部更新、git pull、重构清理时，必须验证受保护文件完整。

---

## 修改代码前必读

1. 先读 [架构.md](架构.md) 了解全貌，查 `文档/设计文档/` 和 `文档/质量评分/`
2. start.ts 为服务入口（import gateway.ts），gateway.ts spawn server.ts 作为 Worker；记忆系统区分 memory.ts（库）和 memory-tool.ts（CLI）
3. 遵守飞书卡片限制（详见 `agent-identity.mdc`）
4. 改完 → `/审查刚才的文件与操作` · 涉及安全 → 安全卫士审查
