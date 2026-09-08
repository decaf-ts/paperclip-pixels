/**
 * Conversation-extract shaping for the dialog pane (spec
 * PAPERCLIP_PIXELS-2, WS4-C; PAPERCLIP_PIXELS-1 NFR-7; CEO decision 2).
 *
 * Pure, deterministic text hygiene applied PLUGIN-SIDE (in the Paperclip
 * worker, before anything rides the wire): whatever the dialog pane later
 * shows, the raw sensitive prompt never leaves this plugin unredacted. Two
 * layers, both applied here rather than in any renderer:
 *
 * 1. **Secret redaction (always on, both modes).** Bearer tokens, credential
 *    assignments, and long credential-shaped runs are replaced with
 *    `[redacted]` before any truncation decision. A dialog pane is a
 *    lossy summary surface, never a log sink — secrets must not ride it
 *    even when the company opted in.
 * 2. **Extract truncation (mode-dependent).** With the per-company
 *    `dialogPanePrivacyOptIn` toggle OFF (the default), a comment body is
 *    cut to a short redacted excerpt; with the toggle ON, a fuller — but
 *    still bounded — excerpt ships. Neither mode ever ships a full
 *    unbounded prompt; the wire cap {@link DIALOG_LINE_MAX_CHARS} is the
 *    same in both modes.
 */

/**
 * Maximum characters of a comment body shipped with the privacy toggle OFF
 * (default). Deliberately short: an excerpt that hints at the conversation
 * without reproducing it.
 */
export const DIALOG_EXTRACT_MAX_CHARS_REDACTED = 120;

/**
 * Maximum characters of a comment body shipped with the privacy toggle ON.
 * Fuller than the redacted excerpt, still far from a full prompt.
 */
export const DIALOG_EXTRACT_MAX_CHARS_OPT_IN = 480;

/**
 * Hard wire cap for ANY dialog line (composed lines include an author
 * prefix; both modes share this ceiling). The feed apply side clamps to it
 * again as defense in depth — a bug upstream can never push an unbounded
 * payload through the pane.
 */
export const DIALOG_LINE_MAX_CHARS = 600;

/** Ellipsis appended when an extract is cut mid-text. */
const TRUNCATION_MARK = "…";

/** Credential-bearing `Authorization: Bearer …` headers and prose forms. */
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** Credential-bearing `Authorization: Basic …` headers and prose forms
 * (base64 `user:password` pairs — short values sit under the long-run
 * threshold, so they need their own pass). */
const BASIC_PATTERN = /\bBasic\s+[A-Za-z0-9._~+/=-]{4,}={0,2}/gi;

/** `api_key=…` / `"db_password": …` style credential assignments. The key
 * name match allows leading/trailing identifier characters (so compound
 * keys like `db_password` or `MY_API_TOKEN` are caught — `_` is a word
 * character and would otherwise shield them from a `\b` anchor). */
const ASSIGNMENT_PATTERN =
  /([A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token|password|passwd|authorization)[A-Za-z0-9_-]*)["']?\s*[:=]\s*["']?[^\s"']{6,}/gi;

/** Long credential-shaped runs (JWTs, hex/base64 keys, PATs). */
const LONG_CREDENTIAL_PATTERN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

/**
 * Replace obvious secrets with `[redacted]`. Ordered: bearer forms first
 * (most specific), then basic-auth forms, then assignments, then bare long
 * runs. False positives
 * (a long hash quoted in prose) are acceptable on a summary surface;
 * false negatives are not, hence the broad final pass.
 */
export function redactSensitiveText(text: string): string {
  return text
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(BASIC_PATTERN, "Basic [redacted]")
    .replace(ASSIGNMENT_PATTERN, (match) => {
      // Keep the key name, drop the value: `api_key: k123…` → `api_key: [redacted]`.
      const separator = match.search(/[:=]/);
      if (separator === -1) return "[redacted]";
      return `${match.slice(0, separator).trimEnd()}=[redacted]`;
    })
    .replace(LONG_CREDENTIAL_PATTERN, "[redacted]");
}

/** Collapse all whitespace runs to single spaces and trim. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cut `text` to at most `maxChars`, appending the ellipsis when cut. */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}${TRUNCATION_MARK}`;
}

/**
 * Build the dialog-pane extract of one conversation body (a comment).
 * Always redacts secrets; truncates to the mode-dependent excerpt length.
 * Returns the empty string when nothing presentable remains.
 */
export function dialogExtract(body: string, optIn: boolean): string {
  const redacted = redactSensitiveText(body ?? "");
  const collapsed = collapseWhitespace(redacted);
  if (collapsed.length === 0) return "";
  return truncate(collapsed, optIn ? DIALOG_EXTRACT_MAX_CHARS_OPT_IN : DIALOG_EXTRACT_MAX_CHARS_REDACTED);
}

/**
 * Clamp an already-composed dialog line (author prefix + activity text)
 * to the shared wire cap. Composed lines carry no raw prompt bodies, but
 * the cap applies uniformly: nothing unbounded reaches the pane.
 */
export function clampDialogLine(text: string): string {
  const collapsed = collapseWhitespace(text ?? "");
  if (collapsed.length === 0) return "";
  return truncate(collapsed, DIALOG_LINE_MAX_CHARS);
}
