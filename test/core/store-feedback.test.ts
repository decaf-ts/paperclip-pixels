import { BridgeStore } from "../../src/core/index.js";
import { commentCreated, snapshot, COMPANY_ID } from "./fixtures";

describe("BridgeStore.getFeedbackById (§5.2, §18.3)", () => {
  async function seededStore(): Promise<BridgeStore> {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(commentCreated("e1", 10, "progress update"));
    return store;
  }

  it("returns the company-scoped feedback matching the id", async () => {
    const store = await seededStore();
    const fb = store.getFeedbackById(COMPANY_ID, "e1:progress");
    expect(fb).toBeDefined();
    expect(fb?.id).toBe("e1:progress");
    expect(fb?.companyId).toBe(COMPANY_ID);
    expect(fb?.issueId).toBeDefined();
  });

  it("returns undefined for a different company (company scoping)", async () => {
    const store = await seededStore();
    expect(store.getFeedbackById("wrong-company", "e1:progress")).toBeUndefined();
  });

  it("returns undefined for an unknown feedback id", async () => {
    const store = await seededStore();
    expect(store.getFeedbackById(COMPANY_ID, "nonexistent:progress")).toBeUndefined();
  });

  it("returns a copy so the caller cannot mutate store state", async () => {
    const store = await seededStore();
    const fb = store.getFeedbackById(COMPANY_ID, "e1:progress");
    expect(fb).toBeDefined();
    fb!.summary = "mutated";
    const again = store.getFeedbackById(COMPANY_ID, "e1:progress");
    expect(again?.summary).not.toBe("mutated");
  });
});
