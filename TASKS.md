# 打八张任务领取板

> 状态：`BLOCKED → READY → IN_PROGRESS → VERIFY → DONE`

| ID | 状态 | 依赖 | 负责人 | 独占路径 | 分支/工作树 | 验收命令 | 提交 SHA | 总目标复核 |
|---|---|---|---|---|---|---|---|---|
| T00 | DONE | 无 | 主协调代理 | 目标、规则、架构、任务板 | main | 文档人工复核 | e9792d1 | 通过 |
| T01 | DONE | T00 | 主协调代理 | 根配置、`packages/protocol`、CI | codex/v1-web-game | lint、typecheck、build | 317a567 | 通过 |
| T02 | DONE | T01 | Franklin | `packages/game-core` 基础 | task/T02-engine-model / `.worktrees/T02` | game-core tests | 32e8421 | 通过 |
| T03 | IN_PROGRESS | T02 | Franklin | `packages/game-core` 规则 | task/T03-engine-rules / `.worktrees/T03` | unit + property tests | 待填 | 待复核 |
| T04 | IN_PROGRESS | T01 | Kuhn | `apps/server` 房间与会话 | task/T04-server-room / `.worktrees/T04` | server tests | 待填 | 待复核 |
| T05 | IN_PROGRESS | T01 | Hume | `apps/web` 页面壳 | task/T05-web-shell / `.worktrees/T05` | web tests + build | 待填 | 待复核 |
| T06 | BLOCKED | T03 | Franklin | `packages/bot` | task/T06-bot | bot tests | 待填 | 待复核 |
| T07 | BLOCKED | T03,T04,T06 | Kuhn | `apps/server` 实时与恢复 | task/T07-server-realtime | server integration tests | 待填 | 待复核 |
| T08 | BLOCKED | T05 | Hume | `apps/web` 四方牌桌 | task/T08-web-table | web tests + screenshots | 待填 | 待复核 |
| T09 | BLOCKED | T03,T08 | Hume | `apps/web` 游戏交互 | task/T09-web-actions | web tests | 待填 | 待复核 |
| T10 | BLOCKED | T06,T07,T09 | 主协调代理 | 跨模块集成 | codex/v1-web-game | integration + build | 待填 | 待复核 |
| T11 | BLOCKED | T07 | Kuhn | 服务安全与部署 | task/T11-deploy | Docker + health smoke | 待填 | 待复核 |
| T12 | BLOCKED | T10 | Hume | E2E、视觉、无障碍 | task/T12-qa | Playwright + a11y | 待填 | 待复核 |
| T13 | BLOCKED | T11,T12 | 主协调代理 | 发布与总验收 | codex/v1-web-game | full CI | 待填 | 待复核 |

## 领取流程

主协调代理负责检查依赖、创建任务分支或工作树、登记 `IN_PROGRESS`、验证交付、合并、填写任务提交 SHA 和标记 `DONE`。子代理完成一项后必须重新读取本文件，再领取下一个 `READY` 任务。
