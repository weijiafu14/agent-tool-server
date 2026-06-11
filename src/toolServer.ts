/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * tool-server mode — the "Hands" side of the split-brain architecture (see
 * docs/PROTOCOL.md). It does NOT run the agent loop and needs NO LLM
 * credentials: it receives {id,name,input}, runs the base's NATIVE tool
 * implementation, and returns the result.
 *
 * Same binary: the host runs agent mode (loop + session + key), the sandbox runs
 * this mode → tool behavior is byte-for-byte identical, with no rewrite, no
 * chatty RPC, and recoverable control.
 *
 * Protocol (JSON, one frame per line):
 *   Recv: { id, name, input }
 *   Send: { id, ok:true, output } | { id, ok:false, error:{code,message} }
 *   Streaming (Bash): { id, type:'progress', data } ... then a final { id, ok, output }
 *
 * Two transports, one handleRequest:
 *   - stdio        local: line-delimited JSON (simplest for two local agents).
 *   - --port N(WS) sandbox: Bun.serve hosts a WebSocket; the sandbox exposes that
 *                  port → the host holds a persistent connection (PROTOCOL.md:
 *                  use WS, not HTTP keepalive).
 *
 * Modeled on a base's non-interactive tool executor (the same "no agent loop,
 * just run tools" entrypoint used for MCP-style tool serving).
 */
import { spawn } from 'node:child_process'
import * as readline from 'node:readline'
import { readFileSync as fsReadFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import {
  getDefaultAppState,
  findToolByName,
  getAllBaseTools,
  enableConfigs,
  createAbortController,
  createFileStateCacheWithSizeLimit,
  createAssistantMessage,
  getMainLoopModel,
  getCwdState,
  setCwdState,
  setNotificationEmitter,
  type ToolResult,
  type ToolUseContext,
  type Tools,
} from './base.js'
import { markToolServerProcess } from './env.js'
import { SERVABLE_TOOLS } from './servableTools.js'
import type { CtxIn, CtxDelta } from './remoteClient.js'

// The servable-tool whitelist lives in ./servableTools.ts — the host-side
// dispatch interceptor and this side share one copy.

const READ_FILE_STATE_CACHE_SIZE = 200

// The tool-server's currently-active WS connection (the proxy's). When a
// background task (a long-running shell) finishes asynchronously, a
// task-notification is pushed back to the host over this connection. Module-level
// because completion fires in an async callback outside the message handler.
let toolServerActiveWs: { send: (s: string) => void } | null = null

type Req = { id: string; name: string; input: unknown; ctxIn?: CtxIn; validateOnly?: boolean }
type Control = { type: 'control'; op?: string; id?: string; backgroundTaskId?: string }
/** Hook-exec frame (forward a command-type hook into the sandbox to spawn a shell). Not a tool; never goes through findToolByName / whitelist. */
type HookExecReq = {
  id: string
  type: 'hook-exec'
  command: string
  stdin?: string
  env?: Record<string, string>
  cwd?: string
  shell?: 'bash' | 'powershell'
  timeoutMs?: number
}
type Send = (obj: unknown) => void

// Process-level: AbortControllers for in-flight tool calls (keyed by request id), so the host's abort control frame can interrupt them.
const inflight = new Map<string, { abort: () => void }>()

/**
 * Sandbox-side diagnostic log → console.error → pod stderr (retrievable from the
 * sandbox platform's logs, but lost once the sandbox is disposed). So a KEY
 * failure ALSO carries a diag field back in the response frame (the host logs it,
 * and debugging does not require fetching the pod stderr).
 */
function tlog(msg: string): void {
  try {
    // eslint-disable-next-line no-console
    console.error(`[tool-server] ${msg}`)
  } catch {
    /* logging must not affect the main path */
  }
}

/**
 * Handle a control frame (abort / ping).
 * - abort: host interrupt → terminate the matching in-flight tool call (the sandbox aborts the real running process).
 * - ping (host heartbeat): reply with a pong frame to create traffic in the
 *   sandbox→host direction, defeating an idle timeout on the ingress/proxy.
 *   A host→sandbox-only ping cannot defeat a DIRECTION-level idle timeout: when a
 *   turn is idle (e.g. plan mode awaiting approval) there is no return traffic and
 *   the connection is dropped, causing repeated reconnects. A pong gives both
 *   directions traffic. Not logged (too frequent). The proxy treats an inbound
 *   pong as a control frame with no id → ignored, never forwarded to the agent.
 */
function handleControl(ctrl: Control, send?: Send): void {
  if (ctrl.op === 'abort' && ctrl.id) {
    tlog(`control abort id=${ctrl.id}${inflight.has(ctrl.id) ? '' : ' (not in-flight)'}`)
    try { inflight.get(ctrl.id)?.abort() } catch { /* interrupt is best-effort */ }
    return
  }
  if (ctrl.op === 'ping' && send) {
    try { send({ type: 'control', op: 'pong' }) } catch { /* keepalive is best-effort; failure surfaces via connection close → crash recovery */ }
  }
}

/**
 * Execute a command hook (the host forwards a command-type hook's exec here to
 * run it in the sandbox).
 * NOT a tool — never goes through findToolByName / SERVABLE_TOOLS; just a "spawn a
 * shell in the sandbox" transport frame the agent/LLM never sees. Control (matcher
 * / parseHookOutput / decision) stays on the host; this is pure execution + result.
 * env: the sandbox's own process.env as the base, merged with the host-supplied
 * hook-specific env (host system env / credentials never travel).
 * abort: registered in inflight, so the host's abort control frame kills this hook
 * process by id (same as tools).
 * The response reuses the tool's { id, ok, output } shape (output = { stdout, stderr, exitCode }), so the host remoteClient needs no change.
 */
async function handleHookExec(req: HookExecReq, send: Send): Promise<void> {
  const { id, command, stdin = '', env, cwd, shell, timeoutMs } = req
  const t0 = Date.now()
  tlog(`<- hook id=${id} cmd=${command.slice(0, 60)}`)
  try {
    const spawnEnv = { ...process.env, ...(env || {}) }
    // detached:true → the child becomes a process-group leader, so kill targets the
    // WHOLE group (including grandchildren the shell forked). Otherwise SIGKILL only
    // kills /bin/sh and a backgrounded grandchild (e.g. `yes &`) keeps the stdout
    // write fd open → the child's 'close' never fires → handleHookExec hangs +
    // inflight leaks + the OOM safeguard is bypassed (the grandchild keeps eating
    // sandbox memory).
    const child =
      shell === 'powershell'
        ? spawn('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
            cwd: cwd || undefined,
            env: spawnEnv,
            detached: true,
          })
        : // shell:true → /bin/sh -c command, same semantics as the host's bash hook spawn.
          spawn(command, [], { shell: true, cwd: cwd || undefined, env: spawnEnv, detached: true })
    // Kill the whole process group (detached → negative pid); fall back to killing just the child if no pid.
    // exited guard: after 'close', child.pid may be recycled to another process group by the kernel; if an abort
    // arrives in the tiny "exited → settle" window, process.kill(-pid) could in theory hit the recycled pgid.
    // If the child already exited, no-op (in-sandbox; ESRCH is caught anyway, but the guard is cleaner).
    let exited = false
    const killGroup = (): void => {
      if (exited) return
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* best-effort */ }
      }
    }
    let settled = false
    let resolveExit: (code: number) => void = () => {}
    let killGraceTimer: ReturnType<typeof setTimeout> | null = null
    // Backstop: if 'close' still does not arrive after killing the group (extreme:
    // a lingering process holding an unreleased fd), a local grace timeout force-settles,
    // so handleHookExec cannot hang and inflight cannot leak.
    const armKillGrace = (): void => {
      if (killGraceTimer) return
      killGraceTimer = setTimeout(() => {
        tlog(`-> hook id=${id} close did not arrive (suspect lingering process holding fd); force-settle exit=137`)
        resolveExit(137)
      }, 3000)
      if (typeof killGraceTimer?.unref === 'function') killGraceTimer.unref()
    }
    inflight.set(id, { abort: () => { killGroup(); armKillGrace() } })
    // Guard a hook that floods output (infinite echo / cat a huge file) from blowing
    // out sandbox memory: cap stdout/stderr at 10MB each (counted in UTF-8 bytes);
    // over the cap, stop accumulating and kill the group. truncatedOut/truncatedErr
    // are SEPARATE flags; the truncation marker NEVER mixes into the content body
    // (otherwise a stderr overflow would corrupt the otherwise-valid stdout JSON →
    // the host's parseHookOutput fails to parse → a block/deny is silently swallowed
    // → fail-open). It is carried back via the response frame's truncated field instead.
    const MAX_HOOK_OUTPUT = 10 * 1024 * 1024
    let stdout = '', stderr = '', outBytes = 0, errBytes = 0
    let truncatedOut = false, truncatedErr = false
    const capture = (d: string, which: 'out' | 'err'): void => {
      if (which === 'out') {
        if (outBytes >= MAX_HOOK_OUTPUT) {
          if (!truncatedOut) { truncatedOut = true; tlog(`-> hook id=${id} STDOUT-OVERFLOW >${MAX_HOOK_OUTPUT}B -> kill`); killGroup(); armKillGrace() }
          return
        }
        outBytes += Buffer.byteLength(d, 'utf8'); stdout += d
      } else {
        if (errBytes >= MAX_HOOK_OUTPUT) {
          if (!truncatedErr) { truncatedErr = true; tlog(`-> hook id=${id} STDERR-OVERFLOW >${MAX_HOOK_OUTPUT}B -> kill`); killGroup(); armKillGrace() }
          return
        }
        errBytes += Buffer.byteLength(d, 'utf8'); stderr += d
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', d => capture(d, 'out'))
    child.stderr?.on('data', d => capture(d, 'err'))
    // Feed stdin (the host already assembled the hook input JSON + newline), then end —
    // interactive requestPrompt is unsupported (the hook reads EOF).
    try {
      child.stdin?.write(stdin)
      child.stdin?.end()
    } catch { /* ignore if stdin is not writable */ }
    let timedOut = false
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            tlog(`-> hook id=${id} TIMEOUT after ${timeoutMs}ms -> kill`)
            killGroup(); armKillGrace()
          }, timeoutMs)
        : null
    const exitCode: number = await new Promise<number>(resolve => {
      resolveExit = (code: number) => { if (!settled) { settled = true; resolve(code) } }
      // When killed by signal (SIGKILL), close's code=null → use 137 (the kill-by-signal convention), distinct from a normal exit.
      child.on('close', code => { exited = true; resolveExit(code == null ? 137 : code) })
      // spawn failure (command missing / no permission) → return 127 (shell convention) + log, distinct from "command exited 1", to avoid confusion when debugging.
      child.on('error', e => {
        tlog(`-> hook id=${id} SPAWN-ERROR ${String((e as Error)?.message || e).slice(0, 120)}`)
        resolveExit(127)
      })
    })
    if (timer) clearTimeout(timer)
    if (killGraceTimer) clearTimeout(killGraceTimer)
    const truncated = truncatedOut || truncatedErr
    tlog(`-> hook id=${id} exit=${exitCode} ms=${Date.now() - t0} out=${outBytes}B err=${errBytes}B${timedOut ? ' (TIMED-OUT)' : ''}${truncated ? ` (TRUNCATED out=${truncatedOut} err=${truncatedErr})` : ''}`)
    // truncated goes at the frame TOP LEVEL (alongside ctxDelta/newMessages) so the
    // host's remoteClient surfaces it in the hook log (visible without digging into
    // the sandbox pod); it does NOT pollute the stdout/stderr content body.
    send({ id, ok: true, output: { stdout, stderr, exitCode }, ...(truncated ? { truncated: { stdout: truncatedOut, stderr: truncatedErr } } : {}) })
  } catch (err: unknown) {
    const e = err as { message?: string; stack?: string }
    const diag = (e?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 300)
    tlog(`-> hook id=${id} FAIL ${String(e?.message ?? err).slice(0, 160)}`)
    send({ id, ok: false, error: { code: 'HOOK_EXEC_ERROR', message: String(e?.message ?? err), diag } })
  } finally {
    inflight.delete(id)
  }
}

export async function runToolServer(argv: string[]): Promise<void> {
  // Mark this process as a tool-server (execution-only): the base's shell provider
  // uses this to `cd` to the authoritative cwd before each Bash command (the
  // process cwd is the image WORKDIR, and a persistent shell inheriting it would
  // drift from the host's authoritative cwd). The host / CLI mode does not set this
  // env, so Bash there is unaffected.
  markToolServerProcess()
  // The tool-server is routed to before the base's main initialization runs
  // enableConfigs(), so it must enable config reads itself first — otherwise
  // buildBaseContext → getMainLoopModel()/getDefaultAppState() throw
  // "Config accessed before allowed" (the root cause of a crashloop in a bare
  // environment / sandbox). enableConfigs is idempotent and creates defaults when
  // no config exists, so it is safe.
  enableConfigs()
  const tools = getAllBaseTools()

  // Persistent state: shared across the tool-server's whole lifetime (stdio / WS
  // both use one copy). Crucially, readFileState must persist across requests — a
  // remote Read writes the cache so a later remote Edit/Write's "has been read?"
  // check passes within the same process (the host keeps its own readFileState for
  // freshness; see PROTOCOL.md control/execution split).
  const readFileState = createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)
  let appState = getDefaultAppState()
  const baseContext = buildBaseContext(
    tools,
    readFileState,
    () => appState,
    f => {
      appState = f(appState)
    },
  )

  const portIdx = argv.indexOf('--port')
  if (portIdx >= 0) {
    const port = Number(argv[portIdx + 1])
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`--port needs a port number, got: ${argv[portIdx + 1]}`)
    }
    runWsServer(port, tools, baseContext)
    return
  }

  // stdio: line-delimited JSON request → line-delimited JSON response. Concurrent requests each process asynchronously (a long Bash does not block other reads).
  const rl = readline.createInterface({ input: process.stdin })
  const send: Send = obj => process.stdout.write(JSON.stringify(obj) + '\n')
  for await (const line of rl) {
    if (!line.trim()) continue
    let msg: Req | Control | HookExecReq
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if ((msg as Control).type === 'control') { handleControl(msg as Control, send); continue }
    if ((msg as HookExecReq).type === 'hook-exec') { void handleHookExec(msg as HookExecReq, send); continue }
    void handleRequest(tools, baseContext, msg as Req, send)
  }
}

/**
 * Production entrypoint: WebSocket. The sandbox exposes the port → the platform
 * maps it to a URL → the host holds one persistent WS for all tools (PROTOCOL.md).
 * Each WS text frame = one {id,name,input} request; responses/progress are pushed
 * back via ws.send. Health check: a non-upgrade GET returns 200 (for readiness probes).
 */
function runWsServer(port: number, tools: Tools, baseContext: ToolUseContext): void {
  // Bun.serve: a native WS server (no extra dependency). The --port path therefore
  // requires the Bun runtime; the stdio path works on plain Node.
  const server = (globalThis as { Bun?: { serve: (o: unknown) => { port: number } } }).Bun?.serve({
    port,
    fetch(req: Request, srv: { upgrade: (r: Request) => boolean }) {
      if (srv.upgrade(req)) return undefined // upgraded to WS; subsequent traffic via websocket.message
      return new Response('tool-server ok', { status: 200 })
    },
    websocket: {
      message(ws: { send: (s: string) => void }, message: string | Uint8Array) {
        toolServerActiveWs = ws // remember the current connection, for pushing a notify frame when a background task finishes
        let msg: Req | Control | HookExecReq
        try {
          msg = JSON.parse(typeof message === 'string' ? message : Buffer.from(message).toString())
        } catch {
          return
        }
        if ((msg as Control).type === 'control') { handleControl(msg as Control, obj => ws.send(JSON.stringify(obj))); return }
        if ((msg as HookExecReq).type === 'hook-exec') { void handleHookExec(msg as HookExecReq, obj => ws.send(JSON.stringify(obj))); return }
        void handleRequest(tools, baseContext, msg as Req, obj => ws.send(JSON.stringify(obj)))
      },
    },
  })
  if (!server) throw new Error('tool-server --port requires the Bun runtime (Bun.serve)')
  // A finished background task's (run_in_background) task-notification: the sandbox
  // has no agent loop to consume the local queue, so push a {type:'notify'} frame
  // back to the host (the proxy passes it through → host enqueuePendingNotification
  // → agent loop consumes it natively). On the host the emitter stays null (no effect
  // in non-remote mode). If the connection is down / the turn already ended, send is
  // swallowed (a background task finishing across turns is a known boundary).
  setNotificationEmitter(command => {
    const c = command as { agentId?: string; mode?: string }
    if (!toolServerActiveWs) {
      // No active connection = the turn that started it has ended (cross-turn boundary): the notification has nowhere to go; log it to debug "where did the notification go".
      tlog(`-> notify DROP (no active connection; turn ended / cross-turn boundary) mode=${c?.mode} agentId=${c?.agentId ?? 'main'}`)
      return
    }
    try {
      toolServerActiveWs.send(JSON.stringify({ type: 'notify', command }))
      tlog(`-> notify (background task done → push frame to host) mode=${c?.mode} agentId=${c?.agentId ?? 'main'}`)
    } catch (e) {
      tlog(`-> notify FAIL ${String((e as Error)?.message || e).slice(0, 80)}`)
    }
  })
  // eslint-disable-next-line no-console
  console.error(`[tool-server] WS listening on :${server.port}`)
}

async function handleRequest(
  tools: Tools,
  baseContext: ToolUseContext,
  req: Req,
  send: Send,
): Promise<void> {
  const { id, name, input, ctxIn } = req
  const t0 = Date.now()
  // Log key inbound data (so a problem can be traced to exactly what the host sent): cwd / agentId / permission-dir count / userModified.
  tlog(
    `<- tool ${name} id=${id}` +
      (ctxIn?.cwd ? ` cwd=${ctxIn.cwd}` : '') +
      (ctxIn?.agentId ? ` agent=${ctxIn.agentId}` : '') +
      (ctxIn?.toolPermissionContext?.additionalWorkingDirectories?.length
        ? ` permDirs=${ctxIn.toolPermissionContext.additionalWorkingDirectories.length}`
        : '') +
      (ctxIn?.userModified ? ' userModified' : ''),
  )
  if (!SERVABLE_TOOLS.has(name)) {
    tlog(`-> tool ${name} id=${id} REJECT NOT_SERVABLE`)
    send({
      id,
      ok: false,
      error: { code: 'NOT_SERVABLE', message: `${name} is host-only, not proxied` },
    })
    return
  }
  const tool = findToolByName(tools, name)
  if (!tool) {
    tlog(`-> tool ${name} id=${id} REJECT UNKNOWN_TOOL`)
    send({ id, ok: false, error: { code: 'UNKNOWN_TOOL', message: name } })
    return
  }

  // ── Apply the host-supplied authoritative state (ctxIn) to the sandbox execution environment ──
  // cwd: align with the host. Otherwise relative paths / the default Glob·Grep directory resolve against the sandbox's own cwd state, diverging from the host.
  if (ctxIn?.cwd) {
    try {
      setCwdState(ctxIn.cwd)
      // The tool-server process cwd defaults to the image WORKDIR; a persistent Bash
      // shell inherits it → drifts from the host's authoritative cwd (Read/Glob use
      // getCwd()=cwd state and are unaffected, but a Bash-spawned subshell lands in
      // the WORKDIR, so relative paths / pwd are wrong). process.chdir aligns the
      // process cwd with the host so a newly-spawned shell starts correctly; an
      // already-spawned shell is covered by the shell provider's per-command cd.
      try { process.chdir(ctxIn.cwd) } catch (e2) { tlog(`<- tool ${name} id=${id} ctxIn chdir FAIL ${String((e2 as Error)?.message || e2).slice(0, 80)}`) }
    } catch (e) { tlog(`<- tool ${name} id=${id} ctxIn setCwd FAIL ${String((e as Error)?.message || e).slice(0, 80)}`) }
  }
  // readFileState: seed the host's known "reads" into the sandbox cache (lightweight, no content), so the "has been read?" guard + read dedup can see them.
  if (ctxIn?.readFileState) {
    for (const [p, v] of Object.entries(ctxIn.readFileState)) {
      const existing = baseContext.readFileState.get(p) as
        | { content?: string; offset?: number; limit?: number | undefined; isPartialView?: boolean }
        | undefined
      baseContext.readFileState.set(p, {
        content: existing?.content ?? '',
        timestamp: v.timestamp,
        offset: existing?.offset ?? 0,
        limit: existing?.limit,
        isPartialView: v.isPartialView ?? existing?.isPartialView ?? false,
      } as never)
    }
  }

  // Record this tool's set/delete on readFileState → report back via ctxDelta; the host applies it to its own authoritative cache.
  const rfsDelta: NonNullable<CtxDelta['readFileState']> = []
  const recordingRfs = new Proxy(baseContext.readFileState as object, {
    get(target, prop, recv) {
      if (prop === 'set') {
        return (k: string, val: unknown) => {
          rfsDelta.push({ op: 'set', path: k, value: val })
          return (target as { set: (k: string, v: unknown) => unknown }).set(k, val)
        }
      }
      if (prop === 'delete') {
        return (k: string) => {
          rfsDelta.push({ op: 'delete', path: k })
          return (target as { delete: (k: string) => unknown }).delete(k)
        }
      }
      const v = Reflect.get(target, prop, recv)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  }) as ToolUseContext['readFileState']

  const cwdBefore = (() => { try { return getCwdState() } catch { return undefined } })()
  const abortController = createAbortController()
  inflight.set(id, abortController as unknown as { abort: () => void })
  try {
    // Per-request AbortController (aborting one does not affect others); readFileState uses the recording Proxy; everything else shares baseContext.
    // These two trigger Sets are read on the host by the attachments mechanism (the
    // next query injects nested memory files / dynamic skills). The sandbox gives an
    // empty Set for tools to collect into, then reports the paths back via ctxDelta
    // for the host to merge (same shape as readFileState). Otherwise they are lost across the process boundary.
    const nestedMemTriggers = new Set<string>()
    const dynSkillTriggers = new Set<string>()
    // The host's real permission context arrives in ctxIn → per-call override of
    // getAppState's toolPermissionContext, so a tool that reads
    // additionalWorkingDirectories (e.g. to decide whether a cd left the project)
    // sees the real value; otherwise a legitimate cd target is misjudged out-of-bounds
    // and reset. Override THIS call only (do not write back to shared baseContext.appState),
    // to avoid concurrent requests stepping on each other; the Map is rebuilt from entries.
    const baseGetAppState = baseContext.getAppState
    const callGetAppState = (
      ctxIn?.toolPermissionContext
        ? () => {
            const s = baseGetAppState()
            const tpc = ctxIn.toolPermissionContext!
            return {
              ...s,
              toolPermissionContext: {
                ...s.toolPermissionContext,
                ...(tpc.mode !== undefined ? { mode: tpc.mode } : {}),
                ...(tpc.alwaysAllowRules !== undefined ? { alwaysAllowRules: tpc.alwaysAllowRules } : {}),
                ...(tpc.alwaysDenyRules !== undefined ? { alwaysDenyRules: tpc.alwaysDenyRules } : {}),
                ...(tpc.additionalWorkingDirectories
                  ? { additionalWorkingDirectories: new Map(tpc.additionalWorkingDirectories) }
                  : {}),
              },
            }
          }
        : baseGetAppState
    ) as ToolUseContext['getAppState']
    const context: ToolUseContext = {
      ...baseContext,
      abortController,
      toolUseId: id,
      getAppState: callGetAppState,
      readFileState: recordingRfs,
      nestedMemoryAttachmentTriggers: nestedMemTriggers,
      dynamicSkillDirTriggers: dynSkillTriggers,
      ...(ctxIn?.fileReadingLimits ? { fileReadingLimits: ctxIn.fileReadingLimits } : {}),
      // agentId/agentType: pure ctx data, faithfully passed through (the tool body does not read them today — hooks/host do — but carrying them is zero-risk and matches "rebuild the whole ctx").
      ...(ctxIn?.agentId ? { agentId: ctxIn.agentId as ToolUseContext['agentId'] } : {}),
      ...(ctxIn?.agentType ? { agentType: ctxIn.agentType } : {}),
      // userModified: the file-edit tool's call() really reads it (to decide the "user modified the proposal" note to the assistant).
      ...(ctxIn?.userModified !== undefined ? { userModified: ctxIn.userModified } : {}),
    }
    // validateOnly request → run validateInput against the sandbox's REAL filesystem
    // (the host's on-disk view is a turn-start snapshot; files written by shell/Write
    // only exist in the sandbox; validating on the host would read a stale disk and
    // misjudge does-not-exist / string-not-found, making back-to-back edits fail).
    // Read-only validation; no call(), no ctxDelta; return runs through finally to clear inflight.
    if (req.validateOnly) {
      const vr = await (tool as { validateInput?: (i: unknown, c: ToolUseContext) => Promise<unknown> }).validateInput?.(input, context)
      tlog(`-> validate ${name} id=${id} ms=${Date.now() - t0} result=${(vr as { result?: boolean })?.result !== false}`)
      send({ id, ok: true, output: vr ?? { result: true } })
      return
    }
    // Permissions were already checked on the host (control stays on the host); allow everything here.
    const allowAll = async (_tool: unknown, inp: unknown) => ({
      behavior: 'allow' as const,
      updatedInput: inp,
    })
    const parentMessage = createAssistantMessage({ content: [] })
    const onProgress = (p: { toolUseID?: string; data?: unknown }) =>
      send({ id, type: 'progress', data: p?.data ?? p })

    const result = (await (
      tool as { call: (...a: unknown[]) => Promise<ToolResult<unknown>> }
    ).call(input, context, allowAll, parentMessage, onProgress)) as ToolResult<unknown>

    // Assemble ctxDelta: cwd change (Bash cd) + readFileState changes → the host applies them with its own real functions, keeping host authority consistent.
    const ctxDelta: CtxDelta = {}
    const cwdAfter = (() => { try { return getCwdState() } catch { return undefined } })()
    if (cwdAfter && cwdAfter !== cwdBefore) ctxDelta.cwd = cwdAfter
    if (rfsDelta.length) ctxDelta.readFileState = rfsDelta
    // Report nested-memory / dynamic-skill trigger paths back to the host (the host adds them to its own Set; the next query's attachments inject them).
    if (nestedMemTriggers.size) ctxDelta.nestedMemoryTriggers = [...nestedMemTriggers]
    if (dynSkillTriggers.size) ctxDelta.dynamicSkillTriggers = [...dynSkillTriggers]
    // Plan mode: if this was a Write/Edit/NotebookEdit to the host-supplied plan file,
    // read the written content back; the host mirrors it to the same path (paths line
    // up) so the host's plan reads (approval card / normalization / history) all see it.
    // Read the file once only on a hit; non-plan writes / non-remote mode (no ctxIn.planFilePath) cost nothing.
    let planWriteBytes = -1
    if ((name === 'Write' || name === 'Edit' || name === 'NotebookEdit') && ctxIn?.planFilePath) {
      const fp = (input as { file_path?: unknown })?.file_path
      if (typeof fp === 'string' && fp) {
        const cwdNow = (() => { try { return getCwdState() } catch { return undefined } })()
        const abs = pathResolve(cwdNow || process.cwd(), fp)
        if (abs === ctxIn.planFilePath) {
          try {
            const content = String(fsReadFileSync(ctxIn.planFilePath, { encoding: 'utf-8' }))
            ctxDelta.planFileWrite = { path: ctxIn.planFilePath, content }
            planWriteBytes = content.length
          } catch (e) {
            tlog(`-> tool ${name} id=${id} planWrite READ-FAIL ${String((e as Error)?.message || e).slice(0, 80)}`)
          }
        }
      }
    }

    tlog(`-> tool ${name} id=${id} ok ms=${Date.now() - t0}${ctxDelta.cwd ? ` cwd->${ctxDelta.cwd}` : ''}${rfsDelta.length ? ` rfs=${rfsDelta.length}` : ''}${nestedMemTriggers.size ? ` nmem=${nestedMemTriggers.size}` : ''}${dynSkillTriggers.size ? ` skill=${dynSkillTriggers.size}` : ''}${planWriteBytes >= 0 ? ` planWrite=${planWriteBytes}b` : ''}`)
    // The host uses output as result.data. Return data + ctxDelta.
    // newMessages (e.g. an image message produced by a Read of a PDF/image) is also
    // carried back — otherwise the forwarding path drops the content and the agent never sees the PDF/image.
    const nm = (result as { newMessages?: unknown[] })?.newMessages
    send({ id, ok: true, output: result?.data ?? result, ctxDelta, ...(nm && nm.length ? { newMessages: nm } : {}) })
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; stack?: string }
    const diag = (e?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 300)
    tlog(`-> tool ${name} id=${id} FAIL ${e?.code || 'TOOL_ERROR'} ${String(e?.message ?? err).slice(0, 160)}`)
    send({
      id,
      ok: false,
      // diag (the first few stack lines from the sandbox) is carried back to the host log, so debugging does not require fetching the pod stderr.
      error: { code: e?.code || 'TOOL_ERROR', message: String(e?.message ?? err), diag },
    })
  } finally {
    inflight.delete(id)
  }
}

/**
 * Minimal ToolUseContext — copied from a base's non-interactive execution context
 * (verified to run tools). readFileState / getAppState are passed in by the caller
 * (they must persist across requests); the rest are no-ops / defaults.
 */
function buildBaseContext(
  tools: Tools,
  readFileState: ReturnType<typeof createFileStateCacheWithSizeLimit>,
  getAppState: ToolUseContext['getAppState'],
  setAppState: ToolUseContext['setAppState'],
): ToolUseContext {
  return {
    abortController: createAbortController(),
    options: {
      commands: [],
      tools,
      mainLoopModel: getMainLoopModel(),
      thinkingConfig: { type: 'disabled' },
      mcpClients: [],
      mcpResources: {},
      isNonInteractiveSession: true,
      debug: false,
      verbose: false,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    getAppState,
    setAppState,
    messages: [],
    readFileState,
    // The no-ops below MIRROR the base's own behavior in this same mode (not laziness):
    //  - setInProgressToolUseIDs/setResponseLength: the base's query engine itself uses ()=>{} (transient loop state, irrelevant to a single tool execution).
    //  - updateFileHistoryState: file history is off by default in non-interactive mode → a tool is blocked from calling it before it would matter; the empty shell matches the host. Wire the real impl (setAppState mutates fileHistory + incremental ctxDelta) only if checkpointing is enabled.
    //  - updateAttributionState: the tool body never calls it (only hooks/analytics do) → the empty shell never has an effect.
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  } as ToolUseContext
}
