# 打八张服务器部署

首版必须以单个 Node.js 进程运行。该进程同时提供 Web 静态文件、SPA 历史路由、Socket.IO、`/healthz` 和 `/readyz`；房间只保存在内存中，不得启用多实例、集群模式或无粘性负载均衡。

## 1. 运行要求

- Node.js 24 LTS 与 npm 11。
- 一台能长期运行单进程服务的 Linux 服务器。
- 由 Caddy、Nginx 或同类反向代理终止 HTTPS，并把 HTTP 与 WebSocket 都转发给同一后端进程。
- 至少使用 32 字节随机值保护服务器登录凭据；游戏本身首版没有账号或数据库。

首次部署：

```bash
git clone git@github.com:2104237821/dabazhang.git
cd dabazhang
git checkout v1.0.0
npm ci
npm run build
NODE_ENV=production \
PUBLIC_ORIGIN=https://cards.example.com \
STATIC_ROOT="$(pwd)/apps/web/dist" \
HOST=127.0.0.1 \
PORT=3000 \
npm start
```

`STATIC_ROOT` 必须是绝对路径。生产构建后应指向 `apps/web/dist`，不要把源码目录作为静态目录。

建议交给 systemd、Docker 或其他进程管理器启动，并让进程管理器在异常退出后重启。收到 `SIGTERM` 或 `SIGINT` 时，服务器会先把 readiness 切换为失败、通知已连接客户端房间即将结束、拒绝新命令，再关闭 Socket.IO 和 HTTP 监听。

## 2. 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `NODE_ENV` | `development` | 生产必须为 `production`；此时启用 HSTS。 |
| `HOST` | `0.0.0.0` | Node 监听地址；同机反代时推荐 `127.0.0.1`。 |
| `PORT` | `3000` | 监听端口，范围 1–65535。 |
| `PUBLIC_ORIGIN` | 未设置 | 唯一允许的跨域来源，例如 `https://cards.example.com`；必须是明确的 HTTP(S) origin，禁止 `*`、路径、查询和片段。未设置时只接受同源浏览器访问。 |
| `STATIC_ROOT` | 未设置 | Web 生产构建的绝对路径。未设置时只提供 Socket.IO 和健康端点。 |
| `ACTION_TIMEOUT_MS` | `45000` | 在线玩家单步行动时限，范围 1000–600000。 |
| `DISCONNECT_GRACE_MS` | `60000` | 断线座位保留时长，范围 1000–3600000。 |
| `BOT_DELAY_MIN_MS` | `500` | 机器人动作最小等待，范围 0–60000。 |
| `BOT_DELAY_MAX_MS` | `900` | 机器人动作最大等待，范围 0–60000，且不得小于最小值。 |
| `COMMAND_RATE_LIMIT_MAX` | `60` | 单个 Socket.IO 连接在一个窗口内允许的命令数，范围 1–10000。 |
| `COMMAND_RATE_LIMIT_WINDOW_MS` | `10000` | 命令限流窗口，范围 100–600000。 |
| `MAX_ACTIVE_ROOMS` | `500` | 单进程允许同时保留的内存房间数，范围 1–100000；达到上限时拒绝创建新房间。 |

配置在进程启动时严格校验；错误值会导致启动失败，不会静默回落到另一个生产配置。

## 3. Nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name cards.example.com;

    # ssl_certificate /etc/letsencrypt/live/cards.example.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/cards.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
    }
}
```

不要单独把 `/socket.io/` 指向另一个实例。若未来必须经过负载均衡，需要先实现外部房间存储和跨实例协调；首版明确不支持。

## 4. Caddy 反向代理

```caddyfile
cards.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy 的 `reverse_proxy` 会自动处理 WebSocket 升级。Node 服务在 `NODE_ENV=production` 下发出 HSTS；只有确认域名始终使用 HTTPS 后才应以生产模式对公网服务。

## 5. Docker

根目录的 Dockerfile 由构建阶段生成 Web 与服务器产物，运行阶段仅启动一个 Node.js 进程。典型启动命令：

```bash
docker build -t dabazhang:v1.0.0 .
docker run -d \
  --name dabazhang \
  --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -e NODE_ENV=production \
  -e PUBLIC_ORIGIN=https://cards.example.com \
  -e STATIC_ROOT=/app/apps/web/dist \
  -e HOST=0.0.0.0 \
  -e PORT=3000 \
  dabazhang:v1.0.0
```

反向代理仍应负责公网 TLS。不要通过 Docker Compose `replicas`、Kubernetes Deployment 多副本或 Node cluster 扩容首版。

## 6. 健康检查与停机

- `GET /healthz`：进程存活时返回 `200 {"status":"ok"}`。
- `GET /readyz`：可接收游戏命令时返回 200；开始优雅停机后返回 503，并包含当前内存房间数。
- 静态文件不存在时返回 JSON 404；只有接受 `text/html` 的无扩展名页面导航才回退到 `index.html`，因此缺失的 `/assets/*` 不会被错误缓存为 HTML。

示例：

```bash
curl --fail https://cards.example.com/healthz
curl --fail https://cards.example.com/readyz
```

容器健康检查应使用 `/healthz`；反向代理摘流或滚动操作应使用 `/readyz`。停机时应先发送 `SIGTERM`，并给进程短暂宽限来发送关闭通知。

## 7. 数据、备份与回滚

所有房间、恢复令牌映射和正在进行的牌局都只存在当前进程内存中。服务重启、容器替换或主机故障会结束全部房间；客户端会显示原房间已结束，无法从服务器恢复牌局。这是首版既定范围，不是持久化故障。

大厅中最后一名真人断线超过宽限期后，服务器会删除该房间和恢复会话并释放房间容量。已经开始的牌局仍按断线规则交由机器人接管，不会因 60 秒宽限到期而删除。

代码回滚优先使用已发布的 Git 标签或不可变镜像标签：

```bash
git fetch --tags
git checkout v0.3.0-playable
npm ci
npm run build
```

若只撤销某项任务，使用 `git revert <任务提交SHA>` 创建新的回滚提交，禁止强推或重写共享历史。Docker 部署应保留前一版本镜像，停止当前容器后以旧标签重新启动。任何回滚和重启都会结束内存房间，应提前通知在线玩家。

发布标签含义：

- `v0.1.0-foundation`：目标、规则、架构和任务流程基线。
- `v0.2.0-engine`：权威规则引擎与合法动作机器人完成。
- `v0.3.0-playable`：实时房间、恢复和完整 Web 牌桌可玩版本。
- `v1.0.0`：部署、浏览器流程、视觉、无障碍和发布验收全部通过。
