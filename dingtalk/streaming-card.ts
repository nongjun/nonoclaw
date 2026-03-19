/**
 * 钉钉流式 AI 卡片（打字机效果）
 *
 * 通过互动卡片 API 实现类 ChatGPT 的逐字输出效果：
 * 1. 创建卡片实例 → POST /v1.0/card/instances
 * 2. 投放到会话 → POST /v1.0/card/instances/spaces + deliver
 * 3. 逐步更新内容 → PUT /v1.0/card/instances
 * 4. 完成后关闭流式状态
 *
 * flowStatus: "0"=正常, "1"=完成(含反馈按钮), "2"=失败, "3"=AI 生成中
 */
import { getAccessToken } from "./client.js";

const DINGTALK_API = "https://api.dingtalk.com";

/**
 * 钉钉不像飞书有内置的流式卡片模板，需要在钉钉开发者后台创建卡片模板。
 * 如果没有配置模板 ID，则降级使用普通 Markdown 消息 + 多次更新的方式。
 *
 * 推荐的卡片模板变量：
 * - markdown: string (AI 输出内容)
 * - flowStatus: "0" | "1" | "2" | "3" (状态)
 */

interface CardState {
	outTrackId: string;
	robotCode: string;
	cardTemplateId: string;
	currentText: string;
	sequence: number;
}

async function apiPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
	const token = await getAccessToken();
	const res = await fetch(`${DINGTALK_API}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-acs-dingtalk-access-token": token,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`DingTalk Card API ${path} ${res.status}: ${text}`);
	}
	return (await res.json()) as Record<string, unknown>;
}

async function apiPut(path: string, body: Record<string, unknown>): Promise<void> {
	const token = await getAccessToken();
	const res = await fetch(`${DINGTALK_API}${path}`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"x-acs-dingtalk-access-token": token,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`DingTalk Card PUT ${path} ${res.status}: ${text}`);
	}
}

export class DingtalkStreamingCard {
	private state: CardState | null = null;
	private queue: Promise<void> = Promise.resolve();
	private closed = false;
	private log?: (msg: string) => void;
	private lastUpdateTime = 0;
	private pendingText: string | null = null;
	private updateThrottleMs = 200;

	constructor(
		private robotCode: string,
		private cardTemplateId: string,
		log?: (msg: string) => void,
	) {
		this.log = log;
	}

	/**
	 * 创建并投放流式卡片到指定会话
	 * @param openConversationId 会话 ID（群聊用 openConversationId，私聊需要先转换）
	 * @param isGroup 是否群聊
	 * @param receiverUserId 私聊时的接收用户 ID
	 */
	async start(
		openConversationId: string,
		isGroup: boolean,
		receiverUserId?: string,
	): Promise<void> {
		if (this.state) return;
		if (!isGroup && !receiverUserId) {
			throw new Error("[钉钉卡片] 私聊模式必须提供 receiverUserId");
		}

		const outTrackId = `stream_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

		await apiPost("/v1.0/card/instances", {
			cardTemplateId: this.cardTemplateId,
			outTrackId,
			cardData: {
				cardParamMap: {
					flowStatus: "3",
					markdown: "**思考中...**",
				},
			},
			robotCode: this.robotCode,
			callbackType: "STREAM",
		});

		const spaceBody: Record<string, unknown> = {
			outTrackId,
			spaceType: isGroup ? "IM_GROUP" : "IM_ROBOT",
		};
		if (isGroup) {
			spaceBody.openConversationId = openConversationId;
		} else if (receiverUserId) {
			spaceBody.userId = receiverUserId;
		}

		await apiPost("/v1.0/card/instances/spaces", spaceBody);
		await apiPost("/v1.0/card/instances/deliver", {
			outTrackId,
			spaceType: isGroup ? "IM_GROUP" : "IM_ROBOT",
			openConversationId: isGroup ? openConversationId : undefined,
			userId: !isGroup ? receiverUserId : undefined,
		});

		this.state = {
			outTrackId,
			robotCode: this.robotCode,
			cardTemplateId: this.cardTemplateId,
			currentText: "",
			sequence: 1,
		};
		this.log?.(`[钉钉卡片] 流式卡片已创建: ${outTrackId}`);
	}

	/**
	 * 更新卡片内容（带节流）
	 */
	async update(text: string): Promise<void> {
		if (!this.state || this.closed) return;

		const now = Date.now();
		if (now - this.lastUpdateTime < this.updateThrottleMs) {
			this.pendingText = text;
			return;
		}
		this.pendingText = null;
		this.lastUpdateTime = now;

		this.queue = this.queue.then(async () => {
			if (!this.state || this.closed) return;
			this.state.currentText = text;
			try {
				await apiPut("/v1.0/card/instances", {
					outTrackId: this.state.outTrackId,
					cardData: {
						cardParamMap: {
							flowStatus: "3",
							markdown: text,
						},
					},
					cardUpdateOptions: { updateCardDataByKey: true },
				});
			} catch (err) {
				this.log?.(`[钉钉卡片] 更新失败: ${err}`);
			}
		});
		await this.queue;
	}

	/**
	 * 关闭流式卡片，设置最终内容
	 */
	async close(finalText?: string): Promise<void> {
		if (!this.state || this.closed) return;
		this.closed = true;
		await this.queue;

		const text = finalText ?? this.pendingText ?? this.state.currentText;
		try {
			await apiPut("/v1.0/card/instances", {
				outTrackId: this.state.outTrackId,
				cardData: {
					cardParamMap: {
						flowStatus: "1",
						markdown: text || "(空)",
					},
				},
				cardUpdateOptions: { updateCardDataByKey: true },
			});
		} catch (err) {
			this.log?.(`[钉钉卡片] 关闭失败: ${err}`);
		}
		this.log?.(`[钉钉卡片] 已关闭: ${this.state.outTrackId}`);
	}

	isActive(): boolean {
		return this.state !== null && !this.closed;
	}
}
