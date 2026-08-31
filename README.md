# 打八张

四人对家制扑克牌 Web 游戏。v1.0 支持房间码联机、真人与机器人混合游玩、刷新恢复、断线接管和再来一局；规则由服务端统一判定，客户端不会收到其他玩家手牌或牌堆顺序。

完整规则见 [`docs/GAME_RULES.md`](docs/GAME_RULES.md)，系统边界见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，部署步骤见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)，发布验收与回滚点见 [`docs/RELEASE.md`](docs/RELEASE.md)。

## 环境

- Node.js 24 LTS
- npm 11+

```bash
npm ci
npm run dev
```

开发服务器启动后，浏览器打开 Vite 输出的本地地址；创建房间后可由房主一键补满三个机器人开始试玩。

## 验证

```bash
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

浏览器测试包含完整真人/机器人牌局、四浏览器联机、刷新与断网恢复、视觉快照和无障碍扫描。

## 生产运行

```bash
npm run build
NODE_ENV=production \
STATIC_ROOT="$(pwd)/apps/web/dist" \
HOST=127.0.0.1 \
PORT=3000 \
npm start
```

首版必须只运行一个 Node.js 进程。房间只保存在该进程内存中，服务器重启后现有房间会结束；公网部署还应配置 HTTPS 与 WebSocket 反向代理。
