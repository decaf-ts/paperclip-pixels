import { BridgeStore } from "../../src/core/index.js";
import {
  runStarted,
  runFailed,
  runFinished,
  commentCreated,
  approvalCreated,
  approvalDecided,
  issueUpdated,
  snapshot,
  AGENT_A,
  BASE_MS,
  PROJECT_X,
  PROJECT_Y,
  PROJECT_Z,
  ISSUE_1,
} from "./fixtures";

const MIN = 60 * 1000;
const NOW = BASE_MS + 5 * MIN;

function freshStore(): BridgeStore {
  const store = new BridgeStore();
  store.replaceAuthoritativeSnapshot(snapshot());
  return store;
}

/** Apply a caller-provided pattern of run outcomes, one start+outcome pair per index. */
async function feedRunPattern(
  store: BridgeStore,
  pattern: Array<"succeed" | "fail">,
): Promise<void> {
  for (let i = 0; i < pattern.length; i++) {
    const t = i * 20_000;
    await store.applyPaperclipEvent(runStarted(`start-${i}`, t, `run-${i}`));
    if (pattern[i] === "fail") {
      await store.applyPaperclipEvent(runFailed(`outcome-${i}`, t + 10_000, `run-${i}`));
    } else {
      await store.applyPaperclipEvent(runFinished(`outcome-${i}`, t + 10_000, `run-${i}`));
    }
  }
}

describe("failure streak → failure pressure and friction (§31.3, §37)", () => {
  async function sample(pattern: Array<"succeed" | "fail">) {
    const store = freshStore();
    await feedRunPattern(store, pattern);
    return store.getBehaviorVector(AGENT_A, BASE_MS + 5 * MIN);
  }

  it("all-success runs leave failurePressure and friction near zero", async () => {
    const v = await sample(["succeed", "succeed", "succeed", "succeed", "succeed", "succeed"]);
    expect(v.failurePressure.value).toBeLessThan(0.01);
    expect(v.friction.value).toBeLessThan(0.01);
  });

  it("failurePressure rises as the failure fraction of the streak rises", async () => {
    const allSucceed = await sample(["succeed", "succeed", "succeed", "succeed", "succeed", "succeed"]);
    const halfFail = await sample(["succeed", "fail", "succeed", "fail", "succeed", "fail"]);
    const allFail = await sample(["fail", "fail", "fail", "fail", "fail", "fail"]);

    expect(halfFail.failurePressure.value).toBeGreaterThan(allSucceed.failurePressure.value);
    expect(allFail.failurePressure.value).toBeGreaterThan(halfFail.failurePressure.value);
    expect(allFail.failurePressure.value).toBeGreaterThan(0.9);
    expect(halfFail.failurePressure.value).toBeGreaterThan(0.4);
  });

  it("friction tracks the failure streak (failure pressure is a friction term)", async () => {
    const allSucceed = await sample(["succeed", "succeed", "succeed", "succeed", "succeed", "succeed"]);
    const halfFail = await sample(["succeed", "fail", "succeed", "fail", "succeed", "fail"]);
    const allFail = await sample(["fail", "fail", "fail", "fail", "fail", "fail"]);

    expect(allFail.friction.value).toBeGreaterThan(halfFail.friction.value);
    expect(halfFail.friction.value).toBeGreaterThan(allSucceed.friction.value);
  });
});

describe("long idle → idle availability and load (§31.3)", () => {
  it("an agent with no recent work reports high idle availability and zero load", async () => {
    const store = freshStore();
    const v = store.getBehaviorVector(AGENT_A, NOW);
    expect(v.idleAvailability.value).toBeGreaterThan(0.9);
    expect(v.load.value).toBeLessThan(0.01);
  });

  it("starting work lowers idle availability and raises load", async () => {
    const idle = freshStore();
    const busy = freshStore();
    await busy.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    const vidle = idle.getBehaviorVector(AGENT_A, NOW);
    const vbusy = busy.getBehaviorVector(AGENT_A, NOW);

    expect(vbusy.idleAvailability.value).toBeLessThan(vidle.idleAvailability.value);
    expect(vbusy.load.value).toBeGreaterThan(vidle.load.value);
  });

  it("a finished burst followed by a long idle restores availability and drops load", async () => {
    const store = freshStore();
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    await store.applyPaperclipEvent(runFinished("e2", 10 * MIN, "r1"));

    const v = store.getBehaviorVector(AGENT_A, BASE_MS + 45 * MIN);
    expect(v.idleAvailability.value).toBeGreaterThan(0.9);
    expect(v.load.value).toBeLessThan(0.01);
  });
});

describe("high collaboration → collaboration rises with comment volume (§31.3)", () => {
  it("collaboration responds to comment volume", async () => {
    const none = freshStore();
    const low = freshStore();
    const high = freshStore();
    for (let i = 0; i < 2; i++) {
      await low.applyPaperclipEvent(commentCreated(`low-${i}`, i * 1000, `body ${i}`));
    }
    for (let i = 0; i < 20; i++) {
      await high.applyPaperclipEvent(commentCreated(`high-${i}`, i * 1000, `body ${i}`));
    }

    const vNone = none.getBehaviorVector(AGENT_A, NOW);
    const vLow = low.getBehaviorVector(AGENT_A, NOW);
    const vHigh = high.getBehaviorVector(AGENT_A, NOW);

    expect(vLow.collaboration.value).toBeGreaterThan(vNone.collaboration.value);
    expect(vHigh.collaboration.value).toBeGreaterThan(vLow.collaboration.value);
    expect(vHigh.collaboration.value).toBeGreaterThan(0.99);
  });
});

describe("burst vs sustained workload (§37)", () => {
  it("burstiness distinguishes a concentrated burst from an even spread at equal volume", async () => {
    // 6 runs: 5 start in the same 5m bucket, 1 straggler in the next.
    const burst = freshStore();
    for (let i = 0; i < 5; i++) {
      await burst.applyPaperclipEvent(runStarted(`b${i}`, i * 10_000, `r${i}`));
    }
    await burst.applyPaperclipEvent(runStarted("b5", 110_000, "r5"));

    // 6 runs: one start per 5m bucket, evenly spaced.
    const spreadStore = freshStore();
    const offsets = [0, 110_000, 410_000, 710_000, 1_010_000, 1_310_000];
    for (let i = 0; i < offsets.length; i++) {
      await spreadStore.applyPaperclipEvent(runStarted(`s${i}`, offsets[i], `r${i}`));
    }

    const vBurst = burst.getBehaviorVector(AGENT_A, BASE_MS + 250_000);
    const vSpread = spreadStore.getBehaviorVector(AGENT_A, BASE_MS + 1_700_000);

    expect(vBurst.burstiness.value).toBeGreaterThan(0.5);
    expect(vSpread.burstiness.value).toBeLessThan(0.1);
    expect(vBurst.burstiness.value).toBeGreaterThan(vSpread.burstiness.value + 0.3);
  });

  it("sustainedLoad is lower for a short burst than for the same volume spread across hours", async () => {
    // Burst: 6 runs finish within the first minute, then 3h of idle.
    const burst = freshStore();
    for (let i = 0; i < 6; i++) {
      const t = i * 10_000;
      await burst.applyPaperclipEvent(runStarted(`bs${i}`, t, `r${i}`));
      await burst.applyPaperclipEvent(runFinished(`bf${i}`, t + 5_000, `r${i}`));
    }

    // Sustained: same 6 runs paced one per 30m across 3h.
    const sustained = freshStore();
    for (let i = 0; i < 6; i++) {
      const t = i * 30 * MIN;
      await sustained.applyPaperclipEvent(runStarted(`ss${i}`, t, `r${i}`));
      await sustained.applyPaperclipEvent(runFinished(`sf${i}`, t + 5 * MIN, `r${i}`));
    }

    const vBurst = burst.getBehaviorVector(AGENT_A, BASE_MS + 3 * 60 * MIN);
    const vSustained = sustained.getBehaviorVector(AGENT_A, BASE_MS + 3 * 60 * MIN + 5 * MIN);

    expect(vBurst.sustainedLoad.value).toBeLessThan(0.15);
    expect(vSustained.sustainedLoad.value).toBeGreaterThan(0.1);
    expect(vSustained.sustainedLoad.value).toBeGreaterThan(vBurst.sustainedLoad.value + 0.05);
  });

  it("load decays back to zero after the burst window passes", async () => {
    const burst = freshStore();
    for (let i = 0; i < 6; i++) {
      const t = i * 10_000;
      await burst.applyPaperclipEvent(runStarted(`bs${i}`, t, `r${i}`));
      await burst.applyPaperclipEvent(runFinished(`bf${i}`, t + 5_000, `r${i}`));
    }
    const v = burst.getBehaviorVector(AGENT_A, BASE_MS + 3 * 60 * MIN);
    expect(v.load.value).toBeLessThan(0.01);
  });
});

describe("context switching ↔ project/issue movement (§37)", () => {
  // Three 60s work slices, non-overlapping so overlapping-run noise stays out.
  async function runSliceSequence(
    store: BridgeStore,
    opts: Array<{ issueId: string; projectId: string }>,
  ): Promise<void> {
    for (let i = 0; i < opts.length; i++) {
      const t = i * MIN;
      await store.applyPaperclipEvent(
        runStarted(`s${i}`, t, `r${i}`, AGENT_A, opts[i].issueId, opts[i].projectId),
      );
      await store.applyPaperclipEvent(runFinished(`f${i}`, t + 10_000, `r${i}`));
    }
  }

  it("moving across issues raises contextSwitching", async () => {
    const sameIssue = freshStore();
    await runSliceSequence(sameIssue, [
      { issueId: ISSUE_1, projectId: PROJECT_X },
      { issueId: ISSUE_1, projectId: PROJECT_X },
      { issueId: ISSUE_1, projectId: PROJECT_X },
    ]);
    const movedIssues = freshStore();
    await runSliceSequence(movedIssues, [
      { issueId: ISSUE_1, projectId: PROJECT_X },
      { issueId: "issue-9", projectId: PROJECT_X },
      { issueId: "issue-8", projectId: PROJECT_X },
    ]);

    const vSame = sameIssue.getBehaviorVector(AGENT_A, NOW);
    const vMoved = movedIssues.getBehaviorVector(AGENT_A, NOW);
    expect(vMoved.contextSwitching.value).toBeGreaterThan(vSame.contextSwitching.value);
  });

  it("moving across projects raises contextSwitching beyond issue movement alone", async () => {
    const issueOnly = freshStore();
    await runSliceSequence(issueOnly, [
      { issueId: ISSUE_1, projectId: PROJECT_X },
      { issueId: "issue-9", projectId: PROJECT_X },
      { issueId: "issue-8", projectId: PROJECT_X },
    ]);
    const projectMoved = freshStore();
    await runSliceSequence(projectMoved, [
      { issueId: ISSUE_1, projectId: PROJECT_X },
      { issueId: "issue-9", projectId: PROJECT_Y },
      { issueId: "issue-8", projectId: PROJECT_Z },
    ]);

    const vIssue = issueOnly.getBehaviorVector(AGENT_A, NOW);
    const vProject = projectMoved.getBehaviorVector(AGENT_A, NOW);
    expect(vProject.contextSwitching.value).toBeGreaterThan(vIssue.contextSwitching.value);
  });
});

describe("friction contributors: blocking, approvals, failures (§37)", () => {
  it("friction rises with each added contributor and falls when the approval resolves", async () => {
    const base = freshStore();
    const blocked = freshStore();
    const blockedAndApproval = freshStore();
    const all = freshStore();

    await blocked.applyPaperclipEvent(issueUpdated("i1", 0, ISSUE_1, "in_progress", { blocked: true }));

    await blockedAndApproval.applyPaperclipEvent(issueUpdated("i1", 0, ISSUE_1, "in_progress", { blocked: true }));
    await blockedAndApproval.applyPaperclipEvent(approvalCreated("a1", 10_000, "approval-1"));

    await all.applyPaperclipEvent(issueUpdated("i1", 0, ISSUE_1, "in_progress", { blocked: true }));
    await all.applyPaperclipEvent(approvalCreated("a1", 10_000, "approval-1"));
    await all.applyPaperclipEvent(runStarted("s1", 20_000, "r1"));
    await all.applyPaperclipEvent(runFailed("f1", 30_000, "r1"));

    const vBase = base.getBehaviorVector(AGENT_A, NOW);
    const vBlocked = blocked.getBehaviorVector(AGENT_A, NOW);
    const vBlockedApproval = blockedAndApproval.getBehaviorVector(AGENT_A, NOW);
    const vAll = all.getBehaviorVector(AGENT_A, NOW);

    expect(vBlocked.friction.value).toBeGreaterThan(vBase.friction.value + 0.1);
    expect(vBlockedApproval.friction.value).toBeGreaterThan(vBlocked.friction.value + 0.1);
    expect(vAll.friction.value).toBeGreaterThan(vBlockedApproval.friction.value);

    // Resolving the pending approval removes its contribution.
    await blockedAndApproval.applyPaperclipEvent(approvalDecided("d1", 40_000, "approval-1", "approved"));
    const vResolved = blockedAndApproval.getBehaviorVector(AGENT_A, NOW);
    expect(vResolved.friction.value).toBeLessThan(vBlockedApproval.friction.value);
  });

  it("decided approvals stop contributing to friction even with other friction still present", async () => {
    const store = freshStore();
    await store.applyPaperclipEvent(issueUpdated("i1", 0, ISSUE_1, "in_progress", { blocked: true }));
    await store.applyPaperclipEvent(approvalCreated("a1", 10_000, "approval-1"));

    const before = store.getBehaviorVector(AGENT_A, NOW).friction.value;
    await store.applyPaperclipEvent(approvalDecided("d1", 20_000, "approval-1", "approved"));
    const after = store.getBehaviorVector(AGENT_A, NOW).friction.value;
    expect(after).toBeLessThan(before);
  });
});
