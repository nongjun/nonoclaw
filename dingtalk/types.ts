/**
 * 钉钉模块类型定义
 */

export interface DingtalkConfig {
	appKey: string;
	appSecret: string;
	robotCode: string;       // 通常等于 appKey
	agentId?: string;
}

export interface DingtalkMessageContext {
	conversationId: string;
	conversationType: "1" | "2"; // 1=私聊, 2=群聊
	chatId: string;              // 群 openConversationId 或私聊 conversationId
	senderId: string;
	senderStaffId: string;
	senderNick: string;
	messageId: string;
	messageType: string;
	text: string;
	sessionWebhook: string;
	sessionWebhookExpiredTime: number;
	robotCode: string;
	isAdmin: boolean;
	rawData: string;
}

export interface DingtalkSendResult {
	ok: boolean;
	processQueryKey?: string;
	error?: string;
}