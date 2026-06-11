# agent-tool-server

**English** · [简体中文](README.zh-CN.md)

**Split-brain sandboxing for Claude Code-compatible agent runtimes.** Keep the
control loop and all credentials on the host; forward only *tool execution* into
a disposable sandbox over one persistent connection. When the sandbox crashes,
the host reconnects to a rebuilt one and the turn continues — the agent never
notices.

This is the design most coding-agent sandboxes get wrong by putting the *whole
agent* in the box. Here the brain stays out:

```
host ("Brain")  — agent loop, session, LLM key, permission/hook approval, git
  │  one dispatch interceptor: if remote mode && tool is servable, delegate execution
  ▼  one persistent connection (stdio locally, or ws:// to a sandbox)
[ your orchestration proxy ]  — stable local endpoint, heartbeat, seamless crash recovery
  ▼
sandbox ("Hands") — `--tool-server`: runs the base's NATIVE tools against the workspace
```

Same binary, two modes. The host runs agent mode; the sandbox runs
`--tool-server` mode. Because it is the *same tool code* on both sides, tool
behavior is byte-for-byte identical — no reimplemented Glob/Grep/Edit semantics,
no chatty per-syscall RPC.

## Why this shape

- **Credentials never enter the sandbox.** The LLM key, git credentials, and any
  cloud/service-account token stay on the host. The sandbox is pure execution —
  it does not call the model and does not do git, so it needs none of them.
- **The sandbox is cattle.** Workspace lives on a per-task volume; session lives
  on the host. A crashed sandbox is rebuilt from the same volume and the turn
  resumes. In-flight idempotent tools auto-retry; non-idempotent ones report the
  failure back to the agent to decide.
- **Untrusted code can't reach the host.** A workspace can inject command hooks
  and MCP config; both are neutralized (hooks are forwarded into the sandbox to
  run; see [SECURITY.md](docs/SECURITY.md)).
- **Zero overhead when off.** With no `REMOTE_TOOLS_URL` set, the host code path
  is the original native path, byte-for-byte. The interceptor is a single `if`.

## What's in here (and what's not)

This repository is the **forwarding layer + protocol** only:

| File | Side | Role |
|------|------|------|
| `src/toolServer.ts` | sandbox | `--tool-server` mode: runs native tools, hooks, control frames |
| `src/remoteClient.ts` | host | forwarding client (stdio / WebSocket, crash detection, fallback timeout) |
| `src/integration.ts` | host | `buildCtxIn` / `applyCtxDelta` / `forwardToolCall` / `forwardValidateInput` / `forwardCommandHook` — the thin aspect you call from dispatch |
| `src/servableTools.ts` | both | the forwardable-tool / idempotent / validate-forward whitelists |
| `src/env.ts` | both | env-var contract (`REMOTE_TOOLS_URL`, …) |
| `src/base.ts` | both | **the single coupling point** to your base runtime — see below |

**Not in scope (you provide these):**

- **Your agent base.** This package is built for a Claude Code-compatible runtime
  that already exposes the tool interfaces in `src/base.ts`. It does not ship a
  base and is not usable without one.
- **The orchestration proxy & sandbox lifecycle.** Provisioning sandboxes,
  per-task volumes, the stable local endpoint, heartbeats, and rebuild-on-crash
  live in *your* infrastructure. The protocol is built to support a proxy in the
  middle (transport errors + idempotent retry), and the included
  [docker example](examples/docker) runs the tool-server directly (no proxy) so
  you can see the forwarding end to end.

## Quickstart (local, stdio)

The simplest wiring: the host self-spawns the tool-server as a child over stdio.

1. Wire `src/base.ts` to your base runtime (one file — see
   [INTEGRATION.md](docs/INTEGRATION.md)).
2. Add the `--tool-server` entrypoint to your CLI:
   ```ts
   if (process.argv[2] === '--tool-server') {
     const { runToolServer } = await import('agent-tool-server/sandbox')
     await runToolServer(process.argv.slice(3))
     return
   }
   ```
3. Add the three call sites in your dispatch / hook paths (see
   [INTEGRATION.md](docs/INTEGRATION.md)).
4. Run the host with `REMOTE_TOOLS_URL=stdio` — tools now execute in a child
   process. Point it at a real sandbox with `REMOTE_TOOLS_URL=wss://host:port/`.

## Documentation

- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the wire protocol: four frame types and
  the `ctxIn`/`ctxDelta` state contract that keeps host and sandbox in sync.
- [docs/INTEGRATION.md](docs/INTEGRATION.md) — the three host call sites and the
  one base-wiring file, described as semantic anchors (no diffs against any base).
- [docs/SECURITY.md](docs/SECURITY.md) — the credential red lines, why hooks must
  be forwarded, the plan-path anti-traversal rule, and env sanitization.
- [docs/LESSONS.md](docs/LESSONS.md) — non-obvious bugs we hit, so you don't.

## Status

Extracted from a production deployment. APIs may shift before 1.0. Contributions
and a reference proxy/provider are welcome.

## License

[Apache-2.0](LICENSE).

This project is designed to run inside a Claude Code-compatible agent runtime
that you supply separately; it contains no third-party agent code. "Claude" and
"Claude Code" are trademarks of Anthropic — this project is not affiliated with
or endorsed by Anthropic, and the name is used only to describe compatibility.
