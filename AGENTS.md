# 子代理协作规则

1. 每次领取任务前完整阅读 `PROJECT_GOAL.md`、`docs/GAME_RULES.md` 和 `TASKS.md`。
2. 只处理状态为 `READY` 且依赖已完成的任务；先向主协调代理发送 `CLAIM Txx`。
3. 只修改任务登记的独占路径，不修改其他代理路径或共享协议。
4. 不得修改 `PROJECT_GOAL.md`、`docs/GAME_RULES.md`、`TASKS.md`、`packages/protocol` 或根配置；这些由主协调代理维护。
5. 发现规则不完整或冲突时立即报告，不自行选择新规则。
6. 完成后运行登记的验收命令，报告修改文件、测试结果和遗留风险。
7. 主协调代理验证并更新任务状态后，重新读取任务文件并领取下一项。
8. 禁止 `git add .`、`git add -A`、强推和破坏历史的 reset；只暂存任务明确拥有的路径。
