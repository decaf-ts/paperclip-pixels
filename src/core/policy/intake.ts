/**
 * Company / leadership intake policy (spec §5.2, §15, §17).
 *
 * Company/leadership intake is the ONLY path that may originate unrestricted
 * new-work intent. This module provides pure validation/classification for the
 * worker's `company.send-message` action handler. It does NOT itself call any
 * Paperclip SDK client — the worker performs the actual session/send calls.
 */

export interface CompanyIntakeConfig {
  /** Designated leadership agent for intake sessions (spec §17.2). */
  leadershipAgentId: string;
}

export interface CompanyIntakeMessage {
  companyId: string;
  text: string;
  /** Host-authenticated actor (spec §15, §28.4). Supplied by the worker. */
  actor?: { id?: string; type?: string };
}

export type IntakeResult =
  | { kind: "accepted"; companyId: string; leadershipAgentId: string; text: string }
  | { kind: "rejected"; reason: "no-leadership-agent" | "empty-text" };

/**
 * Validate a company intake message. Intake is the unrestricted new-work path,
 * so any non-empty text addressed to the company is accepted here. The hard
 * authorization guarantee is the action path (this is the only intake action),
 * not a language-model classifier (spec §5.2).
 */
export function validateIntake(
  input: CompanyIntakeMessage,
  config: CompanyIntakeConfig,
): IntakeResult {
  if (!config.leadershipAgentId) {
    return { kind: "rejected", reason: "no-leadership-agent" };
  }
  if (!input.text || !input.text.trim()) {
    return { kind: "rejected", reason: "empty-text" };
  }
  return {
    kind: "accepted",
    companyId: input.companyId,
    leadershipAgentId: config.leadershipAgentId,
    text: input.text,
  };
}

/**
 * A heuristic classifier that MAY suggest a freeform text looks like new work.
 * It is advisory only — the hard new-work guarantee comes from the action path
 * in `agent-reply.ts`, never from this classifier alone (spec §5.2).
 */
export function looksLikeNewWork(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  const markers = [
    "also build",
    "also create",
    "also implement",
    "also add",
    "new feature",
    "new project",
    "redesign",
    "build a",
    "create a",
    "implement a",
    "start working on",
    "can you build",
    "can you create",
    "please build",
    "please create",
  ];
  return markers.some((m) => t.includes(m));
}
