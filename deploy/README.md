# 部署到腾讯云服务器

应用统一放在 `/opt/app` 下，本项目占用 `/opt/app/agent-chat`。
部署脚本会装好 Node.js、拉取代码、写入配置、注册成系统服务（开机自启、崩溃自动重启）。

## 一、在腾讯云控制台先做两件事

1. **开放端口**：云服务器 → 安全组 → 放行入站 TCP `3000`（或你在 `PORT` 里改的端口）。
   默认不开的话，浏览器打不开。
2. **确认系统**：脚本支持 Ubuntu/Debian（apt）与 CentOS/Rocky（dnf）。轻量应用服务器
   的镜像一般是 Ubuntu，可直接用。

## 二、登录服务器执行

```bash
# 把 <KEY> 换成你的 LLM API Key
LLM_API_KEY=<KEY> bash <(curl -fsSL https://raw.githubusercontent.com/yangzhao917/agent-chat/main/deploy/install.sh)
```

脚本会依次完成：安装 Node.js 22 → 克隆代码到 `/opt/app/agent-chat` → 生成 `.env`
→ 注册并启动 `agent-chat` 服务。

> 第一次跑如果忘了带 `LLM_API_KEY`，服务会起来但没有 Key 调不通 LLM。
> 补救：编辑 `/opt/app/agent-chat/.env` 填上 Key，然后 `systemctl restart agent-chat`。

## 三、验证

```bash
systemctl status agent-chat          # 服务状态
journalctl -u agent-chat -f          # 实时日志
curl -s http://127.0.0.1:3000/api/state | head -c 200
```

浏览器打开 `http://<服务器公网IP>:3000`，应看到「围炉夜话」房间和 10 位成员。

## 四、以后更新

代码推到 GitHub 后，在服务器上重跑同一条命令即可（脚本会 `git reset --hard origin/main`
并重启服务）。服务器上的 `.env` 和 `data/` 不会被覆盖——聊天记录得以保留。

```bash
LLM_API_KEY=<KEY> bash <(curl -fsSL https://raw.githubusercontent.com/yangzhao917/agent-chat/main/deploy/install.sh)
```

## 常用运维命令

| 目的 | 命令 |
| --- | --- |
| 看日志 | `journalctl -u agent-chat -f` |
| 重启 | `systemctl restart agent-chat` |
| 停止 | `systemctl stop agent-chat` |
| 开机不自启 | `systemctl disable agent-chat` |
| 改配置 | 编辑 `/opt/app/agent-chat/.env` 后 `systemctl restart agent-chat` |
| 备份聊天记录 | 拷贝 `/opt/app/agent-chat/data/rooms/main.jsonl` |

## 换端口

默认 `3000`。改端口要同时改两处，否则安全组放了但服务没监听：

```bash
sed -i 's/^PORT=.*/PORT=8080/' /opt/app/agent-chat/.env
systemctl restart agent-chat
```

别忘了在腾讯云安全组里放行同一个端口。

## 注意事项

- 服务以 `root` 运行（`/opt` 需要权限）。若要降权，把 `agent-chat.service` 里的
  `User=` 打开并提前 `chown -R` 应用目录。
- `Restart=always` 会在崩溃后 3 秒重启。如果 LLM Key 失效导致连续发言失败，
  房间会自动停止调度但服务不会退出，这是预期行为。
- 聊天记录是单个 JSONL 文件，备份就是拷贝它。
