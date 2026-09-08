/**
 * Wire schema versioning + protocol compatibility rules
 * (board Revision 3: "keep `schemaVersion` discipline where cheap").
 *
 * Every serialized payload that crosses the Paperclip ↔ Pixel Agents wire
 * carries an explicit integer `schemaVersion`. This module is the single
 * source of truth for those constants and the non-throwing compatibility
 * check used by both sides.
 *
 * The board waived the full version-drift compatibility matrix ("ignored we
 * control versioning"), so this is deliberately a cheap discipline: a current
 * version is accepted, an unsupported version is rejected with a diagnostic.
 */

/** Current canonical bridge schema version (§33.1, NFR-6). */
export const SCHEMA_VERSION = 1 as const;

/** Current plugin feed wire schema version (WS2-C). */
export const PLUGIN_FEED_SCHEMA_VERSION = 1 as const;

/** Current bridge data snapshot schema version (spec §15). */
export const BRIDGE_SCHEMA_VERSION = 1 as const;

/** Current character-composition (appearance DTO v2) schema version (WS5a). */
export const COMPOSITION_SCHEMA_VERSION = 2 as const;

/** The only schema versions this codebase currently speaks. */
export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export type WireSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

/** Shape of the `schemaVersion` discriminator every wire envelope carries. */
export interface Versioned {
  schemaVersion: WireSchemaVersion;
}

/**
 * Non-throwing compatibility check for a wire payload's `schemaVersion`.
 *
 * Returns a list of violations (empty when the version is current). The
 * caller decides the fail-closed posture (reject the batch / refuse the
 * push). Kept synchronous and pure so both the push side and the apply side
 * can share it.
 */
export function checkWireSchemaVersion(
  version: unknown,
  current: number = SCHEMA_VERSION,
): string[] {
  if (version === current) return [];
  if (typeof version !== "number") return ["schemaVersion must be a number"];
  return [
    `schemaVersion ${String(version)} is unsupported; this build accepts ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}`,
  ];
}

/** True when a wire payload carries the current schema version. */
export function isCurrentSchemaVersion(version: unknown): boolean {
  return version === SCHEMA_VERSION;
}

/** True when a wire payload carries the plugin feed schema version. */
export function isCurrentFeedSchemaVersion(version: unknown): boolean {
  return version === PLUGIN_FEED_SCHEMA_VERSION;
}
