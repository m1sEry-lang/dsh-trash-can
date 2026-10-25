# dsh-trash-can · 垃圾桶

给 DeepSeek Harness 加一个**可还原的会话回收站**：先把会话归档，再从右键菜单里红色「删除」把它整包搬进垃圾桶；15 天内可还原，满 **360 小时**（精确到小时）自动彻底删除。

> 适用版本：`dsh >= 0.2.1-rc.2`（Web profile）

## 它做了什么

- 侧栏账户上方固定一条「🗑 垃圾桶」，永远可见，不随会话列表滚动。
- 点击向上抽出垃圾桶抽屉，把工作区会话列表挤矮；抽屉顶部有可点击的"千层饼"边，点它收回。
- 抽屉里每行压缩显示 `标题 + 剩余天数 + ⋯`；悬停 **1 秒**展开详情卡（高度上限 150px，右边界不进入会话内容区）。
- 详情卡显示：标题、≤50 字内容总结、原工作区、移入时间、剩余天数。
- 「⋯」菜单：彻底删除 / 还原 / 详情。
- 垃圾桶项目框右键菜单：清空垃圾桶 / 背景透明度（0–100%，默认 75%，只作用于背景）/ 修改配置。
- 打开界面时扫描一次过期条目（不常驻轮询）；满 360 小时即删除。
- 已归档的会话，右键菜单里出现红色「删除」；未归档的会话不显示该项。

## 安装

### 本地目录

```bash
dsh plugin --profile web add /absolute/path/to/dsh-trash-can
```

### 从 GitHub

```bash
dsh plugin --profile web add github:<you>/dsh-trash-can
```

安装后重启，或等待 profile 的 live patch 重载；新插件首次出现通常需要刷新一次页面。

## 首次使用必须问用户：垃圾桶放在哪

**本插件没有默认垃圾桶目录，也不会猜。** 首次加载会弹出必填对话框；未填写之前，底栏入口显示"尚未设置位置"，不会搬任何文件。

若你把本包交给另一台设备上的智能体安装，请在安装完成后**主动询问用户**：

> 「垃圾桶目录要放在哪里？请给一个本机绝对路径（不要用磁盘根目录，也不要放在 DeepSeek Harness 主目录 `~/.dsh` 里面）。」

用户填写后再调用 `POST /api/dsh-trash/config`，或在弹出的对话框里保存。

## 数据放在哪

| 内容 | 位置 |
|---|---|
| 插件状态（垃圾桶目录、透明度、条目索引） | `~/.dsh/storages/dsh-trash-can.json` |
| 被删除的会话本体 | `<垃圾桶目录>/<sessionId>/`（内含 `trash-meta.json`） |
| 会话原位置 | `~/.dsh/sessions/<product-dir>/<sessionId>/` |
| 投影缓存（保留标题；彻底删除时才清理） | `~/.dsh/storages/session_projcache/sessions/<sessionId>.json` |
| 工作区注册表 | `~/.dsh/storages/workspace.json` |

跨盘移动采用"复制 → 校验文件数与字节数 → 删源"，校验不通过时保留源并报错。

还原时会检查原工作区路径是否还存在：不存在则落到「未分组」，并给标题追加 `（原工作区名）`，例如 `方案讨论（旧工作区）`。

## 已知边界（请如实告知用户）

- **附件**：会话引用到的图片对象在 `~/.dsh/attachments`。只有"没有其它会话引用"的对象才会一起删除；共享的保留，避免弄坏别的会话。
- **服务端**：图片此前已上传到模型文件接口的副本，本地删不掉，只能等其到期（约 7 天）或由平台侧清理。
- **物理擦除**：文件系统删除不覆写磁盘，专业工具仍可能恢复碎片。
- **会话注册表**：删除时会把该会话从 `workspace.json` 的归档/置顶/工作区列表里摘掉；若运行中的 Host 稍后用内存态覆盖该文件，可能短暂出现一条"幽灵行"，刷新页面即可消失。

## 开发与自测

`npm test` 跑三组，全部不需要浏览器、不需要拉起 profile：

| 文件 | 覆盖 |
|---|---|
| `test/smoke.mjs` | 假 ModuleLoader + 假 React hooks：加载工厂、注册 3 个插槽、首渲染、`让智能体帮我改` 是否真的调用了 `uiWorkspace.startSession({ prompt })` |
| `test/flow.mjs` | 假会话走完 计划 → 搬入 → 还原 → 再搬入 → 满 360 小时清理，并验证"未归档拒绝删除"这道闸门 |
| `test/delete-flow.mjs` | 真的点按钮：红色「删除」→ plan → 文件弹窗 → 选「否」→ 追问 → 选「是」，以及选「是」时把文件一起搬走 |

`node test/plan.mjs <sessionId>` 可以对真实会话跑一次只读的摘要/产品文件识别。

## 发布

```powershell
winget install --id GitHub.cli
gh auth login
pwsh -File publish.ps1 -Owner <你的GitHub用户名>
```

脚本会在仓库不存在时创建、已存在时直接推送；令牌只存在于 Windows 凭据管理器，脚本不接触它。

## 卸载

```bash
dsh plugin --profile web remove dsh-trash-can
```

垃圾桶里的会话不会因为卸载而自动还原；需要的话手动把 `<垃圾桶目录>/<sessionId>/` 搬回 `~/.dsh/sessions/<product-dir>/`。

## 许可

MIT

