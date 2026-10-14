#!/usr/bin/env bash
# 一键部署 / 更新到 Vercel 生产环境
#
#   export VERCEL_TOKEN=xxxx        # https://vercel.com/account/tokens
#   ./scripts/deploy.sh
#
# 未设置 VERCEL_TOKEN 时会退回使用 CLI 已登录的凭据。
# CLI 装在仓库内的隔离目录（.tools/ + .home/，均已 gitignore），不污染系统目录。
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

AUTH=()
if [ -n "${VERCEL_TOKEN:-}" ]; then
  AUTH=(--token="$VERCEL_TOKEN")
else
  echo "→ 未设置 VERCEL_TOKEN，尝试使用 CLI 已登录的凭据（没有的话先 npx vercel login）"
fi

"$VC" deploy --prod --yes "${AUTH[@]}"
