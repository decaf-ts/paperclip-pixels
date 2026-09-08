/**
 * Package-local constants for the Pixel Agents plugin surface.
 *
 * These are the Paperclip-host-facing identity values this package ships
 * with (the plugin id registered against the Paperclip host and the package
 * semantic version). They are intentionally local: common's wire contract
 * carries the shared *wire* ids (`PAPERCLIP_PIXEL_PLUGIN_ID`,
 * `ACTION_KEYS`, feed schema version), while this plugin's own identity
 * (the Paperclip plugin registration id + version) belongs to this package.
 */

/** Unique identifier for the Paperclip Pixel plugin (Paperclip host registration). */
export const PLUGIN_ID = "paperclip-pixel.paperclip-plugin";
/** Semantic version of the plugin package. */
export const PLUGIN_VERSION = "0.6.0";
/** Version of the Paperclip Pixel feed wire this plugin speaks. */
export const PLUGIN_FEED_SCHEMA_VERSION = 1 as const;
