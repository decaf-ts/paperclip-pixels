/**
 * paperclip-pixels-common
 *
 * Neutral wire contract package (board Revision 3 migration-plan step 1-2).
 * Schemas only: DTOs, Zod validation, operation ids, error codes,
 * schemaVersion compatibility rules, fixture builders, and contract tests.
 *
 * Hard neutrality rules (audit: "schemas only"):
 *  - imports no Paperclip SDK code, React, Pixel Agents server code, or
 *    filesystem APIs;
 *  - knows no other package at runtime;
 *  - carries no runtime host code (the metric reducer stays with the
 *    Paperclip plugin).
 */

export * from "./version.js";
export * from "./constants.js";
export * from "./pluginHost.js";
export * from "./feed.js";
export * from "./appearance.js";
export * from "./layout.js";
export * from "./composition.js";
export * from "./events.js";
export * from "./analytics.js";
export * from "./action.js";
export * from "./bridge.js";
export * from "./fixtures.js";
