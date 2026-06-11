# 接入

[English](INTEGRATION.md) · **简体中文**

接入本包需要改**一个接线文件**，并在你的基座里加**三个接入点**。接入点用*语义锚点*
描述——"你代码里发生 X 的那个位置"——而你插入的代码全部来自本包。这里没有任何针对
基座的 diff；你在自己的运行时里找到锚点、把调用放进去即可。

> 四处改动全部受远程模式 gate。不设 `REMOTE_TOOLS_URL` 时，每个 helper 都短路回原生
> 路径，所以接入后的基座在你开启转发之前行为逐字节不变。

## 0. 接线 `src/base.ts`（唯一耦合文件）

`base.ts` 是唯一触碰你基座运行时的文件。它声明本包需要的结构化类型，并 re-export 一组
运行时函数。开箱即用时这些函数是会抛错的 stub。把每一个重新指向你基座树里对应的模块，
例如：

```ts
export { getAllBaseTools }            from '../tools.js'
export { findToolByName }             from '../Tool.js'
export { enableConfigs }              from '../utils/config.js'
export { getCwd }                     from '../utils/cwd.js'
export { getCwdState, setCwdState }   from '../bootstrap/state.js'
export { getPlanFilePath }            from '../utils/plans.js'
export { getDefaultAppState }         from '../state/AppStateStore.js'
export { createAbortController }      from '../utils/abortController.js'
export { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
export { createAssistantMessage }     from '../utils/messages.js'
export { getMainLoopModel }           from '../utils/model/model.js'
export { enqueuePendingNotification, setNotificationEmitter } from '../utils/messageQueueManager.js'
```

如果你的基座已经导出了这些类型（`ToolUseContext`、`ToolResult`、`Tool`、`Tools` 等），
也可以一并 re-export 并删掉本地定义。本地类型故意写得很宽松，这样更丰富的基座类型仍能
赋值兼容。

## 1. `--tool-server` 入口（沙箱模式）

**锚点：** 你 CLI 的 argv 分发处，也就是它决定跑哪个模式的地方（挨着你其它的 `--flag`
子命令）。

```ts
if (process.argv[2] === '--tool-server') {
  const { runToolServer } = await import('agent-tool-server/sandbox')
  await runToolServer(process.argv.slice(3))   // 走 WebSocket 传输就传 `--port N`
  return
}
```

同一份 binary 现在用 `--tool-server` 启动时进入纯执行模式。这就是你沙箱镜像入口要调用的。

## 2. 工具 dispatch（host 模式）

**锚点 A —— validateInput。** 你 dispatch 调用 `tool.validateInput(...)` 的位置（zod
解析之后、权限决策之前）。把它包起来：

```ts
import { shouldForwardValidate, forwardValidateInput } from 'agent-tool-server/host/integration'

let isValidCall
if (shouldForwardValidate(tool.name, tool)) {
  isValidCall = await forwardValidateInput(
    tool.name, parsedInput.data, toolUseContext,
    toolUseContext.abortController?.signal,
  )
} else {
  isValidCall = await tool.validateInput?.(parsedInput.data, toolUseContext)
}
```

这之后的权限决策不变——控制留在 host。

**锚点 B —— 执行。** 你 dispatch 调用 `tool.call(...)` 的位置（权限/hook 审批之后，带
最终输入）。把它包起来：

```ts
import { shouldForwardTool, forwardToolCall } from 'agent-tool-server/host/integration'

let result
if (shouldForwardTool(tool.name)) {
  result = await forwardToolCall({
    toolName: tool.name,
    callInput,                                   // 你审批后的最终输入
    ctx: toolUseContext,
    userModified: permissionDecision.userModified ?? false,
    signal: toolUseContext.abortController?.signal,
    onProgress: data => onToolProgress({ toolUseID, data }),
  })
} else {
  result = await tool.call(/* ...你现有的原生调用... */)
}
```

`forwardToolCall` 负责 `ctxIn`/`ctxDelta` 契约、幂等工具的崩溃恢复重试、以及 abort。
`else` 分支就是你的原代码，原封不动。

## 3. command hook 的 spawn 处（host 模式）

**锚点：** 你 hook 执行器里、准备在 host 上 spawn 一个 `command` 类型 hook 的那唯一一个
位置（此时你已经组好了最终命令、stdin JSON、hook env、安全 cwd）。在 spawn *之前*插入：

```ts
import { isRemoteMode, forwardCommandHook } from 'agent-tool-server/host/integration'

if (isRemoteMode()) {
  return await forwardCommandHook({
    command: finalCommand,
    stdin: jsonInput + '\n',
    envVars,                  // 你组好的 hook env；forwardCommandHook 会过滤它
    cwd: safeCwd,
    shell: isPowerShell ? 'powershell' : 'bash',
    timeoutMs: hookTimeoutMs,
    signal,
  })
  // 返回结构与原生 spawn 一致（output = stdout，status = exitCode），所以你下游的
  // parseHookOutput / exit-2-block 逻辑不变。
}
// ...你现有的原生 spawn 路径接在这里...
```

只有 `command` 类型 hook 会到达这个锚点；prompt/agent/http/callback hook 走各自的 host
路径、永不转发。`forwardCommandHook` 在跨进沙箱前会把除安全 `CLAUDE_*` hook env 之外的
一切都剥掉——见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 环境变量

| 变量 | 含义 |
|------|------|
| `REMOTE_TOOLS_URL` | 转发传输。不设 = 原生进程内执行（零开销）。`stdio` 自启 tool-server；`stdio:<cmd...>` spawn 指定命令；`ws://` / `wss://` 连沙箱。 |
| `REMOTE_CALL_TIMEOUT_MS` | 兜底的单次调用超时（默认 15 分钟；`<=0` 关闭）。 |

旧别名 `LEGACY_REMOTE_TOOLS_URL` / `LEGACY_REMOTE_CALL_TIMEOUT_MS` 仍作为回退读取（见
`src/env.ts`）。tool-server 进程还会设 `TOOL_SERVER_MODE=1`（以及旧的 `LEGACY_TOOL_SERVER=1`），
让你的 shell provider 能识别"纯执行模式"，从而在每条命令前 `cd` 到权威 cwd。
