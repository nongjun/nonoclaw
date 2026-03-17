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
import { resolve, basename } from "node:path";
import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	readdirSync,
	statSync,
} from "node:fs";

// ── 配置 ──────────────────────────────────────────

const HOME = process.env.HOME!;
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

interface WorkspaceMapping {
	hash: string;
	path: string;
}

function discoverWorkspaceHashes(targetPath: string): string[] {
	if (!existsSync(CURSOR_CHATS_DIR)) return [];

	const normalizedTarget = targetPath.replace(/\/+$/, "");
	const matched: string[] = [];

	for (const hash of readdirSync(CURSOR_CHATS_DIR)) {
		const wsDir = resolve(CURSOR_CHATS_DIR, hash);
		if (!statSync(wsDir).isDirectory()) continue;

		for (const convId of readdirSync(wsDir)) {
			const dbPath = resolve(wsDir, convId, "store.db");
			if (!existsSync(dbPath)) continue;

			try {
				const db = new Database(dbPath, { create: false, readwrite: true });
				const rows = db.prepare("SELECT data FROM blobs LIMIT 3").all() as { data: Uint8Array }[];

				for (const { data } of rows) {
					const text = Buffer.from(data).toString("utf-8");
					const match = text.match(/Workspace Path: ([^\n\\]+)/);
					if (match) {
						const found = match[1].trim().replace(/\/+$/, "");
						db.close();
						if (found === normalizedTarget) matched.push(hash);
						break;
					}
				}
				db.close();
			} catch {
				continue;
			}
			break;
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
		} catch {}
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
	} catch {
		return null;
	}
}

function cleanUserContent(raw: string): string {
	const uqMatch = raw.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/);
	if (uqMatch) return uqMatch[1].trim();

	let cleaned = raw;
	cleaned = cleaned.replace(/<user_info>[\s\S]*?<\/user_info>/g, "");
	cleaned = cleaned.replace(/<git_status>[\s\S]*?<\/git_status>/g, "");
	cleaned = cleaned.replace(/<agent_transcripts>[\s\S]*?<\/agent_transcripts>/g, "");
	cleaned = cleaned.replace(/<rules>[\s\S]*?<\/rules>/g, "");
	cleaned = cleaned.replace(/<open_and_recently_viewed_files>[\s\S]*?<\/open_and_recently_viewed_files>/g, "");
	cleaned = cleaned.replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, "");
	cleaned = cleaned.replace(/<attached_files>[\s\S]*?<\/attached_files>/g, "");

	return cleaned.trim();
}

function extractConversation(dbPath: string): ExtractedConversation | null {
	try {
		const db = new Database(dbPath, { create: false, readwrite: true });
		const meta = extractMeta(db);
		if (!meta) { db.close(); return null; }

		const rows = db.prepare("SELECT data FROM blobs ORDER BY rowid").all() as { data: Uint8Array }[];
		const turns: ExtractedTurn[] = [];

		for (const { data } of rows) {
			const text = Buffer.from(data).toString("utf-8");

			const jsonPattern = /\{"role":"(user|assistant)"[^]*?"content"/g;
			let match: RegExpExecArray | null;

			while ((match = jsonPattern.exec(text)) !== null) {
				const start = match.index;
				let depth = 0;
				let end = start;

				for (let i = start; i < Math.min(start + 500_000, text.length); i++) {
					if (text[i] === "{") depth++;
					else if (text[i] === "}") {
						depth--;
						if (depth === 0) { end = i + 1; break; }
					}
				}

				if (depth !== 0) continue;

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

		if (turns.length === 0) return null;

		return {
			sessionId: meta.agentId,
			name: meta.name,
			createdAt: new Date(meta.createdAt),
			turns,
		};
	} catch {
		return null;
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
	const cutoffTs = Date.now() - sinceHours * 60 * 60 * 1000;
	const effectiveCutoff = Math.max(cutoffTs, state.lastDistillTs);

	// 3. 扫描所有匹配 hash 下的对话
	const sessionDirs: Array<{ dir: string; sessionId: string }> = [];
	for (const wsHash of wsHashes) {
		const chatDir = resolve(CURSOR_CHATS_DIR, wsHash);
		for (const d of readdirSync(chatDir)) {
			const p = resolve(chatDir, d);
			if (statSync(p).isDirectory() && existsSync(resolve(p, "store.db"))) {
				sessionDirs.push({ dir: p, sessionId: d });
			}
		}
	}

	const newConversations: ExtractedConversation[] = [];

	for (const { dir, sessionId } of sessionDirs) {
		if (state.processedSessions.includes(sessionId)) continue;

		const dbPath = resolve(dir, "store.db");
		const dbStat = statSync(dbPath);

		if (dbStat.mtimeMs < effectiveCutoff) continue;

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
		if (!state.processedSessions.includes(conv.sessionId)) {
			state.processedSessions.push(conv.sessionId);
		}
	}
	// 只保留最近 200 个 session ID
	if (state.processedSessions.length > 200) {
		state.processedSessions = state.processedSessions.slice(-200);
	}
	saveState(memoryDir, state);

	// 7. 输出摘要
	console.log(`[蒸馏] 完成 ✓ — ${newConversations.length} 个对话, ${totalTurns} 轮, 第 ${state.totalDistills} 次蒸馏`);
	console.log(`[蒸馏] 下一步: Cursor Agent 将阅读 ${EXTRACT_FILENAME} 并提炼记忆`);
}

main().catch((e) => {
	console.error(`[蒸馏] 错误: ${e instanceof Error ? e.message : e}`);
	process.exit(1);
});
