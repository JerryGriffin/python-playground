#!/usr/bin/env bash
# test-upload.sh — upload.py 的回归测试（不需要任何凭据，全部为 dry-run 与错误路径）
# 用法：bash test-upload.sh
set -u

# 回归测试要按 UTF-8 比较中文输出；Windows 默认 GBK 会让 grep 匹配不到。
export PYTHONIOENCODING=utf-8

# 解释器探测：优先 $PYTHON，再依次尝试 python3 / python / py 启动器。
# 不再写死任何本机路径（旧版把 C:/Users/<用户名>/.workbuddy/... 带进了公开仓库）。
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  for c in python3 python py; do
    # 不能只看 command -v：Windows 上 python3 可能是应用商店占位符，存在但一执行就退出。
    if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys' >/dev/null 2>&1; then
      PY="$c"; break
    fi
  done
fi
[ -z "$PY" ] && { echo "未找到 python，请先安装 Python 3.7+，或用 PYTHON=/path/to/python bash test-upload.sh 指定"; exit 1; }

cd "$(dirname "$0")" || exit 1

# upload.py 的「假令牌 / 无凭据」用例不是 dry-run：它会先执行第 2 步
# 「仓库就绪」，对未提交改动执行 git add + commit，然后才在认证步骤失败。
# 工作区脏的时候跑测试会凭空生成一个 "chore: 上传前保存本地改动" 提交。
if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -n "$(git status --porcelain)" ] && [ "${ALLOW_DIRTY_TEST:-0}" != "1" ]; then
    echo "工作区有未提交改动：先 commit / stash 再跑测试。"
    echo "（upload.py 的非 dry-run 用例会先把改动提交掉；确实要这样跑可设 ALLOW_DIRTY_TEST=1）"
    exit 1
  fi
fi

FAKE_REMOTE="https://github.com/JerryGriffin/regression-test.git"
PASS=0; FAIL=0; SKIP=0

t() { # t "名称" "期望子串" "命令"
  out=$(eval "$3" 2>&1)
  if echo "$out" | grep -q "$2"; then
    printf "  %sPASS%s  %s\n" "$(printf '\033[32m')" "$(printf '\033[0m')" "$1"
    PASS=$((PASS + 1))
  elif echo "$out" | grep -q "api.github.com 不可达"; then
    # 网络波动会让需要联网的用例失败，这属于环境问题，不算脚本缺陷
    printf "  %sSKIP%s  %s  （网络波动：api.github.com 暂不可达）\n" \
      "$(printf '\033[33m')" "$(printf '\033[0m')" "$1"
    SKIP=$((SKIP + 1))
  else
    printf "  %sFAIL%s  %s  期望包含「%s」\n" "$(printf '\033[31m')" "$(printf '\033[0m')" "$1" "$2"
    echo "$out" | tail -5 | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
}

echo "==> 使用解释器：$PY"
echo "==> 回归测试（全部为 dry-run / 错误路径，不需要凭据）"

t "语法可编译"          "编译通过"       "\"$PY\" -m py_compile upload.py && echo 编译通过"
t "帮助信息可读"        "一键上传"       "\"$PY\" upload.py --help"
t "dry-run 走完 8 阶段" "[8/8]"          "\"$PY\" upload.py --remote $FAKE_REMOTE --dry-run"
t "总结含仓库地址"      "仓库地址"       "\"$PY\" upload.py --remote $FAKE_REMOTE --dry-run"
t "总结含 Pages 预览"   "在线预览"       "\"$PY\" upload.py --remote $FAKE_REMOTE --dry-run"
t "--no-pages 生效"     "跳过"           "\"$PY\" upload.py --remote $FAKE_REMOTE --no-pages --dry-run"
t "--tag - 跳过打标签"  "按要求跳过"     "\"$PY\" upload.py --remote $FAKE_REMOTE --tag - --dry-run"
t "--squash 压缩历史"   "历史已压缩"     "\"$PY\" upload.py --remote $FAKE_REMOTE --squash --dry-run"
t "自定义仓库名生效"    "regression2"    "\"$PY\" upload.py --repo regression2 --remote $FAKE_REMOTE --dry-run"
t "假令牌被识别为 401"  "401"            "\"$PY\" upload.py --token ghp_INVALID --user JerryGriffin"
t "无凭据给出引导"      "没有可用的凭据" "GITHUB_TOKEN= GH_TOKEN= UPLOAD_SKIP_GH=1 \"$PY\" upload.py --repo no-cred < /dev/null"
t "环境体检报告 API"    "api.github.com" "\"$PY\" upload.py --remote $FAKE_REMOTE --dry-run -i < /dev/null"
SRC_DIR="$(pwd)"

t "缺文件时保护退出"    "缺少关键文件"   "tmp=\$(mktemp -d) && cd \"\$tmp\" && git init -q && cp \"$SRC_DIR/upload.py\" . && \"$PY\" upload.py --dry-run"

echo
if [ "$FAIL" -eq 0 ]; then
  printf "%s通过 %d 项%s" "$(printf '\033[32m')" "$PASS" "$(printf '\033[0m')"
  [ "$SKIP" -gt 0 ] && printf "，跳过 %d 项（网络）" "$SKIP"
  echo
else
  printf "%s通过 %d 项，失败 %d 项%s" "$(printf '\033[31m')" "$PASS" "$FAIL" "$(printf '\033[0m')"
  [ "$SKIP" -gt 0 ] && printf "，跳过 %d 项（网络）" "$SKIP"
  echo
fi

rm -rf __pycache__ 2>/dev/null
exit "$FAIL"
