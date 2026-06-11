# Lessons

Non-obvious failures from running this in production. Each one cost real
debugging time; they are baked into the code, documented here so you understand
*why* the code looks the way it does (and don't "simplify" the bug back in).

## A progress frame must NOT clear the in-flight entry

A streaming tool (Bash) emits many `{ type:'progress', id }` frames before its
final `{ id, ok, output }`. The progress frame carries the **same `id`** as the
request. The naive proxy handler deletes the in-flight entry on any frame with a
matching id — so the *first* progress frame empties the routing entry, and then:

- with multi-agent routing, the final `ok` frame can't find its originator (the
  streamed result is lost); and
- if the sandbox crashes mid-stream, the recovery path can't find the call to
  reject with a transport error, so the agent hangs until the turn times out.

Rule: route progress frames, but only delete the in-flight entry on the **final**
response. In `remoteClient.ts` this is the `if ('type' in frame && frame.type ===
'progress') { ...; return }` early-return before the `pending.delete`.

## A control frame has no request id — don't track it as in-flight

`ping`/`pong`/`abort` control frames are fire-and-forget. A `pong` coming back
from the sandbox has no request `id`. If a proxy treats it like a response and
tracks/correlates it, crash recovery later replays it as a stale transport error.
The proxy must recognize control frames and pass them through without counting
them as in-flight. (In `remoteClient.ts`, the `notify` and `control` paths return
before touching `pending`.)

## ctxDelta must be applied incrementally, not as a whole-bag overwrite

When several tools run concurrently, each reports its own `ctxDelta`. If the host
overwrites its whole ctx state from one delta, a later-arriving delta clobbers an
earlier one (lost update). Apply each change individually: `setCwdState(delta.cwd)`,
and per-entry `readFileState.set/delete` — never replace the entire map. See
`applyCtxDelta`.

## The "has been read?" guard runs on the host; the Read runs in the sandbox

This is the whole reason the `ctxIn`/`ctxDelta` contract exists. `Write`/`Edit`
validate that the file was read first — on the **host**, against the host's
`readFileState`. But `Read` is forwarded and updates only the **sandbox's** state.
Without reporting the read back via `ctxDelta.readFileState`, every Edit fails with
*"File has not been read yet."* If you add a new tool whose behavior depends on
shared ctx state, wire it through the contract — do not hardcode a host-side
write-back. See [PROTOCOL.md](PROTOCOL.md).

## validateInput sometimes needs the real filesystem

The host's disk is a turn-start snapshot. A shell command or a prior `Write` may
have created the file the next `Edit` targets — but only in the sandbox. Running
`validateInput` (which does does-not-exist / find-old-string checks) on the host
reads the stale disk and rejects valid back-to-back edits. So the write-family
tools' `validateInput` is forwarded into the sandbox. The permission decision
still happens on the host.

## Detached process group, or hooks leak

A hook spawned with `shell:true` forks grandchildren. `SIGKILL` on the child only
kills `/bin/sh`; a backgrounded grandchild (`yes &`) keeps the stdout write fd
open, so the child's `close` never fires — the call hangs, the in-flight entry
leaks, and the output cap is bypassed (the grandchild keeps eating memory). Spawn
`detached:true` and kill the whole group (`process.kill(-pid)`), with a grace
timer that force-settles if `close` still doesn't arrive.

## Truncation markers must not enter the content body

When hook output exceeds the cap, do not append a "...truncated" marker into
stdout/stderr. A stderr overflow that bleeds a marker into stdout corrupts the
JSON the host's `parseHookOutput` expects — and a failed parse silently swallows a
block/deny decision (fail-open). Carry truncation as a separate top-level frame
field; keep the content body clean.

## Idle disconnects are not always crashes

A long-lived WS through an ingress/proxy can be dropped on idle. Without a
heartbeat, that drop looks like a sandbox crash and triggers an endless rebuild
loop that burns resources. A periodic `ping` (and a `pong` to give the return
direction traffic too) keeps the connection alive below the idle threshold. Note
that some platforms also impose a hard **maximum connection age** that no traffic
can defeat — for that, lean on seamless reconnect (rebuild + reconnect behind the
stable local endpoint) rather than trying to keep one connection alive forever.
