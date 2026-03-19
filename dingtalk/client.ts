/**
 * 钉钉 Stream 客户端管理
 *
 * 基于 dingtalk-stream SDK，通过 Stream 模式接收机器人消息。
 * AccessToken 自动获取和缓存（SDK 内部管理）。
 */
import { DWClient, TOPIC_ROBOT, EventAck, type DWClientDownStream } from "dingtalk-stream";
import type { DingtalkConfig } from "./types.js";

let dwClient: DWClient | null = null;

export function createDingtalkClient(config: DingtalkConfig): DWClient {
	if (dwClient) return dwClient;

	dwClient = new DWClient({
		clientId: config.appKey,
		clientSecret: config.appSecret,
		debug: false,
	});
	return dwClient;
}

export function getDingtalkClient(): DWClient | null {
	return dwClient;
}

/**
 * 获取 AccessToken（用于 OpenAPI 调用）
 * SDK 内部有缓存机制
 */
export async function getAccessToken(): Promise<string> {
	if (!dwClient) throw new Error("DingTalk client not initialized");
	return await dwClient.getAccessToken();
}

/**
 * 启动 Stream 连接并注册消息回调
 */
export function startDingtalkStream(
	config: DingtalkConfig,
	onMessage: (downstream: DWClientDownStream) => void | Promise<void>,
): DWClient {
	const client = createDingtalkClient(config);

	client.registerCallbackListener(TOPIC_ROBOT, async (res: DWClientDownStream) => {
		try {
			await onMessage(res);
		} catch (err) {
			console.error("[钉钉] 消息处理异常:", err);
		}
		client.socketCallBackResponse(res.headers.messageId, { status: EventAck.SUCCESS });
	});

	client.registerAllEventListener((_msg: DWClientDownStream) => {
		return { status: EventAck.SUCCESS };
	});

	client.connect();
	return client;
}

export { TOPIC_ROBOT, EventAck } from "dingtalk-stream";
export type { DWClientDownStream } from "dingtalk-stream";
