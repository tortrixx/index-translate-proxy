#!/usr/bin/env bash
# 验证域名能否在中国大陆【直连】使用（自动绕过本地代理）
#
#   ./scripts/verify-domain.sh api.example.com
#
# 检查顺序：DNS 是否指向 Vercel → 直连 TLS/HTTP 是否通 → 跑完整验收用例
set -uo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  echo "用法: $0 <域名>"
  echo "例如: $0 api.example.com"
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 关键：清掉本地代理相关环境，测的才是真实直连
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy NODE_USE_ENV_PROXY

echo "目标：https://$DOMAIN/v1"
echo

echo "== 1) DNS 解析 =="
IPS="$(dig +short "$DOMAIN" | tr '\n' ' ')"
echo "  $DOMAIN -> ${IPS:-（无记录）}"
case "$IPS" in
  "")
    echo "  ✗ 没有解析记录，请先添加 CNAME（Cloudflare 上必须用 DNS only / 灰云）"
    exit 1
    ;;
  *104.21.*|*172.67.*|*172.64.*|*104.16.*)
    echo "  ⚠️ 解析到 Cloudflare IP：CNAME 很可能还是【橙云 / 代理开启】"
    echo "     必须改成 DNS only（灰云），否则会被 Cloudflare 的 JS 挑战拦住"
    ;;
  *cname.vercel-dns.com*|*vercel-dns*)
    echo "  ⚠️ 似乎还停留在 Vercel 的 CNAME 目标上，请确认最终解析到 A 记录"
    ;;
esac

echo
echo "== 2) 直连 TLS / HTTP（不走代理）=="
CODE="$(curl -sS -o /dev/null --noproxy '*' --max-time 20 -w '%{http_code}' "https://$DOMAIN/v1" 2>&1 | tail -1)"
echo "  GET /v1 -> HTTP $CODE"
case "$CODE" in
  000)
    echo "  ✗ 连接失败。常见原因："
    echo "      · 证书还没签发（刚绑域名时正常，等 1~5 分钟重试）"
    echo "      · DNS 仍是橙云"
    echo "      · TLS 被 reset（SNI 封锁）"
    exit 1
    ;;
  403)
    echo "  ✗ 403：多半是 Cloudflare 代理没关（需灰云），拿到的是 JS 挑战页"
    exit 1
    ;;
esac

echo
echo "== 3) 完整验收（含流式、批量 JSON、CORS 预检）=="
PROXY_URL="https://$DOMAIN" node "$ROOT/test/live-check.mjs"
