# Protocol

**English** · [简体中文](PROTOCOL.zh-CN.md)

One bidirectional, line-delimited JSON connection between the host ("Brain") and
the sandbox ("Hands"). Every message is one JSON object per line (stdio) or one
text frame (WebSocket). Requests and responses correlate by `id`.

Two transports, one message handler:

- **stdio** — the host spawns the tool-server as a child; line-delimited JSON over
  stdin/stdout. Simplest for local development.
- **WebSocket** (`--port N`) — the sandbox exposes a port; the host holds one
  persistent WS. Use a WebSocket, **not** HTTP keep-alive: forwarding is a
  long-lived, bidirectional, streaming channel (progress frames, control frames,
  notifications all flow back), which is exactly what HTTP request/response is bad
  at.

## Frame types

| Frame | Direction | Shape | Response |
|-------|-----------|-------|----------|
| **tool** | host → sandbox | `{ id, name, input, ctxIn }` | `{ id, ok:true, output, ctxDelta, newMessages? }` / `{ id, ok:false, error }` |
| **validate** | host → sandbox | `{ id, name, input, ctxIn, validateOnly:true }` | `{ id, ok:true, output: <validate result> }` |
| **hook-exec** | host → sandbox | `{ id, type:'hook-exec', command, stdin, env, cwd, shell, timeoutMs }` | `{ id, ok:true, output:{ stdout, stderr, exitCode } }` |
| **control** | both | `{ type:'control', op:'abort'\|'ping'\|'pong', id? }` | none (fire-and-forget) |
| **progress** | sandbox → host | `{ id, type:'progress', data }` | n/a (interim; a final `ok` follows) |
| **notify** | sandbox → host | `{ type:'notify', command }` | none (no `id`) |

### tool

The core frame. The host has already done schema validation and
permission/hook approval; the sandbox just **executes** and returns
`output` (= the tool's `result.data`). `ctxIn`/`ctxDelta` carry the state
contract (below). `newMessages` carries content a tool emits as messages (e.g.
images extracted from a PDF read) so the host can advance the conversation.

### validate

A tool's `validateInput` may **read the filesystem** ("does this file exist?",
"find the `old_string` to replace", "has this file been read?"). The host's
on-disk view is a snapshot from the start of the turn — the freshest files
(written by a shell command or a prior `Write`) only exist in the sandbox. So for
the write-family tools, `validateInput` is forwarded into the sandbox and run
against the real filesystem. It is read-only: no `call()`, no `ctxDelta`. The
**permission decision still happens on the host** afterwards.

### hook-exec

A command-type hook is **not a tool** — it never appears on any whitelist and the
agent/LLM never sees it. But an untrusted workspace can inject one via its config,
and running it on the host would be RCE. So command hooks travel as their own
frame and run in the sandbox. All hook *control* (matching, output parsing, the
exit-2-block decision) stays on the host. See [SECURITY.md](SECURITY.md).

### control

Fire-and-forget, no response:

- `abort` — the host interrupts an in-flight call/hook by `id`; the sandbox aborts
  the real process.
- `ping` / `pong` — heartbeat. **Critical:** a control frame has no request `id`,
  so the proxy/host must treat it as id-less and **not** track it as in-flight
  (otherwise crash recovery replays it as a stale transport error). See
  [LESSONS.md](LESSONS.md).

## The ctx state contract (`ctxIn` / `ctxDelta`)

The hardest problem in split-brain execution: some tool *guards* run on the host
while the *reads they depend on* run in the sandbox.

> The host is the **single source of truth** for ctx state. The sandbox borrows
> state to execute (`ctxIn`), reports back what changed (`ctxDelta`), and the host
> applies the change with its **own real functions**. Closures never cross the wire.

**Concrete failure it solves:** the `Write`/`Edit` "you must read a file before
writing it" guard runs on the host (`validateInput`, before forwarding) and checks
the host's `readFileState`. But `Read` is *forwarded to the sandbox*, which updates
only the *sandbox's* `readFileState`. Without the contract, the host never sees the
read and every Edit fails with *"File has not been read yet."* The `cwd` set by a
`Bash` `cd` has the same problem.

`ctxIn` (host → sandbox, data only):

| Field | Why |
|-------|-----|
| `cwd` | align the sandbox's working directory with the host |
| `readFileState` | lightweight (timestamp / isPartialView, **no content**) — seeds the "has been read?" guard and read dedup |
| `fileReadingLimits` | size/token caps the tool honors |
| `agentId` / `agentType` | pure ctx data faithfully passed through |
| `userModified` | whether the user edited the proposed input (read by the edit tool) |
| `toolPermissionContext` | `additionalWorkingDirectories` etc. — a Bash tool checks these to decide if a `cd` left the project; an empty set would misjudge a legitimate cd and reset the cwd. Map → entries. |
| `planFilePath` | plan mode: the host-authoritative plan path (the sandbox must not guess it) |

`ctxDelta` (sandbox → host, **incremental** — apply each change, never overwrite
the whole bag, so concurrent tools don't clobber each other):

| Field | Effect on host |
|-------|----------------|
| `cwd` | `setCwdState(cwd)` |
| `readFileState` | apply each `set`/`delete` to the host's authoritative cache |
| `nestedMemoryTriggers` | add to the host's nested-memory trigger set (next query injects them) |
| `dynamicSkillTriggers` | add to the host's dynamic-skill trigger set |
| `planFileWrite` | mirror the plan **content** to the host's authoritative plan path — **discarding the sandbox-reported path** (anti-traversal; see [SECURITY.md](SECURITY.md)) |

The host implementation lives in `src/integration.ts` (`buildCtxIn`,
`applyCtxDelta`); the sandbox side lives in `src/toolServer.ts` (seeding `ctxIn`,
and a recording `Proxy` over `readFileState` that captures set/delete into the
`ctxDelta`).

## Failure semantics

- **Business failure** (`ok:false`, no `transport` flag) — rethrown to the agent
  verbatim. The tool genuinely failed.
- **Transport failure** (`ok:false` with `error.transport === true`, or a dropped
  connection, or the fallback timeout) — the sandbox/connection died. The host's
  forwarding retries **idempotent** tools (Read/Glob/Grep/Write) with backoff; for
  non-idempotent tools it rethrows so the agent decides (never blindly replays a
  side-effecting Edit/Bash into a rebuilt sandbox).
- `error.diag` carries the first few stack lines from the sandbox so the host log
  has the real cause without fetching the (disposable) sandbox's stderr.
