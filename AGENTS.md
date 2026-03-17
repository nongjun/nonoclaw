# AGENTS.md — nonoclaw（虾群平台版）

> 本文件是 AI 编码助手理解本项目的入口。所有信息矛盾时以 `文档/` 目录为准。

---

## 项目定位

飞书 → Cursor AI 远程遥控桥接服务。用户在飞书发消息，server 自动转发给本地 Cursor Agent CLI 执行，执行结果通过飞书卡片回传。灵感来自 OpenClaw。

---

## 技术栈

| 层 | 技术 |
|---|------|
| 运行时 | Bun 1.x + TypeScript（直接运行，无需编译） |
| 飞书 SDK | @larksuiteoapi/node-sdk（WebSocket 长连接） |
| 数据库 | SQLite（Bun 内置，记忆向量索引 + FTS5） |
| 语音 | 火山引擎豆包 STT → 本地 whisper-cpp 兜底 |
| 向量 | 火山引擎豆包 Embedding API |
| 部署 | macOS launchd / Linux systemd（service.sh 管理） |

---

## 目录结构

```
nonoclaw/
├── server.ts              # 主服务入口：飞书 WebSocket → Cursor Agent CLI
├── bridge.ts              # OpenAI API 桥接（供 OpenClaw 调用）
├── memory.ts              # 记忆管理器 v2（SQLite + 向量 + FTS5）
├── memory-tool.ts         # 记忆 CLI（Cursor Agent 通过 shell 调用）
├── scheduler.ts           # 定时任务调度器（cron-jobs.json 驱动）
├── heartbeat.ts           # 心跳系统（定期触发 HEARTBEAT.md 检查）
├── distill-chats.ts       # 对话蒸馏提取器（从 Cursor 会话中提取记忆）
├── sync-apple-notes.ts    # Apple Notes 同步
├── backfill-embeddings.ts # 向量嵌入回填工具
├── feishu/                # 飞书集成（17 个 .ts 文件）
├── templates/             # 工作区初始化模板
├── plugins/turix-cua/     # 桌面操控代理（AI 视觉 + 鼠标键盘操控）
├── .cursor/               # Cursor 配置（规则、agents、commands、skills）
├── 参考代码/              # 参考项目集合（不参与构建）
├── 文档/                  # 结构化知识库（唯一真相源）
├── 架构.md                # 系统架构鸟瞰图
├── .env / .env.example    # 环境变量
├── package.json           # 项目依赖
└── service.sh / setup.sh  # 部署脚本
```

---

## 模块职责与依赖

### 进程模型

单进程架构，`server.ts` 是唯一的进程入口。所有模块在同一进程内运行。

### 模块关系

- **server.ts** — 主进程，实例化 memory.ts、scheduler.ts、heartbeat.ts，导入 feishu/ 模块
- **memory.ts** — 被 server.ts 实例化，提供记忆读写能力
- **memory-tool.ts** — 独立 CLI 进程，供 Cursor Agent 通过 shell 调用记忆系统
- **distill-chats.ts** — 独立 CLI 进程，被 server.ts 定时调用，从 Cursor 对话数据库提取近期对话供 Agent 蒸馏记忆
- **scheduler.ts** — 被 server.ts 实例化，读取 cron-jobs.json 驱动定时任务
- **heartbeat.ts** — 被 server.ts 实例化，定期触发 HEARTBEAT.md 检查
- **bridge.ts** — 独立服务，提供 OpenAI 兼容 API（供 OpenClaw 调用）
- **feishu/** — 飞书功能集合，被 server.ts 通过 SDK 导入
- **plugins/turix-cua/** — 独立 Python 进程，AI 截屏→理解→操控鼠标键盘完成桌面任务

---

## 工程纪律

这三条原则贯穿所有工作，不可降级：

1. **先策略后执行** — 复杂操作先输出方案，等用户确认后再动手。避免"先射箭再画靶"。
2. **每次修改后自动审查** — 改完代码后，自动检查是否引入了新问题，不等用户来发现。
3. **对外交付标准思考** — 标准不是"代码能跑"，而是"用户不会踩坑"。

---

## 六大闭环体系

本项目的核心竞争力不是某个模块，而是六个互相增强的闭环系统。每个闭环都必须完整运转。

### 1. 开发闭环：需求 → 代码 → 验证

| 阶段 | 动作 | 工具/命令 |
|------|------|----------|
| 规划 | 理解需求，输出方案 | `/规划实施方案` |
| 编码 | 遵循规范实现 | `.cursor/rules/*.mdc` 自动加载 |
| 自验证 | 改完立即验证 | `/审查刚才的文件与操作` |
| 质量评估 | 综合评分 | `/评估代码质量` |

### 2. 验证闭环：代码 → 测试 → 修复

| 场景 | 自动调用 |
|------|---------|
| 代码出现报错或异常行为 | → 调试专家 |
| 代码变更后需要验证 | → 测试专家 |
| 构建失败或类型错误 | → 构建修复师 |
| 需要验证完整用户流程 | → 端到端测试专家 |
| 涉及用户输入、认证、API、敏感数据 | → 安全卫士 |

### 3. 记忆闭环：经历 → 记录 → 蒸馏 → 召回

这是 AI 实现连续性的核心。每次会话都是全新实例，文件就是记忆。

**日常闭环流程：**

```
每次会话开始
  → 读 .cursor/SOUL.md（我是谁）
  → 读 .cursor/USER.md（我在帮谁）
  → 读 .cursor/memory/YYYY-MM-DD.md（今天+昨天的日记）
  → 主会话时加载 .cursor/MEMORY.md（长期记忆）

会话进行中
  → 重要决策、教训、偏好 → 立即写入 memory 文件
  → 禁止"心理笔记"，文件才是真记忆

每 12 小时自动蒸馏（server.ts 调度）
  → distill-chats.ts 从 Cursor 对话数据库提取近期对话
  → 输出到 .cursor/memory/_chat-extract.md
  → Agent 自动从中提炼有价值信息到 .cursor/MEMORY.md
  → 分类：工作习惯 / 编码偏好 / 重要决策 / 教训 / 团队习惯
```

**记忆文件分工：**

| 文件 | 职责 | 更新方式 |
|------|------|---------|
| `.cursor/memory/YYYY-MM-DD.md` | 每日原始日志 | 会话中实时写入 |
| `.cursor/MEMORY.md` | 提炼后的长期记忆 | 手动 + 蒸馏自动 |
| `memory.ts` | 向量索引 + FTS5 搜索引擎 | server.ts 实例化 |
| `memory-tool.ts` | Agent 调用记忆的 CLI 接口 | Agent 通过 shell 调用 |

**铁律：写下来！** "心理笔记"是幻觉 — 会话结束即消失。想记住任何东西 → 立刻写到文件。

### 4. 心跳闭环：巡检 → 发现 → 处理 → 汇报

心跳不是形式上的 ping，而是有意义的自主巡检。

**运转机制：**

```
heartbeat.ts 定时触发（默认 30 分钟）
  → 读取 .cursor/HEARTBEAT.md 获取检查清单
  → 启动独立 Cursor Agent 会话执行检查
  → Agent 按清单逐项检查：
      · 有没有紧急事项？
      · .cursor/memory/ 有待跟进的吗？
      · 任务是否阻塞？
      · 白天未联系超 4 小时 → 考虑轻量级问候
  → 无事返回 HEARTBEAT_OK
  → 有事自动通过飞书通知用户
  → 定期做后台维护：提炼记忆、清理过时信息、更新清单
```

**飞书控制指令：**

| 指令 | 说明 |
|------|------|
| `/心跳` | 查看心跳状态 |
| `/心跳 开启` | 开启心跳检查 |
| `/心跳 关闭` | 关闭心跳检查 |
| `/心跳 执行` | 立即执行一次 |
| `/心跳 间隔 N` | 设置间隔（分钟） |

**AI 拥有 `.cursor/HEARTBEAT.md` 的完全编辑权。** 清单过时时自主更新，不需要请示。

### 5. 调度闭环：定时 → 执行 → 反馈

```
用户在飞书说"每天早上9点检查邮件"
  → server.ts 解析意图，写入 cron-jobs.json
  → scheduler.ts 监听文件变更，热加载任务
  → 到点自动启动 Cursor Agent 会话执行
  → 结果通过飞书卡片推送
```

**管理方式：**

| 方式 | 说明 |
|------|------|
| 飞书自然语言 | "每小时检查一次服务状态" → 自动创建 |
| 飞书指令 | `/任务` 查看 · `/任务 暂停 ID` · `/任务 删除 ID` |
| 直接编辑 | 修改 `cron-jobs.json`，scheduler 自动热加载 |

### 6. 知识沉淀闭环：经验 → 文档 → 规则

```
完成一次有价值的工作
  → /复盘并沉淀规则  → 提取可复用的经验写入 .cursor/rules/
  → /提取本次经验    → 更新 .cursor/MEMORY.md
  → /更新项目文档    → 同步 文档/ 目录
  → /从Git提取团队习惯 → 自动生成 文档/团队习惯.md
```

**钩子自动提醒：**
- 编辑代码文件后 → 提醒是否需要同步更新文档
- 提交 prompt 前 → 自动检测是否包含密钥
- 会话结束时 → 提醒经验沉淀

---

## 会话协议

### 首次启动（出生仪式）

如果 `.cursor/BOOTSTRAP.md` 存在，按引导完成：
1. 弄清楚自己是谁 → 写入 `.cursor/IDENTITY.md`
2. 弄清楚用户是谁 → 写入 `.cursor/USER.md`
3. 聊聊 `.cursor/SOUL.md` 的边界和偏好
4. 完成后删除 `BOOTSTRAP.md`

### 每次会话启动

在做任何事之前，依次读取：
1. `.cursor/SOUL.md` — 我是谁
2. `.cursor/USER.md` — 我在帮谁
3. `.cursor/memory/YYYY-MM-DD.md`（今天 + 昨天） — 最近发生了什么
4. 主会话时加载 `.cursor/MEMORY.md` — 长期记忆

不需要请示，直接做。

### 你是 Cursor Agent

你不是受限的聊天机器人。你运行在 Cursor Agent 内，拥有完整的文件系统、Shell、网络、浏览器、代码、子 Agent 能力。

**不要说"我做不到"。** 先想想怎么用工具组合解决。

| 用户需求 | 正确做法 | 错误做法 |
|---------|---------|---------|
| "帮我查一下XX" | 用 WebSearch 搜索 | 说"我无法联网" |
| "打开这个链接看看" | 用 WebFetch 抓取内容 | 说"我无法访问网页" |
| "帮我监控服务器" | 创建定时任务 + Shell | 说"我无法持续运行" |
| "帮我设置自动化" | 编辑 cron-jobs.json | 说"我不支持自动化" |

---

## 关键设计决策

1. **零提示词污染** — 飞书消息直传 Cursor CLI，server 不拼接任何 system prompt
2. **身份/规则自动注入** — 通过 `.cursor/rules/*.mdc` 的 alwaysApply 机制实现
3. **记忆自主调用** — Cursor Agent 通过 memory-tool.ts CLI 自主管理记忆，server 不注入
4. **会话连续性** — 通过 Cursor CLI `--resume` 参数实现
5. **热更换** — .env 和 projects.json 支持运行时热更换，无需重启服务

---

## 核心编码约束

### 运行时

- **必须使用 Bun**（不支持 Node.js 原生模块）
- 包管理器使用 `bun`（bun install / bun add）
- TypeScript 直接运行，不编译

### 飞书卡片输出限制

所有用户可见回复都经过飞书卡片渲染，必须遵守：

- 单张卡片最多 **5 个 Markdown 表格**
- 卡片 JSON 总大小 **≤ 30KB**（约 3500 中文字）
- 超限内容会渲染失败 → 必须分片或写文件

### 安全红线

- 禁止硬编码 API Key / 密码 / Token / 密钥
- 禁止日志输出用户敏感信息（密码、身份证号等）
- 禁止前端暴露后端内部地址或管理接口
- 禁止将 .env 提交到 Git
- 所有用户输入必须校验，数据库操作使用参数化查询

---

## 文档知识库索引

`文档/` 是唯一真相源，信息矛盾时以此为准。

| 目录 | 内容 |
|------|------|
| [架构.md](架构.md) | 系统架构鸟瞰图、模块依赖、部署拓扑 |
| [文档/设计文档/](文档/设计文档/) | 功能设计方案（均标注验证状态） |
| [文档/核心信念/](文档/核心信念/) | 团队工程原则、编码规范 |
| [文档/执行计划/](文档/执行计划/) | 进行中/已完成的任务计划、技术债务 |
| [文档/产品规格/](文档/产品规格/) | 业务需求定义 |
| [文档/参考资料/](文档/参考资料/) | API 文档、第三方对接 |
| [文档/质量评分/](文档/质量评分/) | 各模块成熟度与改动风险 |
| [文档/凭据与配置/](文档/凭据与配置/) | Token、密码、环境变量（开发环境） |
| [文档/变更日志/](文档/变更日志/) | 重大变更记录 |

---

## 部署与运维

- **运行环境**：macOS / Linux 均可
- **服务管理**：`bash service.sh install/start/stop/restart/logs`
- **启动命令**：`bun run server.ts`
- **自动清理**：inbox/ 目录自动清理 24h 前的临时文件
- **凭据**：开发环境凭据见 [文档/凭据与配置/](文档/凭据与配置/)

---

## 修改代码前必读

1. 先阅读 [架构.md](架构.md) 了解系统全貌
2. 查阅 `文档/设计文档/` 确认相关模块的设计方案
3. 查阅 `文档/质量评分/` 了解目标模块的成熟度和改动风险
4. 遵守飞书卡片输出限制（5 表格 / 30KB）
5. 记住：server.ts 是唯一进程入口，所有模块同进程运行
6. 涉及记忆系统时，区分 memory.ts（库）和 memory-tool.ts（CLI）的边界
7. 改完代码 → 自动执行 `/审查刚才的文件与操作`
8. 涉及安全相关 → 自动调用安全卫士审查
