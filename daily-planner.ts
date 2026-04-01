/**
 * 每日规划（服务器版）
 *
 * 用法:
 *   bun daily-planner.ts morning    # 早间规划
 *   bun daily-planner.ts evening    # 晚间总结
 *
 * 无 Mac 提醒（Linux 服务器），仅钉钉日程+待办
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = import.meta.dirname;
const ENV_PATH = resolve(ROOT, ".env");
const CACHE_PATH = resolve(ROOT, ".dingtalk-contacts.json");
const USER_NAME = "梁钰珊";

function parseEnv(): Record<string, string> {
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
	return env;
}

const env = parseEnv();
const CLIENT_ID = env.DINGTALK_CLIENT_ID;
const CLIENT_SECRET = env.DINGTALK_CLIENT_SECRET;
const ROBOT_CODE = env.DINGTALK_ROBOT_CODE || CLIENT_ID;

async function getAccessToken(): Promise<string> {
	const resp = await fetch("https://api.dingtalk.com/v1.0/oauth2/accessToken", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ appKey: CLIENT_ID, appSecret: CLIENT_SECRET }),
	});
	const data = await resp.json() as any;
	return data.accessToken;
}

function loadContacts(): Record<string, string> {
	if (!existsSync(CACHE_PATH)) return {};
	return JSON.parse(readFileSync(CACHE_PATH, "utf-8")).contacts;
}

async function getUnionId(token: string, userId: string): Promise<string> {
	const resp = await fetch(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${token}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ userid: userId }),
	});
	const data = await resp.json() as any;
	if (data.errcode !== 0) throw new Error(`获取unionId失败: ${data.errmsg}`);
	return data.result.unionid;
}

async function getDingTalkCalendar(token: string, unionId: string): Promise<string[]> {
	const now = new Date();
	const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
	const dayEnd = new Date(now); dayEnd.setHours(23, 59, 59, 999);

	try {
		const url = new URL(`https://api.dingtalk.com/v1.0/calendar/users/${unionId}/calendars/primary/events`);
		url.searchParams.set("timeMin", dayStart.toISOString());
		url.searchParams.set("timeMax", dayEnd.toISOString());
		url.searchParams.set("maxResults", "50");
		const resp = await fetch(url.toString(), {
			headers: { "x-acs-dingtalk-access-token": token },
		});
		const data = await resp.json() as any;
		const events = data.events || [];
		if (events.length === 0) return ["（无日程）"];
		return events.map((e: any) => {
			const start = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }) : "全天";
			const end = e.end?.dateTime ? new Date(e.end.dateTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }) : "";
			const time = end ? `${start}-${end}` : start;
			const attendeeCount = (e.attendees || []).length;
			return `• ${time} ${e.summary}${attendeeCount > 0 ? `（${attendeeCount}人）` : ""}`;
		});
	} catch (err: any) {
		return [`（日程读取失败: ${err.message}）`];
	}
}

async function getDingTalkTodos(token: string, unionId: string): Promise<string[]> {
	try {
		const resp = await fetch(`https://api.dingtalk.com/v1.0/todo/users/${unionId}/org/tasks/query`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
			body: JSON.stringify({ isDone: false }),
		});
		const data = await resp.json() as any;
		const tasks = data.todoCards || data.result || [];
		if (tasks.length === 0) return ["（无待办）"];
		return tasks.slice(0, 15).map((t: any) => {
			const due = t.dueTime ? `（截止 ${new Date(t.dueTime).toLocaleDateString("zh-CN")}）` : "";
			return `• ${t.subject || t.title || "未命名"}${due}`;
		});
	} catch (err: any) {
		return [`（待办读取失败: ${err.message}）`];
	}
}

async function sendMessage(token: string, userId: string, msg: string) {
	await fetch("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-acs-dingtalk-access-token": token },
		body: JSON.stringify({
			robotCode: ROBOT_CODE,
			userIds: [userId],
			msgKey: "sampleText",
			msgParam: JSON.stringify({ content: msg }),
		}),
	});
}

async function main() {
	const mode = process.argv[2];
	if (mode !== "morning" && mode !== "evening") {
		console.log("用法: bun daily-planner.ts morning|evening");
		process.exit(1);
	}

	const today = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai" });

	const token = await getAccessToken();
	const contacts = loadContacts();
	const userId = contacts[USER_NAME];
	if (!userId) { console.error(`未找到联系人: ${USER_NAME}`); process.exit(1); }
	const unionId = await getUnionId(token, userId);

	const [calendar, todos] = await Promise.all([
		getDingTalkCalendar(token, unionId),
		getDingTalkTodos(token, unionId),
	]);

	if (mode === "morning") {
		const msg = `☀️ ${today} 早间规划\n\n📅 今日日程\n${calendar.join("\n")}\n\n📋 钉钉待办\n${todos.join("\n")}\n\n💡 专注当下，一件一件来。`;
		await sendMessage(token, userId, msg);
		console.log("✅ 早间规划已发送");
	} else {
		const msg = `🌙 ${today} 晚间总结\n\n📅 今日日程回顾\n${calendar.join("\n")}\n\n📋 待办状态\n${todos.join("\n")}\n\n💤 辛苦了，早点休息。`;
		await sendMessage(token, userId, msg);
		console.log("✅ 晚间总结已发送");
	}
}

main().catch(console.error);
