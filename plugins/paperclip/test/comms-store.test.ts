import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  DEFAULT_RELAY_COMMS_LIMIT,
  MAX_PAGE_LIMIT,
  RelayCommsStore,
  type RelayCommsAppend,
  type RelayCommsEntry,
} from "../src/comms-store.js";
import { parseCommsLimit } from "../src/relay.js";

const COMPANY = "company-1";
const OTHER = "company-2";
const BASE_MS = 1_700_000_000_000;

function makeEntry(companyId: string, i: number, overrides: Partial<RelayCommsAppend> = {}): RelayCommsAppend {
  return {
    companyId,
    occurredAt: new Date(BASE_MS + i * 1000).toISOString(),
    direction: "outbound",
    kind: "feed-push",
    status: "sent",
    agentId: `agent-${i % 3}`,
    operations: [{ op: "declareAgents", count: 1 }],
    ...overrides,
  };
}

function append(store: RelayCommsStore, companyId: string, i: number, overrides: Partial<RelayCommsAppend> = {}): RelayCommsEntry | undefined {
  return store.append(makeEntry(companyId, i, overrides));
}

function seqs(entries: RelayCommsEntry[]): number[] {
  return entries.map((e) => e.seq);
}

describe("RelayCommsStore", () => {
  it("defaults to a per-company limit of 100 for a fresh company", () => {
    const store = new RelayCommsStore();
    expect(store.getLimit(COMPANY)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(DEFAULT_RELAY_COMMS_LIMIT).toBe(100);
  });

  it("evicts the oldest entry when appending beyond the bound and returns it", () => {
    const store = new RelayCommsStore();
    for (let i = 1; i <= DEFAULT_RELAY_COMMS_LIMIT; i++) {
      expect(append(store, COMPANY, i)).toBeUndefined();
    }
    expect(store.count(COMPANY)).toBe(100);
    const evicted = append(store, COMPANY, 101);
    expect(evicted).toBeDefined();
    expect(evicted?.seq).toBe(1);
    expect(evicted?.companyId).toBe(COMPANY);
    expect(store.count(COMPANY)).toBe(100);
    expect(seqs(store.exportCompact(COMPANY).entries)).toEqual([
      ...Array.from({ length: 99 }, (_, i) => i + 2),
      101,
    ]);
  });

  it("lists newest-first and respects the page limit", () => {
    const store = new RelayCommsStore();
    for (let i = 1; i <= 3; i++) append(store, COMPANY, i);
    const page = store.list(COMPANY);
    expect(page.schemaVersion).toBe(1);
    expect(page.companyId).toBe(COMPANY);
    expect(seqs(page.entries)).toEqual([3, 2, 1]);
    expect(page.nextBeforeSeq).toBeNull();
  });

  it("caps a page at the requested limit", () => {
    const store = new RelayCommsStore();
    for (let i = 1; i <= 60; i++) append(store, COMPANY, i);
    // default page size is 50
    const page = store.list(COMPANY);
    expect(DEFAULT_PAGE_LIMIT).toBe(50);
    expect(page.entries).toHaveLength(DEFAULT_PAGE_LIMIT);
    expect(seqs(page.entries)).toEqual([...Array.from({ length: 50 }, (_, i) => 60 - i)]);
    expect(page.nextBeforeSeq).toBe(11);
    // an explicit page size is honoured
    const small = store.list(COMPANY, { limit: 3 });
    expect(small.entries).toHaveLength(3);
    expect(seqs(small.entries)).toEqual([60, 59, 58]);
  });

  it("clamps a requested page size at the hard max but never returns more than it holds", () => {
    const store = new RelayCommsStore();
    store.setLimit(COMPANY, 150);
    for (let i = 1; i <= 150; i++) append(store, COMPANY, i);
    const clamped = store.list(COMPANY, { limit: MAX_PAGE_LIMIT + 5 });
    expect(clamped.entries).toHaveLength(MAX_PAGE_LIMIT);
    expect(clamped.entries[0].seq).toBe(150);
    expect(clamped.entries[99].seq).toBe(51);
    expect(clamped.nextBeforeSeq).toBe(51);
  });

  it("pages backwards with the beforeSeq cursor", () => {
    const store = new RelayCommsStore();
    for (let i = 1; i <= 60; i++) append(store, COMPANY, i);
    const first = store.list(COMPANY);
    expect(first.nextBeforeSeq).toBe(11);
    const second = store.list(COMPANY, { beforeSeq: first.nextBeforeSeq! });
    expect(seqs(second.entries)).toEqual([...Array.from({ length: 10 }, (_, i) => 10 - i)]);
    expect(second.nextBeforeSeq).toBeNull();
    // beforeSeq is exclusive of the given seq
    const exclusive = store.list(COMPANY, { limit: 5, beforeSeq: 6 });
    expect(seqs(exclusive.entries)).toEqual([5, 4, 3, 2, 1]);
  });

  it("returns an empty page for an unknown company", () => {
    const store = new RelayCommsStore();
    const page = store.list("does-not-exist", { limit: 10, beforeSeq: 5 });
    expect(page).toEqual({ schemaVersion: 1, companyId: "does-not-exist", nextBeforeSeq: null, entries: [] });
  });

  it("is scoped per company with an independent per-company sequence", () => {
    const store = new RelayCommsStore();
    append(store, COMPANY, 1);
    append(store, COMPANY, 2);
    append(store, COMPANY, 3);
    append(store, OTHER, 100);
    expect(store.count(COMPANY)).toBe(3);
    expect(store.count(OTHER)).toBe(1);
    expect(seqs(store.list(COMPANY).entries)).toEqual([3, 2, 1]);
    expect(seqs(store.list(OTHER).entries)).toEqual([1]);
  });

  describe("setLimit", () => {
    it("lowers the bound and evicts the oldest entries", () => {
      const store = new RelayCommsStore();
      for (let i = 1; i <= 60; i++) append(store, COMPANY, i);
      store.setLimit(COMPANY, 50);
      expect(store.getLimit(COMPANY)).toBe(50);
      expect(store.count(COMPANY)).toBe(50);
      expect(seqs(store.list(COMPANY).entries)).toEqual([...Array.from({ length: 50 }, (_, i) => 60 - i)]);
    });

    it("raises the bound without dropping entries", () => {
      const store = new RelayCommsStore();
      for (let i = 1; i <= 10; i++) append(store, COMPANY, i);
      store.setLimit(COMPANY, 200);
      expect(store.getLimit(COMPANY)).toBe(200);
      expect(store.count(COMPANY)).toBe(10);
    });

    it("clamps a rubbish limit to a sane positive integer", () => {
      const store = new RelayCommsStore();
      store.setLimit(COMPANY, 0);
      expect(store.getLimit(COMPANY)).toBe(1);
      store.setLimit(COMPANY, NaN);
      expect(store.getLimit(COMPANY)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    });
  });

  describe("exportCompact / restoreCompact", () => {
    it("round-trips entries and seq", () => {
      const store = new RelayCommsStore();
      for (let i = 1; i <= 5; i++) append(store, COMPANY, i);
      const compact = store.exportCompact(COMPANY);
      expect(compact.limit).toBe(DEFAULT_RELAY_COMMS_LIMIT);
      expect(seqs(compact.entries)).toEqual([1, 2, 3, 4, 5]);

      const restored = new RelayCommsStore();
      restored.restoreCompact(COMPANY, compact);
      expect(restored.getLimit(COMPANY)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
      expect(restored.count(COMPANY)).toBe(5);
      expect(seqs(restored.list(COMPANY, { limit: 10 }).entries)).toEqual([5, 4, 3, 2, 1]);
      // seq continues past the restored tail
      const next = append(restored, COMPANY, 6);
      expect(next).toBeUndefined();
      expect(restored.list(COMPANY, { limit: 10 }).entries[0].seq).toBe(6);
    });

    it("preserves the limit and evicts down to it on restore", () => {
      const store = new RelayCommsStore();
      store.setLimit(COMPANY, 3);
      for (let i = 1; i <= 6; i++) append(store, COMPANY, i);
      const compact = store.exportCompact(COMPANY);
      expect(compact.limit).toBe(3);
      expect(seqs(compact.entries)).toEqual([4, 5, 6]);

      const restored = new RelayCommsStore();
      restored.restoreCompact(COMPANY, compact);
      expect(restored.getLimit(COMPANY)).toBe(3);
      expect(restored.count(COMPANY)).toBe(3);
      expect(seqs(restored.list(COMPANY).entries)).toEqual([6, 5, 4]);
    });

    it("keeps newer in-memory entries when restoring (merge, newest wins)", () => {
      const store = new RelayCommsStore();
      for (let i = 1; i <= 4; i++) append(store, COMPANY, i);
      const compact = store.exportCompact(COMPANY);
      // two more appends on the live store after the export
      append(store, COMPANY, 5);
      append(store, COMPANY, 6);
      // restore the older compact; live seqs 5,6 must survive alongside it
      store.restoreCompact(COMPANY, compact);
      expect(seqs(store.list(COMPANY, { limit: 10 }).entries)).toEqual([6, 5, 4, 3, 2, 1]);
    });
  });
});

describe("parseCommsLimit", () => {
  it("returns a valid positive integer as-is", () => {
    expect(parseCommsLimit(50)).toBe(50);
    expect(parseCommsLimit(2.9)).toBe(2);
    expect(parseCommsLimit("50")).toBe(50);
  });

  it("falls back to the default for NaN, zero and negatives", () => {
    expect(parseCommsLimit(NaN)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(parseCommsLimit(0)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(parseCommsLimit(-5)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(parseCommsLimit(undefined)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(parseCommsLimit(null)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    expect(parseCommsLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
  });
});
