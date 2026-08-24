import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  JOB_KEYS,
  MANIFEST_CAPABILITIES,
  PIXEL_OFFICE_PAGE_ROUTE,
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PLUGIN_VERSION,
  UI_EXPORT_NAMES,
  UI_SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: PLUGIN_API_VERSION,
  version: PLUGIN_VERSION,
  displayName: "Paperclip Pixel Bridge",
  description:
    "Loss-minimizing translation layer that makes Paperclip organizational state legible inside the Pixel Agents graphical environment. Observes Paperclip events, computes behavioral proxies, and exposes a canonical bridge contract — without duplicating business truth.",
  author: "Paperclip",
  categories: ["ui", "automation", "connector"],
  capabilities: [...MANIFEST_CAPABILITIES],
  /** Entrypoints for the plugin: worker script and UI bundle. */
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  /** UI slot configuration exposed to the host. */
  ui: {
    slots: [
      {
        /** Page slot for the Pixel Office page. */
        type: "page",
        id: UI_SLOT_IDS.page,
        displayName: "Pixel Office",
        exportName: UI_EXPORT_NAMES.page,
        routePath: PIXEL_OFFICE_PAGE_ROUTE,
      },
      {
        /** Sidebar slot for the Pixel Office sidebar component. */
        type: "sidebar",
        id: UI_SLOT_IDS.sidebar,
        displayName: "Pixel Office",
        exportName: UI_EXPORT_NAMES.sidebar,
      },
    ],
  },
  jobs: [
    {
      jobKey: JOB_KEYS.reconciliation,
      displayName: "Bridge Reconciliation",
      description:
        "Periodic authoritative reconciliation that repairs drift between the event-derived state and Paperclip's canonical state.",
      schedule: "*/5 * * * *",
    },
  ],
};

export default manifest;
