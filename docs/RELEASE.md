# v1.0 发布验收与回滚

本文件记录首版交付的可复验依据。玩法规格仍以 `PROJECT_GOAL.md` 和 `docs/GAME_RULES.md` 为准；这里不新增或改变规则。

## 发布门槛

在 Node.js 24 LTS 与 npm 11 环境中执行：

```bash
npm ci
npm run lint
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run build
```

GitHub CI 还会执行生产 Node 冒烟、`/healthz`、`/readyz`、优雅停机和 Docker 构建。`quality` 与 `browser-qa` 两个任务都通过后才允许把发布 PR 合入 `main`。

## 首版验收覆盖

- 规则与状态机：54 张牌守恒、主花色、王、攻防、追加、协攻、主动收牌、主2换底、补牌不足、出完顺序和团队胜负。
- 权威与脱敏：`game-core` 生成座位观察；服务端分别发送四份快照，只公开本人手牌和牌堆张数。集成测试会断言快照不存在 `drawPile`，且任何座位都看不到另一座位的牌。
- 联机可靠性：房间创建/加入/准备/机器人补位、请求去重、旧版本拒绝、45 秒单步托管、60 秒断线接管、刷新恢复与安全边界收回控制。
- 浏览器流程：一名真人加三名机器人完成整局并再来一局；四个独立浏览器完成真人联机牌局；刷新和断网后恢复。
- 界面质量：1366×768、1440×900、1920×1080 视觉基线，协攻、收牌、主2、三人阶段与结算场景；键盘操作、焦点、文字状态、减少动画和 axe 严重级无障碍扫描。
- 部署：同一 Node 进程提供 SPA、Socket.IO 和健康端点；普通 Node 与 Docker 构建均在 CI 中验证。

关键测试入口：

- `packages/game-core/src/*.test.ts`
- `apps/server/src/*.test.ts`
- `tests/t10-realtime.integration.test.ts`
- `tests/e2e/realtime-flow.spec.ts`
- `tests/e2e/visual-a11y.spec.ts`

## 安全边界证明

完整牌局状态只存在 `game-core` 和服务端内存。浏览器协议快照只在本人的 `PlayerView` 中提供 `hand`，其他玩家只有 `handCount`；快照另含公开桌面牌与 `drawPileCount`，不包含其他玩家 `cardId` 列表或牌堆顺序。机器人入口接收同一类座位脱敏视图与 `LegalAction[]`，不能读取权威状态。

这是协议与运行时共同执行的边界，并由服务端四座位快照测试和真实 Socket.IO 集成测试持续验证。客户端源码或浏览器开发者工具因此不能恢复未公开牌序。

## 版本回滚点

| 标签 | 可回滚范围 |
|---|---|
| `v0.1.0-foundation` | 目标、规则、架构与任务板基线 |
| `v0.2.0-engine` | 权威规则引擎和机器人 |
| `v0.3.0-playable` | 可联机游玩的完整客户端/服务端 |
| `v1.0.0` | 首版正式发布 |

发布回滚使用 `git checkout <标签>` 后重新构建，单任务撤销使用 `git revert <提交SHA>`。禁止强推或重写共享历史。由于房间只保存在内存中，任何重启或回滚都会结束正在进行的房间。
