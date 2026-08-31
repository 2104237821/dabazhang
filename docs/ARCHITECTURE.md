# 系统架构

## 模块边界

- `packages/game-core`：完整权威牌局状态、合法动作、状态转移、事件和脱敏观察。
- `packages/protocol`：浏览器与服务端共享的 Zod 命令、快照 DTO 和错误码。
- `packages/bot`：只读取玩家观察和合法动作，不能访问隐藏手牌或牌堆。
- `apps/server`：内存房间、游客会话、串行命令队列、计时器、Socket.IO、静态文件和健康检查。
- `apps/web`：房间和牌桌 UI，只提交意图，不在客户端判定胜负或发牌。

## 权威数据流

```text
浏览器意图
  → 协议严格校验
  → 房间串行队列
  → game-core 校验并转移状态
  → revision + 1
  → 为四个座位分别生成脱敏快照
  → Socket.IO 定向发送
```

生产随机数使用 `node:crypto`；测试使用可注入的固定种子或固定牌序。所有有效状态变化增加 `revision`。服务端为每个连接缓存限定数量的 `requestId`，重复请求返回 `DUPLICATE_REQUEST`，过期 `expectedRevision` 返回 `STALE_REVISION`，两者都不会再次改变状态。

## 会话与房间

- 房间码为六位去歧义大写字符，最多四席。
- 创建或加入成功后仅向本人返回随机恢复令牌；令牌保存在浏览器本地存储，不进入 URL、日志或公开快照。
- 同一令牌在新连接恢复时替换旧连接。
- Web 客户端只在本地保存房间码、座位号和恢复令牌；刷新或网络恢复后使用令牌重新绑定座位，并忽略早于当前 `revision` 的快照。
- 房间状态：`LOBBY → PLAYING → POST_GAME → PLAYING`。
- 座位控制：`HUMAN_ONLINE → HUMAN_GRACE → BOT_TAKEOVER → HUMAN_ONLINE`，固定机器人使用独立类型 `BOT_FIXED`。
- 在线决定时间为 45 秒，超时只由机器人执行一个合法动作。
- 断线宽限为 60 秒；轮到断线者时暂停。宽限结束后持续机器人接管，玩家回来时在下一安全决策边界收回。

## 部署边界

单个 Node.js 24 进程监听 `0.0.0.0:3000`，同时提供 SPA、Socket.IO、`/healthz` 和 `/readyz`。Caddy 或 Nginx 负责 TLS 和 WebSocket 反向代理。房间仅在内存中保存，服务器重启会终止所有房间；在引入共享状态前禁止多实例和集群。
