#!/usr/bin/env python3
"""
保活器：等待用户输入下一条指令。
--id 参数提供稳定的会话标识（不随 PID 变化），用于 nonoclaw 集成。
"""
import argparse
import json
import os
import platform
import subprocess
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SESSIONS_DIR = os.path.join(SCRIPT_DIR, "sessions")

_current_session_id = None

def _wait_cmd():
    """构建包含当前 --id 参数的 wait-input 命令"""
    base = "python3 .cursor/scripts/wait-input.py"
    if _current_session_id:
        base += f' --id "{_current_session_id}"'
    return base

def emit(output):
    cmd = _wait_cmd()
    if output == "[SESSION_END]":
        print(output)
    elif output == "[EMPTY_INPUT]":
        print(output)
        print(f"\n[KEEP-ALIVE] 等待超时，立即重新执行 {cmd} 继续等待。")
    else:
        print(output)
        print(f"\n[KEEP-ALIVE] 完成此指令后，你必须再次执行 {cmd} 等待下一条指令。"
              f"如果返回 [EMPTY_INPUT]，立即重新执行同一命令。"
              f"只有收到 [SESSION_END] 才可以结束。")


def _update_session_file(session_file, sid, session_name, status):
    """更新 session JSON，保留用户自定义的 name"""
    existing = {}
    try:
        with open(session_file, "r") as f:
            existing = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    existing["id"] = sid
    existing["status"] = status
    existing["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    if "name" not in existing:
        existing["name"] = session_name or f"会话-{sid}"
    if "created_at" not in existing:
        existing["created_at"] = existing["updated_at"]

    with open(session_file, "w") as f:
        json.dump(existing, f, ensure_ascii=False)


def wait_via_inbox(session_name, session_id=None):
    """通过 .inbox 文件接收输入（Cursor 扩展或 nonoclaw 均可写入）"""
    os.makedirs(SESSIONS_DIR, exist_ok=True)
    sid = session_id or str(os.getpid())
    session_file = os.path.join(SESSIONS_DIR, f"{sid}.json")
    inbox_file = os.path.join(SESSIONS_DIR, f"{sid}.inbox")

    _update_session_file(session_file, sid, session_name, "waiting")

    if os.path.exists(inbox_file):
        os.remove(inbox_file)

    try:
        deadline = time.time() + 3600
        heartbeat = time.time()
        while time.time() < deadline:
            time.sleep(0.5)

            if time.time() - heartbeat > 30:
                _update_session_file(session_file, sid, session_name, "waiting")
                heartbeat = time.time()

            if os.path.exists(inbox_file):
                with open(inbox_file, "r") as f:
                    content = f.read().strip()
                if content:
                    os.remove(inbox_file)
                    _update_session_file(session_file, sid, session_name, "processing")
                    emit("[SESSION_END]" if content == "[SESSION_END]" else content)
                    return
        emit("[EMPTY_INPUT]")
    finally:
        try:
            os.remove(inbox_file)
        except OSError:
            pass


def wait_via_dialog(session_name):
    """macOS 原生对话框"""
    title = f"保活器 — {session_name}" if session_name else "保活器"
    script = f'''
try
    set dialogResult to display dialog "🦞 下一步指令:" default answer "" buttons {{"结束", "继续"}} default button "继续" with title "{title}" giving up after 3600
    if gave up of dialogResult then
        return "[TIMEOUT]"
    else if button returned of dialogResult is "结束" then
        set confirm to display dialog "确定要结束保活吗？" buttons {{"取消", "确定结束"}} default button "取消" with title "{title}"
        if button returned of confirm is "确定结束" then
            return "[SESSION_END]"
        else
            return "[CANCELLED]"
        end if
    else
        return text returned of dialogResult
    end if
on error
    return "[SESSION_END]"
end try
'''
    while True:
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
        output = result.stdout.strip()
        if output == "[CANCELLED]":
            continue
        if not output or output == "[TIMEOUT]":
            emit("[EMPTY_INPUT]")
        elif output == "[SESSION_END]":
            emit("[SESSION_END]")
        else:
            emit(output)
        return


def main():
    global _current_session_id
    parser = argparse.ArgumentParser(description="保活器")
    parser.add_argument("--session", default="", help="会话名称")
    parser.add_argument("--id", default="", help="稳定会话 ID")
    parser.add_argument("--mode", default="extension", choices=["dialog", "extension", "file"])
    args = parser.parse_args()

    _current_session_id = args.id or None

    if args.mode == "dialog" and platform.system() == "Darwin":
        wait_via_dialog(args.session)
    else:
        wait_via_inbox(args.session, args.id or None)


if __name__ == "__main__":
    main()
