/**
 * Structural mirror of the Pixel Agents public provider contract
 * (`pixel-agents/core/src/provider.ts`, cited by spike SAA-175 §1).
 *
 * Pixel Agents does not currently ship an installable types package for its
 * `core` (it is a git submodule with no package.json under `core/`), and NFR-8
 * forbids invasive core hacks or reaching into submodule internals at runtime.
 * This file therefore mirrors only the *public, exposed* `AgentEvent` union
 * (`provider.ts:14-63`) and the `HookProvider` interface (`provider.ts:67-148`)
 * as type-only contracts. `PaperclipBridgeProvider` is structurally assignable
 * to the real `HookProvider` at registration time (after the upstream
 * per-`providerId` dispatch change recommended by the spike), without this
 * package importing or modifying the submodule.
 *
 * Keep this mirror in sync with `pixel-agents/core/src/provider.ts` until
 * Pixel Agents exposes an installable types package; then replace it with a
 * real type import. Any divergence is a source-verification gap (spec §40).
 */

/**
 * Placeholder for the upstream `TeamProvider` interface. The bridge provider is
 * single-agent / push-based and never sets `team`, so this marker only exists
 * to satisfy the `HookProvider.team?` optional field shape. Modeled as
 * `unknown` (not an empty interface) because the bridge never constructs one.
 */
export type TeamProvider = unknown;

/**
 * Normalized events every provider type produces. Verbatim shape of
 * `pixel-agents/core/src/provider.ts:14-63`.
 *
 * The bridge maps ONLY the lifecycle / idle / waiting / permission subset:
 * `sessionStart`, `sessionEnd`, `turnEnd(awaitingInput=false)`,
 * `turnEnd(awaitingInput=true)`, and `permissionRequest`. It never emits
 * `toolStart`/`toolEnd`/`subagent*` (no genuine Paperclip correspondence,
 * FR-14) — those richer semantics live in the sidecar (§21.5).
 */
export type AgentEvent =
  | {
      kind: "toolStart";
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: "toolEnd"; toolId: string }
  | {
      kind: "turnEnd";
      /** True when the turn ended because the agent went idle waiting on the
       *  user rather than simply finishing its response. Drives the "Waiting
       *  for input" vs "Done" label. Absent/false = the agent finished its
       *  turn (Done). */
      awaitingInput?: boolean;
    }
  | {
      kind: "subagentStart";
      parentToolId: string;
      toolId: string;
      toolName: string;
      input?: unknown;
      runInBackground?: boolean;
    }
  | { kind: "subagentEnd"; parentToolId: string; toolId: string }
  | {
      kind: "subagentTurnEnd";
      parentToolId: string;
      reason: "idle" | "completed";
    }
  | { kind: "progress"; toolId: string; data: unknown }
  | { kind: "permissionRequest" }
  | {
      kind: "sessionStart";
      source?: string;
      transcriptPath?: string;
      cwd?: string;
    }
  | { kind: "sessionEnd"; reason?: string };

/**
 * Hook-based provider contract. Verbatim shape of
 * `pixel-agents/core/src/provider.ts:67-148`. Optional CLI-hook-specific
 * members are retained so the mirror stays structurally identical; the bridge
 * provider leaves the CLI-only optionals unset.
 */
export interface HookProvider {
  readonly kind: "hook";
  readonly id: string;
  readonly displayName: string;
  readonly protocolVersion: number;

  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  installHooks(serverUrl: string, authToken: string): Promise<void>;
  uninstallHooks(): Promise<void>;
  areHooksInstalled(): Promise<boolean>;
  consentDisclosure(): { headline: string; disclosure: string };

  formatToolStatus(toolName: string, input?: unknown): string;
  readonly permissionExemptTools: ReadonlySet<string>;
  readonly subagentToolNames: ReadonlySet<string>;
  readonly readingTools: ReadonlySet<string>;
  readonly terminalNamePrefix?: string;

  contextWindowForModel?(model: string | undefined): number | undefined;

  getSessionDirs?(workspacePath: string): string[];
  getAllSessionRoots?(): string[];
  readonly sessionFilePattern?: string;
  parseTranscriptLine?(line: string): AgentEvent | null;
  buildLaunchCommand?(
    sessionId: string,
    cwd: string,
    opts?: { bypassPermissions?: boolean },
  ): {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };

  readonly team?: TeamProvider;
}

/** A mapped AgentEvent bound to the synthetic session id of its agent. */
export interface SessionAgentEvent {
  sessionId: string;
  event: AgentEvent;
}
