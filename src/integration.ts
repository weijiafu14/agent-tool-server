/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host-side integration helpers — the thin "aspect" the host's tool dispatch and
 * hook-spawn paths call into. The whole point of this module is to keep the host
 * base files almost untouched: instead of inlining the forwarding logic into your
 * dispatch function, you call a few small functions from here. See docs/INTEGRATION.md
 * for exactly where the three call sites go.
 *
 * Design principle: the HOST is the single source of truth for ctx state. The
 * sandbox borrows state to execute and reports back "what changed" as data; the
 * host applies it with its own real functions. Closures never cross the wire.
 *  - buildCtxIn:  before forwarding, package the authoritative state the sandbox
 *                 needs (cwd / lightweight readFileState / fileReadingLimits / ...).
 *  - applyCtxDelta: after forwarding, apply the sandbox-reported changes (cwd /
 *                 readFileState set·delete / triggers / plan write) to the host ctx.
 * This keeps the host's validateInput ("has been read?" guard), compaction, and
 * memory reads all seeing one latest state — no host/sandbox divergence.
 */
import { writeFileSync as fsWriteFileSync, mkdirSync as fsMkdirSync } from 'node:fs'
import { dirname as pathDirname } from 'node:path'
import {
  getCwd,
  setCwdState,
  getPlanFilePath,
  type ToolUseContext,
  type ToolResult,
} from './base.js'
import { isRemoteMode } from './env.js'
import { SERVABLE_TOOLS, IDEMPOTENT_TOOLS, VALIDATE_FORWARD_TOOLS } from './servableTools.js'
import {
  callRemoteTool,
  callRemoteValidate,
  execRemoteHook,
  RemoteToolTransportError,
  type CtxIn,
  type CtxDelta,
} from './remoteClient.js'

export { isRemoteMode } from './env.js'
export { RemoteToolTransportError } from './remoteClient.js'

// ─────────────────────────────────────────────────────────────────────────
//  ctx state contract
// ─────────────────────────────────────────────────────────────────────────

/** Package the host's authoritative state to send into the sandbox before a forwarded call. */
export function buildCtxIn(ctx: ToolUseContext): CtxIn {
  const ctxIn: CtxIn = {}
  try { ctxIn.cwd = getCwd() } catch { /* ignore */ }
  // Lightweight readFileState: timestamp/isPartialView only (no content) → feeds the sandbox's "has been read?" guard + read dedup.
  try {
    const rfs = ctx.readFileState as unknown as {
      entries?: () => Iterable<[string, { timestamp: number; isPartialView?: boolean }]>
    }
    if (rfs && typeof rfs.entries === 'function') {
      const light: NonNullable<CtxIn['readFileState']> = {}
      for (const [path, v] of rfs.entries()) {
        light[path] = { timestamp: v.timestamp, isPartialView: v.isPartialView }
      }
      if (Object.keys(light).length) ctxIn.readFileState = light
    }
  } catch { /* ignore */ }
  if (ctx.fileReadingLimits) ctxIn.fileReadingLimits = ctx.fileReadingLimits
  // Natively, tool.call(input, {...toolUseContext}, ...) hands the whole context to the tool. Faithfully wire the pure-data fields a tool might read into the sandbox too.
  const c = ctx as unknown as {
    agentId?: string
    agentType?: string
    getAppState?: () => {
      toolPermissionContext?: {
        mode?: string
        alwaysAllowRules?: unknown
        alwaysDenyRules?: unknown
        additionalWorkingDirectories?: Map<string, unknown>
      }
    } | undefined
  }
  if (c.agentId) ctxIn.agentId = c.agentId
  if (c.agentType) ctxIn.agentType = c.agentType
  // A Bash tool's body reads toolPermissionContext.additionalWorkingDirectories to decide whether a cd left the project and, if so, reset the cwd.
  // The sandbox with empty permissions would misjudge a legitimate cd target as out-of-bounds → the host's real permissions must be sent in and rebuilt. The Map is serialized to entries.
  try {
    const pc = c.getAppState?.()?.toolPermissionContext
    if (pc) {
      ctxIn.toolPermissionContext = {
        mode: pc.mode,
        alwaysAllowRules: pc.alwaysAllowRules,
        alwaysDenyRules: pc.alwaysDenyRules,
        additionalWorkingDirectories:
          pc.additionalWorkingDirectories instanceof Map
            ? [...pc.additionalWorkingDirectories.entries()]
            : undefined,
      }
    }
  } catch { /* not fatal: the sandbox falls back to empty permissions, same as a host with no additionalWorkingDirectories */ }
  // Plan mode: the host-authoritative plan-file path is sent with ctxIn. When the
  // sandbox Write/Edit hits it, the written content is reported back via
  // ctxDelta.planFileWrite and the host mirrors it → the host's plan reads (approval
  // card / normalization / history) see it. Without it the real plan lives only in
  // the sandbox and the host reads empty. getPlanFilePath is lightweight (joins a
  // plans dir + slug) and safe outside plan mode.
  try {
    const pfp = getPlanFilePath(c.agentId)
    if (pfp) ctxIn.planFilePath = pfp
  } catch { /* not fatal: plan write-back degrades; the host still uses its original getPlan (reads empty, same as before wiring) */ }
  return ctxIn
}

/** Apply the sandbox-reported ctx changes to the host's authoritative ctx. */
export function applyCtxDelta(ctxDelta: CtxDelta | undefined, ctx: ToolUseContext): void {
  if (!ctxDelta) return
  // cwd: a Bash `cd` in the sandbox changed it → align the host via setCwdState (else later host relative paths / default Glob·Grep dir use the stale cwd).
  // Failure must be visible — otherwise the cwd is misaligned, later tools' relative paths are wrong, and there is no trace. Goes to stderr → the host log.
  try {
    if (ctxDelta.cwd) setCwdState(ctxDelta.cwd)
  } catch (e) {
    process.stderr.write(`[ctxdelta] setCwd FAIL: ${String((e as Error)?.message || e).slice(0, 120)}\n`)
  }
  // readFileState: apply the sandbox's set/delete to the host's authoritative cache (using the host's own set/delete).
  // Failure must be visible — otherwise the "has been read?" guard does not see this Read and Write/Edit re-raises "File has not been read yet".
  try {
    const rfs = ctx.readFileState as unknown as {
      set: (k: string, v: unknown) => unknown
      delete: (k: string) => unknown
    }
    if (rfs && Array.isArray(ctxDelta.readFileState)) {
      for (const op of ctxDelta.readFileState) {
        if (op.op === 'set') {
          // Defensive: value must be an object (readFileState entry shape); skip malformed entries rather than poisoning the "has been read?" cache.
          if (op.value && typeof op.value === 'object') rfs.set(op.path, op.value)
          else process.stderr.write(`[ctxdelta] skip malformed set path=${op.path}\n`)
        } else if (op.op === 'delete') rfs.delete(op.path)
      }
    }
  } catch (e) {
    process.stderr.write(`[ctxdelta] readFileState apply FAIL: ${String((e as Error)?.message || e).slice(0, 120)}\n`)
  }
  // nested-memory / dynamic-skill trigger paths → add to the host's own Sets, so the
  // next query's attachments inject the nested memory / dynamic skill (otherwise the
  // injection triggered by a forwarded Read/Write/Edit is lost across the process
  // boundary and the agent never sees the rules it should).
  try {
    const c = ctx as unknown as {
      nestedMemoryAttachmentTriggers?: Set<string>
      dynamicSkillDirTriggers?: Set<string>
    }
    if (Array.isArray(ctxDelta.nestedMemoryTriggers) && c.nestedMemoryAttachmentTriggers) {
      for (const p of ctxDelta.nestedMemoryTriggers) c.nestedMemoryAttachmentTriggers.add(p)
    }
    if (Array.isArray(ctxDelta.dynamicSkillTriggers) && c.dynamicSkillDirTriggers) {
      for (const p of ctxDelta.dynamicSkillTriggers) c.dynamicSkillDirTriggers.add(p)
    }
  } catch (e) {
    process.stderr.write(`[ctxdelta] triggers apply FAIL: ${String((e as Error)?.message || e).slice(0, 120)}\n`)
  }
  // Plan mode: the sandbox wrote the plan file (matched ctxIn.planFilePath) → its
  // content is reported back here, and the host mirrors it to the same absolute path
  // (paths line up: the sandbox mounts the workspace at the host cwd). Once landed,
  // the host's plan reads all see it → the plan-mode approval card has content and
  // execute has plan context. This is the root of plan mode working in remote mode.
  // Failure must be visible — otherwise the host plan file is missing, the approval card is empty, and there is no trace. Goes to stderr → the host log.
  try {
    const pfw = ctxDelta.planFileWrite
    if (pfw && typeof pfw.content === 'string') {
      // SECURITY: NEVER trust the path the sandbox reports. The sandbox is untrusted
      // (the agent could even tamper with the tool-server memory to forge the path),
      // so writing it directly with fsWriteFileSync = a path-traversal write to ANY
      // host file (overwrite ~/.ssh/authorized_keys, drop a cron job, modify git hooks
      // → host RCE). The host computes the authoritative plan path itself (same source
      // as the ctxIn.planFilePath it sent down: getPlanFilePath(agentId)) and only
      // takes the sandbox-reported content; pfw.path is discarded. If the reported path
      // disagrees with the authoritative one, log it (an attack signal, observable).
      const authPath = getPlanFilePath(
        (ctx as unknown as { agentId?: string }).agentId,
      )
      if (authPath) {
        if (typeof pfw.path === 'string' && pfw.path !== authPath) {
          process.stderr.write(
            `[ctxdelta] planFileWrite: sandbox-reported path disagrees with the authoritative path, discarded (suspected attack): got=${String(pfw.path).slice(0, 160)}\n`,
          )
        }
        fsMkdirSync(pathDirname(authPath), { recursive: true })
        fsWriteFileSync(authPath, pfw.content, { encoding: 'utf-8' })
      }
    }
  } catch (e) {
    process.stderr.write(`[ctxdelta] planFileWrite FAIL: ${String((e as Error)?.message || e).slice(0, 120)}\n`)
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  dispatch helpers — call these from your tool dispatch (see docs/INTEGRATION.md)
// ─────────────────────────────────────────────────────────────────────────

/** True when this tool's EXECUTION should be forwarded to the sandbox. */
export function shouldForwardTool(toolName: string): boolean {
  return isRemoteMode() && SERVABLE_TOOLS.has(toolName)
}

/** True when this tool's validateInput should be forwarded to the sandbox (real filesystem). */
export function shouldForwardValidate(toolName: string, tool: { validateInput?: unknown }): boolean {
  return isRemoteMode() && VALIDATE_FORWARD_TOOLS.has(toolName) && !!tool.validateInput
}

/** Result shape the host's validateInput contract expects. */
export type ValidateResult = { result?: boolean; message?: string; errorCode?: number }

/**
 * Forward a tool's validateInput into the sandbox (real filesystem). Call this
 * INSTEAD of `tool.validateInput(...)` when shouldForwardValidate is true; the
 * permission decision still happens on the host afterwards (control unchanged).
 * A transport/sandbox failure here returns `{ result: true }` (do not misjudge on
 * a sandbox flap — let the subsequent call() forwarding handle recovery).
 */
export async function forwardValidateInput(
  toolName: string,
  parsedInput: unknown,
  ctx: ToolUseContext,
  signal?: AbortSignal,
): Promise<ValidateResult> {
  try {
    const vCtxIn = buildCtxIn(ctx)
    const vr = await callRemoteValidate(toolName, parsedInput, vCtxIn, signal)
    return (vr?.output ?? { result: true }) as ValidateResult
  } catch (e) {
    if (e instanceof RemoteToolTransportError) {
      return { result: true }
    }
    throw e
  }
}

export interface ForwardToolCallArgs {
  toolName: string
  /** The final input after permission/hook processing (the same value you would pass to tool.call). */
  callInput: unknown
  ctx: ToolUseContext
  /** permissionDecision.userModified ?? false — faithfully forwarded so the sandbox tool sees the same value. */
  userModified: boolean
  /** Host abort signal (typically ctx.abortController?.signal). */
  signal?: AbortSignal
  /** Progress callback — wire it to your onToolProgress, e.g. data => onToolProgress({ toolUseID, data }). */
  onProgress: (data: unknown) => void
}

/**
 * Forward one tool EXECUTION to the sandbox, with crash-recovery retry. Call this
 * INSTEAD of `tool.call(...)` when shouldForwardTool is true.
 *
 * On a transport failure (sandbox crash; the orchestration proxy returns a
 * transport error for in-flight calls while rebuilding) an IDEMPOTENT tool is
 * auto-retried — once the proxy rebuilds the sandbox the retried request forwards
 * successfully, fully transparent to the agent/LLM. Non-idempotent tools (Bash /
 * Edit / ...) or non-transport errors are rethrown immediately so the agent decides
 * (never blindly retried, to avoid duplicating side effects).
 */
export async function forwardToolCall(args: ForwardToolCallArgs): Promise<ToolResult<unknown>> {
  const { toolName, callInput, ctx, userModified, signal, onProgress } = args
  let result: ToolResult<unknown>
  const maxAttempts = IDEMPOTENT_TOOLS.has(toolName) ? 3 : 1
  let attempt = 0
  for (;;) {
    attempt++
    // abort red line: check before each remote call — if aborted, throw; NEVER replay a (retried) Write/Edit into a new sandbox.
    if (signal?.aborted) {
      throw new RemoteToolTransportError(`${toolName} aborted before forwarding; stopping`)
    }
    try {
      // ctx state contract: send ctxIn (cwd/readFileState/limits) into the sandbox; the abort signal lets a host interrupt terminate the sandbox-side execution.
      const ctxIn = buildCtxIn(ctx)
      ctxIn.userModified = userModified
      const { output, ctxDelta, newMessages } = await callRemoteTool(
        toolName,
        callInput,
        ctxIn,
        onProgress,
        signal,
      )
      // newMessages from the sandbox (e.g. an image message from a Read of a PDF/image) are merged into the result so the host advances the conversation and the agent sees the content.
      result = (newMessages && newMessages.length
        ? { data: output, newMessages }
        : { data: output }) as ToolResult<unknown>
      // The sandbox-reported ctxDelta (cwd / readFileState changes) → applied with the host's real functions, keeping host authority consistent:
      //   the host's validateInput ("has been read?" guard), compaction, and memory all read this → no more "File has not been read yet".
      applyCtxDelta(ctxDelta, ctx)
      break
    } catch (remoteErr) {
      const transport = remoteErr instanceof RemoteToolTransportError
      const m = (remoteErr as Error)?.message || String(remoteErr)
      // abort red line: after an interrupt NEVER retry (else a Write/Edit replays into the rebuilt sandbox, duplicating side effects).
      if (signal?.aborted) {
        process.stderr.write(`[remote-retry] ${toolName} ABORTED -> not retrying, throwing to agent\n`)
        throw remoteErr
      }
      if (transport && attempt < maxAttempts) {
        process.stderr.write(`[remote-retry] ${toolName} attempt=${attempt}/${maxAttempts} transport-fail, backoff ${1500 * attempt}ms: ${m.slice(0, 160)}\n`)
        // Watch for abort during backoff: an interrupt settles immediately and the top-of-loop abort check throws (no waiting out the full backoff).
        // On a normal timeout settle, removeEventListener avoids accumulating listeners on the turn-level signal (across many flap retries).
        await new Promise<void>(resolve => {
          let t: ReturnType<typeof setTimeout>
          const onAbort = () => { clearTimeout(t); resolve() }
          t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 1500 * attempt)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
        continue
      }
      // Give up (non-idempotent tried once / idempotent exhausted / non-transport error) → throw to the agent. Log it so debugging knows this was a forwarding give-up, not the tool itself erroring.
      process.stderr.write(`[remote-retry] ${toolName} GIVE-UP attempt=${attempt}/${maxAttempts} ${transport ? 'transport' : 'biz'} -> throw to agent: ${m.slice(0, 160)}\n`)
      throw remoteErr
    }
  }
  return result
}

// ─────────────────────────────────────────────────────────────────────────
//  hook forwarding — call from your command-hook spawn site (see docs/INTEGRATION.md)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Env keys whose name contains any of these are stripped before a hook's env is
 * sent into the (untrusted) sandbox — a blacklist backstop so credentials that
 * happen to start with the allowed CLAUDE_ prefix (e.g. CLAUDE_*_TOKEN /
 * *_OAUTH_*) still never travel. Mirrors the allowlist+blacklist approach used
 * for env sanitization elsewhere on the host.
 */
const SENSITIVE_ENV_KEY = /(KEY|TOKEN|SECRET|OAUTH|CERT|PASS|CRED|AUTH|BEARER|INGRESS)/i

/**
 * Filter the host's assembled hook env down to what is safe to send into the
 * sandbox: the CLAUDE_ prefix only (the hook env convention), excluding
 * CLAUDE_ENV_FILE (a host-home path that would not line up with the sandbox) and
 * CLAUDE_PLUGIN_OPTION_* (may carry sensitive plugin config), with the sensitive
 * blacklist as a backstop. Host system env / credentials never travel.
 */
export function buildHookEnv(envVars: Record<string, unknown>): Record<string, string> {
  const hookEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(envVars)) {
    if (
      k.startsWith('CLAUDE_') &&
      k !== 'CLAUDE_ENV_FILE' &&
      !k.startsWith('CLAUDE_PLUGIN_OPTION_') &&
      !SENSITIVE_ENV_KEY.test(k) &&
      v != null
    ) {
      hookEnv[k] = String(v)
    }
  }
  return hookEnv
}

export interface CommandHookForwardArgs {
  command: string
  /** The hook input (host already assembled the JSON + a trailing newline). */
  stdin: string
  /** The full env the host assembled for the hook; this fn filters it via buildHookEnv. */
  envVars: Record<string, unknown>
  cwd: string
  shell: 'bash' | 'powershell'
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Forward a command hook's EXECUTION into the sandbox. Call this from your hook
 * spawn site when isRemoteMode() is true, INSTEAD of spawning the hook on the host;
 * return its result directly (the shape matches a native spawn: output = stdout,
 * status = exitCode), so the host's parseHookOutput / exit-2-block decisions are
 * byte-for-byte unchanged. Control stays on the host; only the exec moves.
 */
export async function forwardCommandHook(
  args: CommandHookForwardArgs,
): Promise<{ stdout: string; stderr: string; output: string; status: number }> {
  const hookEnv = buildHookEnv(args.envVars)
  const r = await execRemoteHook(
    {
      command: args.command,
      stdin: args.stdin,
      env: hookEnv,
      cwd: args.cwd,
      shell: args.shell,
      timeoutMs: args.timeoutMs,
    },
    args.signal,
  )
  return { stdout: r.stdout, stderr: r.stderr, output: r.stdout, status: r.exitCode }
}
