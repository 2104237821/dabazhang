# 打八张任务领取板

> 状态：`BLOCKED → READY → IN_PROGRESS → VERIFY → DONE`

| ID | 状态 | 依赖 | 负责人 | 独占路径 | 分支/工作树 | 验收命令 | 提交 SHA | 总目标复核 |
|---|---|---|---|---|---|---|---|---|
| T00 | DONE | 无 | 主协调代理 | 目标、规则、架构、任务板 | main | 文档人工复核 | e9792d1 | 通过 |
| T01 | DONE | T00 | 主协调代理 | 根配置、`packages/protocol`、CI | codex/v1-web-game | lint、typecheck、build | 317a567 | 通过 |
| T02 | DONE | T01 | Franklin | `packages/game-core` 基础 | task/T02-engine-model / `.worktrees/T02` | game-core tests | 32e8421 | 通过 |
| T03 | DONE | T02 | Franklin + 主协调代理 | `packages/game-core` 规则 | task/T03-engine-rules / `.worktrees/T03` | unit + property tests | d82fcaa | 通过，含仅剩王收尾 |
| T04 | DONE | T01 | Kuhn | `apps/server` 房间与会话 | task/T04-server-room / `.worktrees/T04` | server tests | 102a30f | 通过 |
| T05 | DONE | T01 | Hume | `apps/web` 页面壳 | task/T05-web-shell / `.worktrees/T05` | web tests + build | 3359ec7 | 通过 |
| T06 | DONE | T03 | 主协调代理 | `packages/bot` | task/T06-bot / `.worktrees/T06` | bot tests | 28ccfe0 | 通过，只使用脱敏视图和合法动作 |
| T07 | DONE | T03,T04,T06 | 主协调代理（接管 Kuhn） | `apps/server` 实时与恢复 | task/T07-server-realtime / `.worktrees/T07` | server integration tests | b0ff505 | 通过，含规格与质量双重复核 |
| T08 | DONE | T05 | Hume | `apps/web` 四方牌桌 | task/T08-web-table / `.worktrees/T08` | web tests + screenshots | 2fb9d82 | 通过，四种目标尺寸与键盘操作均已实测 |
| T09 | DONE | T03,T08 | Hume | `apps/web` 游戏交互 | task/T09-web-actions / `.worktrees/T09` | web tests | c61de43 | 通过，59 项交互测试及规格、质量复核通过 |
| T10 | DONE | T06,T07,T09 | 主协调代理 | 跨模块集成 | codex/v1-web-game | integration + build | 651c46a,3c59cd4 | 通过，153 项测试；真实创建、开局、出牌、刷新恢复及脱敏检查通过 |
| T11 | DONE | T07 | Kuhn + 主协调代理 | `apps/server`、部署文档；根部署配置由主协调代理维护 | task/T11-deploy / `.worktrees/T11` | Docker + health smoke | c245309,5effabb | 通过，38 项服务测试、生产冒烟与 GitHub Docker CI 通过 |
| T12 | DONE | T10 | 主协调代理（接管 Hume） | E2E、视觉、无障碍 | task/T12-qa / `.worktrees/T12` | Playwright + a11y | b0ef85e | 通过，9 项真实浏览器流程、macOS/Linux 视觉基线与 axe 扫描通过 |
| T13 | IN_PROGRESS | T11,T12 | 主协调代理 | 发布与总验收 | codex/v1-web-game | full CI | 待填 | 已复读总体目标，开始发布验收 |

## 领取流程

主协调代理负责检查依赖、创建任务分支或工作树、登记 `IN_PROGRESS`、验证交付、合并、填写任务提交 SHA 和标记 `DONE`。子代理完成一项后必须重新读取本文件，再领取下一个 `READY` 任务。
