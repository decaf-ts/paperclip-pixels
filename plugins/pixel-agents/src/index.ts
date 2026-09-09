/**
 * @paperclip-pixel/pixel-agents-paperclip-plugin
 *
 * The Paperclip bridge as the first first-class Pixel Agents plugin (spec
 * PAPERCLIP_PIXELS-2, WS2-C). Two halves, one wire contract:
 *
 * - **Embedding side** (runs inside the Pixel Agents server process): the
 *   manifest + handlers + `registerPaperclipPixelPlugin` through the WS2-A1
 *   host API, and the mountable `POST /api/plugin-feed` handler
 *   (feed-server.ts) that applies pushed operations through the plugin's
 *   sanctioned agent/team source.
 * - **Push side** (runs inside the Paperclip plugin worker): the feed mapper
 *   (canonical bridge events → feed operations) and the HTTP sink that
 *   delivers them to the embedding surface.
 *
 * The retired impersonation surfaces (Claude-hook wire format, synthetic
 * team-metadata transcripts, `saveAgentSeats` seat-driving) have no
 * counterpart here by construction.
 *
 * This package depends only on `paperclip-pixels-common` (the neutral wire
 * contract) plus its own local runtime helpers (`constants.ts`, `dialog.ts`,
 * `characters.ts`). It never imports the Paperclip plugin package or the
 * outer `src/` tree.
 */

export {
  PAPERCLIP_PIXEL_PLUGIN_ID,
  PAPERCLIP_PLUGIN_ACTIONS,
  PAPERCLIP_PLUGIN_STARTED_MESSAGE,
  PAPERCLIP_DIALOG_LINES_MESSAGE,
  PAPERCLIP_REPLY_MENU_ITEM,
  BASE_PIXEL_PLUGIN_ID,
  PAPERCLIP_OVERRIDE_TARGET,
  PAPERCLIP_OVERRIDE_CAPABILITIES,
  PAPERCLIP_OVERRIDE_CAPABILITY_IDS,
  createPaperclipPluginManifest,
} from "./manifest.js";

export {
  createFeedAppearanceApplier,
  loadPluginCharacterSheets,
} from "./appearance.js";
export type { PluginCharacterSheets, AppearanceLog } from "./appearance.js";

export {
  createPaperclipPluginHandlers,
  createPaperclipPluginRegistration,
  registerPaperclipPixelPlugin,
} from "./plugin.js";
export type { PaperclipPluginDeps } from "./plugin.js";

export {
  HttpReplyForwarder,
  parseReplyPayload,
} from "./reply-forwarder.js";
export type {
  ReplyFetchLike,
  ReplyForwarder,
  ReplyForwardRequest,
  ReplyForwardResult,
  HttpReplyForwarderOptions,
} from "./reply-forwarder.js";

export {
  PLUGIN_FEED_SCHEMA_VERSION,
  validatePluginFeedBatch,
} from "./feed.js";
export type {
  PluginFeedActivityOperation,
  PluginFeedAppearanceAssignmentOperation,
  PluginFeedBatch,
  PluginFeedDialogLine,
  PluginFeedDialogLinesOperation,
  PluginFeedOperation,
  PluginFeedStatusOperation,
} from "./feed.js";

export { PluginFeedMapper } from "./feed-mapper.js";
export type { FeedAppearanceEntry, PluginFeedMapperOptions } from "./feed-mapper.js";

export { PluginFeedHttpSink } from "./feed-sink.js";
export type { FeedFetchLike, PluginFeedSinkOptions } from "./feed-sink.js";

export {
  createPluginFeedHandler,
  DeclaredAgentCache,
} from "./feed-server.js";
export type {
  PluginFeedAppearanceSink,
  PluginFeedDialogSink,
  PluginFeedHandlerOptions,
  PluginFeedHandlerResult,
} from "./feed-server.js";

export {
  PLUGIN_FEED_PATH,
  bearerTokenMatches,
  createEmbeddingRequestHandler,
  parseEmbeddingEnv,
} from "./embedding.js";
export {
  // Aliased: `register` is the fork plugin-module contract's generic name,
  // but this package's export surface names things by what they register.
  register as registerPaperclipPixelEmbedding,
} from "./embedding.js";
export type { EmbeddingConfig } from "./embedding.js";

export type {
  BaseCapabilityImpl,
  CapabilityFallback,
  CapabilityId,
  CapabilityImplementation,
  PixelAgentsPluginContext,
  PixelAgentsPluginHandlers,
  PixelAgentsPluginHost,
  PixelAgentsPluginManifest,
  PixelAgentsPluginRegistration,
  PluginActionDeclaration,
  PluginActionHandler,
  PluginAgentDeclaration,
  PluginAgentSource,
  PluginAgentStatusUpdate,
  PluginAppearanceSource,
  PluginCapabilityDeclaration,
  PluginCharacterSheetDeclaration,
  PluginContributions,
  PluginMessageDeclaration,
  PluginSourceDeclarations,
} from "paperclip-pixels-common";
