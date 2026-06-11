/*
 * Copyright 2024 agent-tool-server contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * ============================================================================
 *  base.ts — THE SINGLE COUPLING POINT to your agent's base code.
 * ============================================================================
 *
 *  Everything else in this package imports the host runtime ONLY through this
 *  file. To integrate the package into a Claude Code-compatible agent runtime,
 *  you edit exactly one thing: the BINDINGS section at the bottom — repoint each
 *  binding at the matching module in your base tree. Nothing else changes.
 *
 *  The package is shipped with default stub bindings that compile (so the repo
 *  type-checks on its own) but THROW at runtime. That is intentional: it forces
 *  a deliberate wiring step and makes "I forgot to wire base.ts" a loud, early
 *  failure instead of a subtle bug.
 *
 *  The TYPES below describe the structural contract the package needs from your
 *  base. They are deliberately loose (optional fields + index signatures) so a
 *  real base's richer types remain assignable. If your base already exports
 *  these types, you may instead `export type { ToolUseContext } from '...'` and
 *  delete the local definitions — both work.
 */

// ─────────────────────────────────────────────────────────────────────────
//  TYPES — the structural contract the package expects from the base.
// ─────────────────────────────────────────────────────────────────────────

/** One entry in the "files the agent has read" cache. */
export interface FileStateEntry {
  content?: string
  timestamp: number
  offset?: number
  limit?: number
  isPartialView?: boolean
}

/**
 * The read-file-state cache. The host owns the authoritative copy; the sandbox
 * keeps a per-process mirror. Both expose this Map-like surface.
 */
export interface ReadFileState {
  get(path: string): FileStateEntry | undefined
  set(path: string, value: FileStateEntry): unknown
  delete(path: string): unknown
  entries(): Iterable<[string, FileStateEntry]>
}

/** App-level state. Only the permission context is read by forwarded tools. */
export interface AppState {
  toolPermissionContext?: {
    mode?: string
    alwaysAllowRules?: unknown
    alwaysDenyRules?: unknown
    additionalWorkingDirectories?: Map<string, unknown>
  }
  [key: string]: unknown
}

/** Loose options bag carried inside a tool-use context. */
export interface ToolUseOptions {
  commands?: unknown[]
  tools?: Tools
  mainLoopModel?: unknown
  thinkingConfig?: unknown
  mcpClients?: unknown[]
  mcpResources?: Record<string, unknown>
  isNonInteractiveSession?: boolean
  debug?: boolean
  verbose?: boolean
  agentDefinitions?: unknown
  [key: string]: unknown
}

/**
 * The execution context handed to a tool's `call()`. Only the members the
 * package actually touches are typed; the index signature carries the rest.
 */
export interface ToolUseContext {
  abortController: AbortController
  readFileState: ReadFileState
  getAppState: () => AppState
  setAppState: (mutate: (s: AppState) => AppState) => void
  messages: unknown[]
  options: ToolUseOptions
  toolUseId?: string
  fileReadingLimits?: { maxTokens?: number; maxSizeBytes?: number }
  agentId?: string
  agentType?: string
  userModified?: boolean
  nestedMemoryAttachmentTriggers?: Set<string>
  dynamicSkillDirTriggers?: Set<string>
  setInProgressToolUseIDs?: (...a: unknown[]) => void
  setResponseLength?: (...a: unknown[]) => void
  updateFileHistoryState?: (...a: unknown[]) => void
  updateAttributionState?: (...a: unknown[]) => void
  [key: string]: unknown
}

/** Result of a tool's `call()`. `data` is the payload the host shows the model. */
export interface ToolResult<T = unknown> {
  data?: T
  newMessages?: unknown[]
  [key: string]: unknown
}

/** Opaque progress payload streamed from a tool (e.g. Bash output chunks). */
export type ToolProgressData = unknown

export interface ToolProgress<T = ToolProgressData> {
  toolUseID?: string
  data?: T
}

/** A single tool definition (subset of fields used here). */
export interface Tool {
  name: string
  inputSchema: { safeParse: (input: unknown) => { success: boolean; data?: unknown; error?: unknown } }
  validateInput?: (input: unknown, ctx: ToolUseContext) => Promise<unknown> | unknown
  call: (...args: unknown[]) => Promise<ToolResult<unknown>>
  isMcp?: boolean
}

/** The set of tools available to the agent. */
export type Tools = Tool[]

// ─────────────────────────────────────────────────────────────────────────
//  BINDINGS — ⚠️ EDIT THIS SECTION when integrating into your base. ⚠️
//
//  Replace each stub below with a re-export from the matching module in your
//  base tree, e.g.:
//
//      export { getAllBaseTools }      from '../tools.js'
//      export { enableConfigs }        from '../utils/config.js'
//      export { getCwd }               from '../utils/cwd.js'
//      export { getCwdState, setCwdState } from '../bootstrap/state.js'
//      ...and so on.
//
//  Then delete the `notWired()` stubs. The signatures here are the contract.
// ─────────────────────────────────────────────────────────────────────────

function notWired(name: string): never {
  throw new Error(
    `[agent-tool-server] base binding "${name}" is not wired. ` +
      `Edit src/base.ts and point it at your base runtime.`,
  )
}

/** Build the default app-level state object. */
export function getDefaultAppState(): AppState {
  return notWired('getDefaultAppState')
}

/** Look up a tool by name within the tool set. */
export function findToolByName(_tools: Tools, _name: string): Tool | undefined {
  return notWired('findToolByName')
}

/** Return all built-in tools the agent can run. */
export function getAllBaseTools(): Tools {
  return notWired('getAllBaseTools')
}

/**
 * Allow configuration reads. Must be called before any code path that reads
 * config (model selection, default app state) — otherwise those throw.
 * Idempotent; safe to call when no config exists (creates defaults).
 */
export function enableConfigs(): void {
  return notWired('enableConfigs')
}

/** Create a fresh AbortController-like object (with `.signal` and `.abort()`). */
export function createAbortController(): AbortController {
  return notWired('createAbortController')
}

/** Create a size-bounded read-file-state cache. */
export function createFileStateCacheWithSizeLimit(_size: number): ReadFileState {
  return notWired('createFileStateCacheWithSizeLimit')
}

/** Create an (empty) assistant message used as a tool's parent message. */
export function createAssistantMessage(_opts: { content: unknown[] }): unknown {
  return notWired('createAssistantMessage')
}

/** The model used by the main agent loop (tools may consult it). */
export function getMainLoopModel(): unknown {
  return notWired('getMainLoopModel')
}

/** Read the process-global authoritative working directory. */
export function getCwdState(): string | undefined {
  return notWired('getCwdState')
}

/** Set the process-global authoritative working directory. */
export function setCwdState(_cwd: string): void {
  return notWired('setCwdState')
}

/** Read the effective current working directory (may differ from cwd state). */
export function getCwd(): string {
  return notWired('getCwd')
}

/**
 * Resolve the authoritative plan-file path for an agent (plan mode). Lightweight
 * (joins a plans directory with a slug); safe to call outside plan mode.
 */
export function getPlanFilePath(_agentId?: string): string | undefined {
  return notWired('getPlanFilePath')
}

/** Enqueue a pending notification into the host agent loop's queue. */
export function enqueuePendingNotification(_command: unknown): void {
  return notWired('enqueuePendingNotification')
}

/**
 * Register an emitter that the base calls when a background task finishes. Used
 * sandbox-side to push a completion notification back to the host. On the host
 * the base keeps this unset (no effect when not in sandbox mode).
 */
export function setNotificationEmitter(_emit: (command: unknown) => void): void {
  return notWired('setNotificationEmitter')
}
