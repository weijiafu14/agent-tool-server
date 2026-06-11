/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Whitelists of tools that may be forwarded to a remote tool-server (pure
 * filesystem / exec work on the workspace). The host-side dispatch interceptor
 * and the sandbox-side tool-server share this one source so the two agree.
 *
 * Kept off these lists (host-only): Task (sub-agent — needs the loop + LLM key),
 * AskUserQuestion, ExitPlanMode, TodoWrite. Those require the control loop,
 * credentials, or UI; the sandbox is always pure execution ("Hands").
 *
 * This is a leaf module (no imports) so pulling the whitelist into the agent's
 * dispatch path drags in no tool-server dependencies and creates no import
 * cycle.
 */

/**
 * Tools whose execution may be forwarded to the sandbox tool-server.
 *
 * Background tasks (run_in_background): a Bash background process runs in the
 * sandbox and registers in the sandbox-side app state; TaskOutput / TaskStop
 * are also on this list, so they forward to the same sandbox to read/stop that
 * task list — start / read / kill all work within a turn. Known boundary
 * (accepted as "works within a turn", since the sandbox is created per turn and
 * disposed at turn end):
 *   - Not persistent across turns: the sandbox is disposable; a long-lived dev
 *     server would need a per-task persistent sandbox (out of scope here).
 *   - A background task's own completion notification fires inside the sandbox;
 *     it is pushed back to the host via a notify frame (see toolServer.ts), so
 *     the agent is notified within the same turn without polling.
 */
export const SERVABLE_TOOLS = new Set<string>([
  'Bash',
  'Read',
  'Write',
  'Edit',
  // Note: MultiEdit has no corresponding tool implementation in the base
  // (getAllBaseTools yields no tool named 'MultiEdit'), so whitelisting it would
  // only make the tool-server's findToolByName return undefined → forwarding
  // would always answer UNKNOWN_TOOL. Hence it is omitted.
  'NotebookEdit',
  'Glob',
  'Grep',
  // Background-task read/stop: forwarded to the sandbox, reading the sandbox's
  // app-state task list (where Bash run_in_background registers, persisted in the
  // same sandbox process). Their call() only reads tasks + updates app state +
  // reads output files; it never touches host UI, so the sandbox context
  // satisfies them. Not in IDEMPOTENT_TOOLS: if the sandbox crashes the
  // background task dies with it, so a transport error fed back to the agent is
  // more honest than retrying into an empty not-found.
  'TaskOutput',
  'TaskStop',
])

/**
 * Tools that are safe to AUTO-RETRY on a transport failure (sandbox crash &
 * rebuild) — idempotent or overwrite semantics, so a replay yields the same
 * result: Read/Glob/Grep are read-only; Write overwrites (rewriting the same
 * content is identical).
 *
 * NOT here (non-idempotent — never blindly retried; the error is fed back to the
 * agent to decide): Bash (arbitrary side effects), Edit/MultiEdit (edits relative
 * to current content — a replay may double-apply or fail to match), NotebookEdit.
 */
export const IDEMPOTENT_TOOLS = new Set<string>(['Read', 'Glob', 'Grep', 'Write'])

/**
 * Tools whose validateInput READS THE FILESYSTEM to validate (file exists /
 * find the old_string to replace / "has this been read?" guard).
 *
 * The host's on-disk view is a snapshot from the start of the turn — the latest
 * files written by shell/Write only exist in the sandbox. Running validateInput
 * on the host would therefore misjudge does-not-exist / string-not-found and
 * make back-to-back edits fail. So in remote mode the validateInput of these
 * tools is FORWARDED INTO THE SANDBOX to run against the real filesystem (see the
 * dispatch interceptor in integration.ts and the validateOnly branch in
 * toolServer.ts's handleRequest).
 *
 *   - Background-task tools (TaskOutput/TaskStop): their validateInput reads the
 *     task list; background tasks register in the SANDBOX's app state, while the
 *     host's is empty → they would always report "No task found" and never reach
 *     the sandbox. Forward so validation uses the sandbox task list.
 *
 * Not included: Read/Bash/Glob/Grep — Read.validateInput deliberately avoids the
 * filesystem (I/O is deferred to call(), checked in the sandbox); the others'
 * validateInput does not depend on sandbox state. They are also high-frequency,
 * so forwarding would add a validate round-trip every time.
 *
 * Note: the sandbox-side validate branch runs ANY tool's validateInput and does
 * NOT consult this whitelist (the whitelist is host-side only, deciding whether
 * to forward). So adding a tool here does NOT require rebuilding the sandbox
 * image — only the host code needs updating.
 */
export const VALIDATE_FORWARD_TOOLS = new Set<string>([
  'Write',
  'Edit',
  'NotebookEdit',
  'TaskOutput',
  'TaskStop',
])

/*
 * Hook forwarding (security-critical). A command-type hook would otherwise be
 * spawned in the HOST agent process. An untrusted workspace can inject a command
 * hook via its own `.<config>/settings.json`; if that ran on the host it would
 * be arbitrary RCE on the host (able to read git keys / host env). The fix routes
 * command-type hooks through a dedicated hook-exec frame into the sandbox
 * tool-server. A hook is NOT a tool — it is never on these whitelists and never
 * goes through findToolByName, so the agent/LLM can never see or call it. All
 * control (matcher / parseHookOutput / exit-2-block decision) stays on the host;
 * only the exec is moved into the sandbox. See:
 *   - host  interceptor   (your hook spawn site — see docs/INTEGRATION.md)
 *   - host  frame sender  remoteClient.ts `execRemoteHook`
 *   - sandbox frame handler toolServer.ts  `handleHookExec`
 * ctx: only `cwd` is carried (host-authoritative); readFileState is not touched
 * (a hook is an external shell, outside the agent's file cache).
 *
 * Known limitations (non-critical, addressed later):
 *   1. async hooks ({"async":true}) degrade to synchronous wait (a sandbox
 *      background process does not persist across turns).
 *   2. interactive hooks (requestPrompt: a hook asking the host for input
 *      mid-run) are unsupported; stdin gets EOF once fed.
 *   3. env-file chains (a SessionStart hook writing env for later Bash to source)
 *      are not propagated (the path embeds host home + session id and would not
 *      line up with the sandbox's Bash).
 *   4. agent / prompt / http / callback hook types are handled on their own host
 *      paths, never reach the interceptor, and are unaffected (not forwarded).
 */
