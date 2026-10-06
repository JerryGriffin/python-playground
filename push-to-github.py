#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
push-to-github.py — 一条命令把本项目上传到 GitHub。

用途：在能访问 github.com 的网络环境里执行本脚本，自动完成
      建仓库 + 推送 + 打标签。本机（沙箱）到 github.com 的认证与推送
      通道不可用，因此上传这一步需要在你自己的环境完成。

用法：
    # 方式 A：让脚本引导 gh 登录后自动建仓库并推送（推荐）
    python push-to-github.py

    # 方式 B：已有 Personal Access Token（classic 勾选 repo，fine-grained 给 Contents 写权限）
    python push-to-github.py --token ghp_xxxxxxxx

    # 方式 C：仓库已在 GitHub 上建好，只推送上去了事
    python push-to-github.py --remote https://github.com/<你的用户名>/python-playground.git

常用可选参数：
    --repo python-playground    仓库名（默认 python-playground）
    --user Jerry_Griffin        用户名（默认从 gh 或 remote 推断）
    --branch main               分支名（默认 main）
    --private                   建私有仓库（默认公开）
    --tag v2.0.1                推送后打的标签（默认 v2.0.1，传 - 表示不打）
    --dry-run                   只打印将执行的命令，不做任何改动
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

DEFAULT_REPO = "python-playground"
DEFAULT_TAG = "v2.0.1"
DEFAULT_BRANCH = "main"


# --------------------------------------------------------------------- 工具 --

class Fail(Exception):
    pass


def run(cmd, dry=False, check=True, quiet=False, cwd=None):
    """执行命令；dry=True 时只打印。返回 (returncode, stdout)。"""
    printable = " ".join(cmd) if isinstance(cmd, list) else cmd
    if dry:
        print("    [dry-run] " + printable)
        return 0, ""
    if not quiet:
        print("    $ " + printable)
    proc = subprocess.run(
        cmd, cwd=cwd, shell=isinstance(cmd, str),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace",
    )
    out = (proc.stdout or "").strip()
    if out and not quiet:
        for line in out.splitlines()[:12]:
            print("      " + line)
    if check and proc.returncode != 0:
        raise Fail("命令失败（退出码 %s）：%s" % (proc.returncode, printable))
    return proc.returncode, out


def which(name):
    return shutil.which(name)


def find_gh():
    """gh 可能刚装好但不在当前 PATH 里，做一次常见路径兜底。"""
    p = which("gh")
    if p:
        return p
    if os.name == "nt":
        for cand in (r"C:\Program Files\GitHub CLI\gh.exe",
                     r"C:\Program Files (x86)\GitHub CLI\gh.exe",
                     os.path.expanduser(r"~\AppData\Local\GitHub CLI\gh.exe")):
            if os.path.isfile(cand):
                return cand
    return None


def api(url, token, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "push-to-github.py")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8") or "{}")
        except Exception:
            payload = {}
        return e.code, payload
    except Exception as e:
        raise Fail("请求 %s 失败：%s\n"
                   "（若本机无法访问 api.github.com，请换到可访问的网络再执行）" % (url, e))


# ----------------------------------------------------------------- 前置检查 --

def preflight():
    print("==> 1/5 环境检查")
    if not which("git"):
        raise Fail("未找到 git，请先安装 Git。")
    code, _ = run(["git", "--version"], quiet=True)
    code, top = run(["git", "rev-parse", "--show-toplevel"], quiet=True, check=False)
    if code != 0:
        raise Fail("当前目录不是 git 仓库。请在本项目目录下执行本脚本；"
                   "若尚未初始化，先运行：git init -b main")
    print("    项目目录：" + top)

    code, dirty = run(["git", "status", "--porcelain"], quiet=True, check=False)
    if dirty:
        print("    提示：有未提交的改动，将被一并推送（如需排除请先自行处理）：")
        for line in dirty.splitlines()[:8]:
            print("      " + line)
    return top


def ensure_identity(root):
    print("==> 2/5 检查提交身份")
    code, name = run(["git", "config", "user.name"], quiet=True, check=False, cwd=root)
    if not name:
        run(["git", "config", "user.name", "Jerry_Griffin"], cwd=root)
        print("    已设置 user.name = Jerry_Griffin")
    code, mail = run(["git", "config", "user.email"], quiet=True, check=False, cwd=root)
    if not mail:
        run(["git", "config", "user.email", "Jerry_Griffin@users.noreply.github.com"], cwd=root)
        print("    已设置 user.email = Jerry_Griffin@users.noreply.github.com")


# ------------------------------------------------------------------ 认证 -- --

def resolve_token(args):
    """返回 (token, login)。优先命令行 token，其次环境变量，其次 gh 登录态。"""
    token = args.token or os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        status, me = api("https://api.github.com/user", token)
        if status != 200:
            raise Fail("Token 无效或权限不足（HTTP %s）：%s" % (status, me.get("message", "")))
        print("    已使用 Token 认证，账号：" + me.get("login", "?"))
        return token, me.get("login")

    gh = find_gh()
    if not gh:
        raise Fail(
            "未检测到登录凭据。三选一：\n"
            "  1) 安装 GitHub CLI 后运行 gh auth login（Windows：winget install GitHub.cli）\n"
            "  2) 设置环境变量 GITHUB_TOKEN=你的令牌 后重跑\n"
            "  3) 直接传参 --token 你的令牌"
        )

    code, out = run([gh, "auth", "token"], quiet=True, check=False)
    if code != 0 or not out:
        print("    未登录 GitHub。现在启动授权流程，请按提示在浏览器中操作…")
        code, _ = run([gh, "auth", "login", "--hostname", "github.com",
                       "--git-protocol", "https", "--web"], check=False)
        if code != 0:
            raise Fail("gh 登录未完成。若提示连接 github.com 失败，请换网络后重试，"
                       "或改用 --token 方式。")
        code, out = run([gh, "auth", "token"], quiet=True, check=False)
        if code != 0 or not out:
            raise Fail("仍未取到令牌。")
    status, me = api("https://api.github.com/user", out)
    if status != 200:
        raise Fail("gh 令牌不可用（HTTP %s）。" % status)
    print("    已使用 gh 登录态，账号：" + me.get("login", "?"))
    return out, me.get("login")


# ------------------------------------------------------------- 建仓库并推送 --

def create_repo(token, login, repo, private, dry):
    print("==> 3/5 确认远端仓库 %s/%s" % (login, repo))
    status, info = api("https://api.github.com/repos/%s/%s" % (login, repo), token)
    if status == 200:
        print("    仓库已存在，将直接推送：" + info.get("html_url", ""))
        return info.get("clone_url") or "https://github.com/%s/%s.git" % (login, repo)

    body = {
        "name": repo,
        "private": bool(private),
        "description": "极简在线 Python 编辑器：浏览器内运行真实 CPython 3.11（Pyodide），代码不出本机。",
        "homepage": "https://python-online-ide.app.workbuddy.host/",
        "has_issues": True,
        "has_wiki": False,
    }
    if dry:
        print("    [dry-run] 将创建仓库 %s/%s（%s）" % (login, repo, "私有" if private else "公开"))
        return "https://github.com/%s/%s.git" % (login, repo)

    status, info = api("https://api.github.com/user/repos", token, "POST", body)
    if status not in (200, 201):
        msg = info.get("message", "")
        if "already exists" in msg:
            print("    仓库已存在，按既有仓库处理。")
            return "https://github.com/%s/%s.git" % (login, repo)
        raise Fail("创建仓库失败（HTTP %s）：%s\n"
                   "提示：令牌需要 repo 权限（fine-grained 需 Contents 读写）。" % (status, msg))
    print("    已创建：" + info.get("html_url", ""))
    return info.get("clone_url")


def push(root, remote, branch, dry, login=None, repo=None, token=None):
    print("==> 4/5 推送代码到 %s 分支 %s" % (remote, branch))
    code, cur = run(["git", "remote", "get-url", "origin"], quiet=True, check=False, cwd=root)
    if code == 0 and cur:
        print("    已有 origin：" + cur + "，改为 set-url 更新")
        run(["git", "remote", "set-url", "origin", remote], cwd=root, dry=dry)
    else:
        run(["git", "remote", "add", "origin", remote], cwd=root, dry=dry)

    # 统一分支名
    run(["git", "branch", "-M", branch], cwd=root, dry=dry, check=False)

    # 用一次性凭据注入，避免把 token 写进 .git/config
    env_note = ""
    if token and login:
        remote_auth = "https://%s:%s@github.com/%s/%s.git" % (login, token, login, repo)
        env_note = "（使用一次性凭据，不写入配置文件）"
    else:
        remote_auth = remote

    print("    git push -u origin %s %s" % (branch, env_note))
    code, out = run(["git", "push", "-u", "origin", branch], cwd=root, dry=dry, check=False)
    if code != 0 and token and login:
        # 回退：改用内嵌凭据的 URL 重推一次
        print("    首次推送失败，改用内嵌凭据重试…")
        code, out = run(["git", "push", remote_auth, branch + ":" + branch],
                        cwd=root, dry=dry, check=False)
    if code != 0:
        raise Fail(
            "推送失败。常见原因与对策：\n"
            "  - 连接 github.com 超时/被重置 → 换网络，或配置代理：\n"
            "      git config --global http.proxy http://127.0.0.1:端口\n"
            "      git config --global https.proxy http://127.0.0.1:端口\n"
            "  - 认证失败 → 用 --token 传入有效令牌（需 repo 权限）\n"
            "  - 远端有提交导致被拒 → git pull --rebase origin %s 后重试" % branch
        )
    return remote


def tag(root, name, dry):
    print("==> 5/5 打标签 " + name)
    code, existing = run(["git", "tag", "-l", name], quiet=True, check=False, cwd=root)
    if existing.strip():
        print("    标签已存在，跳过。")
        return
    run(["git", "tag", "-a", name, "-m", "Python 练习场 " + name], cwd=root, dry=dry)
    run(["git", "push", "origin", name], cwd=root, dry=dry, check=False)


# ------------------------------------------------------------------- 主流程 --

def main():
    ap = argparse.ArgumentParser(add_help=True, description="把本项目上传到 GitHub")
    ap.add_argument("--repo", default=DEFAULT_REPO, help="仓库名（默认 %s）" % DEFAULT_REPO)
    ap.add_argument("--user", help="GitHub 用户名（默认自动推断）")
    ap.add_argument("--branch", default=DEFAULT_BRANCH, help="分支名（默认 %s）" % DEFAULT_BRANCH)
    ap.add_argument("--tag", default=DEFAULT_TAG, help="推送后打的标签，传 - 表示不打")
    ap.add_argument("--token", help="Personal Access Token（需 repo 权限）")
    ap.add_argument("--remote", help="远端 URL；给出后跳过建仓库，直接推送")
    ap.add_argument("--private", action="store_true", help="建私有仓库")
    ap.add_argument("--dry-run", action="store_true", help="只打印将执行的命令")
    args = ap.parse_args()

    print("=" * 62)
    print("  Python 练习场 · 上传到 GitHub")
    print("=" * 62)

    try:
        root = preflight()
        ensure_identity(root)

        token = login = None
        if args.remote:
            remote = args.remote
            m = re.search(r"github\.com[:/]([^/]+)/", remote)
            if m:
                login = args.user or m.group(1)
            print("==> 3/5 使用指定远端：" + remote)
        else:
            token, login = resolve_token(args)
            login = args.user or login
            remote = create_repo(token, login, args.repo, args.private, args.dry_run)

        push(root, remote, args.branch, args.dry_run,
             login=login, repo=args.repo, token=token)

        if args.tag and args.tag != "-":
            tag(root, args.tag, args.dry_run)

        print()
        print("完成。仓库地址：https://github.com/%s/%s" % (login or "<用户名>", args.repo))
        if args.dry_run:
            print("（这是 dry-run，未做任何改动。去掉 --dry-run 即真正执行。）")
        return 0

    except Fail as e:
        print("\n[失败] " + str(e), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n已取消。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
