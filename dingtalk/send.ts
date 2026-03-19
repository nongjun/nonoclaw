/**
 * 钉钉消息发送
 *
 * 三条发送路径：
 * 1. sessionWebhook — 回复收到的消息（临时 URL，有过期时间）
 * 2. OpenAPI 私聊 — /v1.0/robot/oToMessages/batchSend
 * 3. OpenAPI 群聊 — /v1.0/robot/groupMessages/send
 */
import { getAccessToken } from "./client.js";
import type { DingtalkSendResult } from "./types.js";

const DINGTALK_API = "https://api.dingtalk.com";

async function dingtalkFetch(
	path: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
		throw new Error(`DingTalk API ${path} ${res.status}: ${text}`);
	}
	return (await res.json()) as Record<string, unknown>;
}

async function dingtalkPut(
	path: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
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
		throw new Error(`DingTalk API PUT ${path} ${res.status}: ${text}`);
	}
	const contentType = res.headers.get("content-type") || "";
	if (contentType.includes("application/json")) {
		return (await res.json()) as Record<string, unknown>;
	}
	return { ok: true };
}

/**
 * 通过 sessionWebhook 回复消息（最简单的方式）
 */
export async function replyViaWebhook(
	webhookUrl: string,
	markdown: string,
	title?: string,
	atUserIds?: string[],
): Promise<DingtalkSendResult> {
	try {
		const body: Record<string, unknown> = {
			msgtype: "markdown",
			markdown: {
				title: title || "回复",
				text: markdown,
			},
		};
		if (atUserIds?.length) {
			body.at = { atUserIds, isAtAll: false };
		}
		const res = await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) {
			const text = await res.text();
			return { ok: false, error: `webhook ${res.status}: ${text}` };
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 通过 OpenAPI 发送私聊消息
 */
export async function sendPrivateMessage(
	robotCode: string,
	userIds: string[],
	markdown: string,
	title?: string,
): Promise<DingtalkSendResult> {
	try {
		const result = await dingtalkFetch("/v1.0/robot/oToMessages/batchSend", {
			robotCode,
			userIds,
			msgKey: "sampleMarkdown",
			msgParam: JSON.stringify({
				title: title || "消息",
				text: markdown,
			}),
		});
		return {
			ok: true,
			processQueryKey: result.processQueryKey as string | undefined,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 通过 OpenAPI 发送群聊消息
 */
export async function sendGroupMessage(
	robotCode: string,
	openConversationId: string,
	markdown: string,
	title?: string,
): Promise<DingtalkSendResult> {
	try {
		const result = await dingtalkFetch("/v1.0/robot/groupMessages/send", {
			robotCode,
			openConversationId,
			msgKey: "sampleMarkdown",
			msgParam: JSON.stringify({
				title: title || "消息",
				text: markdown,
			}),
		});
		return {
			ok: true,
			processQueryKey: result.processQueryKey as string | undefined,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 通过 OpenAPI 发送纯文本私聊消息
 */
export async function sendPrivateText(
	robotCode: string,
	userIds: string[],
	text: string,
): Promise<DingtalkSendResult> {
	try {
		const result = await dingtalkFetch("/v1.0/robot/oToMessages/batchSend", {
			robotCode,
			userIds,
			msgKey: "sampleText",
			msgParam: JSON.stringify({ content: text }),
		});
		return {
			ok: true,
			processQueryKey: result.processQueryKey as string | undefined,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 通过 OpenAPI 发送纯文本群聊消息
 */
export async function sendGroupText(
	robotCode: string,
	openConversationId: string,
	text: string,
): Promise<DingtalkSendResult> {
	try {
		const result = await dingtalkFetch("/v1.0/robot/groupMessages/send", {
			robotCode,
			openConversationId,
			msgKey: "sampleText",
			msgParam: JSON.stringify({ content: text }),
		});
		return {
			ok: true,
			processQueryKey: result.processQueryKey as string | undefined,
		};
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

