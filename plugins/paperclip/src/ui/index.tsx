/**
 * Pixel Agents plugin UI entry (spec PAPERCLIP_PIXELS-1, §14, §27).
 *
 * The host loads this bundle into the plugin's declared UI slots and mounts
 * the named export matching each slot's `exportName` (PLUGIN_SPEC §19).
 *
 * - `pixel-office-page` → `PixelOfficePage` (Design/View)
 * - `pixel-office-config-page` → `PixelOfficeConfigPage` (Configuration)
 * - `pixel-office-sidebar` → `PixelOfficeSidebar`
 * - `agent-detail-character` → `AgentCharacterDetailTab` (agent detailTab)
 *
 * Trust boundary (FR-9, §28.2): the UI talks only to the plugin worker via
 * the SDK bridge hooks. No Paperclip HTTP routes are called from this bundle.
 */

export { PixelOfficePage } from "./PixelOfficePage";
export { PixelOfficeConfigPage } from "./PixelOfficeConfigPage";
export { PixelOfficeSidebar } from "./PixelOfficeSidebar";
export { AgentCharacterDetailTab } from "./AgentCharacterDetailTab";
