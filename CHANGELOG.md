# 更新记录

## 0.2.0

### 新增：删除后自检

- 每次移入垃圾桶后，宿主侧在 **+10 秒 / +20 秒**各跑一轮自检（九项），报告写入 `~/.dsh/storages/dsh-trash-can-selfcheck/`（保留最近 20 份）。
- 检查项：垃圾桶目录规则、过期清理、数据是否已搬离 `sessions/`、账本条目是否有目录、`trash-meta.json` 一致性、注册表残留、桶内孤立目录、跨盘复制残留、投影缓存。
- 自动修复仅限四类：摘除注册表残留、用账本重建 `trash-meta.json`、清理超过 1 小时的 `.partial-*` 暂存目录、清理超过 360 小时的过期条目。其余一律只报告。
- 前端默认静默：两轮全绿不打扰；只有「已修复 / 需注意 / 失败」才弹出报告。
- 新增 `GET /api/dsh-trash/reports`、`POST /api/dsh-trash/selfcheck`（垃圾桶菜单「立即自检」）。

### 修复

- **删除后侧栏残留幽灵行**：0.1.7 调用的是不存在的 `ctx.workspaceController`，于是只改了 `workspace.json` 文件；运行中的宿主内存状态不变，行要等重启才消失。现在经 `ctx.workspaceRegistry` 同时更新归档集合与工作区成员表。
- **还原后要重启才出现，或掉进「未分组」**：还原按会话日志 header 里的 `cwd` 解析工作区实体（删除时记录的路径作为兜底，另加大小写/分隔符归一化匹配），并要求 `workspace.sessionIds` 真的包含它；客户端同时刷新 `sessions` 与 `workspaces` 服务，无需重启。
- **客户端取错服务**：`ctx.sessions?.refresh?.()` 在只注入 `slots` 的插件里是 `undefined`，静默失效；改为 `ctx.get('sessions')`。

### 界面

- 底部提示改为挂在 `document.body` 上的独立节点：点击、切换会话、面板开关都不会让它消失，只在 **2.5 秒**后淡出；带淡入淡出与 `prefers-reduced-motion` 处理。
- 删除完成保留一条提示；自检全绿不再出现任何提示。

### 测试

- 新增 `test/selfcheck-flow.mjs`：用一份"已知坏数据"验证九项判定与自动修复是否真的落盘。
- `npm test` 现在包含它。
