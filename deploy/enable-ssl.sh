#!/usr/bin/env bash
# 为反代域名申请并启用 HTTPS。前提：域名 A 记录已指向本机公网 IP，且 80 端口可达
# （Let's Encrypt 的 HTTP-01 校验走 80 端口，解析没生效时必然失败）。
# 用法：sudo bash deploy/enable-ssl.sh chat.yangzhao.tech
set -euo pipefail

DOMAIN="${1:?用法: sudo bash deploy/enable-ssl.sh <域名>}"
EMAIL="${EMAIL:-admin@${DOMAIN#*.}}"

echo "==> 先确认域名解析是否已指向本机"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)
if [ -z "$RESOLVED" ]; then
  echo "!! 域名无法解析，Let's Encrypt 校验会失败。请先修正 DNS A 记录。" >&2
  exit 1
fi
# 腾讯云等云厂商的公网 IP 是 NAT 映射到私网的，服务器上看不到自己的公网 IP，
# 所以不能直接和"本机 IP"比对；改为验证该地址上跑的是不是本应用。
LOCAL_IPS=" $(hostname -I 2>/dev/null) $(ip -4 addr show 2>/dev/null | grep -oP 'inet \K[\d.]+' | tr '\n' ' ') "
if echo "$LOCAL_IPS" | grep -q " $RESOLVED "; then
  echo "    域名解析到本机地址 $RESOLVED"
elif curl -s --max-time 10 -H "Host: $DOMAIN" "http://$RESOLVED/api/state" | grep -q '"id":"main"'; then
  echo "    域名解析到 $RESOLVED（NAT 公网 IP），该地址上正在运行本应用"
else
  echo "!! $RESOLVED 上没有本应用在响应，DNS 可能仍指向别处。" >&2
  echo "   请用 dig +short $DOMAIN 与服务器公网 IP 对照后重试。" >&2
  exit 1
fi

echo "==> 申请证书并写入 Nginx 配置（含 80 -> 443 跳转）"
certbot --nginx -d "$DOMAIN" --redirect -n --agree-tos -m "$EMAIL"

echo "==> 重载并验证"
systemctl reload nginx
# 用 GET 而非 HEAD：应用只处理 GET/POST，HEAD 会拿到 404（浏览器不受影响）
curl -s -o /dev/null --max-time 15 -w "https://$DOMAIN/ -> HTTP %{http_code}\n" "https://$DOMAIN/"
echo "完成: https://$DOMAIN/"
