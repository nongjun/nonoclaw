/**
 * 钉钉媒体文件下载
 *
 * 钉钉机器人消息中的图片、文件等媒体通过 OpenAPI 下载。
 * 支持旧版 API（oapi.dingtalk.com）和新版 API（api.dingtalk.com）。
 */
import { getAccessToken } from "./client.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const OAPI_BASE = "https://oapi.dingtalk.com";

/**
 * 下载钉钉媒体文件（图片/语音/文件）
 *
 * 钉钉机器人收到的富媒体消息体中会包含 downloadCode，
 * 可通过 OpenAPI 下载文件内容。
 *
 * @param downloadCode 文件下载码（从消息体中提取）
 * @param inboxDir 保存目录
 * @param ext 文件扩展名
 * @returns 保存的本地文件路径
 */
export async function downloadDingtalkMedia(
	downloadCode: string,
	inboxDir: string,
	ext: string = "",
): Promise<string> {
	if (!downloadCode) throw new Error("downloadCode is required");

	const token = await getAccessToken();
	const res = await fetch(`${OAPI_BASE}/robot/messageFile/download?access_token=${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ downloadCode }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`DingTalk media download failed: ${res.status} ${body || res.statusText}`);
	}

	const buffer = Buffer.from(await res.arrayBuffer());
	await mkdir(inboxDir, { recursive: true });
	const filename = `dingtalk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const filepath = resolve(inboxDir, filename);
	await writeFile(filepath, buffer);
	console.log(`[钉钉下载] ${filepath} (${buffer.length} bytes)`);
	return filepath;
}

/**
 * 通过新版 API 下载文件
 *
 * 部分钉钉消息类型使用 mediaId 来标识文件，
 * 需要通过 /v1.0/robot/messageFiles/download 接口下载。
 */
export async function downloadDingtalkMediaById(
	downloadCode: string,
	robotCode: string,
	inboxDir: string,
	ext: string = "",
): Promise<string> {
	if (!downloadCode) throw new Error("downloadCode is required");

	const token = await getAccessToken();
	const res = await fetch(`https://api.dingtalk.com/v1.0/robot/messageFiles/download`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-acs-dingtalk-access-token": token,
		},
		body: JSON.stringify({ downloadCode, robotCode }),
	});

	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`DingTalk media download v2 failed: ${res.status} ${body || res.statusText}`);
	}

	const buffer = Buffer.from(await res.arrayBuffer());
	await mkdir(inboxDir, { recursive: true });
	const filename = `dingtalk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
	const filepath = resolve(inboxDir, filename);
	await writeFile(filepath, buffer);
	console.log(`[钉钉下载v2] ${filepath} (${buffer.length} bytes)`);
	return filepath;
}
