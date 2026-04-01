/**
 * 保活会话管理器
 *
 * 管理持久的 Cursor CLI 会话，CLI 进程不退出，通过 wait-input.py 的 inbox 文件
 * 实现多轮消息注入。每轮 Agent 完成任务后调用 wait-input.py，本模块检测到该
 * tool call 后将累积的 assistant 文本作为本轮"结果"返回。
 *
 * 关键能力：
 * - 检测 stream-json 中的 wait-input.py tool call 作为轮次分隔符
 * - 通过 inbox 文件向等待中的 Agent 注入新消息
 * - 为飞书消息和定时任务提供统一接口
 */
import { spawn, type ChildProcess } from "child_process";
import {
	writeFileSync,
	mkdirSync,
	existsSync,
	unlinkSync,
	readFileSync,
} from "fs";
import { resolve, join } from "path";

export interface AgentProgress {
	elapsed: number;
	phase: "thinking" | "tool_call" | "responding";
	snippet: string;
}

export interface KeepAliveOptions {
	agentBin: string;
	agentSpawnArgs: (args: string[]) => [string, string[]];
	apiKey: string;
	model: string;
	sessionId?: string;
	onProgress?: (p: AgentProgress) => void;
	onRoundComplete?: (result: string) => void;
	onError?: (err: Error) => void;
	onClose?: () => void;
}

interface PendingRound {
	resolve: (result: string) => void;
	reject: (err: Error) => void;
}

/**
 * 单个保活会话实例
 */
export class KeepAliveSession {
	readonly id: string;
	readonly workspace: string;
	readonly lockKey: string;
	private child: ChildProcess | null = null;
	private status: "idle" | "starting" | "running" | "waiting" | "closed" =
		"idle";
	private sessionsDir: string;
	private inboxPath: string;

	private lastSegment = "";
	private resultText = "";
	private toolBuf = "";
	private thinkingBuf = "";
	private phase: AgentProgress["phase"] = "thinking";
	private startTime = 0;
	private lineBuf = "";
	private pendingRound: PendingRound | null = null;
	private opts: KeepAliveOptions | null = null;

	constructor(id: string, workspace: string, lockKey: string) {
		this.id = id;
		this.workspace = workspace;
		this.lockKey = lockKey;
		this.sessionsDir = resolve(workspace, ".cursor", "scripts", "sessions");
		this.inboxPath = join(this.sessionsDir, `${id}.inbox`);
		mkdirSync(this.sessionsDir, { recursive: true });
	}

	get currentStatus() {
		return this.status;
	}

	/**
	 * 启动保活会话，发送初始 prompt
	 * 返回第一轮结果（Agent 完成初始任务并调用 wait-input 后 resolve）
	 */
	start(
		initialPrompt: string,
		opts: KeepAliveOptions,
	): Promise<string> {
		this.opts = opts;
		this.status = "starting";
		this.startTime = Date.now();

		const waitCmd = `python3 .cursor/scripts/wait-input.py --id "${this.id}" --session "${this.lockKey}"`;
		const keepAlivePrompt =
			initialPrompt +
			`\n\n[系统指令] 你已进入保活模式。每次完成任务后，执行: ${waitCmd}` +
			` 然后等待下一条指令。如果返回 [EMPTY_INPUT] 或 [TIMEOUT]，立即重新执行同一命令继续等待。` +
			` 只有收到 [SESSION_END] 才可以结束。绝对不要结束回复。`;

		return this.spawnAndWaitRound(keepAlivePrompt, opts);
	}

	/**
	 * 向等待中的 Agent 发送新消息，返回本轮结果
	 */
	sendMessage(text: string): Promise<string> {
		if (this.status !== "waiting") {
			return Promise.reject(
				new Error(
					`会话 ${this.id} 状态为 ${this.status}，无法发送消息`,
				),
			);
		}

		this.status = "running";
		this.lastSegment = "";
		this.resultText = "";
		this.toolBuf = "";
		this.thinkingBuf = "";
		this.phase = "thinking";

		return new Promise((resolve, reject) => {
			this.pendingRound = { resolve, reject };
			try {
				writeFileSync(this.inboxPath, text, "utf-8");
			} catch (err) {
				this.pendingRound = null;
				this.status = "waiting";
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	/**
	 * 关闭保活会话
	 */
	close() {
		if (this.status === "closed") return;
		this.status = "closed";

		if (existsSync(this.inboxPath)) {
			try { unlinkSync(this.inboxPath); } catch (e) {
				console.warn(`[KeepAlive:${this.id}] inbox 清理失败:`, e);
			}
		}

		try {
			writeFileSync(this.inboxPath, "[SESSION_END]", "utf-8");
		} catch (e) {
			console.warn(`[KeepAlive:${this.id}] 写 SESSION_END 失败:`, e);
		}

		setTimeout(() => {
			if (this.child) {
				try { this.child.kill("SIGTERM"); } catch {}
				this.child = null;
			}
		}, 3000);

		if (this.pendingRound) {
			this.pendingRound.reject(new Error("会话已关闭"));
			this.pendingRound = null;
		}

		this.opts?.onClose?.();
	}

	private spawnAndWaitRound(
		prompt: string,
		opts: KeepAliveOptions,
	): Promise<string> {
		return new Promise((resolve, reject) => {
			this.pendingRound = { resolve, reject };

			const args = [
				"-p",
				"--force",
				"--trust",
				"--approve-mcps",
				"--workspace",
				this.workspace,
				"--model",
				opts.model,
				"--output-format",
				"stream-json",
				"--stream-partial-output",
			];
			if (opts.sessionId) args.push("--resume", opts.sessionId);
			args.push("--", prompt);

			const [cmd, cmdArgs] = opts.agentSpawnArgs(args);
			this.child = spawn(cmd, cmdArgs, {
				env: { ...process.env, CURSOR_API_KEY: opts.apiKey },
				stdio: ["ignore", "pipe", "pipe"],
			});
			this.status = "running";

			let stderr = "";

			this.child.stdout!.on("data", (chunk: Buffer) => {
				this.lineBuf += chunk.toString();
				const lines = this.lineBuf.split("\n");
				this.lineBuf = lines.pop()!;
				for (const line of lines) this.processLine(line);
			});

			this.child.stderr!.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
			});

			this.child.on("close", (code) => {
				this.child = null;
				if (this.status !== "closed") {
					this.status = "closed";
					if (this.lineBuf.trim()) this.processLine(this.lineBuf);

					const output =
						this.resultText ||
						this.lastSegment.trim() ||
						stderr.trim() ||
						"(会话已结束)";

					if (this.pendingRound) {
						this.pendingRound.resolve(output);
						this.pendingRound = null;
					}
					this.opts?.onClose?.();
				}
			});

			this.child.on("error", (err) => {
				console.error(`[KeepAlive:${this.id}] 子进程错误:`, err);
				this.status = "closed";
				this.child = null;
				if (this.pendingRound) {
					this.pendingRound.reject(err);
					this.pendingRound = null;
				}
				this.opts?.onError?.(err);
				this.opts?.onClose?.();
			});
		});
	}

	private processLine(line: string) {
		let ev: any;
		try {
			ev = JSON.parse(line);
		} catch {
			return;
		}

		const prevPhase = this.phase;

		switch (ev.type) {
			case "thinking":
				this.phase = "thinking";
				if (ev.text) this.thinkingBuf += ev.text;
				break;

			case "assistant":
				if (this.phase !== "responding") {
					this.toolBuf = "";
					this.lastSegment = "";
				}
				this.phase = "responding";
				if (ev.message?.content) {
					let text = "";
					for (const c of ev.message.content) {
						if (c.type === "text" && c.text) text += c.text;
					}
					if (text) this.lastSegment = text;
				}
				break;

			case "tool_call":
				this.phase = "tool_call";

				if (ev.subtype === "started" && this.isWaitInputCall(ev)) {
					this.onWaitInputDetected();
					return;
				}

				this.lastSegment = "";
				if (ev.tool_call) {
					if (ev.subtype === "started") {
						const name = ev.tool_call.name || "";
						const cmd =
							ev.tool_call.arguments?.command || "";
						this.toolBuf +=
							(this.toolBuf ? "\n" : "") +
							`[${name}] ${cmd.slice(0, 120)}`;
					}
				}
				break;

			case "result":
				if (ev.result != null) this.resultText = ev.result;
				if (ev.subtype === "error" && ev.error)
					this.resultText = ev.error;
				break;
		}

		if (
			(this.phase !== prevPhase ||
				(ev.type === "tool_call" && ev.tool_call)) &&
			this.opts?.onProgress
		) {
			const elapsed = Math.round(
				(Date.now() - this.startTime) / 1000,
			);
			const snippet = this.getSnippet();
			if (snippet) {
				this.opts.onProgress({ elapsed, phase: this.phase, snippet });
			}
		}
	}

	/**
	 * 检测是否为 wait-input.py 的 shell tool call
	 */
	private isWaitInputCall(ev: any): boolean {
		const toolCall = ev.tool_call;
		if (!toolCall) return false;
		const cmd =
			toolCall.arguments?.command ||
			toolCall.params?.command ||
			"";
		return cmd.includes("wait-input.py");
	}

	/**
	 * 检测到 wait-input 调用 → 本轮结束，resolve pending round
	 */
	private onWaitInputDetected() {
		const result =
			this.resultText ||
			this.lastSegment.trim() ||
			"(本轮无文本输出)";
		this.status = "waiting";

		console.log(
			`[KeepAlive:${this.id}] 轮次完成，状态→waiting，结果长度=${result.length}`,
		);

		if (this.pendingRound) {
			this.pendingRound.resolve(result);
			this.pendingRound = null;
		}

		this.opts?.onRoundComplete?.(result);

		this.lastSegment = "";
		this.resultText = "";
		this.toolBuf = "";
		this.thinkingBuf = "";
	}

	private getSnippet(): string {
		if (this.phase === "thinking") return this.thinkingBuf.slice(-200);
		if (this.phase === "tool_call") {
			const lines = this.toolBuf.split("\n").filter((l) => l.trim());
			return (
				lines.slice(-6).join("\n") || this.lastSegment.slice(-300)
			);
		}
		return this.lastSegment.slice(-300);
	}
}

/**
 * 保活会话管理器（全局单例）
 */
class KeepAliveManager {
	private sessions = new Map<string, KeepAliveSession>();

	/**
	 * 获取指定 lockKey 的保活会话
	 */
	get(lockKey: string): KeepAliveSession | undefined {
		return this.sessions.get(lockKey);
	}

	/**
	 * 检查指定 lockKey 是否有等待中的保活会话
	 */
	isWaiting(lockKey: string): boolean {
		const s = this.sessions.get(lockKey);
		return s?.currentStatus === "waiting";
	}

	/**
	 * 创建并启动一个保活会话
	 */
	async create(
		lockKey: string,
		workspace: string,
		initialPrompt: string,
		opts: KeepAliveOptions,
	): Promise<{ session: KeepAliveSession; firstResult: string }> {
		if (this.sessions.has(lockKey)) {
			const existing = this.sessions.get(lockKey)!;
			if (
				existing.currentStatus !== "closed"
			) {
				throw new Error(`lockKey ${lockKey} 已有活跃保活会话`);
			}
			this.sessions.delete(lockKey);
		}

		const id =
			lockKey.replace(/[^a-zA-Z0-9_-]/g, "_") +
			"_" +
			Date.now().toString(36);
		const session = new KeepAliveSession(id, workspace, lockKey);

		const mergedOpts: KeepAliveOptions = {
			...opts,
			onClose: () => {
				console.log(`[KeepAlive] 会话 ${lockKey} 已关闭`);
				this.sessions.delete(lockKey);
				opts.onClose?.();
			},
		};

		this.sessions.set(lockKey, session);
		const firstResult = await session.start(initialPrompt, mergedOpts);
		return { session, firstResult };
	}

	/**
	 * 向指定 lockKey 的保活会话发送消息
	 */
	async send(lockKey: string, text: string): Promise<string> {
		const session = this.sessions.get(lockKey);
		if (!session) throw new Error(`无保活会话: ${lockKey}`);
		return session.sendMessage(text);
	}

	/**
	 * 关闭指定保活会话
	 */
	close(lockKey: string) {
		const session = this.sessions.get(lockKey);
		if (session) {
			session.close();
			this.sessions.delete(lockKey);
		}
	}

	/**
	 * 列出所有活跃会话
	 */
	list(): Array<{ lockKey: string; id: string; status: string }> {
		return [...this.sessions.entries()].map(([k, s]) => ({
			lockKey: k,
			id: s.id,
			status: s.currentStatus,
		}));
	}
}

export const keepAliveManager = new KeepAliveManager();
