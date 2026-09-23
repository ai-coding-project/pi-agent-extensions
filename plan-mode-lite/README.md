# plan-mode-lite — pi 计划模式扩展

为 [pi coding agent](https://github.com/badlogic/pi-mono) 提供的轻量级计划模式（Plan Mode）扩展。启动时默认进入只读的"计划模式"，模型只做调研和规划，不改任何文件；用快捷键或 `/plan` 随时切换。

## 功能

- **默认开启**：每次新会话自动进入计划模式（可用 `/plan default-off` 关闭，或启动时加 `--plan` 强制开启）
- **快捷键切换**：默认 `tab`（可配置），`/plan` 无参数也可切换
- **只读防护**（移植自 [@narumitw/pi-plan-mode-lite](https://github.com/narumiruna/pi-extensions) 的 tool-policy，MIT）：
  - `edit` / `write` 工具被停用并双重拦截
  - bash / PowerShell 走**白名单 + fail-closed** 策略：无法安全解析的命令（重定向、反引号、子 shell、未闭合引号、变量展开）一律拒绝；白名单命令的危险参数（`sed -i`、`find -delete`、`sort -o` 等）单独拦截；git/gh 逐子命令、逐参数校验
- **Plan contract 注入**：计划模式期间以命名 section（`plan-mode`）注入系统提示——要求模型只读调研、产出完整可实施计划、不得动手实现；开关状态以增量记入会话记录，resume 后自动还原
- **状态变化通知**：用户主动切换时通过 `pi.sendMessage` 发送一条**仅模型可见**的通知（"Plan mode is now ON/OFF …"），模型能明确感知模式已切换，不会在用户关闭后仍反复要求其退出计划模式
- **`plan_mode_question` 工具**：模型遇到无法从代码得到答案、又会实质影响方案的取舍时，通过结构化选择器向你提问（1-3 个问题，每个 2-4 个选项，也可自定义作答）
- **状态持久化**：切换状态写入会话条目，resume / fork 后自动恢复
- **页脚状态**：计划模式开启时页脚显示 `⏸ plan`

## 安装

```bash
pi install npm:plan-mode-lite
```

开发调试可以用 symlink 直接指向本仓库目录：

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn /path/to/pi-agent-extensions/plan-mode-lite ~/.pi/agent/extensions/plan-mode-lite
```

（pi 支持加载 `~/.pi/agent/extensions/` 下含 `index.ts` 的子目录，symlink 可跟随。）

## 使用

| 操作 | 效果 |
|---|---|
| `ctrl+tab`（或配置的快捷键） | 切换计划模式 |
| `/plan` | 切换计划模式 |
| `/plan on` / `/plan off` | 开 / 关 |
| `/plan status` | 查看状态、默认值、配置路径 |
| `/plan default-on` / `default-off` | 设置并持久化"启动时默认进入计划模式" |
| `pi --plan` | 本次启动强制进入计划模式 |

## 配置

`~/.pi/agent/plan-mode-lite.json`：

```json
{
  "defaultOn": true,
  "toggleShortcut": "ctrl+tab",
  "safeSubcommands": {
    "kubectl": ["get", "describe"],
    "git": ["rev-parse", "blame"]
  }
}
```

- `defaultOn`：启动时是否默认进入计划模式（默认 `true`）
- `toggleShortcut`：切换快捷键（默认 `ctrl+tab`；注意不要设成 `tab`，会遮蔽输入框的 Tab 补全，`shift+tab` 则会遮蔽 thinking 级别循环——扩展快捷键优先于内置按键）
- `safeSubcommands`：额外放行的子命令（自担风险）。`gh` 的键值格式为 `"pr view"` 这类双段路径，且必须带 `--json` 输出

旧版 `~/.pi/agent/pi-plan-mode-lite.json`（narumitw 包的配置）在新配置文件不存在时会作为迁移回退被读取。

## 测试

```bash
npm test        # node --test test/（bash 策略 / 提问参数 / 扩展接线）
npm run typecheck
```

## 结构

- `index.ts` — 扩展入口：状态、切换、`/plan` 命令、快捷键、提示注入、事件拦截
- `src/bash-policy.ts` — 只读命令策略（移植自 narumitw，MIT）
- `src/config.ts` — 配置加载与持久化（`PLAN_MODE_CONFIG_DIR` 环境变量可覆盖配置目录，测试用）
- `src/plan-question.ts` — `plan_mode_question` 工具
- `test/*.test.ts` — node:test 测试（需 Node ≥ 22.18，原生 type stripping）

## License

MIT
