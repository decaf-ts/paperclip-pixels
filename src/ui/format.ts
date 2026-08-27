/**
 * Display formatting helpers for the bridge UI (spec PAPERCLIP_PIXELS-1,
 * §26.2, §11.11–11.12, FR-15).
 *
 * Behavioral proxies are rendered as operational estimates with explicit
 * confidence — never as factual emotion.
 */

/** Format a normalized [0, 1] value as a rounded percentage. */
export function formatPercent(value: number): string {
  const clamped = Math.min(1, Math.max(0, value));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Semantic band for a normalized value. Thresholds match the core store's
 * hysteresis bands (spec §24) so UI copy and renderer bands agree.
 */
export function bandLabel(value: number): "low" | "moderate" | "high" {
  if (value >= 0.72) return "high";
  if (value >= 0.42) return "moderate";
  return "low";
}

/** Human-readable timestamp; falls back to the raw value when unparseable. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Short display form of a canonical Paperclip ID (first 8 chars). */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * Disclaimer copy for optional higher-level proxies (spec §11.11, §11.12,
 * FR-15). These are operational estimates, never claims about subjective
 * emotion.
 */
export const STRESS_PROXY_NOTE =
  "Operational-pressure estimate derived from workload and friction. Not a claim about subjective emotion.";

export const ENGAGEMENT_PROXY_NOTE =
  "Operational estimate of sustained, unblocked activity. Not a claim about satisfaction or emotion.";
