# 如何上传到 GitHub

`upload.py` 是一个**自包含的一键上传脚本**，只用 Python 标准库和系统已装的 git，不需要 `pip install` 任何东西。

## 为什么需要这个脚本

本机（当前工作环境）**无法直连 github.com 的认证与推送端点**，实测：

| 目标 | 结果 |
|---|---|
| `api.github.com`（只读 API） | ✅ 200（因此脚本能建仓库、能校验令牌） |
| `codeload.github.com` | ✅ 301 |
| `github.com`（git 推送入口） | ❌ 走代理报 `502 CONNECT tunnel failed`，直连报 `Connection was reset` |
| `github.com/login/device/code`（登录授权） | ❌ 全部超时，导致 `gh auth login` 拿不到设备码 |
| `ssh.github.com:443` | ❌ 不可达 |

也就是说：**仓库我能替你建好、代码我能替你提交好，唯独"推送"这一下需要你的网络环境**。脚本就是把剩下的部分全部自动化。

## 用法

```bash
cd python-test-studio
python upload.py
```

脚本会依次做完这 8 步：

1. **环境体检** —— 检查 git、关键文件是否齐全、`api.github.com` 是否可达（分层探测，故障点一目了然）
2. **准备仓库** —— 按需 `git init`、设置提交身份、切到 `main`、自动提交未保存的改动
3. **身份认证** —— 按优先级尝试：`--token` → 环境变量 → `gh` 登录态 → 交互式粘贴
4. **创建仓库** —— 调 GitHub API 建仓，自动填描述与主页；已存在则复用
5. **推送代码** —— 推 `main`，网络错误自动重试，失败时给出针对性排查建议
6. **打标签** —— 推送 `v2.0.1`
7. **仓库增强** —— 设置 Topics、开启 GitHub Pages 并回传访问地址
8. **总结** —— 打印仓库地址、Pages 地址、后续同步命令

### 常用方式

```bash
# 最省事：已有 Personal Access Token
python upload.py --token ghp_xxxxxxxxxxxx

# 先看看会做什么，不做任何改动
python upload.py --dry-run

# 仓库已在 GitHub 建好，只推送
python upload.py --remote https://github.com/你的用户名/python-playground.git

# 跟着提示走（会在半途停下来问你）
python upload.py --interactive
```

> **关于 `--interactive`**：默认情况下脚本**不会停下来提问**，遇到需要确认的步骤直接用默认值推进——这样可以无人值守跑完。想中途停下来问你，才加 `--interactive`。
>
> 之所以不靠 `sys.stdin.isatty()` 自动判断，是因为它在某些环境下不可靠：实测 Git Bash 里 `python x.py < /dev/null` 仍然返回 `True`，据此分支会让脚本挂住等一个永远不会来的输入。

### 全部参数

```
--repo NAME       仓库名（默认 python-playground）
--user NAME       用户名（默认自动推断）
--branch NAME     分支名（默认 main）
--token TOKEN     Personal Access Token（需 repo 权限）
--remote URL      已有远端地址；给出后跳过建仓库
--private         建私有仓库
--tag NAME        标签名（默认 v2.0.1，传 - 表示不打）
--squash          推送前把历史压成一个初始提交
--no-pages        不开启 GitHub Pages
--no-topics       不设置 Topics
--dry-run         只打印，不执行
--yes             全部按默认值，不询问
--interactive, -i 遇到确认步骤时停下来提问
```

## 令牌怎么生成

访问 https://github.com/settings/tokens

- **classic token**：勾选 `repo`。想开 Pages 还需要 `workflow`（部分账号）。
- **fine-grained token**：给 `Contents` 读写、`Administration` 读写、`Pages` 读写；**注意**授权时必须选择"所有仓库"或明确包含目标仓库，只选单个仓库会导致建仓失败。

## 自检

不想动真格时，先跑回归测试（13 项，全部为 dry-run 与错误路径，不需要凭据）：

```bash
bash test-upload.sh
```

它会验证 8 阶段流程、各开关是否生效、错误提示是否正确、缺文件时是否保护性退出。

## 推送失败的常见原因

| 报错关键词 | 含义与处理 |
|---|---|
| `Failed to connect` / `Connection was reset` / `502` | 到 github.com 不通。换网络，或给 git 单独配代理：<br>`git config --global http.proxy http://127.0.0.1:端口`<br>`git config --global https.proxy http://127.0.0.1:端口`<br>用完后取消：`git config --global --unset http.proxy` |
| `Authentication failed` / `403` | 令牌无效或权限不足。GitHub 已不支持账号密码推送，必须用 Token。 |
| `Updates were rejected` / `fetch first` | 远端有本地没有的提交。先 `git pull --rebase origin main` 再重试。 |
| 建仓 `Resource not accessible` | fine-grained 令牌没授权到你的账号，或缺 `Administration` 权限。 |

## 上传之后

1. **Homepage** 已自动填为线上站点，可在仓库 About 里改。
2. **开启 GitHub Pages** 后（脚本会尝试），访问地址形如 `https://你的用户名.github.io/python-playground/`。本项目是零构建纯静态站点，Pages 开箱即用。若脚本提示权限不足，手动开：Settings → Pages → Source 选 `main` / `(root)`。
3. **以后同步**：`git add -A && git commit -m "说明" && git push`

## 当前仓库状态

分支 `main`，工作区干净，关键文件齐全。运行 `bash test-upload.sh` 可复验脚本本身。
