#!/usr/bin/env python3
"""AI 调用量分析报告 — 查询 SLS ai-stats 生成全系统摘要

用法：
  python3 ai-stats-report.py              # 默认过去 12 小时
  python3 ai-stats-report.py --hours 24   # 过去 24 小时
"""
import argparse, time, os, sys, json


def _maybe_reexec_without_local_proxy():
    ld = os.environ.get("LD_PRELOAD", "")
    hp = os.environ.get("HTTP_PROXY", "") + os.environ.get("HTTPS_PROXY", "") + os.environ.get("ALL_PROXY", "")
    lp = os.environ.get("http_proxy", "") + os.environ.get("https_proxy", "") + os.environ.get("all_proxy", "")
    combined = hp + lp
    risky = ("proxychains" in ld.lower()) or ("127.0.0.1:7897" in combined) or ("localhost:7897" in combined)
    if not risky:
        return
    env = {k: v for k, v in os.environ.items()
           if k.upper() not in ("LD_PRELOAD", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY")
           and k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    os.execve(sys.executable, [sys.executable, os.path.abspath(__file__)] + sys.argv[1:], env)


def load_env(path="/root/瑞小美AiOS/.env"):
    env = {}
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return env


MODEL_NAMES = {
    "composer-2-fast": "Composer 2 Fast (nonomax)",
    "composer-2": "Composer 2 (nonomax)",
    "doubao-seed-2-0-pro-260215": "豆包 2.0 (火山引擎)",
}

MODULE_NAMES = {
    "quality": "对话质检",
    "contacts": "联系人",
    "hosting": "企微托管",
    "hosting_agent": "托管Agent",
    "ai_features": "AI功能",
    "archive": "会话存档",
    "content": "内容中心",
    "moment": "朋友圈",
    "portal": "门户系统",
    "reply": "侧边栏",
    "liaohui": "聊回",
    "outreach": "主动触达",
}


def query_sls(client, project, logstore, from_time, to_time, query, limit=200):
    from aliyun.log import GetLogsRequest
    req = GetLogsRequest(project, logstore, from_time, to_time, query=query, line=limit)
    resp = client.get_logs(req)
    return [log.get_contents() for log in resp.get_logs()]


def main():
    parser = argparse.ArgumentParser(description="AI 调用量分析报告")
    parser.add_argument("--hours", type=float, default=12, help="查询最近N小时（默认12）")
    args = parser.parse_args()

    env = load_env()
    endpoint = env.get("SLS_ENDPOINT", "cn-shenzhen.log.aliyuncs.com")
    project = env.get("SLS_PROJECT", "rxm-aios")
    key_id = env.get("SLS_ACCESS_KEY_ID", "")
    key_secret = env.get("SLS_ACCESS_KEY_SECRET", "")

    if not key_id or not key_secret:
        print("错误: SLS 凭据未配置", file=sys.stderr)
        sys.exit(1)

    from aliyun.log import LogClient
    client = LogClient(endpoint, key_id, key_secret)

    to_time = int(time.time())
    from_time = to_time - int(args.hours * 3600)
    logstore = "ai-stats"
    hours = args.hours

    # 1. 总量统计
    overall = query_sls(client, project, logstore, from_time, to_time,
        "* | SELECT status, count(*) as cnt GROUP BY status")
    total = sum(int(r.get("cnt", 0)) for r in overall)
    status_map = {r["status"]: int(r["cnt"]) for r in overall}
    success = status_map.get("success", 0)
    error = status_map.get("error", 0)
    cancelled = status_map.get("cancelled", 0)
    success_rate = f"{success/total*100:.1f}%" if total > 0 else "N/A"

    # 2. 按模块统计
    by_module = query_sls(client, project, logstore, from_time, to_time,
        "* | SELECT module_code, status, count(*) as cnt GROUP BY module_code, status ORDER BY module_code")
    modules = {}
    for r in by_module:
        mc = r.get("module_code", "unknown")
        st = r.get("status", "unknown")
        cnt = int(r.get("cnt", 0))
        if mc not in modules:
            modules[mc] = {"total": 0, "success": 0, "error": 0, "cancelled": 0}
        modules[mc]["total"] += cnt
        modules[mc][st] = modules[mc].get(st, 0) + cnt

    # 3. 按模型统计
    by_model = query_sls(client, project, logstore, from_time, to_time,
        "* | SELECT gen_ai_request_model, status, count(*) as cnt, "
        "avg(gen_ai_response_latency_ms) as avg_lat "
        "GROUP BY gen_ai_request_model, status ORDER BY cnt DESC")
    models = {}
    for r in by_model:
        m = r.get("gen_ai_request_model", "unknown")
        st = r.get("status", "unknown")
        cnt = int(r.get("cnt", 0))
        avg_lat = float(r.get("avg_lat", 0))
        if m not in models:
            models[m] = {"total": 0, "success": 0, "error": 0, "cancelled": 0, "avg_lat_sum": 0, "lat_count": 0}
        models[m]["total"] += cnt
        models[m][st] = models[m].get(st, 0) + cnt
        if avg_lat > 0:
            models[m]["avg_lat_sum"] += avg_lat * cnt
            models[m]["lat_count"] += cnt

    # 4. 降级到豆包的详情
    doubao_details = query_sls(client, project, logstore, from_time, to_time,
        "* AND gen_ai_request_model: doubao-seed-2-0-pro-260215 | "
        "SELECT module_code, prompt_name, count(*) as cnt "
        "GROUP BY module_code, prompt_name ORDER BY cnt DESC")

    # 5. 按小时分布
    by_hour = query_sls(client, project, logstore, from_time, to_time,
        "* | SELECT date_format(from_unixtime(__time__), '%H:00') as hour, "
        "count(*) as cnt GROUP BY hour ORDER BY hour")

    # ── 输出报告 ──
    print(f"# AI 调用量分析报告（过去 {hours:.0f} 小时）\n")

    print(f"## 总量")
    print(f"- 总调用: **{total}** 次")
    print(f"- 成功: {success} | 失败: {error} | 取消: {cancelled}")
    print(f"- 整体成功率: **{success_rate}**")
    if total > 0:
        print(f"- 平均每小时: {total/hours:.0f} 次")
    print()

    # 模块表
    print("## 按模块")
    print("| 模块 | 总量 | 成功 | 失败 | 成功率 |")
    print("|------|------|------|------|--------|")
    for mc in sorted(modules, key=lambda x: modules[x]["total"], reverse=True):
        m = modules[mc]
        name = MODULE_NAMES.get(mc, mc)
        rate = f"{m['success']/m['total']*100:.0f}%" if m["total"] > 0 else "N/A"
        flag = " ⚠" if m["total"] > 0 and m["success"] / m["total"] < 0.5 else ""
        print(f"| {name}({mc}) | {m['total']} | {m['success']} | {m['error']} | {rate}{flag} |")
    print()

    # 模型表
    print("## 按模型")
    print("| 模型 | 总量 | 成功率 | 平均延迟 |")
    print("|------|------|--------|----------|")
    for mn in sorted(models, key=lambda x: models[x]["total"], reverse=True):
        m = models[mn]
        name = MODEL_NAMES.get(mn, mn)
        rate = f"{m['success']/m['total']*100:.0f}%" if m["total"] > 0 else "N/A"
        avg_lat = f"{m['avg_lat_sum']/m['lat_count']/1000:.1f}s" if m["lat_count"] > 0 else "N/A"
        flag = " ⚠" if m["total"] > 0 and m["success"] / m["total"] < 0.5 else ""
        print(f"| {name} | {m['total']} | {rate}{flag} | {avg_lat} |")
    print()

    # 豆包降级详情
    if doubao_details:
        print("## 降级到豆包的调用")
        print("| 模块 | 功能 | 次数 |")
        print("|------|------|------|")
        for r in doubao_details:
            mc = r.get("module_code", "?")
            pn = r.get("prompt_name", "?")
            cnt = r.get("cnt", "0")
            print(f"| {MODULE_NAMES.get(mc, mc)} | {pn} | {cnt} |")
        print()

    # 小时分布
    if by_hour:
        print("## 调用时段分布")
        for r in sorted(by_hour, key=lambda x: x.get("hour", "")):
            hour = r.get("hour", "?")
            cnt = int(r.get("cnt", 0))
            bar = "█" * max(1, cnt // 10)
            print(f"  {hour}  {bar} {cnt}")
        print()

    # 异常提醒
    anomalies = []
    for mc, m in modules.items():
        if m["total"] > 10 and m["success"] / m["total"] < 0.5:
            anomalies.append(f"- ⚠ {MODULE_NAMES.get(mc, mc)} 成功率仅 {m['success']/m['total']*100:.0f}%（{m['error']} 次失败）")
    for mn, m in models.items():
        if m["total"] > 10 and m["success"] / m["total"] < 0.5:
            anomalies.append(f"- ⚠ {MODEL_NAMES.get(mn, mn)} 成功率仅 {m['success']/m['total']*100:.0f}%（{m['error']} 次失败）")
    if anomalies:
        print("## ⚠ 异常提醒")
        for a in anomalies:
            print(a)
    elif total > 0:
        print("## ✅ 无异常")
        print("所有模块和模型运行正常。")


if __name__ == "__main__":
    _maybe_reexec_without_local_proxy()
    main()
