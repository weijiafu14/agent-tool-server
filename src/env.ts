/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * Environment-variable contract.
 *
 * Primary names are vendor-neutral (REMOTE_TOOLS_URL, ...). For backward
 * compatibility each reader also accepts a legacy alias prefixed with the
 * original project name (LEGACY_*), so an existing deployment that vendors this
 * package in keeps working without re-plumbing its launcher. Prefer the primary
 * name for anything new; the alias may be dropped in a future major version.
 */

/** Primary env name → legacy alias accepted as a fallback. */
export const ENV_ALIASES = {
  REMOTE_TOOLS_URL: 'LEGACY_REMOTE_TOOLS_URL',
  REMOTE_CALL_TIMEOUT_MS: 'LEGACY_REMOTE_CALL_TIMEOUT_MS',
} as const

function readWithAlias(primary: keyof typeof ENV_ALIASES): string | undefined {
  return process.env[primary] ?? process.env[ENV_ALIASES[primary]] ?? undefined
}

/**
 * The forwarding transport URL. When unset, tools execute natively in-process
 * and the package adds zero overhead (the host code path is byte-for-byte the
 * original). Supported forms:
 *   - `stdio`                spawn `process.execPath --tool-server` (self-spawn).
 *   - `stdio:<cmd...>`       spawn the given command as a long-lived tool-server.
 *   - `ws://host:port` / `wss://...`  connect to a tool-server's WebSocket.
 */
export function getRemoteToolsUrl(): string | undefined {
  return readWithAlias('REMOTE_TOOLS_URL')
}

/** True when this process should forward tool execution to a remote tool-server. */
export function isRemoteMode(): boolean {
  return !!getRemoteToolsUrl()
}

/**
 * Fallback per-call timeout (ms). The orchestration proxy normally reports a
 * dead sandbox far sooner (connection close / heartbeat); this is the last
 * resort against a half-dead connection leaving a call pending forever.
 * Default 15min (> a typical 10min max Bash timeout). `<= 0` disables it.
 */
export function getRemoteCallTimeoutMs(): number {
  const raw = readWithAlias('REMOTE_CALL_TIMEOUT_MS')
  const v = Number(raw)
  return Number.isFinite(v) && !Number.isNaN(v) ? v : 15 * 60 * 1000
}

/**
 * Env keys set on the tool-server (sandbox) process so the base can detect that
 * it is running in execution-only mode — e.g. a shell provider that needs to
 * `cd` to the authoritative cwd before each command (the process cwd defaults
 * to the image WORKDIR and would otherwise drift from the host's cwd).
 *
 * Both the primary key and the legacy alias are set, so a base that checks
 * either name works.
 */
export const TOOL_SERVER_ENV_KEYS = ['TOOL_SERVER_MODE', 'LEGACY_TOOL_SERVER'] as const

/** Mark the current process as a tool-server (execution-only) process. */
export function markToolServerProcess(): void {
  for (const key of TOOL_SERVER_ENV_KEYS) process.env[key] = '1'
}
