#!/usr/bin/env node
/**
 * 火山引擎豆包 STT（WebSocket 二进制协议，支持 OGG/Opus 直传）
 *
 * 用法: node volc-stt.js <audioPath> <appId> <accessToken>
 * 成功时输出识别文本到 stdout（exit 0），失败输出错误到 stderr（exit 1）
 *
 * 必须用 Node.js 运行（Bun 的 WebSocket 客户端在部分网络环境下不工作）
 */
const WebSocket = require("ws");
const { readFileSync } = require("fs");
const { gzipSync, gunzipSync } = require("zlib");
const { randomUUID } = require("crypto");

const [audioPath, appId, accessToken] = process.argv.slice(2);
if (!audioPath || !appId || !accessToken) {
	process.stderr.write("用法: node volc-stt.js <audioPath> <appId> <accessToken>\n");
	process.exit(1);
}

const STT_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
const RESOURCE_ID = "volc.bigasr.sauc.duration";

function buildHeader(msgType, flags, serial, compress) {
	const h = Buffer.alloc(4);
	h[0] = 0x11;
	h[1] = ((msgType & 0xf) << 4) | (flags & 0xf);
	h[2] = ((serial & 0xf) << 4) | (compress & 0xf);
	h[3] = 0x00;
	return h;
}

function buildPacket(header, payload) {
	const size = Buffer.alloc(4);
	size.writeUInt32BE(payload.length);
	return Buffer.concat([header, size, payload]);
}

let settled = false;
const ws = new WebSocket(STT_URL, {
	headers: {
		"X-Api-App-Key": appId,
		"X-Api-Access-Key": accessToken,
		"X-Api-Resource-Id": RESOURCE_ID,
		"X-Api-Connect-Id": randomUUID(),
	},
});

const timer = setTimeout(() => done(new Error("超时 (30s)")), 30000);

function done(err, text) {
	if (settled) return;
	settled = true;
	clearTimeout(timer);
	try { ws.close(); } catch {}
	if (err) {
		process.stderr.write(err.message + "\n");
		process.exit(1);
	}
	process.stdout.write(text);
	process.exit(0);
}

ws.on("open", () => {
	const ext = audioPath.replace(/.*\./, ".").toLowerCase();
	const isOgg = ext === ".ogg" || ext === ".opus";

	const audioConfig = isOgg
		? { format: "ogg", codec: "opus", rate: 16000, bits: 16, channel: 1 }
		: { format: "pcm", rate: 16000, bits: 16, channel: 1 };

	const configPayload = Buffer.from(JSON.stringify({
		user: { uid: "relay-bot" },
		audio: audioConfig,
		request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, enable_ddc: true },
	}));
	ws.send(buildPacket(buildHeader(0x1, 0x0, 0x1, 0x1), gzipSync(configPayload)));

	const fileData = readFileSync(audioPath);
	if (fileData.length === 0) {
		done(new Error("音频文件为空"));
		return;
	}
	const CHUNK = 6400;

	for (let off = 0; off < fileData.length; off += CHUNK) {
		const isLast = off + CHUNK >= fileData.length;
		const chunk = fileData.subarray(off, Math.min(off + CHUNK, fileData.length));
		ws.send(buildPacket(buildHeader(0x2, isLast ? 0x2 : 0x0, 0x0, 0x1), gzipSync(chunk)));
	}
});

ws.on("message", (raw) => {
	const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
	if (buf.length < 4) return;

	const msgType = (buf[1] >> 4) & 0xf;
	const flags = buf[1] & 0xf;
	const compress = buf[2] & 0xf;

	if (msgType === 0xf) {
		let msg = "服务端错误";
		if (buf.length >= 12) {
			const code = buf.readUInt32BE(4);
			const msgLen = buf.readUInt32BE(8);
			msg = `[${code}] ${buf.subarray(12, 12 + Math.min(msgLen, buf.length - 12)).toString("utf-8")}`;
		}
		done(new Error(msg));
		return;
	}

	if (msgType === 0x9 && (flags & 0x2)) {
		let off = 4;
		if (flags & 0x1) off += 4;
		if (off + 4 > buf.length) return;
		const pSize = buf.readUInt32BE(off);
		off += 4;
		if (off + pSize > buf.length) return;

		let payload = buf.subarray(off, off + pSize);
		if (compress === 1) {
			try { payload = gunzipSync(payload); } catch { done(new Error("解压响应失败")); return; }
		}
		try {
			const json = JSON.parse(payload.toString("utf-8"));
			const text = json?.result?.text?.trim();
			if (text) done(null, text);
			else done(new Error("识别结果为空"));
		} catch {
			done(new Error("解析响应 JSON 失败"));
		}
	}
});

ws.on("unexpected-response", (_req, res) => {
	done(new Error(`HTTP ${res.statusCode ?? "unknown"} (WebSocket 升级被拒)`));
});
ws.on("error", (err) => done(new Error(`WebSocket: ${err.message}`)));
ws.on("close", () => { if (!settled) done(new Error("连接意外断开")); });
