# pi-subagent-lite

为 [pi](https://github.com/badlogic/pi-mono)（`@earendil-works/pi-coding-agent`）提供的精简版 subagent 扩展：把任务委托给子 agent 同步或后台执行，并在会话关闭时清理全部存活子会话。

设计原则：从 [pi-subagents](https://github.com/nicobailon/pi-subagents) 拷贝核心运行逻辑（子会话工厂、运行循环状态机、frontmatter 解析、通知格式），只保留「创建子 agent 并跑完」这一件事，其余功能全部裁剪。

## 功能

- **同步执行**（默认）：`subagent-lite` 工具阻塞至子 agent 完成，返回其最终输出
- **异步执行**（`async: true`）：立即返回运行 id，后台执行；完成时自动向父会话推送通知
- **agent 定义**：markdown 文件（`~/.pi/agent/agents/` 与 `<cwd>/.pi/agents/`，项目优先）或内联 `systemPrompt`
- **边界处理**：超时中止、Ctrl-C 传递、递归防护（单层嵌套）、前台互斥、provider 继承、优雅关闭

## 安装

复制本目录到 pi 的扩展目录：

```bash
mkdir -p ~/.pi/agent/extensions
cp -r pi-subagent-lite ~/.pi/agent/extensions/
```

重启 pi 后 `subagent-lite` 工具即可用。

## 工具参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `task` | string（必填） | 给子 agent 的任务文本 |
| `agent` | string | 已发现 agent 的名字（与 `systemPrompt` 二选一） |
| `systemPrompt` | string | 内联系统提示（与 `agent` 二选一） |
| `model` | string | `provider/id` 或 `id`，可带 `:thinking` 后缀；缺省继承父会话模型 |
| `thinking` | enum | `off/minimal/low/medium/high/xhigh/max` |
| `tools` | string[] 或 CSV | 工具白名单；缺省用 agent 定义的，否则用 pi 默认 |
| `cwd` | string | 子 agent 工作目录（相对路径按父 cwd 解析） |
| `async` | boolean | 后台执行（默认 false） |
| `timeoutMs` | number | 运行超时（默认 30 分钟） |
| `action` | `"list"` \| `"stop"` | 管理操作：列出运行 / 停止后台运行（需 `id`） |
| `id` | string | `stop` 的目标运行 id |

## Agent 定义示例

`~/.pi/agent/agents/reviewer.md`：

```markdown
---
name: reviewer
description: Reviews code changes for correctness and style
model: anthropic/claude-sonnet-4-5
thinking: high
tools:
  - read
  - grep
---

You are a meticulous code reviewer. Examine the provided diff and report
concrete issues: bugs, races, missing error handling, and style violations.
Answer with a numbered list, most severe first.
```

frontmatter 字段：`name`（缺省用文件名）、`description`、`model`、`thinking`、`tools`（缩进 dash 列表或 CSV）、`systemPromptMode`（`replace` 默认 / `append` 追加到 pi 默认系统提示后）；正文即系统提示。

## 并发与递归规则

- 前台（同步）运行同时只允许 1 个；占用时第二次调用报错并建议 `async: true`
- 后台运行最多 16 个活跃
- 子 agent 不能再创建子 agent（单层嵌套，调用直接被拒绝）
- 运行历史保留最近 50 条（`action: "list"` 可查）

## 已知限制

- **异步任务随父进程存活**：后台子 agent 跑在父 pi 进程内，父进程退出即终止，不落盘恢复
- **单层嵌套**：子会话内无法再调用 subagent-lite
- **无断线恢复、无 steering、无结构化输出、无 watchdog**：有意裁剪，保持精简
- 子会话使用内存 SessionManager，不写入会话历史文件

## 开发

```bash
npm install        # 安装依赖
npm run typecheck  # tsc --noEmit
npm test           # node --test test/（全部假工厂注入，无真实模型调用）
```

## License

MIT
