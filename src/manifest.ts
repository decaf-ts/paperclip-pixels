import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
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

/**
 * Operator-editable, company-scoped configuration for the bridge relay that
 * pushes mapped AgentEvents to a Pixel Agents server's hook endpoint. The
 * relay is enabled by default once `pixelAgentsUrl` is set.
 */
/**
 * JSON schema defining the operator‑editable, company‑scoped configuration for
 * the bridge relay. The schema is used by the plugin SDK to render a UI for
 * configuring the Pixel Agents connection and to validate the stored config.
 */
const relayConfigSchema: JsonSchema = {
  type: "object",
  properties: {
    pixelAgentsUrl: {
      type: "string",
      title: "Pixel Agents server URL",
      description:
        "Base URL of the paperclip-pixel-relay companion (not Pixel Agents itself). Public endpoints must use https; the bundled loopback/Compose sidecar may use http. Defaults to http://127.0.0.1:8081.",
      format: "uri",
    },
    pixelAgentsUiUrl: {
      type: "string",
      title: "Pixel Agents browser URL",
      description:
        "Browser-reachable URL embedded in the Pixel Office page. This is normally http://localhost:8090 for the bundled Compose deployment and is distinct from the worker-to-relay URL.",
      format: "uri",
      default: "http://localhost:8090",
    },
    pixelAgentsTokenRef: {
      format: "secret-ref",
      anyOf: [
        { type: "string" },
        {
          type: "object",
          additionalProperties: false,
          required: ["type", "secretId"],
          properties: {
            type: { const: "secret_ref" },
            secretId: { type: "string", format: "uuid" },
            version: {
              anyOf: [
                { const: "latest" },
                { type: "integer", minimum: 1 },
              ],
            },
          },
        },
      ],
      title: "Pixel Agents bearer token",
      description:
        "Optional secret reference resolved to the bearer token sent on each push to POST /api/hooks/<providerId>. Stored as a secret_ref binding, never as a plaintext value. Requires an https: pixelAgentsUrl. Not needed for the bundled sidecar default.",
    },
    pixelAgentsProviderId: {
      type: "string",
      pattern: "^[a-z0-9-]+$",
      title: "Provider id",
      description: "Provider id used in the hook path. Defaults to 'claude' — the only id Pixel Agents' unmodified route currently dispatches on.",
      default: "claude",
    },
    pixelAgentsRelayEnabled: {
      type: "boolean",
      title: "Relay enabled",
      description: "Explicit on/off. Defaults to on when pixelAgentsUrl is set.",
    },
  },
};

/**
 * Plugin manifest describing the Paperclip Pixel Bridge plugin.
 * Includes metadata, entrypoints, UI slot configuration, and job definitions.
 */
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
  instanceConfigSchema: relayConfigSchema,
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
      {
        type: "settingsPage",
        id: UI_SLOT_IDS.settings,
        displayName: "Pixel Office Settings",
        exportName: UI_EXPORT_NAMES.settings,
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
