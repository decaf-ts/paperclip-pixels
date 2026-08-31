import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { JOB_KEYS, MANIFEST_CAPABILITIES, PLUGIN_API_VERSION, PLUGIN_ID, PLUGIN_VERSION } from "../src/constants.js";
import manifest from "../src/manifest.js";

describe("manifest", () => {
  it("identifies the least-privilege worker plugin", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.apiVersion).toBe(PLUGIN_API_VERSION);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.displayName).toBe("Paperclip Pixel Bridge");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.author).toBe("Paperclip");
  });

  it("points the worker entrypoint at the built worker", () => {
    expect(manifest.entrypoints.worker).toBe("./dist/worker.js");
  });

  it("declares the bridge reconciliation job", () => {
    expect(manifest.jobs).toHaveLength(1);
    const job = manifest.jobs?.[0];
    expect(job?.jobKey).toBe(JOB_KEYS.reconciliation);
    expect(job?.displayName).toBe("Bridge Reconciliation");
    expect(typeof job?.schedule).toBe("string");
  });

  it("declares exactly the constants capability set", () => {
    expect(manifest.capabilities).toEqual([...MANIFEST_CAPABILITIES]);
  });

  it("declares comment-create capabilities but no issue-create/update capabilities", () => {
    expect(manifest.capabilities).toContain("issue.subtree.read");
    expect(manifest.capabilities).toContain("issue.comments.create");
    expect(manifest.capabilities).toContain("issue.comments.create_human_attributed");
    expect(manifest.capabilities).not.toContain("issues.create");
    expect(manifest.capabilities).not.toContain("issues.update");
  });

  it("declares the http.outbound capability for the relay push (trust boundary)", () => {
    expect(manifest.capabilities).toContain("http.outbound");
  });

  it("refuses issues.create through the harness at default capabilities", async () => {
    const harness = createTestHarness({ manifest });
    await expect(
      harness.ctx.issues.create({
        companyId: "company-x",
        title: "anything",
        description: "should never be reachable",
      }),
    ).rejects.toThrow(/missing required capability 'issues\.create'/);
  });

  it("routes outbound HTTP through the declared http.outbound capability gate", async () => {
    const call = vi.fn(async (_url: string, _init?: RequestInit) => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", call);
    try {
      const harness = createTestHarness({ manifest });
      const res = await harness.ctx.http.fetch("https://pixel-agents.example/api/hooks/x", { method: "POST" });
      expect(res.ok).toBe(true);
      expect(call).toHaveBeenCalledWith("https://pixel-agents.example/api/hooks/x", { method: "POST" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses outbound HTTP through the harness when http.outbound is not declared", async () => {
    const capabilities = manifest.capabilities.filter((c) => c !== "http.outbound");
    const harness = createTestHarness({ manifest, capabilities });
    await expect(
      harness.ctx.http.fetch("https://paperclip.example/api/companies"),
    ).rejects.toThrow(/missing required capability 'http\.outbound'/);
  });

  describe("relay instance config schema", () => {
    // NOTE: the SAA-229 staged manifest declared a plaintext `pixelAgentsToken`
    // field; the current implementation declares exactly four relay fields with
    // `pixelAgentsTokenRef` (a `secret-ref` binding, never a plaintext value).
    // These assertions lock in the current schema.
    const properties = (manifest.instanceConfigSchema as {
      type?: string;
      properties?: Record<string, Record<string, unknown>>;
    }).properties ?? {};

    it("declares an object instanceConfigSchema with exactly the four relay fields", () => {
      expect(manifest.instanceConfigSchema).toBeDefined();
      expect((manifest.instanceConfigSchema as { type?: string }).type).toBe("object");
      expect(Object.keys(properties).sort()).toEqual([
        "pixelAgentsProviderId",
        "pixelAgentsRelayEnabled",
        "pixelAgentsTokenRef",
        "pixelAgentsUiUrl",
        "pixelAgentsUrl",
      ]);
      expect(properties.pixelAgentsToken).toBeUndefined();
    });

    it("declares pixelAgentsUrl as a uri-format string", () => {
      expect(properties.pixelAgentsUrl).toMatchObject({ type: "string", format: "uri" });
    });

    it("declares pixelAgentsTokenRef as a secret-ref string (never a plaintext value)", () => {
      expect(properties.pixelAgentsTokenRef).toMatchObject({ type: "string", format: "secret-ref" });
    });

    // Removed 2026-08-31: `x-paperclip-advanced` was a UI-grouping hint with
    // no functional purpose, but Paperclip's host validates instanceConfigSchema
    // with ajv in strict mode, which rejects any unrecognized keyword at
    // schema-compile time — so ANY POST /api/plugins/:id/config call for this
    // plugin 500'd with `strict mode: unknown keyword: "x-paperclip-advanced"`,
    // even an empty configJson (ajv compiles the whole schema before touching
    // the data). Confirmed live against a real Paperclip host. Assert it never
    // comes back on any property.
    it("never declares the ajv-strict-mode-incompatible x-paperclip-advanced keyword on any property", () => {
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema, `${name} must not declare x-paperclip-advanced`).not.toHaveProperty("x-paperclip-advanced");
      }
    });

    it("declares pixelAgentsProviderId with the ^[a-z0-9-]+$ pattern and claude default", () => {
      expect(properties.pixelAgentsProviderId).toMatchObject({
        type: "string",
        pattern: "^[a-z0-9-]+$",
        default: "claude",
      });
    });

    it("declares pixelAgentsRelayEnabled as a boolean", () => {
      expect(properties.pixelAgentsRelayEnabled).toMatchObject({ type: "boolean" });
    });
  });
});
