#!/usr/bin/env bun
/**
 * 对话蒸馏提取器 — 从 Cursor CLI 的 store.db 中提取近期对话
 *
 * 工作原理：
 *   Cursor CLI 把每次对话完整保存在 ~/.cursor/chats/{workspace_hash}/{session_uuid}/store.db
 *   本脚本读取这些 SQLite 数据库，提取 user/assistant 消息，去除系统噪音，
 *   输出到 .cursor/memory/_chat-extract.md 供 Cursor Agent 做记忆蒸馏。
 *
 * 用法：
 *   bun distill-chats.ts                        # 提取当前工作区最近 24h 对话
 *   bun distill-chats.ts --since 48              # 提取最近 48 小时
 *   bun distill-chats.ts --workspace /path/to/ws  # 指定工作区路径
 *
 * 输出：
 *   .cursor/memory/_chat-extract.md  — 格式化的对话内容（供 Agent 蒸馏）
 *   stdout                          — 提取摘要（对话数、轮次数、是否有新内容）
 */

import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";

// ── 配置 ──────────────────────────────────────────

const HOME = process.env.HOME;
if (!HOME) { console.error("[蒸馏] 错误: $HOME 环境变量未设置"); process.exit(1); }

const CURSOR_CHATS_DIR = resolve(HOME, ".cursor/chats");
const STATE_FILENAME = "distill-state.json";
const EXTRACT_FILENAME = "_chat-extract.md";
const MAX_CONTENT_PER_TURN = 2000;
const MAX_EXTRACT_SIZE = 80_000;

// ── 参数解析 ──────────────────────────────────────

function parseArgs(): { workspacePath: string; sinceHours: number } {
	const args = process.argv.slice(2);
	let workspacePath = process.cwd();
	let sinceHours = 24;

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--workspace" && args[i + 1]) {
			workspacePath = resolve(args[++i]);
		} else if (args[i] === "--since" && args[i + 1]) {
			sinceHours = parseInt(args[++i], 10) || 24;
		}
	}

	return { workspacePath, sinceHours };
}

// ── 工作区 Hash 自动发现 ──────────────────────────

function discoverWorkspaceHashes(targetPath: string): string[] {
	if (!existsSync(CURSOR_CHATS_DIR)) return [];

	const normalizedTarget = targetPath.replace(/\/+$/, "");
	const matched: string[] = [];

	for (const hash of readdirSync(CURSOR_CHATS_DIR)) {
		const wsDir = resolve(CURSOR_CHATS_DIR, hash);
		try { if (!statSync(wsDir).isDirectory()) continue; } catch { continue; }

		for (const convId of readdirSync(wsDir)) {
			const dbPath = resolve(wsDir, convId, "store.db");
			if (!existsSync(dbPath)) continue;

			let db: Database | null = null;
			try {
				// Bun 的 readonly 在 WAL 模式 SQLite 上会失败，需用 readwrite 但不做写操作
				db = new Database(dbPath, { create: false, readwrite: true });
				const rows = db.prepare("SELECT data FROM blobs LIMIT 3").all() as { data: Uint8Array }[];

				for (const { data } of rows) {
					const text = Buffer.from(data).toString("utf-8");
					const match = text.match(/Workspace Path: ([^\n\\]+)/);
					if (match) {
						const found = match[1].trim().replace(/\/+$/, "");
						if (found === normalizedTarget) matched.push(hash);
						break;
					}
				}
			} catch {
				// 数据库打不开或查询失败，跳过
			} finally {
				try { db?.close(); } catch {}
			}
			break; // 每个 hash 只需检查第一个会话即可确定工作区
		}
	}

	return matched;
}

// ── 状态管理（增量处理）─────────────────────────

interface DistillState {
	lastDistillAt: string;
	lastDistillTs: number;
	processedSessions: string[];
	totalDistills: number;
}

function loadState(memoryDir: string): DistillState {
	const statePath = resolve(memoryDir, STATE_FILENAME);
	if (existsSync(statePath)) {
		try {
			return JSON.parse(readFileSync(statePath, "utf-8"));
		} catch { /* 文件损坏，返回默认值 */ }
	}
	return {
		lastDistillAt: "",
		lastDistillTs: 0,
		processedSessions: [],
		totalDistills: 0,
	};
}

function saveState(memoryDir: string, state: DistillState): void {
	writeFileSync(resolve(memoryDir, STATE_FILENAME), JSON.stringify(state, null, 2));
}

// ── 对话提取 ──────────────────────────────────────

interface ConversationMeta {
	agentId: string;
	name: string;
	createdAt: number;
}

interface ExtractedTurn {
	role: "user" | "assistant";
	content: string;
}

interface ExtractedConversation {
	sessionId: string;
	name: string;
	createdAt: Date;
	turns: ExtractedTurn[];
}

function extractMeta(db: Database): ConversationMeta | null {
	try {
		const row = db.prepare("SELECT value FROM meta WHERE key='0'").get() as { value: string } | null;
		if (!row) return null;
		return JSON.parse(Buffer.from(row.value, "hex").toString("utf-8"));
	} catch (e) {
		console.warn(`[蒸馏] meta 解码失败: ${e instanceof Error ? e.message : e}`);
		return null;
	}
}

// Cursor 注入的系统标签（提取时需要清除的噪音）
const SYSTEM_TAG_PATTERN = /<(?:user_info|git_status|agent_transcripts|rules|open_and_recently_viewed_files|system_reminder|attached_files|task_notification|agent_skills|cursor_commands)>[\s\S]*?<\/\1>/g;

function cleanUserContent(raw: string): string {
	const uqMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
	if (uqMatch) return uqMatch[1].trim();

	let cleaned = raw;
	cleaned = cleaned.replace(/<(?:user_info|git_status|agent_transcripts|rules|open_and_recently_viewed_files|system_reminder|attached_files|task_notification|agent_skills|cursor_commands)>[\s\S]*?<\/(?:user_info|git_status|agent_transcripts|rules|open_and_recently_viewed_files|system_reminder|attached_files|task_notification|agent_skills|cursor_commands)>/g, "");

	return cleaned.trim();
}

/**
 * 字符串感知的 JSON 对象边界查找。
 * 从 start 位置开始，追踪花括号深度，在字符串内部（被 " 包裹）忽略花括号。
 */
function findJsonEnd(text: string, start: number, maxLen = 500_000): number {
	let depth = 0;
	let inString = false;
	const limit = Math.min(start + maxLen, text.length);

	for (let i = start; i < limit; i++) {
		const ch = text[i];

		if (inString) {
			if (ch === "\\" ) { i++; continue; } // 跳过转义字符
			if (ch === '"') inString = false;
			continue;
		}

		if (ch === '"') { inString = true; continue; }
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}

	return -1; // 未找到匹配的闭合括号
}

function extractConversation(dbPath: string): ExtractedConversation | null {
	let db: Database | null = null;
	try {
		db = new Database(dbPath, { create: false, readwrite: true });
		const meta = extractMeta(db);
		if (!meta) { db.close(); return null; }

		const rows = db.prepare("SELECT data FROM blobs ORDER BY rowid").all() as { data: Uint8Array }[];
		const turns: ExtractedTurn[] = [];

		for (const { data } of rows) {
			const text = Buffer.from(data).toString("utf-8");

			const jsonPattern = /\{"role":"(user|assistant)"/g;
			let match: RegExpExecArray | null;

			while ((match = jsonPattern.exec(text)) !== null) {
				const start = match.index;
				const end = findJsonEnd(text, start);
				if (end === -1) continue;

				try {
					const msg = JSON.parse(text.slice(start, end));
					const role = msg.role as "user" | "assistant" | "system";
					if (role === "system") continue;

					let content = msg.content;
					if (Array.isArray(content)) {
						content = content
							.filter((p: any) => typeof p === "object" && p.type === "text")
							.map((p: any) => p.text)
							.join("\n");
					}
					if (typeof content !== "string" || !content.trim()) continue;

					if (role === "user") {
						content = cleanUserContent(content);
					} else if (role === "assistant") {
						content = content.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
					}

					if (!content || content.length < 5) continue;

					const truncated = content.length > MAX_CONTENT_PER_TURN
						? content.slice(0, MAX_CONTENT_PER_TURN) + "\n...(已截断)"
						: content;

					turns.push({ role, content: truncated });
				} catch {
					continue;
				}
			}
		}

		db.close();
		db = null;

		if (turns.length === 0) return null;

		return {
			sessionId: meta.agentId,
			name: meta.name,
			createdAt: new Date(meta.createdAt),
			turns,
		};
	} catch (e) {
		console.warn(`[蒸馏] 提取失败 ${dbPath}: ${e instanceof Error ? e.message : e}`);
		return null;
	} finally {
		try { db?.close(); } catch {}
	}
}

// ── 格式化输出 ────────────────────────────────────

function formatExtract(conversations: ExtractedConversation[], workspacePath: string): string {
	const now = new Date();
	const lines: string[] = [
		`# Cursor 对话提取`,
		``,
		`> 工作区: ${workspacePath}`,
		`> 提取时间: ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
		`> 对话数: ${conversations.length}`,
		`> 总轮次: ${conversations.reduce((s, c) => s + c.turns.length, 0)}`,
		``,
		`---`,
		``,
		`以下是近期对话的完整内容。请从中提取：`,
		`1. **工作习惯** — 用户反复使用的工作方式、偏好的沟通风格`,
		`2. **编码偏好** — 技术选型倾向、代码风格偏好、常用模式`,
		`3. **重要决策** — 做出的关键技术/产品决策及理由`,
		`4. **反复出现的需求** — 多次提到的主题或关注点`,
		`5. **教训与修正** — 出错后的调整、需要记住的注意事项`,
		``,
		`---`,
		``,
	];

	let totalChars = lines.join("\n").length;

	for (const conv of conversations) {
		const header = [
			`## ${conv.createdAt.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} — ${conv.name}`,
			``,
		];

		const turnLines: string[] = [];
		for (const turn of conv.turns) {
			const prefix = turn.role === "user" ? "**用户**" : "**AI**";
			turnLines.push(`${prefix}: ${turn.content}`, ``);
		}

		const section = [...header, ...turnLines, `---`, ``].join("\n");

		if (totalChars + section.length > MAX_EXTRACT_SIZE) {
			lines.push(`\n> ⚠️ 提取内容已达上限（${Math.round(MAX_EXTRACT_SIZE / 1024)}KB），后续对话已省略`);
			break;
		}

		lines.push(section);
		totalChars += section.length;
	}

	return lines.join("\n");
}

// ── 主流程 ────────────────────────────────────────

async function main() {
	const { workspacePath, sinceHours } = parseArgs();

	const memoryDir = resolve(workspacePath, ".cursor/memory");
	mkdirSync(memoryDir, { recursive: true });

	console.log(`[蒸馏] 工作区: ${workspacePath}`);
	console.log(`[蒸馏] 时间范围: 最近 ${sinceHours} 小时`);

	// 1. 发现工作区 hash（一个工作区可能有多个 hash）
	const wsHashes = discoverWorkspaceHashes(workspacePath);
	if (wsHashes.length === 0) {
		console.log("[蒸馏] 未找到该工作区的 Cursor 对话记录，跳过");
		process.exit(0);
	}
	console.log(`[蒸馏] Cursor workspace hash: ${wsHashes.join(", ")}`);

	// 2. 加载状态
	const state = loadState(memoryDir);
	const processedSet = new Set(state.processedSessions);
	const cutoffTs = Date.now() - sinceHours * 60 * 60 * 1000;
	const effectiveCutoff = Math.max(cutoffTs, state.lastDistillTs);

	// 3. 扫描所有匹配 hash 下的对话
	const sessionDirs: Array<{ dir: string; sessionId: string }> = [];
	for (const wsHash of wsHashes) {
		const chatDir = resolve(CURSOR_CHATS_DIR, wsHash);
		try {
			for (const d of readdirSync(chatDir)) {
				const p = resolve(chatDir, d);
				try {
					if (statSync(p).isDirectory() && existsSync(resolve(p, "store.db"))) {
						sessionDirs.push({ dir: p, sessionId: d });
					}
				} catch { /* 目录被删或权限不足，跳过 */ }
			}
		} catch { /* chat 目录不可读，跳过 */ }
	}

	const newConversations: ExtractedConversation[] = [];

	for (const { dir, sessionId } of sessionDirs) {
		if (processedSet.has(sessionId)) continue;

		const dbPath = resolve(dir, "store.db");
		try {
			const dbStat = statSync(dbPath);
			if (dbStat.mtimeMs < effectiveCutoff) continue;
		} catch { continue; }

		const conv = extractConversation(dbPath);
		if (conv && conv.turns.length >= 2) {
			newConversations.push(conv);
		}
	}

	// 4. 检查是否有新对话
	if (newConversations.length === 0) {
		console.log("[蒸馏] 无新对话，跳过蒸馏");
		process.exit(0);
	}

	newConversations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

	const totalTurns = newConversations.reduce((s, c) => s + c.turns.length, 0);
	console.log(`[蒸馏] 发现 ${newConversations.length} 个新对话，共 ${totalTurns} 轮`);

	// 5. 格式化并写入提取文件
	const extractContent = formatExtract(newConversations, workspacePath);
	const extractPath = resolve(memoryDir, EXTRACT_FILENAME);
	writeFileSync(extractPath, extractContent);
	console.log(`[蒸馏] 已写入提取文件: ${extractPath} (${Math.round(extractContent.length / 1024)}KB)`);

	// 6. 更新状态
	state.lastDistillAt = new Date().toISOString();
	state.lastDistillTs = Date.now();
	state.totalDistills++;
	for (const conv of newConversations) {
		processedSet.add(conv.sessionId);
	}
	state.processedSessions = [...processedSet].slice(-200);
	saveState(memoryDir, state);

	// 7. 输出摘要
	console.log(`[蒸馏] 完成 ✓ — ${newConversations.length} 个对话, ${totalTurns} 轮, 第 ${state.totalDistills} 次蒸馏`);
	console.log(`[蒸馏] 下一步: Cursor Agent 将阅读 ${EXTRACT_FILENAME} 并提炼记忆`);
}

main().catch((e) => {
	console.error(`[蒸馏] 错误: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
