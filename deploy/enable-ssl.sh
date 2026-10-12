#!/usr/bin/env bash
# 为反代域名申请并启用 HTTPS。前提：域名 A 记录已指向本机公网 IP，且 80 端口可达
# （Let's Encrypt 的 HTTP-01 校验走 80 端口，解析没生效时必然失败）。
# 用法：sudo bash deploy/enable-ssl.sh chat.yangzhao.tech
set -euo pipefail

DOMAIN="${1:?用法: sudo bash deploy/enable-ssl.sh <域名>}"
EMAIL="${EMAIL:-admin@${DOMAIN#*.}}"

echo "==> 先确认域名解析是否已指向本机"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
MINE=$(curl -s --max-time 8 https://api.ipify.org || hostname -I | awk '{print $1}')
echo "    域名解析到: ${RESOLVED:-无}   本机公网 IP: ${MINE}"
if [ "$RESOLVED" != "$MINE" ]; then
  echo "!! 域名没有解析到本机，Let's Encrypt 校验会失败。请先修正 DNS A 记录。" >&2
  exit 1
fi

echo "==> 申请证书并写入 Nginx 配置（含 80 -> 443 跳转）"
certbot --nginx -d "$DOMAIN" --redirect -n --agree-tos -m "$EMAIL"

echo "==> 重载并验证"
systemctl reload nginx
curl -sI --max-time 15 "https://$DOMAIN/" | head -1
echo "完成: https://$DOMAIN/"
