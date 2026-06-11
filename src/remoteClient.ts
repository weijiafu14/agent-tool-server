/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Remote forwarding client (host / "Brain" side).
 *
 * In agent mode, the tool dispatch layer (see docs/INTEGRATION.md) does zod
 * validation + permission/hook approval on the host, then delegates the actual
 * EXECUTION here: it sends {id,name,input} to a long-lived tool-server and
 * reads back {ok,output} — where output is the tool's result.data (same binary,
 * byte-for-byte identical behavior). Control stays on the host; execution runs
 * remotely. See docs/PROTOCOL.md.
 *
 * The transport is chosen by REMOTE_TOOLS_URL (legacy alias: LEGACY_REMOTE_TOOLS_URL):
 *   - `stdio:<cmd...>`  local: spawn that command (long-lived), line-delimited
 *                       JSON over stdin/stdout. e.g. `stdio:/abs/agent --tool-server`.
 *   - `stdio`           default: spawn `process.execPath --tool-server` (self-spawn).
 *   - `ws://host:port`  sandbox: persistent WebSocket to the sandbox's exposed
 *                       port (PROTOCOL.md mandates WS). e.g. `wss://<sandbox-host>:<port>/`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import * as readline from 'node:readline'
import { randomBytes } from 'node:crypto'
import { getRemoteToolsUrl, getRemoteCallTimeoutMs } from './env.js'
import { enqueuePendingNotification } from './base.js'

/**
 * Process-level request-id prefix (multi-agent). Several concurrent turns of the
 * same task are each a separate agent process that reuses one sandbox
 * tool-server (the orchestration proxy routes responses back to the originator
 * by id). If two processes both started ids at `t1`, the proxy's inflight
 * routing table (id → agent) would collide and responses would cross. A random
 * per-process prefix + a per-process counter makes ids globally unique. Harmless
 * for the stdio / single-agent case.
 */
const ID_PREFIX = randomBytes(4).toString('hex')

/**
 * FALLBACK call timeout (ms). Normally a sandbox crash is detected by the
 * orchestration proxy (upstream close / heartbeat) and in-flight calls get a
 * transport error fast; this is the LAST resort against "half-dead connection /
 * stuck sandbox / lost response frame" leaving a pending call hung forever (which
 * surfaces as a turn that just sits there with nothing to grab onto). On timeout
 * the call rejects as a transport failure (idempotent tools auto-retry,
 * non-idempotent ones feed the error back to the agent) and logs a TIMEOUT line.
 * Default 15min (> a 10min max Bash timeout, so long tools are not killed);
 * REMOTE_CALL_TIMEOUT_MS configures it, `<= 0` disables it.
 * This does not contradict "never give up rebuilding a crashed sandbox" — the
 * rebuild keeps going in the proxy; this only ensures a SINGLE call cannot hang.
 */
const CALL_TIMEOUT_MS = getRemoteCallTimeoutMs()

/**
 * Sandbox / transport failure (connection dropped, timeout, container exited) —
 * distinct from a "business failure", which is rethrown to the agent verbatim.
 * The tool-layer rebuild logic uses this to decide whether a retry is safe.
 */
export class RemoteToolTransportError extends Error {
  readonly isTransport = true
  constructor(message: string) {
    super(message)
    this.name = 'RemoteToolTransportError'
  }
}

/**
 * Forwarded result: the tool output (= result.data) + the ctx changes the
 * sandbox reports back (ctxDelta) + newMessages (e.g. messages emitted from a
 * Read of a PDF/image — the host advances the conversation with them) +
 * truncated (a signal that hook output exceeded the cap and was truncated, so
 * the host can log it).
 */
export type RemoteToolResult = {
  output: unknown
  ctxDelta?: CtxDelta
  newMessages?: unknown[]
  truncated?: { stdout: boolean; stderr: boolean }
}

/**
 * After the sandbox executes using host-supplied state, it reports back "what
 * changed"; the host applies it to its own authoritative ctx. Closures do not
 * cross the wire — changes travel as data.
 */
export type CtxDelta = {
  /** If a tool (Bash cd) changed the cwd, carry the new value; the host aligns via setCwdState. */
  cwd?: string
  /** readFileState set/delete (set carries the full entry value; the host replays it verbatim). */
  readFileState?: Array<{ op: 'set'; path: string; value: unknown } | { op: 'delete'; path: string }>
  /**
   * Paths that a Read triggered as "nested memory file to inject" (the sandbox
   * collects them into a Set; the host adds them to its own trigger set so the
   * next query's attachments inject the nested memory). Same shape as
   * readFileState: the guard/injection lives on the host, execution in the sandbox.
   */
  nestedMemoryTriggers?: string[]
  /** Paths where a Read/Write/Edit hit a skill directory, triggering dynamic-skill discovery (same pattern). */
  dynamicSkillTriggers?: string[]
  /**
   * Plan mode: when a sandbox Write/Edit/NotebookEdit writes the plan file (the
   * one the host sent down via ctxIn.planFilePath), carry the written content
   * back; the host mirrors it to the same path so its plan reads (approval card /
   * normalization / history) all see it. Without this the real plan lives only in
   * the sandbox volume and the host reads empty → an empty approval card and a
   * lost plan at execute time. Paths line up (the sandbox mounts the workspace at
   * the host cwd path).
   */
  planFileWrite?: { path: string; content: string }
}

/** State the host sends with each call (the sandbox builds/aligns ctx before executing; data only, no functions). */
export type CtxIn = {
  cwd?: string
  /** Lightweight (timestamp/isPartialView only, no content): feeds the sandbox's "has been read" guard + read dedup. */
  readFileState?: Record<string, { timestamp: number; isPartialView?: boolean }>
  fileReadingLimits?: { maxTokens?: number; maxSizeBytes?: number }
  /** Natively, tool.call(input, {...toolUseContext}, ...) hands the whole context to the tool; faithfully wired so the sandbox tool gets the same data fields. */
  agentId?: string
  agentType?: string
  /** Edit/Write's "the user modified the proposal" flag: natively the interceptor passes permissionDecision.userModified to the tool; forwarded the same. */
  userModified?: boolean
  /** Permission context (mode / allow·deny rules / additionalWorkingDirectories). The Map is serialized to entries; the sandbox rebuilds it. */
  toolPermissionContext?: {
    mode?: string
    alwaysAllowRules?: unknown
    alwaysDenyRules?: unknown
    additionalWorkingDirectories?: Array<[string, unknown]>
  }
  /**
   * Plan mode: the host-authoritative absolute plan-file path (getPlanFilePath(agentId)).
   * When a sandbox Write/Edit/NotebookEdit hits it, the content is sent back via
   * ctxDelta.planFileWrite and the host mirrors it. The host sends it down (the
   * plans directory / slug are host config; the sandbox must not guess the path).
   */
  planFilePath?: string
}

/** Control frame (abort/kill): fire-and-forget, never enters pending (no response); the sandbox routes by id/backgroundTaskId. */
export type RemoteControl =
  | { op: 'abort'; id: string }
  | { op: 'kill'; backgroundTaskId: string }

/**
 * Hook-exec frame (forward a command-type hook into the sandbox to close a host
 * RCE hole). NOT a tool — it never goes through findToolByName / SERVABLE_TOOLS;
 * it is just a "spawn a shell in the sandbox" transport frame the agent/LLM never
 * sees. Control (matcher / parseHookOutput / decision) stays on the host; only
 * the exec moves into the sandbox.
 */
export type RemoteHookSpec = {
  command: string
  stdin: string
  /** Hook-specific env only (CLAUDE_*, excluding CLAUDE_ENV_FILE); the sandbox merges onto its own env. Host system env / credentials never travel. */
  env: Record<string, string>
  cwd: string
  shell: 'bash' | 'powershell'
  timeoutMs: number
}

/** Result of a hook executed in the sandbox (fed back into the host's parseHookOutput; exit 2 = block semantics etc. unchanged). */
export type RemoteHookResult = { stdout: string; stderr: string; exitCode: number }

/**
 * Forwarding diagnostic log. Goes to STDERR → the host captures this process's
 * stderr into its logs. It must NEVER go to stdout (that is the agent's
 * stream-json channel; polluting it breaks the client parser). Keep it to a
 * single short line. These `[remote]` lines are the first thing to grep when
 * debugging forwarding.
 */
function rlog(msg: string): void {
  try {
    process.stderr.write(`[remote] ${msg}\n`)
  } catch {
    /* logging must never affect the main path */
  }
}

type Pending = {
  resolve: (r: RemoteToolResult) => void
  reject: (err: Error) => void
  onProgress?: (data: unknown) => void
  /** Send timestamp (ms) — for round-trip timing; label — for diagnostics (tool:Read / hook:<cmd>). */
  startTime: number
  label: string
  /** Fallback timeout handle: cleared on final response / connection down; reset on progress (long streaming tools are not killed). */
  timer?: ReturnType<typeof setTimeout>
}

type Frame =
  | { id: string; type: 'progress'; data?: unknown }
  | { id: string; ok: true; output?: unknown; ctxDelta?: CtxDelta; newMessages?: unknown[]; truncated?: { stdout: boolean; stderr: boolean } }
  | { id: string; ok: false; error?: { code?: string; message?: string; transport?: boolean } }

/** Common request/response-by-id logic; subclasses only handle "send a line, receive a line, detect death". */
abstract class Connection {
  protected pending = new Map<string, Pending>()
  private seq = 0
  protected dead = false

  /** Subclass: send one frame (one JSON line). May buffer if not yet connected. */
  protected abstract writeLine(line: string): void

  /** Arm a fallback timeout: no final response within CALL_TIMEOUT_MS → reject as a transport failure + log TIMEOUT. */
  protected armTimeout(id: string, p: Pending): void {
    if (CALL_TIMEOUT_MS <= 0) return // 0/negative = fallback disabled
    p.timer = setTimeout(() => {
      if (!this.pending.has(id)) return // already settled/cleared
      this.pending.delete(id)
      const ms = Date.now() - p.startTime
      rlog(`<- ${p.label} id=${id} TIMEOUT ms=${ms} (>${CALL_TIMEOUT_MS}ms no response → treated as transport failure; suspect stuck sandbox / half-dead connection / lost response)`)
      p.reject(new RemoteToolTransportError(`remote ${p.label} did not respond in ${ms}ms; treated as transport failure`))
    }, CALL_TIMEOUT_MS)
    if (typeof p.timer?.unref === 'function') p.timer.unref() // do not block process exit
  }

  /** Subclasses call this when a frame arrives. */
  protected onLine(line: string): void {
    if (!line.trim()) return
    let frame: Frame
    try {
      frame = JSON.parse(line)
    } catch {
      return // non-JSON noise, ignore
    }
    // A task-notification pushed by a finished sandbox background task: no id, not
    // tied to any pending request → enqueue it straight into the host's notification
    // queue, where the agent loop consumes it natively (same path as non-remote mode).
    if ((frame as { type?: string }).type === 'notify') {
      try {
        enqueuePendingNotification(
          (frame as unknown as { command: Parameters<typeof enqueuePendingNotification>[0] }).command,
        )
        rlog(`<- notify (task-notification) → host enqueuePendingNotification`)
      } catch (e) {
        rlog(`<- notify FAIL ${String((e as Error)?.message || e).slice(0, 80)}`)
      }
      return
    }
    const p = this.pending.get(frame.id)
    if (!p) {
      // Response with no matching pending (id mismatch / duplicate / already timed out) → drop, but log it to debug "responses crossed / lost".
      rlog(`<- orphan id=${frame.id} (no pending, dropped)`)
      return
    }
    if ('type' in frame && frame.type === 'progress') {
      p.onProgress?.(frame.data)
      // Progress → reset the fallback timeout, so a long streaming tool (continuous progress, total time > timeout) is not killed.
      if (p.timer) { clearTimeout(p.timer); this.armTimeout(frame.id, p) }
      return
    }
    this.pending.delete(frame.id)
    if (p.timer) clearTimeout(p.timer) // final response arrived; clear fallback timeout
    const ms = Date.now() - p.startTime
    if ('ok' in frame && frame.ok) {
      const ctxDelta = (frame as { ctxDelta?: CtxDelta }).ctxDelta
      const nrfs = ctxDelta?.readFileState?.length ?? 0
      const newMessages = (frame as { newMessages?: unknown[] }).newMessages
      const nnm = newMessages?.length ?? 0
      // Hook-output truncation signal → into the host log, so it is visible without digging into the sandbox pod.
      const truncated = (frame as { truncated?: { stdout: boolean; stderr: boolean } }).truncated
      rlog(`<- ${p.label} id=${frame.id} ok ms=${ms}${ctxDelta?.cwd ? ` cwd->${ctxDelta.cwd}` : ''}${nrfs ? ` rfs=${nrfs}` : ''}${nnm ? ` msgs=${nnm}` : ''}${truncated ? ` TRUNCATED(out=${truncated.stdout},err=${truncated.stderr})` : ''}`)
      p.resolve({ output: frame.output, ctxDelta, newMessages, truncated })
    } else {
      const e =
        'ok' in frame && !frame.ok
          ? (frame as { error?: { code?: string; message?: string; transport?: boolean; diag?: string } }).error
          : undefined
      // The orchestration proxy returns {error:{transport:true}} for in-flight requests while a crashed sandbox
      // is being rebuilt. That is a TRANSPORT failure (upper layer may retry idempotent tools), not a business
      // failure. Any other ok:false is a business failure and is rethrown verbatim.
      const transport = !!(e && (e as { transport?: boolean }).transport)
      // Failure diagnostic from the tool-server (the sandbox-side cause; see toolServer.ts diag) → into the host log, so debugging does not require fetching the sandbox pod stderr.
      const diag = (e as { diag?: string } | undefined)?.diag
      rlog(`<- ${p.label} id=${frame.id} FAIL(${transport ? 'transport' : 'biz'}) ms=${ms} ${e?.code || ''} ${(e?.message || '').slice(0, 160)}${diag ? ` | diag=${String(diag).slice(0, 200)}` : ''}`)
      if (transport) {
        p.reject(new RemoteToolTransportError(e.message || 'sandbox rebuilding; tool call interrupted'))
      } else {
        p.reject(new Error(e?.message || 'remote tool failed'))
      }
    }
  }

  /** Subclasses call this when the connection drops; all pending requests reject as transport failures. */
  protected fail(reason: string): void {
    if (this.dead) return
    this.dead = true
    rlog(`connection DOWN: ${reason} (${this.pending.size} in-flight -> transport error)`)
    const err = new RemoteToolTransportError(reason)
    for (const p of this.pending.values()) { if (p.timer) clearTimeout(p.timer); p.reject(err) }
    this.pending.clear()
    if (conn === this) conn = null
  }

  /** Control frame (abort/kill): fire-and-forget, never enters pending (no response). Dead connection / write failure are swallowed. */
  sendControl(ctrl: RemoteControl): void {
    if (this.dead) return
    rlog(`control ${ctrl.op}${'id' in ctrl ? ` id=${ctrl.id}` : ''}${'backgroundTaskId' in ctrl ? ` bg=${ctrl.backgroundTaskId}` : ''}`)
    try {
      this.writeLine(JSON.stringify({ type: 'control', ...ctrl }))
    } catch {
      /* control frames are best-effort; failure is not thrown */
    }
  }

  call(
    name: string,
    input: unknown,
    ctxIn?: CtxIn,
    onProgress?: (data: unknown) => void,
    signal?: AbortSignal,
    validateOnly?: boolean,
  ): Promise<RemoteToolResult> {
    if (this.dead) {
      rlog(`-> tool:${name} REJECT (connection dead)`)
      return Promise.reject(new RemoteToolTransportError('tool-server connection unavailable'))
    }
    const id = `${ID_PREFIX}t${++this.seq}`
    // Host abort → send an abort control frame so the sandbox aborts this in-flight call (it finds the AbortController by id).
    if (signal) {
      if (signal.aborted) this.sendControl({ op: 'abort', id })
      else signal.addEventListener('abort', () => this.sendControl({ op: 'abort', id }), { once: true })
    }
    const label = validateOnly ? `validate:${name}` : `tool:${name}`
    rlog(`-> ${label} id=${id}${ctxIn?.cwd ? ` cwd=${ctxIn.cwd}` : ''}`)
    return new Promise<RemoteToolResult>((resolve, reject) => {
      const p: Pending = { resolve, reject, onProgress, startTime: Date.now(), label }
      this.pending.set(id, p)
      this.armTimeout(id, p) // fallback timeout: no final response still cannot hang forever
      try {
        this.writeLine(JSON.stringify({ id, name, input, ctxIn, ...(validateOnly ? { validateOnly: true } : {}) }))
      } catch (e) {
        this.pending.delete(id)
        if (p.timer) clearTimeout(p.timer)
        rlog(`-> ${label} id=${id} SEND-FAIL ${(e as Error).message}`)
        reject(new RemoteToolTransportError(`send failed: ${(e as Error).message}`))
      }
    })
  }

  /**
   * Send a hook-exec frame to spawn a command hook's shell in the sandbox.
   * The response reuses the tool's { ok, output } shape (output = RemoteHookResult),
   * so onLine / crash recovery / pending are all reused unchanged.
   * Failure semantics match call(): business error → plain Error; transport/sandbox failure → RemoteToolTransportError.
   */
  execHook(spec: RemoteHookSpec, signal?: AbortSignal): Promise<RemoteHookResult> {
    if (this.dead) {
      rlog(`-> hook REJECT (connection dead)`)
      return Promise.reject(new RemoteToolTransportError('tool-server connection unavailable'))
    }
    const id = `${ID_PREFIX}h${++this.seq}`
    // Host abort → send an abort control frame so the sandbox kills this hook process by id (same control frame as tools).
    if (signal) {
      if (signal.aborted) this.sendControl({ op: 'abort', id })
      else signal.addEventListener('abort', () => this.sendControl({ op: 'abort', id }), { once: true })
    }
    const label = `hook:${spec.command.slice(0, 40)}`
    rlog(`-> ${label} id=${id}`)
    return new Promise<RemoteHookResult>((resolve, reject) => {
      const p: Pending = {
        resolve: (r: RemoteToolResult) =>
          resolve((r.output ?? { stdout: '', stderr: '', exitCode: 0 }) as RemoteHookResult),
        reject,
        startTime: Date.now(),
        label,
      }
      this.pending.set(id, p)
      this.armTimeout(id, p) // fallback timeout: a stuck hook still cannot hang forever
      try {
        this.writeLine(JSON.stringify({ id, type: 'hook-exec', ...spec }))
      } catch (e) {
        this.pending.delete(id)
        if (p.timer) clearTimeout(p.timer)
        rlog(`-> ${label} id=${id} SEND-FAIL ${(e as Error).message}`)
        reject(new RemoteToolTransportError(`send failed: ${(e as Error).message}`))
      }
    })
  }
}

/** stdio: spawn a long-lived tool-server child and use its stdin/stdout. */
class StdioConnection extends Connection {
  private child: ChildProcess

  constructor(url: string) {
    super()
    const { command, args } = parseStdioUrl(url)
    this.child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'inherit'], // child stderr → passes through to host stderr for debugging
      env: process.env,
    })
    this.child.on('error', err => this.fail(`spawn failed: ${err.message}`))
    this.child.on('exit', (code, signal) =>
      this.fail(`tool-server exited code=${code} signal=${signal}`),
    )
    readline.createInterface({ input: this.child.stdout! }).on('line', l => this.onLine(l))
  }

  protected writeLine(line: string): void {
    if (this.dead || !this.child.stdin?.writable) {
      throw new RemoteToolTransportError('tool-server stdin not writable')
    }
    this.child.stdin.write(line + '\n')
  }
}

/** ws://: connect to the sandbox's exposed port over a persistent WebSocket. Requests before "open" queue and flush on open. */
class WsConnection extends Connection {
  private ws: WebSocket
  private open = false
  private queue: string[] = []

  constructor(url: string) {
    super()
    rlog(`ws connecting ${url.replace(/\?.*$/, '')}`) // strip token
    this.ws = new WebSocket(url)
    this.ws.onopen = () => {
      this.open = true
      rlog(`ws open (flush ${this.queue.length} queued)`)
      for (const line of this.queue) this.ws.send(line)
      this.queue = []
    }
    this.ws.onmessage = ev => this.onLine(String((ev as MessageEvent).data))
    this.ws.onerror = () => this.fail('WebSocket error')
    this.ws.onclose = ev => this.fail(`WebSocket closed code=${(ev as CloseEvent).code}`)
  }

  protected writeLine(line: string): void {
    if (this.dead) throw new RemoteToolTransportError('WebSocket closed')
    if (this.open) this.ws.send(line)
    else this.queue.push(line) // buffer before open
  }
}

function parseStdioUrl(url: string): { command: string; args: string[] } {
  if (url === 'stdio' || url === '') {
    return { command: process.execPath, args: ['--tool-server'] }
  }
  const rest = url.slice('stdio:'.length).trim()
  const parts = rest.split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { command: process.execPath, args: ['--tool-server'] }
  return { command: parts[0], args: parts.slice(1) }
}

let conn: Connection | null = null

function getConnection(): Connection {
  if (conn) return conn
  const url = getRemoteToolsUrl() || 'stdio'
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    conn = new WsConnection(url)
  } else if (url === 'stdio' || url.startsWith('stdio:') || url === '') {
    conn = new StdioConnection(url)
  } else {
    throw new RemoteToolTransportError(`unrecognized REMOTE_TOOLS_URL: ${url}`)
  }
  return conn
}

/**
 * Delegate one tool execution to the remote tool-server.
 * Returns { output (= tool result.data), ctxDelta (which ctx state the sandbox changed; the host applies it) }.
 * ctxIn: state the host sends into the sandbox (cwd / lightweight readFileState / fileReadingLimits).
 * signal: host abort signal; firing sends an abort control frame.
 * Failure: business error → plain Error; transport/sandbox failure → RemoteToolTransportError.
 */
export function callRemoteTool(
  name: string,
  input: unknown,
  ctxIn?: CtxIn,
  onProgress?: (data: unknown) => void,
  signal?: AbortSignal,
): Promise<RemoteToolResult> {
  return getConnection().call(name, input, ctxIn, onProgress, signal)
}

/**
 * Delegate a tool's validateInput to the sandbox so it runs against the REAL
 * filesystem. The host's on-disk view is a turn-start snapshot; files written by
 * shell/Write only exist in the sandbox → validating on the host would misjudge
 * does-not-exist / string-not-found. The sandbox's handleRequest, on a validateOnly
 * frame, runs tool.validateInput and returns the result in output (read-only; no
 * call(), no ctxDelta). A transport/sandbox failure throws RemoteToolTransportError
 * (the host then lets it pass, so the subsequent call() forwarding handles recovery).
 */
export function callRemoteValidate(
  name: string,
  input: unknown,
  ctxIn?: CtxIn,
  signal?: AbortSignal,
): Promise<RemoteToolResult> {
  return getConnection().call(name, input, ctxIn, undefined, signal, true)
}

/**
 * Delegate a command hook's execution to the remote tool-server (spawn a shell in
 * the sandbox). Control stays on the host (matcher / parseHookOutput / decision);
 * only the exec moves. Returns { stdout, stderr, exitCode }.
 * Failure: business error → plain Error; transport/sandbox failure → RemoteToolTransportError.
 */
export function execRemoteHook(spec: RemoteHookSpec, signal?: AbortSignal): Promise<RemoteHookResult> {
  return getConnection().execHook(spec, signal)
}

/** Send a control frame (abort/kill) to the current tool-server connection; no-op if none. Used by background-task kill etc. */
export function sendRemoteControl(ctrl: RemoteControl): void {
  conn?.sendControl(ctrl)
}
