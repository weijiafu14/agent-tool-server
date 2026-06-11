# Security model

The threat model is **untrusted workspace contents and untrusted model output**.
The agent may be steered (by prompt injection in files, or by the workspace's own
config) into trying to exfiltrate credentials or execute code on the host. The
split-brain design is what contains that, and these are the invariants that make
it hold.

## Red lines (never crossed)

1. **The LLM key, git credentials, and any cloud / service-account token never
   enter the sandbox.** The sandbox is pure execution: it does not call the model
   and does not run git, so it never needs them. They stay on the host.
2. **The sandbox is disposable, per task.** Workspace lives on a per-task volume;
   session lives on the host. Nothing of value is lost when a sandbox is destroyed.
3. **If a sandbox cannot be provisioned, never silently fall back to running
   untrusted code without isolation.** Degrade to another isolated runtime if you
   have one, or fail closed. Running unsandboxed is not an option for untrusted
   input. (This package provides the forwarding layer; *you* enforce this in your
   orchestration when provisioning fails.)

## Why command hooks must be forwarded

A command-type hook is configured to run a shell command on certain events. Two
facts combine into a host RCE:

- Hook configuration can come from the **workspace** (its own settings file),
  which an untrusted task controls.
- Hooks are spawned by the **host agent process** — outside the tool dispatch
  path, so a tool-execution interceptor alone does not cover them.

Left alone, an untrusted workspace injects a command hook and gets arbitrary code
execution on the host on the next event — able to read the git private key, the
host env, anything the agent process can. (We verified this end to end before
fixing it.)

The fix: command hooks travel as their own **hook-exec frame** and run *in the
sandbox*. A hook is **not a tool** — it is never on any whitelist and never goes
through `findToolByName`, so the agent/LLM can never see or call it as a tool. All
hook *control* (matching, output parsing, the exit-2-block decision) stays on the
host; only the `exec` moves. See `src/integration.ts` (`forwardCommandHook`) and
`src/toolServer.ts` (`handleHookExec`).

### Hook env sanitization

Only `CLAUDE_*` keys (the hook env convention) cross into the sandbox, and even
those are filtered:

- `CLAUDE_ENV_FILE` is dropped (a host-home path that would not line up with the
  sandbox, and a vector for env-file chaining).
- `CLAUDE_PLUGIN_OPTION_*` is dropped (may carry sensitive plugin config).
- A blacklist backstop strips any key whose name matches
  `KEY|TOKEN|SECRET|OAUTH|CERT|PASS|CRED|AUTH|BEARER|INGRESS`, so a credential
  that happens to start with `CLAUDE_` (e.g. `CLAUDE_*_TOKEN`) still never
  travels. Allowlist *and* blacklist — do not rely on "sensitive vars happen not
  to start with `CLAUDE_`."

Host system env is never forwarded; the sandbox merges the filtered hook env onto
its **own** process env.

## Plan-file write is anti-traversal

In plan mode the plan file is written by the model's `Write`, which is forwarded —
so the file lands in the sandbox. The host needs a copy (its approval card and
execute step read it), so the sandbox reports the written content back via
`ctxDelta.planFileWrite`.

**The host never trusts the path the sandbox reports.** The sandbox is untrusted
(the model could even tamper with the tool-server's memory to forge the path);
writing it directly would be a path-traversal write to any host file — overwrite
`~/.ssh/authorized_keys`, drop a cron job, modify git hooks → host RCE. So the
host recomputes the authoritative plan path itself (same source it used to send
`ctxIn.planFilePath`) and writes only the **content** there. A reported path that
disagrees is logged as an attack signal and discarded. See `applyCtxDelta` in
`src/integration.ts`.

## MCP from an untrusted workspace

A workspace can also inject MCP server config, which would be another arbitrary-
command host RCE on the same footing as hooks. This package does not manage MCP
config, but your host must: for untrusted tenants, **drop workspace- and
user-sourced MCP servers** (keep only platform-provided ones) and run the agent
with strict MCP config (no filesystem auto-discovery from the workspace).

## Defense in depth at the sandbox boundary

The forwarding protocol assumes the sandbox is a real isolation boundary. It does
not provide that boundary — your runtime does. A production deployment for
untrusted input should also, at the platform level:

- **egress**: default-deny + allowlist; block the cloud metadata endpoint
  (`169.254.169.254`); restrict cross-pod/internal network.
- **no service-account token auto-mount** into the sandbox pod.
- **non-root, drop all capabilities, no-new-privileges, seccomp**; read-only
  rootfs; per-task workspace volume destroyed on teardown.
- a user-space-kernel or microVM runtime (gVisor / Kata / Firecracker) rather than
  a shared-kernel namespace sandbox if the input is fully untrusted — a namespace
  sandbox (e.g. bubblewrap) is explicitly *not* a security boundary against a
  determined attacker sharing the host kernel.

These live in your infrastructure, not in this package.
