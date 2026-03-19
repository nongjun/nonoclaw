/**
 * nonoclaw Gateway v2
 *
 * 多渠道 IM 连接 + Worker 进程管理
 * - 飞书 WebSocket 长连接，接收消息事件
 * - 钉钉 Stream 长连接，接收机器人消息
 * - 飞书/钉钉操作 API 供 Worker 通过 HTTP 调用
 * - 消息去重和解析
 * - Worker 进程管理（spawn、健康检查、崩溃自动重启、消息队列）
 *
 * 启动: bun run gateway.ts
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import {
	readFileSync, readdirSync, statSync, mkdirSync,
	writeFileSync, unlinkSync, existsSync,
} from "node:fs";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { startDingtalkStream, type DWClientDownStream } from "./dingtalk/client.js";
import { replyViaWebhook, sendPrivateMessage, sendGroupMessage } from "./dingtalk/send.js";
import { downloadDingtalkMediaById } from "./dingtalk/media.js";
import type { DingtalkConfig, DingtalkMessageContext } from "./dingtalk/types.js";

const ROOT = import.meta.dirname;
const ENV_PATH = resolve(ROOT, ".env");
const INBOX_DIR = resolve(ROOT, "inbox");

mkdirSync(INBOX_DIR, { recursive: true });

const DAY_MS = 24 * 60 * 60 * 1000;
for (const f of readdirSync(INBOX_DIR)) {
	const p = resolve(INBOX_DIR, f);
	try { if (Date.now() - statSync(p).mtimeMs > DAY_MS) unlinkSync(p); } catch {}
}

process.on("uncaughtException", (err) => {
	console.error(`[致命] ${err.message}\n${err.stack}`);
});
process.on("unhandledRejection", (reason) => {
	console.error("[致命] unhandledRejection:", reason);
});

// ── .env 解析 ─────────────────────────────────────
interface GatewayEnvConfig {
	FEISHU_APP_ID: string;
	FEISHU_APP_SECRET: string;
	DINGTALK_APP_KEY: string;
	DINGTALK_APP_SECRET: string;
	DINGTALK_ROBOT_CODE: string;
	DINGTALK_AGENT_ID: string;
}

function parseEnv(): GatewayEnvConfig {
	if (!existsSync(ENV_PATH)) {
		console.error(`[致命] .env 文件不存在: ${ENV_PATH}`);
		process.exit(1);
	}
	const raw = readFileSync(ENV_PATH, "utf-8");
	const env: Record<string, string> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx < 0) continue;
		let val = trimmed.slice(eqIdx + 1).trim();
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		env[trimmed.slice(0, eqIdx).trim()] = val;
	}
	return {
		FEISHU_APP_ID: env.FEISHU_APP_ID || "",
		FEISHU_APP_SECRET: env.FEISHU_APP_SECRET || "",
		DINGTALK_APP_KEY: env.DINGTALK_APP_KEY || "",
		DINGTALK_APP_SECRET: env.DINGTALK_APP_SECRET || "",
		DINGTALK_ROBOT_CODE: env.DINGTALK_ROBOT_CODE || env.DINGTALK_APP_KEY || "",
		DINGTALK_AGENT_ID: env.DINGTALK_AGENT_ID || "",
	};
}

const config = parseEnv();
const hasDingtalk = !!(config.DINGTALK_APP_KEY && config.DINGTALK_APP_SECRET);
const hasFeishu = !!(config.FEISHU_APP_ID && config.FEISHU_APP_SECRET);

// ── 端口配置 ──────────────────────────────────────
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || "18800");
const WORKER_PORT = parseInt(process.env.WORKER_PORT || "18801");

// ── 飞书 Client（仅在配置存在时创建）──────────────
const larkClient = hasFeishu
	? new Lark.Client({
		appId: config.FEISHU_APP_ID,
		appSecret: config.FEISHU_APP_SECRET,
		domain: Lark.Domain.Feishu,
	})
	: null;

// ── 卡片构建 ─────────────────────────────────────
function buildCard(markdown: string, header?: { title?: string; color?: string }): string {
	const card: Record<string, unknown> = {
		schema: "2.0",
		config: { wide_screen_mode: true },
		body: { elements: [{ tag: "markdown", content: markdown }] },
	};
	if (header) {
		const h: Record<string, unknown> = { template: header.color || "blue" };
		if (header.title) h.title = { tag: "plain_text", content: header.title };
		card.header = h;
	}
	return JSON.stringify(card);
}

function extractCardError(err: unknown): string | null {
	try {
		const e = err as Record<string, unknown>;
		const data = (e.response as Record<string, unknown>)?.data as Record<string, unknown>
			?? (Array.isArray(e) ? e[1] : null)
			?? e;
		if (!data) return null;
		const code = data.code as number;
		const msg = data.msg as string;
		if (code === 230099) return `卡片渲染失败: ${msg}`;
		if (code === 230025) return "卡片内容超过30KB大小限制";
		if (msg) return msg;
	} catch {}
	return null;
}

// ── 飞书消息操作 ─────────────────────────────────
async function replyCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	if (!larkClient) return undefined;
	try {
		const res = await larkClient.im.message.reply({
			path: { message_id: messageId },
			data: { content: buildCard(markdown, header), msg_type: "interactive" },
		});
		return res.data?.message_id;
	} catch (err) {
		console.error("[回复卡片失败]", err);
		try {
			const res = await larkClient.im.message.reply({
				path: { message_id: messageId },
				data: { content: JSON.stringify({ text: markdown }), msg_type: "text" },
			});
			return res.data?.message_id;
		} catch {}
	}
}

async function updateCard(
	messageId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<{ ok: boolean; error?: string }> {
	if (!larkClient) return { ok: false, error: "feishu not configured" };
	try {
		await larkClient.im.message.patch({
			path: { message_id: messageId },
			data: { content: buildCard(markdown, header) },
		});
		return { ok: true };
	} catch (err) {
		const reason = extractCardError(err) || (err instanceof Error ? err.message : String(err));
		console.error(`[更新卡片失败] ${reason}`);
		return { ok: false, error: reason };
	}
}

async function sendCard(
	chatId: string,
	markdown: string,
	header?: { title?: string; color?: string },
): Promise<string | undefined> {
	if (!larkClient) return undefined;
	try {
		const res = await larkClient.im.message.create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "interactive", content: buildCard(markdown, header) },
		});
		return res.data?.message_id;
	} catch (err) {
		console.error("[发送卡片失败]", err);
	}
}

// ── 媒体下载 ─────────────────────────────────────
async function readResponseBuffer(response: unknown, depth = 0): Promise<Buffer> {
	if (depth > 3) throw new Error("readResponseBuffer: 响应嵌套过深");
	const resp = response as Record<string, unknown>;
	if (resp instanceof Readable || typeof (resp as Readable).pipe === "function") {
		const chunks: Buffer[] = [];
		for await (const chunk of resp as Readable) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
		}
		return Buffer.concat(chunks);
	}
	if (typeof resp.writeFile === "function") {
		const tmp = resolve(INBOX_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		await (resp as { writeFile: (p: string) => Promise<void> }).writeFile(tmp);
		const buf = readFileSync(tmp);
		try { unlinkSync(tmp); } catch {}
		return buf;
	}
	if (Buffer.isBuffer(resp)) return resp;
	if (resp.data && resp.data !== resp) return readResponseBuffer(resp.data, depth + 1);
	throw new Error("无法解析飞书资源响应");
}

async function downloadMedia(
	messageId: string,
	fileKey: string,
	type: "image" | "file",
	ext: string,
): Promise<string> {
	if (!larkClient) throw new Error("feishu not configured");
	const response = await larkClient.im.messageResource.get({
		path: { message_id: messageId, file_key: fileKey },
		params: { type },
	});
	const buffer = await readResponseBuffer(response);
	const filename = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const filepath = resolve(INBOX_DIR, filename);
	writeFileSync(filepath, buffer);
	console.log(`[下载] ${filepath} (${buffer.length} bytes)`);
	return filepath;
}

// ── 消息解析 ─────────────────────────────────────
function parseContent(
	messageType: string,
	content: string,
): { text: string; imageKey?: string; fileKey?: string; fileName?: string } {
	try {
		const p = JSON.parse(content);
		switch (messageType) {
			case "text":
				return { text: p.text || "" };
			case "image":
				return { text: "", imageKey: p.image_key };
			case "audio":
				return { text: "", fileKey: p.file_key };
			case "file":
				return { text: "", fileKey: p.file_key, fileName: p.file_name };
			case "post": {
				const texts: string[] = [];
				for (const lang of Object.values(p) as Array<{
					title?: string;
					content?: Array<Array<{ tag: string; text?: string }>>;
				}>) {
					if (lang?.title) texts.push(lang.title);
					if (Array.isArray(lang?.content))
						for (const para of lang.content)
							for (const e of para) if (e.tag === "text" && e.text) texts.push(e.text);
				}
				return { text: texts.join(" ") };
			}
			default:
				return { text: `[不支持: ${messageType}]` };
		}
	} catch {
		return { text: content };
	}
}

// ── 去重 ─────────────────────────────────────────
const seen = new Map<string, number>();
function isDup(id: string): boolean {
	const now = Date.now();
	for (const [k, t] of seen) if (now - t > 60_000) seen.delete(k);
	if (seen.has(id)) return true;
	seen.set(id, now);
	return false;
}

// ── Worker 进程管理 ──────────────────────────────
let workerProcess: ChildProcess | null = null;
let workerReady = false;
let workerStarting = false;
const bootTime = Date.now();

interface QueuedMessage {
	text: string;
	messageId: string;
	chatId: string;
	chatType: string;
	messageType: string;
	content: string;
	channel: "feishu" | "dingtalk";
	sessionWebhook?: string;
	senderStaffId?: string;
	queuedAt: number;
}

const messageQueue: QueuedMessage[] = [];

async function checkWorkerHealth(): Promise<boolean> {
	try {
		const res = await fetch(`http://localhost:${WORKER_PORT}/health`, {
			signal: AbortSignal.timeout(2000),
		});
		if (res.ok) {
			const data = await res.json() as { status: string };
			return data.status === "ok";
		}
		return false;
	} catch {
		return false;
	}
}

async function drainQueue(): Promise<void> {
	while (messageQueue.length > 0 && workerReady) {
		const msg = messageQueue.shift()!;
		const age = Date.now() - msg.queuedAt;
		if (age > 5 * 60 * 1000) {
			console.log(`[队列] 丢弃过期消息 (${Math.round(age / 1000)}s): ${msg.text.slice(0, 60)}`);
			continue;
		}
		try {
			await fetch(`http://localhost:${WORKER_PORT}/message`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					text: msg.text,
					messageId: msg.messageId,
					chatId: msg.chatId,
					chatType: msg.chatType,
					messageType: msg.messageType,
					content: msg.content,
					channel: msg.channel,
					sessionWebhook: msg.sessionWebhook,
					senderStaffId: msg.senderStaffId,
				}),
				signal: AbortSignal.timeout(5000),
			});
		} catch (err) {
			console.error(`[队列] 转发失败，重新入队: ${err instanceof Error ? err.message : err}`);
			messageQueue.unshift(msg);
			break;
		}
	}
}

function spawnWorker(): void {
	if (workerStarting) return;
	workerStarting = true;
	workerReady = false;

	if (workerProcess) {
		try { workerProcess.kill("SIGTERM"); } catch {}
		workerProcess = null;
	}

	console.log("[Worker] 启动中...");
	const child = spawn("bun", ["run", resolve(ROOT, "server.ts")], {
		env: {
			...process.env,
			GATEWAY_URL: `http://localhost:${GATEWAY_PORT}`,
			WORKER_PORT: String(WORKER_PORT),
		},
		stdio: ["ignore", "inherit", "inherit"],
	});

	workerProcess = child;

	child.on("close", (code) => {
		console.warn(`[Worker] 进程退出 (code=${code})`);
		workerProcess = null;
		workerReady = false;
		workerStarting = false;
		setTimeout(() => {
			console.log("[Worker] 2s 后自动重启...");
			spawnWorker();
		}, 2000);
	});

	child.on("error", (err) => {
		console.error(`[Worker] 启动错误: ${err.message}`);
		workerStarting = false;
	});

	const pollInterval = setInterval(async () => {
		const healthy = await checkWorkerHealth();
		if (healthy) {
			clearInterval(pollInterval);
			workerReady = true;
			workerStarting = false;
			console.log("[Worker] 就绪 ✓");
			drainQueue().catch(console.error);
		}
	}, 500);

	setTimeout(() => {
		clearInterval(pollInterval);
		if (!workerReady && workerStarting) {
			workerStarting = false;
			console.warn("[Worker] 启动超时（30s），将在收到消息时重试");
		}
	}, 30_000);
}

async function forwardToWorker(message: Omit<QueuedMessage, "queuedAt">): Promise<void> {
	if (!workerReady) {
		messageQueue.push({ ...message, queuedAt: Date.now() });
		console.log(`[队列] Worker 未就绪，消息已缓冲 (${messageQueue.length} 条)`);
		if (!workerStarting && !workerProcess) {
			spawnWorker();
		}
		return;
	}
	try {
		const res = await fetch(`http://localhost:${WORKER_PORT}/message`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text: message.text,
				messageId: message.messageId,
				chatId: message.chatId,
				chatType: message.chatType,
				messageType: message.messageType,
				content: message.content,
				channel: message.channel,
				sessionWebhook: message.sessionWebhook,
				senderStaffId: message.senderStaffId,
			}),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) {
			throw new Error(`Worker 响应 ${res.status}`);
		}
	} catch (err) {
		console.error(`[转发] 失败: ${err instanceof Error ? err.message : err}`);
		messageQueue.push({ ...message, queuedAt: Date.now() });
	}
}

// ── 飞书事件处理 ─────────────────────────────────
const dispatcher = new Lark.EventDispatcher({});
const TYPES = new Set(["text", "image", "audio", "file", "post"]);

dispatcher.register({
	"im.message.receive_v1": async (data) => {
		console.log("[事件] 收到 im.message.receive_v1");
		try {
			const ev = data as Record<string, unknown>;
			const msg = ev.message as Record<string, unknown>;
			if (!msg) {
				console.error("[事件] msg 为空");
				return;
			}
			const messageType = msg.message_type as string;
			const messageId = msg.message_id as string;
			const chatId = msg.chat_id as string;
			const chatType = (msg.chat_type as string) || "p2p";
			const content = msg.content as string;

			if (isDup(messageId)) return;
			if (!TYPES.has(messageType)) {
				await replyCard(messageId, `暂不支持: ${messageType}`);
				return;
			}

			const { text: parsedText, imageKey, fileKey } = parseContent(messageType, content);
			console.log(`[解析] type=${messageType} chat=${chatType} text="${parsedText.slice(0, 60)}" img=${imageKey ?? ""} file=${fileKey ?? ""}`);

			await forwardToWorker({
				text: parsedText.trim(),
				messageId,
				chatId,
				chatType,
				messageType,
				content,
				channel: "feishu",
			});
		} catch (e) {
			console.error("[事件异常]", e);
		}
	},
});

// ── HTTP API 服务（供 Worker 回调）────────────────
Bun.serve({
	port: GATEWAY_PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		if (req.method === "GET" && path === "/health") {
			const workerStatus = workerReady ? "running" : workerStarting ? "starting" : "dead";
			return Response.json({
				status: "ok",
				uptime: Math.round((Date.now() - bootTime) / 1000),
				worker: workerStatus,
				queue: messageQueue.length,
			});
		}

		if (req.method === "POST" && path === "/worker/restart") {
			console.log("[API] 收到 Worker 重启请求");
			workerReady = false;
			workerStarting = false;
			if (workerProcess) {
				try { workerProcess.kill("SIGTERM"); } catch {}
				workerProcess = null;
			}
			setTimeout(() => spawnWorker(), 500);
			return Response.json({ ok: true });
		}

		if (req.method === "POST" && path === "/feishu/reply") {
			try {
				const body = await req.json() as {
					messageId: string;
					markdown: string;
					header?: { title?: string; color?: string };
				};
				const messageId = await replyCard(body.messageId, body.markdown, body.header);
				return Response.json({ messageId });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (req.method === "POST" && path === "/feishu/update") {
			try {
				const body = await req.json() as {
					messageId: string;
					markdown: string;
					header?: { title?: string; color?: string };
				};
				const result = await updateCard(body.messageId, body.markdown, body.header);
				return Response.json(result);
			} catch (err) {
				return Response.json(
					{ ok: false, error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (req.method === "POST" && path === "/feishu/send") {
			try {
				const body = await req.json() as {
					chatId: string;
					markdown: string;
					header?: { title?: string; color?: string };
				};
				const messageId = await sendCard(body.chatId, body.markdown, body.header);
				return Response.json({ messageId });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (req.method === "POST" && path === "/feishu/download") {
			try {
				const body = await req.json() as {
					messageId: string;
					fileKey: string;
					type: "image" | "file";
					ext: string;
				};
				const filepath = await downloadMedia(body.messageId, body.fileKey, body.type, body.ext);
				return Response.json({ path: filepath });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		// ── 钉钉 API ──────────────────────────────
		if (req.method === "POST" && path === "/dingtalk/reply") {
			try {
				const body = await req.json() as {
					sessionWebhook?: string;
					senderStaffId?: string;
					chatId?: string;
					chatType?: string;
					markdown: string;
					title?: string;
					robotCode?: string;
				};
				if (body.sessionWebhook) {
					const result = await replyViaWebhook(
						body.sessionWebhook,
						body.markdown,
						body.title,
						body.senderStaffId ? [body.senderStaffId] : undefined,
					);
					return Response.json(result);
				}
				const robotCode = body.robotCode || config.DINGTALK_ROBOT_CODE;
				if (body.chatType === "1" && body.senderStaffId) {
					const result = await sendPrivateMessage(robotCode, [body.senderStaffId], body.markdown, body.title);
					return Response.json(result);
				}
				if (body.chatId) {
					const result = await sendGroupMessage(robotCode, body.chatId, body.markdown, body.title);
					return Response.json(result);
				}
				return Response.json({ ok: false, error: "missing sessionWebhook or chatId" }, { status: 400 });
			} catch (err) {
				return Response.json(
					{ ok: false, error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (req.method === "POST" && path === "/dingtalk/send") {
			try {
				const body = await req.json() as {
					chatId: string;
					chatType?: string;
					senderStaffId?: string;
					markdown: string;
					title?: string;
					robotCode?: string;
				};
				const robotCode = body.robotCode || config.DINGTALK_ROBOT_CODE;
				if (body.chatType === "1" && body.senderStaffId) {
					const result = await sendPrivateMessage(robotCode, [body.senderStaffId], body.markdown, body.title);
					return Response.json(result);
				}
				const result = await sendGroupMessage(robotCode, body.chatId, body.markdown, body.title);
				return Response.json(result);
			} catch (err) {
				return Response.json(
					{ ok: false, error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		if (req.method === "POST" && path === "/dingtalk/update") {
			// 钉钉没有原生的消息更新 API（不像飞书可以 patch 消息），
			// 在 server.ts 侧使用卡片更新或重新发送来替代
			return Response.json({ ok: true, note: "dingtalk has no message patch API" });
		}

		if (req.method === "POST" && path === "/dingtalk/download") {
			try {
				const body = await req.json() as {
					downloadCode: string;
					robotCode?: string;
					ext?: string;
				};
				const robotCode = body.robotCode || config.DINGTALK_ROBOT_CODE;
				const filepath = await downloadDingtalkMediaById(
					body.downloadCode,
					robotCode,
					INBOX_DIR,
					body.ext || "",
				);
				return Response.json({ path: filepath });
			} catch (err) {
				return Response.json(
					{ error: err instanceof Error ? err.message : String(err) },
					{ status: 500 },
				);
			}
		}

		return new Response("Not Found", { status: 404 });
	},
});

// ── 进程信号处理 ─────────────────────────────────
function shutdown() {
	if (workerProcess) {
		try { workerProcess.kill("SIGTERM"); } catch {}
	}
	process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ── 飞书 WebSocket 长连接 ────────────────────────
const wsClient = hasFeishu
	? new Lark.WSClient({
		appId: config.FEISHU_APP_ID,
		appSecret: config.FEISHU_APP_SECRET,
		domain: Lark.Domain.Feishu,
		loggerLevel: Lark.LoggerLevel.info,
	})
	: null;

// ── 钉钉消息处理 ─────────────────────────────────
function parseDingtalkMessage(downstream: DWClientDownStream): DingtalkMessageContext | null {
	try {
		const raw = downstream.data;
		const msg = JSON.parse(raw);
		const text = msg.text?.content?.trim() || "";
		const conversationType = msg.conversationType || "1";
		const chatType = conversationType === "2" ? "group" : "p2p";
		return {
			conversationId: msg.conversationId || "",
			conversationType,
			chatId: msg.conversationId || "",
			senderId: msg.senderId || "",
			senderStaffId: msg.senderStaffId || "",
			senderNick: msg.senderNick || "",
			messageId: msg.msgId || downstream.headers.messageId || "",
			messageType: msg.msgtype || "text",
			text,
			sessionWebhook: msg.sessionWebhook || "",
			sessionWebhookExpiredTime: msg.sessionWebhookExpiredTime || 0,
			robotCode: msg.robotCode || config.DINGTALK_ROBOT_CODE,
			isAdmin: msg.isAdmin || false,
			rawData: raw,
		};
	} catch (err) {
		console.error("[钉钉] 消息解析失败:", err);
		return null;
	}
}

// ── 启动 ─────────────────────────────────────────
const channels: string[] = [];
if (hasFeishu) channels.push("飞书");
if (hasDingtalk) channels.push("钉钉");

console.log(`
┌──────────────────────────────────────┐
│  nonoclaw Gateway v2                 │
│  HTTP:   localhost:${GATEWAY_PORT}              │
│  Worker: localhost:${WORKER_PORT}              │
│  渠道:   ${(channels.join(" + ") || "无").padEnd(25)}│
└──────────────────────────────────────┘
`);

spawnWorker();

if (wsClient) {
	wsClient.start({ eventDispatcher: dispatcher });
	console.log("[飞书] WebSocket 长连接已启动，等待消息...");
}

if (hasDingtalk) {
	const dingtalkConfig: DingtalkConfig = {
		appKey: config.DINGTALK_APP_KEY,
		appSecret: config.DINGTALK_APP_SECRET,
		robotCode: config.DINGTALK_ROBOT_CODE,
		agentId: config.DINGTALK_AGENT_ID || undefined,
	};
	startDingtalkStream(dingtalkConfig, async (downstream) => {
		const msg = parseDingtalkMessage(downstream);
		if (!msg) return;

		if (isDup(`dt_${msg.messageId}`)) return;

		console.log(`[钉钉] type=${msg.messageType} chat=${msg.conversationType === "2" ? "group" : "p2p"} from=${msg.senderNick} text="${msg.text.slice(0, 60)}"`);

		await forwardToWorker({
			text: msg.text,
			messageId: msg.messageId,
			chatId: msg.chatId,
			chatType: msg.conversationType === "2" ? "group" : "p2p",
			messageType: msg.messageType,
			content: msg.rawData,
			channel: "dingtalk",
			sessionWebhook: msg.sessionWebhook,
			senderStaffId: msg.senderStaffId,
		});
	});
	console.log("[钉钉] Stream 连接已启动，等待消息...");
}

if (!hasFeishu && !hasDingtalk) {
	console.warn("[警告] 未配置任何 IM 渠道（飞书/钉钉），Gateway 仅提供 HTTP API");
}
