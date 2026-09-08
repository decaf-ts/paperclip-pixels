/**
 * Reverse-action wire contract (Pixel Agents → Paperclip).
 *
 * Pixel Agents may *request* an action; Paperclip authorizes and performs it.
 * This module owns the request params (as received by the Paperclip worker
 * action handlers) and the result shapes both sides read. The strict schemas
 * mirror the worker's actual input validation, including the `.strict()`
 * allowlisting of the `renderEnvironment` metadata the host merges in.
 */

import { z } from "zod";

/** `company.send-message` request params. */
export interface CompanySendMessageRequest {
  companyId: string;
  text: string;
}

export const CompanySendMessageRequestSchema: z.ZodType<CompanySendMessageRequest> = z
  .object({
    companyId: z.string().min(1),
    text: z.string().min(1),
  })
  .strict();

/** `agent.reply-to-feedback` request params. */
export interface AgentReplyToFeedbackRequest {
  companyId: string;
  feedbackId: string;
  text: string;
  renderEnvironment?: unknown;
}

export const AgentReplyToFeedbackRequestSchema: z.ZodType<AgentReplyToFeedbackRequest> = z
  .object({
    companyId: z.string().min(1),
    feedbackId: z.string().min(1),
    text: z.string().min(1),
    renderEnvironment: z.unknown().optional(),
  })
  .strict();

/** `agent.set-pixel-appearance` request params. */
export interface SetAgentAppearanceRequest {
  companyId: string;
  agentId: string;
  characterId: string;
  palette: number;
  hueShift: number;
  renderEnvironment?: unknown;
}

export const SetAgentAppearanceRequestSchema: z.ZodType<SetAgentAppearanceRequest> = z
  .object({
    companyId: z.string().min(1),
    agentId: z.string().min(1),
    characterId: z.string().min(1),
    palette: z.number().int().min(0),
    hueShift: z.number().int().min(0).max(360).default(0),
    renderEnvironment: z.unknown().optional(),
  })
  .strict();

/** Result of `company.send-message`. */
export interface CompanySendMessageResult {
  ok: true;
  sessionId: string;
}

/** Result of `agent.reply-to-feedback`. */
export interface AgentReplyToFeedbackResult {
  ok: true;
  feedbackId: string;
  issueId?: string;
  runId?: string;
}

/** Result of `agent.set-pixel-appearance`. */
export interface SetAgentAppearanceResult {
  ok: boolean;
  error?: string;
  assignment?: unknown;
  applied?: boolean;
}

/** Any action-handler result (the union of the ok/err wire shapes). */
export type ActionResult =
  | CompanySendMessageResult
  | AgentReplyToFeedbackResult
  | { ok: false; error: string; details?: unknown }
  | { ok: false; error: string; reason?: string; suggestedText?: string }
  | SetAgentAppearanceResult
  | { ok: boolean; error: string; assignment?: unknown; applied?: boolean };
