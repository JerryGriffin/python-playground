#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
upload.py — 把本项目一键上传到 GitHub（全包含版，零第三方依赖）。

一条命令做完这些事：
    1. 环境体检：git 是否可用、目录结构是否完整、github.com 各端点连通性
    2. 仓库就绪：按需 git init、设置提交身份、切到 main、提交未保存的改动
    3. 身份认证：gh 登录态 / 环境变量令牌 / 命令行令牌 / 交互式粘贴，四种方式
    4. 创建仓库：调用 GitHub API 建仓（已存在则复用），自动填描述与主页
    5. 推送代码：先把历史重写成单个初始提交（可选），再推 main
    6. 打标签：推送 v2.0.1（可关）
    7. 收尾增强：填 Topics、开 Issues、开启 GitHub Pages 并回传访问地址
    8. 失败自愈：网络错误自动重试；打印针对性的排查建议

只依赖 Python 3.7+ 标准库与系统已装的 git，无需 pip install 任何东西。

--------------------------------------------------------------- 快速使用 --

    # 最简单：跟着提示走（会问你要不要登录）
    python upload.py

    # 已有 Personal Access Token
    python upload.py --token ghp_xxxxxxxxxxxx

    # 只干跑，看看会执行什么，不改动任何东西
    python upload.py --dry-run

    # 仓库已在 GitHub 建好，只推送
    python upload.py --remote https://github.com/你的用户名/python-playground.git

--------------------------------------------------------------- 常用参数 --

    --repo NAME       仓库名（默认 python-playground）
    --user NAME       用户名（默认自动推断）
    --branch NAME     分支名（默认 main）
    --token TOKEN     Personal Access Token（需 repo 权限）
    --remote URL      已有远端地址，跳过建仓库
    --private         建私有仓库
    --tag NAME        标签名（默认 v2.0.1，传 - 表示不打）
    --squash          推送前把历史压成一个初始提交
    --no-pages        不开启 GitHub Pages
    --no-topics       不设置 Topics
    --keep-history    等价于不加 --squash（默认行为）
    --dry-run         只打印，不执行
    --yes             全部按默认值，不询问
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ------------------------------------------------------------------- 常量 --

DEFAULT_REPO = "python-playground"
DEFAULT_BRANCH = "main"
DEFAULT_TAG = "v2.0.1"
DESCRIPTION = "极简在线 Python 编辑器：浏览器内运行真实 CPython 3.11（Pyodide），代码不出本机。"
HOMEPAGE = "https://python-online-ide.app.host/"  # 占位，实际按域名规则替换
LIVE_SITE = "https://python-online-ide.app.workbuddy.host/"
TOPICS = ["python", "pyodide", "webassembly", "playground", "online-editor", "wasm"]
REQUIRED_FILES = ["index.html", "styles.css", "editor.js", "app.js", "runner.worker.js"]
AUTHOR_NAME = "Jerry_Griffin"
AUTHOR_MAIL = "Jerry_Griffin@users.noreply.github.com"

API = "https://api.github.com"
UA = "upload.py/1.0"


# ------------------------------------------------------------------- 输出 --

class C:
    G = "\033[32m"   # 绿
    Y = "\033[33m"   # 黄
    R = "\033[31m"   # 红
    B = "\033[36m"   # 青
    D = "\033[90m"   # 灰
    W = "\033[97m"   # 白
    X = "\033[0m"

    @classmethod
    def off(cls):
        for k in ("G", "Y", "R", "B", "D", "W", "X"):
            setattr(cls, k, "")


if os.name == "nt" and not os.environ.get("WT_SESSION"):
    # 老版 conhost 对 ANSI 支持不稳定，检测失败就退化为纯文本
    try:
        import ctypes
        k = ctypes.windll.kernel32
        if not k.SetConsoleMode(k.GetStdHandle(-11), 7):
            C.off()
    except Exception:
        C.off()


def step(n, total, text):
    print("\n%s[%d/%d]%s %s%s%s" % (C.B, n, total, C.X, C.W, text, C.X))


def ok(text):
    print("  %s✓%s %s" % (C.G, C.X, text))


def warn(text):
    print("  %s!%s %s" % (C.Y, C.X, text))


def bad(text):
    print("  %s✗%s %s" % (C.R, C.X, text))


def info(text):
    print("  %s·%s %s" % (C.D, C.X, text))


class Fail(Exception):
    """可预期的失败，直接打印友好提示后退出。"""


class Ask:
    """
    交互策略。

    默认不交互：所有提问都用默认值直接通过，脚本可以无人值守跑到底。
    只有用户显式给出 --interactive 时才真的停下来提问。

    之所以不用 sys.stdin.isatty() 判断：在 Git Bash / 重定向等环境下它可能
    误报为 True（实测 `python x.py < /dev/null` 仍返回 True），据此分支会让
    脚本挂着等一个永远不会来的输入。显式开关是确定性的。
    """

    enabled = False

    @classmethod
    def confirm(cls, what, assume=False):
        if RUN.dry:
            print("  %s?%s %s  %s(自动确认)%s" % (C.Y, C.X, what, C.D, C.X))
            return True
        if not cls.enabled:
            print("  %s?%s %s  %s(按默认继续)%s" % (C.Y, C.X, what, C.D, C.X))
            return assume
        try:
            ans = input("  %s?%s %s  %s[y/N]%s " % (C.Y, C.X, what, C.D, C.X)).strip().lower()
        except (EOFError, KeyboardInterrupt):
            print()
            return False
        return ans in ("y", "yes")

    @classmethod
    def secret(cls, prompt):
        if not cls.enabled:
            info("未开启交互模式，跳过输入")
            return ""
        try:
            return getpass.getpass(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return ""
        except Exception:
            try:
                return input(prompt).strip()
            except (EOFError, KeyboardInterrupt):
                return ""


# ----------------------------------------------------------------- 命令执行 --

class Runner:
    def __init__(self, dry=False, verbose=True):
        self.dry = dry
        self.verbose = verbose

    def __call__(self, cmd, check=True, cwd=None, quiet=False, timeout=None,
                 retries=0, retry_delay=3, env=None, input_text=None):
        printable = cmd if isinstance(cmd, str) else " ".join(cmd)
        if self.dry:
            if not quiet:
                print("    %s[dry-run]%s %s" % (C.D, C.X, printable))
            return 0, ""

        full_env = dict(os.environ)
        if env:
            full_env.update(env)

        attempt = 0
        while True:
            attempt += 1
            if not quiet and self.verbose:
                print("    %s$%s %s" % (C.D, C.X, printable))
            try:
                proc = subprocess.run(
                    cmd, cwd=cwd, shell=isinstance(cmd, str), env=full_env,
                    input=input_text,
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    text=True, encoding="utf-8", errors="replace",
                    timeout=timeout,
                )
                out = (proc.stdout or "").strip()
                code = proc.returncode
            except subprocess.TimeoutExpired:
                out, code = "（命令超时）", 124
            except FileNotFoundError:
                raise Fail("找不到命令：%s。请确认已安装并加入 PATH。" % printable)

            if not quiet and out and self.verbose:
                for line in out.splitlines()[:15]:
                    print("      " + line)

            if code == 0 or not check:
                return code, out

            if retries > 0:
                retries -= 1
                warn("命令失败，%d 秒后重试（剩余 %d 次）…" % (retry_delay, retries))
                time.sleep(retry_delay)
                continue
            raise Fail("命令失败（退出码 %s）：\n      %s\n\n%s" % (code, printable, indent(out)))


def indent(text, prefix="      "):
    return "\n".join(prefix + l for l in (text or "").splitlines())


RUN = Runner()   # 全局，由 main 重新初始化


# ------------------------------------------------------------------ HTTP --

def http(method, url, token=None, body=None, accept="application/vnd.github+json",
         timeout=30, retries=3):
    """最小可用的 GitHub API 客户端，带重试。返回 (status, json)。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    last_err = None

    for i in range(retries + 1):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Accept", accept)
        req.add_header("User-Agent", UA)
        if token:
            req.add_header("Authorization", "Bearer " + token)
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
                try:
                    return resp.status, (json.loads(raw) if raw.strip() else {})
                except json.JSONDecodeError:
                    return resp.status, {"raw": raw}
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw) if raw.strip() else {}
            except json.JSONDecodeError:
                payload = {"raw": raw}
            return e.code, payload        # HTTP 层错误不重试，交给调用方判断
        except Exception as e:            # 网络层错误才重试
            last_err = e
            if i < retries:
                warn("请求失败（%s），%d 秒后重试…" % (e, 2 * (i + 1)))
                time.sleep(2 * (i + 1))
                continue
    raise Fail(
        "无法连接 %s：%s\n\n"
        "    这通常是网络问题，常见处理：\n"
        "      1) 换一个能访问 github.com 的网络（手机热点常可绕过）\n"
        "      2) 若使用代理，请为命令行单独配置：\n"
        "           set HTTPS_PROXY=http://127.0.0.1:端口    （Windows）\n"
        "           export https_proxy=http://127.0.0.1:端口  （macOS/Linux）\n"
        "      3) 确认能打开 https://github.com 后再重试\n"
        % (url, last_err))


# ------------------------------------------------------------- 1. 环境体检 --

def check_environment():
    step(1, 8, "环境体检")

    if not shutil.which("git"):
        raise Fail("未检测到 git。请先安装 Git：https://git-scm.com/downloads")
    _, ver = RUN(["git", "--version"], quiet=True)
    ok(ver or "git 已安装")

    root = RUN(["git", "rev-parse", "--show-toplevel"], quiet=True, check=False)[1]
    if not root:
        warn("当前目录还不是 git 仓库，稍后会自动 git init")
        root = os.getcwd()
    else:
        ok("项目目录：%s" % root)

    missing = [f for f in REQUIRED_FILES if not os.path.isfile(os.path.join(root, f))]
    if missing:
        raise Fail("目录里缺少关键文件：%s\n"
                   "请在 python-test-studio 目录下运行本脚本。" % "、".join(missing))
    ok("关键文件齐全（%d 个）" % len(REQUIRED_FILES))

    # 连通性：分层探测，便于精确指出问题所在
    checks = [
        ("api.github.com", API, True),
        ("github.com", "https://github.com", True),
    ]
    reachable_api = False
    for name, url, need in checks:
        try:
            status, _ = http("GET", url, timeout=15, retries=0)
            if name == "api.github.com":
                reachable_api = True
                ok("%s 可达（HTTP %s）" % (name, status))
            else:
                ok("%s 可达（HTTP %s）" % (name, status))
        except Fail:
            if name == "api.github.com":
                bad("%s 不可达 —— 无法创建仓库，也无法校验令牌" % name)
            else:
                warn("%s 直连不通 —— 推送可能失败，稍后会自动重试" % name)

    if not reachable_api:
        raise Fail(
            "api.github.com 不可达，脚本无法继续。\n\n"
            "    请先解决网络问题（换网络 / 配置代理）后重试。\n"
            "    自检命令：curl -I https://api.github.com"
        )

    return root


# --------------------------------------------------------- 2. 仓库与身份 --

def prepare_repo(root, branch, squash, yes):
    step(2, 8, "准备本地仓库")

    if not os.path.isdir(os.path.join(root, ".git")):
        RUN(["git", "init", "-b", branch], cwd=root)
        ok("已初始化仓库，默认分支 %s" % branch)
    else:
        ok("仓库已存在")

    if not RUN(["git", "config", "user.name"], cwd=root, quiet=True, check=False)[1]:
        RUN(["git", "config", "user.name", AUTHOR_NAME], cwd=root)
        ok("提交身份 user.name = %s" % AUTHOR_NAME)
    if not RUN(["git", "config", "user.email"], cwd=root, quiet=True, check=False)[1]:
        RUN(["git", "config", "user.email", AUTHOR_MAIL], cwd=root)
        ok("提交身份 user.email = %s" % AUTHOR_MAIL)

    # 跨平台一致性：避免换行符被反复转换导致 diff 噪声
    RUN(["git", "config", "core.autocrlf", "false"], cwd=root)

    code, dirty = RUN(["git", "status", "--porcelain"], cwd=root, quiet=True, check=False)
    if dirty:
        info("发现未提交的改动：")
        for line in dirty.splitlines()[:10]:
            print("        " + line)
        RUN(["git", "add", "-A"], cwd=root, quiet=True)
        RUN(["git", "-c", "core.safecrlf=false", "commit", "-q",
             "-m", "chore: 上传前保存本地改动"], cwd=root)
        ok("已自动提交")
    else:
        ok("工作区干净")

    has_commit = RUN(["git", "rev-parse", "HEAD"], cwd=root, quiet=True, check=False)[0] == 0
    if not has_commit:
        raise Fail("仓库里还没有任何提交，无法推送。")

    if squash:
        if dry_guard(yes, "把全部历史压缩为一个初始提交（原历史仅保存在本地 reflog 中）",
                     assume=True):
            RUN(["git", "checkout", "--orphan", "_upload"], cwd=root)
            RUN(["git", "add", "-A"], cwd=root, quiet=True)
            RUN(["git", "-c", "core.safecrlf=false", "commit", "-q",
                 "-m", "init: 极简在线 Python 练习场（浏览器内运行 CPython 3.11）"], cwd=root)
            RUN(["git", "branch", "-M", branch], cwd=root)
            ok("历史已压缩为单个提交")
    RUN(["git", "branch", "-M", branch], cwd=root)
    ok("当前分支：%s" % branch)

    return root


def dry_guard(yes, what, assume=False):
    """需要确认的操作；交由 Ask.confirm 统一处理交互策略。"""
    if yes:
        print("  %s?%s %s  %s(按 --yes 通过)%s" % (C.Y, C.X, what, C.D, C.X))
        return True
    return Ask.confirm(what, assume=assume)


# ------------------------------------------------------------- 3. 认证 --

def find_gh():
    p = shutil.which("gh")
    if p:
        return p
    if os.name == "nt":
        for c in (r"C:\Program Files\GitHub CLI\gh.exe",
                  r"C:\Program Files (x86)\GitHub CLI\gh.exe",
                  os.path.expanduser(r"~\AppData\Local\GitHub CLI\gh.exe")):
            if os.path.isfile(c):
                return c
    for c in ("/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/usr/bin/gh"):
        if os.path.isfile(c):
            return c
    return None


def verify_token(token, token_source):
    status, me = http("GET", API + "/user", token=token, retries=1)
    if status == 200 and me.get("login"):
        ok("认证成功，账号：%s" % me["login"])
        scopes = ""
        # classic token 会在响应头给出 scope，这里用 /user 的权限间接提示
        info("令牌来源：%s" % token_source)
        return me["login"]
    if status == 401:
        raise Fail("令牌无效或已过期（HTTP 401）。请重新生成后重试。")
    if status == 403:
        raise Fail("令牌被拒绝（HTTP 403），可能已过期或被撤销。")
    raise Fail("校验令牌失败（HTTP %s）：%s" % (status, me.get("message", "")))


def do_auth(args):
    step(3, 8, "身份认证")

    # 1) 命令行令牌
    if args.token:
        return verify_token(args.token.strip(), "命令行 --token"), args.token.strip()

    # 2) 环境变量
    for key in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(key):
            tok = os.environ[key].strip()
            return verify_token(tok, "环境变量 " + key), tok

    # 3) gh 登录态
    gh = find_gh()
    if gh:
        code, tok = RUN([gh, "auth", "token"], quiet=True, check=False)
        if code == 0 and tok:
            try:
                return verify_token(tok.strip(), "GitHub CLI 登录态"), tok.strip()
            except Fail as e:
                warn("gh 里的令牌不可用（%s），转向其他方式" % e)
        else:
            info("检测到 GitHub CLI，但尚未登录")
            if dry_guard(args.yes, "现在启动 gh 浏览器登录（会打开浏览器）", assume=False):
                RUN([gh, "auth", "login", "--hostname", "github.com",
                     "--git-protocol", "https", "--web"], check=False, timeout=600)
                code, tok = RUN([gh, "auth", "token"], quiet=True, check=False)
                if code == 0 and tok:
                    return verify_token(tok.strip(), "GitHub CLI 登录态"), tok.strip()
                warn("gh 登录未完成")
    else:
        info("未安装 GitHub CLI（可选）")

    # 4) 交互粘贴令牌
    if RUN.dry:
        warn("dry-run：跳过令牌输入")
        return "dry-run-user", "dry-run-token"

    if Ask.enabled:
        print()
        print("  需要凭据才能创建仓库并推送。任选其一：")
        print("    a) 直接粘贴 Personal Access Token（输入时不回显）")
        print("       生成地址：https://github.com/settings/tokens")
        print("       classic 勾选 %srepo%s；fine-grained 勾 %sContents%s 与 %sAdministration%s 的读写"
              % (C.W, C.X, C.W, C.X, C.W, C.X))
        print("    b) 回车跳过，改用 gh 登录或手动推送")
        print()
        tok = Ask.secret("  令牌（回车跳过）: ")
        if tok:
            return verify_token(tok, "交互输入"), tok

    raise Fail(
        "没有可用的凭据。请选择一种方式后重试：\n"
        "    1) python upload.py --token 你的令牌\n"
        "    2) 装 GitHub CLI 后登录：winget install GitHub.cli  →  gh auth login\n"
        "       然后执行 python upload.py --interactive\n"
        "    3) 设置环境变量后重跑：set GITHUB_TOKEN=你的令牌（Windows）\n"
        "    4) 自己建好仓库，再用：python upload.py --remote 仓库地址\n\n"
        "    提示：加 --interactive 可以让脚本在半途停下来向你提问。"
    )


# --------------------------------------------------------- 4. 创建仓库 --

def ensure_repo(token, login, repo, private, dry):
    step(4, 8, "准备 GitHub 仓库 %s/%s" % (login, repo))

    status, data = http("GET", "%s/repos/%s/%s" % (API, login, repo), token=token)
    if status == 200:
        ok("仓库已存在，直接复用：%s" % data.get("html_url", ""))
        return data.get("clone_url") or "https://github.com/%s/%s.git" % (login, repo)

    if status not in (404,):
        warn("查询仓库返回 HTTP %s，仍尝试创建" % status)

    body = {
        "name": repo,
        "private": bool(private),
        "description": DESCRIPTION,
        "homepage": LIVE_SITE,
        "has_issues": True,
        "has_projects": False,
        "has_wiki": False,
        "auto_init": False,
    }
    if dry:
        info("[dry-run] 将创建%s仓库" % ("私有" if private else "公开"))
        return "https://github.com/%s/%s.git" % (login, repo)

    status, data = http("POST", API + "/user/repos", token=token, body=body)
    if status in (200, 201):
        ok("已创建：%s" % data.get("html_url", ""))
        return data.get("clone_url")
    if "already exists" in (data.get("message") or ""):
        ok("仓库已存在（并发情况），按既有仓库处理")
        return "https://github.com/%s/%s.git" % (login, repo)

    msg = data.get("message", "")
    hint = ""
    if status == 403 or "not accessible" in msg:
        hint = ("\n    令牌权限不足。classic 需勾选 repo；"
                "fine-grained 需给 Contents 与 Administration 的读写权限，"
                "并授权访问你的个人账号（不能只选某个仓库）。")
    elif "name already exists" in msg:
        hint = "\n    换个仓库名试试：python upload.py --repo 别的名字"
    raise Fail("创建仓库失败（HTTP %s）：%s%s" % (status, msg, hint))


# ------------------------------------------------------------- 5. 推送 --

def push_code(root, remote, branch, login, repo, token):
    step(5, 8, "推送到 %s" % remote)

    code, cur = RUN(["git", "remote", "get-url", "origin"], cwd=root, quiet=True, check=False)
    if code == 0 and cur:
        if cur.strip() != remote.strip():
            RUN(["git", "remote", "set-url", "origin", remote], cwd=root)
            ok("已更新 origin")
        else:
            ok("origin 已正确")
    else:
        RUN(["git", "remote", "add", "origin", remote], cwd=root)
        ok("已添加 origin")

    # 避免令牌落盘：用一次性 URL 推送，随后把 remote 还原成干净地址
    auth_url = None
    if token and login:
        auth_url = "https://%s:%s@github.com/%s/%s.git" % (login, token, login, repo)

    env = {"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo",
           "GCM_INTERACTIVE": "never"}

    if RUN.dry:
        RUN(["git", "push", "-u", "origin", branch], cwd=root)
        return remote

    code, out = RUN(["git", "push", "-u", "origin", branch], cwd=root,
                    check=False, retries=0, env=env)
    if code != 0 and auth_url:
        warn("首次推送未成功，改用内嵌凭据重试…")
        code, out = RUN(["git", "push", auth_url, "%s:%s" % (branch, branch)],
                        cwd=root, check=False, retries=0, env=env)
        if code == 0:
            # 确保远端配置里不残留令牌
            RUN(["git", "remote", "set-url", "origin", remote], cwd=root, quiet=True)

    if code != 0:
        low = (out or "").lower()
        tips = []
        if any(k in low for k in ("could not resolve", "connect", "timed out",
                                  "connection was reset", "failed to connect", "502")):
            tips.append("网络到 github.com 不通。换网络，或为 git 单独设置代理：\n"
                        "        git config --global http.proxy http://127.0.0.1:你的端口\n"
                        "        git config --global https.proxy http://127.0.0.1:你的端口\n"
                        "      用完后记得取消：git config --global --unset http.proxy")
        if any(k in low for k in ("authentication", "403", "permission denied",
                                 "invalid username or password")):
            tips.append("认证被拒。换个有效令牌：python upload.py --token 新令牌\n"
                        "      注意不要用账号密码，GitHub 已不支持密码推送。")
        if "rejected" in low or "fetch first" in low:
            tips.append("远端有本地没有的提交。先执行：\n"
                        "        git pull --rebase origin %s\n"
                        "      然后重新运行本脚本。" % branch)
        if not tips:
            tips.append("可尝试：git push -u origin %s（手动执行看完整报错）" % branch)
        raise Fail("推送失败。\n    " + "\n    ".join(tips) +
                   "\n\n    原始输出：\n" + indent(out))
    ok("推送完成")
    return remote


# ------------------------------------------------------------- 6. 打标签 --

def push_tag(root, name, dry):
    step(6, 8, "打标签 %s" % name)
    if not name or name == "-":
        info("按要求跳过")
        return
    run = RUN
    if run.dry:
        run(["git", "tag", "-a", name, "-m", name], cwd=root)
        run(["git", "push", "origin", name], cwd=root)
        return
    if run(["git", "tag", "-l", name], cwd=root, quiet=True, check=False)[1].strip():
        info("标签已存在，跳过")
        return
    run(["git", "tag", "-a", name, "-m", "Python 练习场 %s" % name], cwd=root)
    code, _ = run(["git", "push", "origin", name], cwd=root, check=False,
                  env={"GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": "echo"})
    if code == 0:
        ok("标签已推送")
    else:
        warn("标签推送失败（不影响代码，可稍后手动：git push origin %s）" % name)


# ------------------------------------------------------- 7. 仓库增强 --

def enhance(token, login, repo, do_topics, do_pages, dry):
    step(7, 8, "仓库增强（Topics / Pages）")
    base = "%s/repos/%s/%s" % (API, login, repo)

    if do_topics:
        if dry:
            info("[dry-run] 将设置 Topics：%s" % ", ".join(TOPICS))
        else:
            status, data = http("PUT", base + "/topics", token=token,
                                body={"names": TOPICS}, accept="application/vnd.github.mercy-preview+json")
            if status == 200:
                ok("Topics 已设置：%s" % ", ".join(TOPICS))
            else:
                warn("Topics 设置失败（HTTP %s），不影响代码" % status)

    pages_url = None
    if do_pages:
        if dry:
            info("[dry-run] 将开启 GitHub Pages（源：%s 分支根目录）" % DEFAULT_BRANCH)
            return "https://%s.github.io/%s/" % (login, repo)
        status, data = http("GET", base + "/pages", token=token)
        if status == 200:
            pages_url = data.get("html_url")
            ok("Pages 已开启：%s" % pages_url)
        else:
            status, data = http("POST", base + "/pages", token=token,
                                body={"source": {"branch": DEFAULT_BRANCH, "path": "/"}})
            if status in (200, 201):
                pages_url = (data.get("html_url")
                             or "https://%s.github.io/%s/" % (login, repo))
                ok("Pages 已开启：%s" % pages_url)
                info("首次构建约需 1–2 分钟，期间访问可能 404")
            elif status == 403:
                warn("开启 Pages 需要令牌含 Pages 写权限（classic: repo；"
                     "fine-grained: Pages 读写）。可在网页端手动开启：")
                info("仓库 Settings → Pages → Source 选 %s / (root)" % DEFAULT_BRANCH)
            else:
                warn("Pages 开启失败（HTTP %s）：%s" % (status, data.get("message", "")))
    return pages_url


# ------------------------------------------------------------- 8. 总结 --

def summary(root, login, repo, branch, tag, pages_url, live_site, dry):
    step(8, 8, "完成")
    url = "https://github.com/%s/%s" % (login, repo)
    print()
    print("  %s仓库地址%s  %s" % (C.W, C.X, url))
    print("  %s分支%s      %s" % (C.W, C.X, branch))
    if tag and tag != "-":
        print("  %s标签%s      %s" % (C.W, C.X, tag))
    if pages_url:
        print("  %s在线预览%s  %s" % (C.W, C.X, pages_url))
    print("  %s线上站点%s  %s" % (C.W, C.X, live_site))

    if not dry:
        code, out = RUN(["git", "log", "--oneline", "-1"], cwd=root, quiet=True, check=False)
        if out:
            print("  %s最新提交%s  %s" % (C.W, C.X, out.splitlines()[0]))

    print()
    print("  后续建议：")
    print("    1. 仓库 About 里的 Homepage 已自动填为线上站点，可按需修改")
    print("    2. 想自定义域名或加徽章，编辑 README.md 顶部即可")
    print("    3. 以后改完代码，一条命令即可同步：")
    print("         git add -A && git commit -m \"说明\" && git push")
    if dry:
        print()
        print("  %s以上为 dry-run 结果，未做任何实际改动。去掉 --dry-run 即真正执行。%s"
              % (C.Y, C.X))
    print()


# ---------------------------------------------------------------- 主流程 --

def main():
    global RUN

    ap = argparse.ArgumentParser(
        description="把本项目一键上传到 GitHub（建仓库 / 推送 / 标签 / Pages）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--repo", default=DEFAULT_REPO, help="仓库名（默认 %s）" % DEFAULT_REPO)
    ap.add_argument("--user", help="GitHub 用户名（默认自动推断）")
    ap.add_argument("--branch", default=DEFAULT_BRANCH, help="分支名（默认 %s）" % DEFAULT_BRANCH)
    ap.add_argument("--token", help="Personal Access Token（需 repo 权限）")
    ap.add_argument("--remote", help="已有远端地址；给出后跳过建仓库")
    ap.add_argument("--private", action="store_true", help="建私有仓库")
    ap.add_argument("--tag", default=DEFAULT_TAG, help="标签名，传 - 表示不打")
    ap.add_argument("--squash", action="store_true", help="推送前把历史压成一个初始提交")
    ap.add_argument("--no-pages", dest="pages", action="store_false", help="不开启 GitHub Pages")
    ap.add_argument("--no-topics", dest="topics", action="store_false", help="不设置 Topics")
    ap.add_argument("--dry-run", action="store_true", help="只打印，不执行")
    ap.add_argument("--yes", action="store_true", help="全部按默认值，不询问")
    ap.add_argument("--interactive", "-i", action="store_true",
                    help="遇到需要确认的步骤时停下来提问（默认不问，直接用默认值推进）")
    args = ap.parse_args()

    RUN = Runner(dry=args.dry_run)
    Ask.enabled = args.interactive

    print()
    print("  %s┌──────────────────────────────────────────────┐%s" % (C.B, C.X))
    print("  %s│%s  Python 练习场  %s→%s  GitHub 一键上传          %s│%s"
          % (C.B, C.X, C.G, C.X, C.B, C.X))
    print("  %s└──────────────────────────────────────────────┘%s" % (C.B, C.X))
    if args.dry_run:
        print("  %s模式：dry-run（只演示，不做任何改动）%s" % (C.Y, C.X))

    try:
        root = check_environment()
        root = prepare_repo(root, args.branch, args.squash, args.yes)

        token = login = None
        if args.remote:
            step(3, 8, "使用指定远端，跳过认证与建仓")
            remote = args.remote.strip()
            m = re.search(r"github\.com[:/]+([^/]+)/", remote)
            login = args.user or (m.group(1) if m else "unknown")
            ok("远端：%s" % remote)
            step(4, 8, "跳过（沿用已有远端）")
        else:
            # do_auth 返回的是 (login, token)，顺序别弄反
            login_raw, token = do_auth(args)
            login = args.user or login_raw
            if login != login_raw and login_raw not in ("dry-run-user",):
                info("按 --user 使用账号：%s" % login)
            remote = ensure_repo(token, login, args.repo, args.private, args.dry_run)

        push_code(root, remote, args.branch, login, args.repo, token)
        push_tag(root, args.tag, args.dry_run)
        pages_url = enhance(token, login, args.repo, args.topics, args.pages, args.dry_run)
        summary(root, login, args.repo, args.branch, args.tag, pages_url, LIVE_SITE, args.dry_run)
        return 0

    except Fail as e:
        print()
        bad("未能完成")
        print()
        print(indent(str(e), "    "))
        print()
        print("  需要帮助时，把上面的完整输出发我即可。")
        print()
        return 1
    except KeyboardInterrupt:
        print("\n\n  已取消，未做改动。\n")
        return 130


if __name__ == "__main__":
    sys.exit(main())
