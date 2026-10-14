#!/usr/bin/env bash
# 一键部署 / 更新到 Vercel 生产环境
#
#   export VERCEL_TOKEN=xxxx        # https://vercel.com/account/tokens
#   ./scripts/deploy.sh
#
# 未设置 VERCEL_TOKEN 时会退回使用 CLI 已登录的凭据。
# CLI 装在仓库内的隔离目录（.tools/ + .home/，均已 gitignore），不污染系统目录。
#
# 注意：本脚本刻意兼容 macOS 自带的 bash 3.2 ——
#   1. 变量引用一律加花括号（${VAR}），否则紧跟中文标点时会被 3.2 误解析成变量名
#   2. 空数组用 ${arr[@]+"${arr[@]}"} 展开，3.2 下 "${arr[@]}" 遇 set -u 会报未绑定变量
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export npm_config_cache="$ROOT/.npm-cache"
export npm_config_prefix="$ROOT/.tools"
export HOME="$ROOT/.home"
export VERCEL_TELEMETRY_DISABLED=1

VC="$ROOT/.tools/bin/vercel"
if [ ! -x "$VC" ]; then
  echo "→ 首次运行，正在安装 Vercel CLI 到 .tools/（约 300MB，之后复用）..."
  npm i -g vercel
fi

TOKEN_ARGS=()
if [ -n "${VERCEL_TOKEN:-}" ]; then
  TOKEN_ARGS=(--token="${VERCEL_TOKEN}")
else
  echo "→ 未设置 VERCEL_TOKEN，将使用 CLI 已登录的凭据（没有的话先执行 npx vercel login）"
fi

# .vercel/ 是本地关联文件，不随仓库分发。全新 clone 后若直接 deploy，
# CLI 会把这次部署当成新项目创建，而不是更新已有项目 —— 所以先补上关联。
# 项目名可用 VERCEL_PROJECT 覆盖。
if [ ! -f "${ROOT}/.vercel/project.json" ]; then
  PROJECT="${VERCEL_PROJECT:-index-translate-proxy}"
  echo "→ 尚未关联 Vercel 项目，正在关联 ${PROJECT} ..."
  "$VC" link --yes --project "${PROJECT}" ${TOKEN_ARGS[@]+"${TOKEN_ARGS[@]}"}
fi

"$VC" deploy --prod --yes ${TOKEN_ARGS[@]+"${TOKEN_ARGS[@]}"}
