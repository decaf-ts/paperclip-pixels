import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  JOB_KEYS,
  MANIFEST_CAPABILITIES,
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PLUGIN_VERSION,
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
  entrypoints: {
    worker: "./dist/worker.js",
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
