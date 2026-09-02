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
 * pushes plugin feed operations (agent declarations, status, activity) to the
 * Paperclip plugin's embedding surface inside Pixel Agents. The relay is
 * enabled by default once `pixelAgentsUrl` is set.
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
      title: "Pixel Agents companion URL",
      description:
        "Base URL of the companion sidecar that embeds the Paperclip plugin inside Pixel Agents and serves POST /api/plugin-feed. Public endpoints must use https; plain http is only accepted for loopback hosts (localhost, 127.0.0.0/8, ::1). Defaults to http://127.0.0.1:8081.",
      format: "uri",
    },
    pixelAgentsUiUrl: {
      type: "string",
      title: "Pixel Agents browser URL",
      description:
        "Browser-reachable URL embedded in the Pixel Office page. This is normally http://localhost:8090 for the bundled Compose deployment and is distinct from the worker-to-companion URL.",
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
        "Optional secret reference resolved to the bearer token sent on each plugin feed push to the companion. Stored as a secret_ref binding, never as a plaintext value. Requires an https: pixelAgentsUrl (plain http is only accepted for loopback hosts). Not needed for the bundled sidecar default.",
    },
    pixelAgentsRelayEnabled: {
      type: "boolean",
      title: "Relay enabled",
      description: "Explicit on/off. Defaults to on when pixelAgentsUrl is set.",
    },
    paperclipApiBaseUrl: {
      type: "string",
      title: "Paperclip API base URL (for real tool descriptions)",
      description:
        "Base URL this plugin worker calls to read a run's raw execution log (GET /api/heartbeat-runs/:runId/log), used to show real per-tool-call status (\"Reading X\"/\"Using Y\") instead of the generic \"Task: …\" placeholder. Defaults to http://127.0.0.1:3100 (the worker runs in the same container as the Paperclip server in the bundled Compose deployment). Also the base URL the embedding side's reply forwarder uses to route click-menu replies through this plugin's existing actions. Only used when paperclipApiTokenRef is also set.",
      format: "uri",
    },
    paperclipApiTokenRef: {
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
      title: "Paperclip API bearer token (for real tool descriptions)",
      description:
        "A board API key, resolved to a bearer token for GET /api/heartbeat-runs/:runId/log calls. Optional -- without it, Pixel Agents shows the generic \"Task: …\" placeholder instead of a real tool name/file, but everything else (names, rooms, busy/idle status) keeps working unaffected.",
    },
    dialogPanePrivacyOptIn: {
      type: "boolean",
      title: "Conversation dialog pane (privacy opt-in)",
      description:
        "Per-company opt-in for the agent conversation dialog pane (WS4 conversation-extract feed). Default OFF: when off, the pane shows only a redacted/truncated extract, never full sensitive prompts (PAPERCLIP_PIXELS-1 NFR-7; locked CEO decision 2).",
      default: false,
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
      // No custom `settingsPage` slot: the host auto-renders an editable
      // global config form from `instanceConfigSchema` (PAPERCLIP_PIXELS-2
      // WS0 task 2). A custom slot would suppress that form.
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
