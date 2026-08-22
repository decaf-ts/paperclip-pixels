import { describe, expect, it } from "vitest";
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
    expect(manifest.capabilities).toContain("issue.comments.create");
    expect(manifest.capabilities).toContain("issue.comments.create_human_attributed");
    expect(manifest.capabilities).not.toContain("issues.create");
    expect(manifest.capabilities).not.toContain("issues.update");
  });

  it("declares no outbound HTTP capability (trust boundary)", () => {
    expect(manifest.capabilities).not.toContain("http.outbound");
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

  it("refuses outbound HTTP through the harness at default capabilities", async () => {
    const harness = createTestHarness({ manifest });
    await expect(
      harness.ctx.http.fetch("https://paperclip.example/api/companies"),
    ).rejects.toThrow(/missing required capability 'http\.outbound'/);
  });
});
