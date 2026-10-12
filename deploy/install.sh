#!/usr/bin/env bash
# 在腾讯云服务器上以 root 执行：把 agent-chat 部署到 /opt/app/agent-chat 并注册为系统服务。
# 用法：
#   LLM_API_KEY=sk-xxx bash deploy/install.sh            # 全新安装
#   bash deploy/install.sh                                # 已安装则更新代码并重启
set -euo pipefail

APP_DIR=/opt/app/agent-chat
REPO_URL=https://github.com/yangzhao917/agent-chat.git
PORT="${PORT:-3000}"

log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

# ---- 1. Node.js >= 22 -------------------------------------------------------
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -v | sed 's/^v//' | cut -d. -f1)
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  log "安装 Node.js 22"
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
    dnf install -y nodejs
  else
    echo "未识别的包管理器，请手动安装 Node.js >= 22" >&2
    exit 1
  fi
fi
log "Node $(node -v) / npm $(npm -v)"

# ---- 2. 代码到 /opt/app ------------------------------------------------------
log "同步代码到 $APP_DIR"
mkdir -p /opt/app
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" reset --hard origin/main
elif [ -d "$APP_DIR/package.json" ]; then
  # 没有 .git：说明是 scp 拷过来的压缩包解压的，跳过拉取，直接用它
  echo "检测到非 git 部署，保留现有代码"
else
  if git clone --depth 1 "$REPO_URL" "$APP_DIR" 2>/dev/null; then
    echo "已从 GitHub 克隆"
  else
    echo "无法访问 github.com（国内服务器常见）。请改用 scp 部署：" >&2
    echo "  本地:  git archive --format=tar.gz -o /tmp/ac.tgz HEAD" >&2
    echo "  本地:  scp /tmp/ac.tgz ${RUN_USER}@<服务器IP>:/tmp/" >&2
    echo "  服务器: sudo mkdir -p $APP_DIR && sudo tar -xzf /tmp/ac.tgz -C $APP_DIR" >&2
    echo "  然后重跑本脚本" >&2
    exit 1
  fi
fi

# ---- 3. 配置 ----------------------------------------------------------------
# .env 只在首次创建，之后保留服务器上的本地修改（含 API Key）
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
fi
if [ -n "${LLM_API_KEY:-}" ]; then
  if grep -q '^LLM_API_KEY=' "$APP_DIR/.env"; then
    sed -i "s|^LLM_API_KEY=.*|LLM_API_KEY=${LLM_API_KEY}|" "$APP_DIR/.env"
  else
    printf 'LLM_API_KEY=%s\n' "$LLM_API_KEY" >> "$APP_DIR/.env"
  fi
fi
if grep -q '^PORT=' "$APP_DIR/.env"; then
  sed -i "s|^PORT=.*|PORT=${PORT}|" "$APP_DIR/.env"
else
  printf 'PORT=%s\n' "$PORT" >> "$APP_DIR/.env"
fi

if ! grep -qE '^LLM_API_KEY=.+' "$APP_DIR/.env"; then
  log "警告：$APP_DIR/.env 里还没有 LLM_API_KEY"
  echo "    请编辑后执行：systemctl restart agent-chat"
fi

# ---- 4. 注册为系统服务 ------------------------------------------------------
log "注册 systemd 服务"
# 服务按部署账号运行，不用 root：既缩小权限，也避免 root 建的文件让后续更新写不进去
RUN_USER="${SUDO_USER:-$(id -un)}"
sed -e "s|^User=.*|User=${RUN_USER}|" -e "s|^Group=.*|Group=${RUN_USER}|" \
  "$APP_DIR/deploy/agent-chat.service" > /etc/systemd/system/agent-chat.service
chown -R "${RUN_USER}:${RUN_USER}" "$APP_DIR"
systemctl daemon-reload
systemctl enable --now agent-chat
sleep 2

log "部署完成"
systemctl --no-pager --lines=0 status agent-chat || true
echo
echo "本地自检:  curl -s http://127.0.0.1:${PORT}/api/state | head -c 200"
echo "浏览器访问: http://<服务器公网IP>:${PORT}"
echo "查看日志:   journalctl -u agent-chat -f"
