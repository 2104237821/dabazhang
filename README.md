# 打八张

四人对家制扑克牌 Web 游戏。当前处于首版开发阶段，完整规则见 [`docs/GAME_RULES.md`](docs/GAME_RULES.md)，项目目标和非目标见 [`PROJECT_GOAL.md`](PROJECT_GOAL.md)。

## 环境

- Node.js 24 LTS
- npm 11+

```bash
npm ci
npm run dev
```

生产构建：

```bash
npm run build
npm start
```

首版房间只保存在单个服务器进程的内存中，服务器重启后现有房间会结束。
