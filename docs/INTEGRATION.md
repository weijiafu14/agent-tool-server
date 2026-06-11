# Integration

You integrate this package by editing **one wiring file** and adding **three call
sites** in your base. The call sites are described as *semantic anchors* — "the
point in your code where X happens" — and the code you insert is entirely from
this package. There are no diffs against any base here; you locate the anchor in
your own runtime and drop the call in.

> All four edits are gated on remote mode. With `REMOTE_TOOLS_URL` unset, every
> helper short-circuits to the native path, so an integrated base behaves
> byte-for-byte as before until you turn forwarding on.

## 0. Wire `src/base.ts` (the one coupling file)

`base.ts` is the only file that touches your base runtime. It declares the
structural types the package needs and re-exports a set of runtime functions.
Out of the box those functions are stubs that throw. Repoint each one at the
matching module in your base tree, e.g.:

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

If your base already exports the types (`ToolUseContext`, `ToolResult`, `Tool`,
`Tools`, …), you may re-export those too and delete the local definitions. The
local types are deliberately loose so a richer base type stays assignable.

## 1. The `--tool-server` entrypoint (sandbox mode)

**Anchor:** your CLI's argv dispatch, where it decides which mode to run (next to
your other `--flag` subcommands).

```ts
if (process.argv[2] === '--tool-server') {
  const { runToolServer } = await import('agent-tool-server/sandbox')
  await runToolServer(process.argv.slice(3))   // pass `--port N` for the WebSocket transport
  return
}
```

The same binary now runs in execution-only mode when launched with
`--tool-server`. This is what your sandbox image's entrypoint invokes.

## 2. Tool dispatch (host mode)

**Anchor A — validateInput.** The point where your dispatch calls
`tool.validateInput(...)` (after zod parsing, before the permission decision).
Wrap it:

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

The permission decision after this is unchanged — control stays on the host.

**Anchor B — execution.** The point where your dispatch calls `tool.call(...)`
(after permission/hook approval, with the final input). Wrap it:

```ts
import { shouldForwardTool, forwardToolCall } from 'agent-tool-server/host/integration'

let result
if (shouldForwardTool(tool.name)) {
  result = await forwardToolCall({
    toolName: tool.name,
    callInput,                                   // your final, post-approval input
    ctx: toolUseContext,
    userModified: permissionDecision.userModified ?? false,
    signal: toolUseContext.abortController?.signal,
    onProgress: data => onToolProgress({ toolUseID, data }),
  })
} else {
  result = await tool.call(/* ...your existing native call... */)
}
```

`forwardToolCall` handles the `ctxIn`/`ctxDelta` contract, crash-recovery retry
for idempotent tools, and abort. The `else` branch is your original code, untouched.

## 3. Command-hook spawn (host mode)

**Anchor:** the single point in your hook runner where a `command`-type hook is
about to be spawned on the host (you have already assembled the final command,
the stdin JSON, the hook env, and a safe cwd). Insert *before* the spawn:

```ts
import { isRemoteMode, forwardCommandHook } from 'agent-tool-server/host/integration'

if (isRemoteMode()) {
  return await forwardCommandHook({
    command: finalCommand,
    stdin: jsonInput + '\n',
    envVars,                  // your assembled hook env; forwardCommandHook filters it
    cwd: safeCwd,
    shell: isPowerShell ? 'powershell' : 'bash',
    timeoutMs: hookTimeoutMs,
    signal,
  })
  // shape matches a native spawn (output = stdout, status = exitCode), so your
  // parseHookOutput / exit-2-block logic downstream is unchanged.
}
// ...your existing native spawn path continues here...
```

Only `command`-type hooks reach this anchor; prompt/agent/http/callback hooks go
through their own host paths and are never forwarded. `forwardCommandHook` strips
everything but the safe `CLAUDE_*` hook env before it crosses into the sandbox —
see [SECURITY.md](SECURITY.md).

## Environment

| Var | Meaning |
|-----|---------|
| `REMOTE_TOOLS_URL` | forwarding transport. Unset = native in-process (zero overhead). `stdio` self-spawns the tool-server; `stdio:<cmd...>` spawns a given command; `ws://` / `wss://` connects to a sandbox. |
| `REMOTE_CALL_TIMEOUT_MS` | fallback per-call timeout (default 15min; `<=0` disables). |

Legacy aliases `LEGACY_REMOTE_TOOLS_URL` / `LEGACY_REMOTE_CALL_TIMEOUT_MS` are
still read as fallbacks (see `src/env.ts`). The tool-server process also sets
`TOOL_SERVER_MODE=1` (and the legacy `LEGACY_TOOL_SERVER=1`) so your shell
provider can detect execution-only mode and `cd` to the authoritative cwd before
each command.
