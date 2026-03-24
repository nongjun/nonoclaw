#!/usr/bin/env python3
"""SLS 日志查询工具 — 供 Agent shell 调用

用法：
  python3 query-sls.py                          # 近1小时 ERROR 日志
  python3 query-sls.py --hours 6                # 近6小时
  python3 query-sls.py --query "level:ERROR AND __tag__:login"  # 自定义查询
  python3 query-sls.py --logstore ai-stats      # 指定 logstore

说明：本机若启用 proxychains（LD_PRELOAD）或 HTTP(S)_PROXY 指向本地 Clash，
访问阿里云 SLS OpenAPI 易出现 HTTP 502。脚本会在检测到上述情况时自动 re-exec
为直连环境，避免误判为「SLS 故障」。
"""
import argparse, time, json, os, sys


def _maybe_reexec_without_local_proxy():
    """避免 proxychains / 127.0.0.1:7897 链路导致 SLS 502。"""
    ld = os.environ.get("LD_PRELOAD", "")
    hp = os.environ.get("HTTP_PROXY", "") + os.environ.get("HTTPS_PROXY", "") + os.environ.get("ALL_PROXY", "")
    lp = os.environ.get("http_proxy", "") + os.environ.get("https_proxy", "") + os.environ.get("all_proxy", "")
    combined = hp + lp
    risky = ("proxychains" in ld.lower()) or ("127.0.0.1:7897" in combined) or ("localhost:7897" in combined)
    if not risky:
        return
    env = {k: v for k, v in os.environ.items() if k.upper() not in ("LD_PRELOAD", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY") and k.lower() not in ("http_proxy", "https_proxy", "all_proxy")}
    script = os.path.abspath(__file__)
    os.execve(sys.executable, [sys.executable, script] + sys.argv[1:], env)

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

def main():
    parser = argparse.ArgumentParser(description="查询 SLS 日志")
    parser.add_argument("--hours", type=float, default=1, help="查询最近N小时")
    parser.add_argument("--query", default="ERROR", help="SLS 查询语句")
    parser.add_argument("--logstore", default="app-logs", help="logstore 名称")
    parser.add_argument("--limit", type=int, default=100, help="返回条数")
    parser.add_argument("--count-only", action="store_true", help="只返回数量")
    args = parser.parse_args()

    env = load_env()
    endpoint = env.get("SLS_ENDPOINT", "cn-shenzhen.log.aliyuncs.com")
    project = env.get("SLS_PROJECT", "rxm-aios")
    key_id = env.get("SLS_ACCESS_KEY_ID", "")
    key_secret = env.get("SLS_ACCESS_KEY_SECRET", "")

    if not key_id or not key_secret:
        print("错误: SLS_ACCESS_KEY_ID 或 SLS_ACCESS_KEY_SECRET 未配置", file=sys.stderr)
        sys.exit(1)

    from aliyun.log import LogClient, GetLogsRequest
    client = LogClient(endpoint, key_id, key_secret)

    to_time = int(time.time())
    from_time = to_time - int(args.hours * 3600)

    req = GetLogsRequest(project, args.logstore, from_time, to_time, query=args.query, line=args.limit)
    resp = client.get_logs(req)

    logs = resp.get_logs()

    if args.count_only:
        print(f"{len(logs)} 条匹配")
        return

    if not logs:
        print(f"近 {args.hours} 小时内无 {args.query} 日志")
        return

    print(f"近 {args.hours} 小时共 {len(logs)} 条匹配：\n")
    for i, log in enumerate(logs[:args.limit]):
        contents = log.get_contents()
        ts = contents.get("__time__", "")
        level = contents.get("level", "")
        module = contents.get("module", contents.get("logger", ""))
        msg = contents.get("message", contents.get("msg", json.dumps(contents, ensure_ascii=False)))
        print(f"[{i+1}] {ts} [{level}] {module}: {msg[:300]}")

if __name__ == "__main__":
    _maybe_reexec_without_local_proxy()
    main()
