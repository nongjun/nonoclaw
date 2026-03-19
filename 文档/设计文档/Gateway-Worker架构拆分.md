# Gateway-Worker 架构拆分

> 验证状态: ✅ 已实现 | 创建: 2026-03-18

## 动机

当前 server.ts 是单体架构（2300 行），飞书长连接、消息解析、Agent 调度、记忆、定时任务、心跳全在一个进程。任何代码修改都要杀进程重启，飞书连接断开十几秒。

## 架构

拆为两个进程，通过本地 HTTP 通信：

```
gateway.ts (稳定层，极少重启)
├── 飞书 WebSocket 长连接
├── 飞书操作 API (reply/update/send/download)
├── 消息去重 + 解析
├── HTTP API 服务 (localhost:18800)
├── Worker 进程管理 (spawn/monitor/restart)
└── 消息队列 (Worker 重启期间缓冲)

server.ts (业务层，随时可重启，双模运行)
├── 检测 GATEWAY_URL 环境变量决定运行模式
├── Worker 模式: HTTP 服务接收消息，通过 HTTP 调 Gateway
├── 独立模式: 原有行为（向后兼容）
├── Agent 调度 + 会话管理
├── 记忆 / 定时任务 / 心跳 / 蒸馏
└── 所有指令处理
```

## 通信协议

### Gateway HTTP API (Worker 调用)

| 端点 | 说明 |
|------|------|
| POST /feishu/reply | 回复卡片 → {messageId} |
| POST /feishu/update | 更新卡片 → {ok, error?} |
| POST /feishu/send | 发送卡片 → {messageId} |
| POST /feishu/download | 下载媒体 → {path} |
| GET /health | 网关状态 |
| POST /worker/restart | 重启 Worker |

### Worker HTTP API (Gateway 调用)

| 端点 | 说明 |
|------|------|
| POST /message | 接收消息 → 202 |
| GET /health | Worker 状态 |

## 重启流程

1. 用户发 `/重启` 或 Gateway 检测 Worker 崩溃
2. Gateway 向 Worker 发 SIGTERM，等 10s
3. Gateway 缓冲新消息到队列
4. Gateway spawn 新 Worker
5. Worker /health 返回 ok → flush 队列

## 向后兼容

server.ts 保持双模：
- `GATEWAY_URL` 存在 → Worker 模式（飞书操作走 HTTP）
- `GATEWAY_URL` 不存在 → 独立模式（原有行为）

## 未来扩展

- 多 Worker（不同项目独立 Worker）
- Web UI 接入（Gateway 加 WebSocket 端点）
- 驾驶舱平台复用 Gateway 协议
