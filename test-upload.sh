#!/usr/bin/env bash
# test-upload.sh — upload.py 的回归测试（不需要任何凭据，全部为 dry-run 与错误路径）
# 用法：bash test-upload.sh
set -u

PY=""
for c in python3 python "C:/Users/zhang/.workbuddy/binaries/python/versions/3.13.12/python.exe"; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY="$c"; break; fi
done
[ -z "$PY" ] && { echo "未找到 python，请先安装 Python 3.7+"; exit 1; }

cd "$(dirname "$0")" || exit 1

FAKE_REMOTE="https://github.com/Jerry_Griffin/regression-test.git"
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
t "假令牌被识别为 401"  "401"            "\"$PY\" upload.py --token ghp_INVALID --user Jerry_Griffin"
t "无凭据给出引导"      "没有可用的凭据" "\"$PY\" upload.py --repo no-cred < /dev/null"
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
