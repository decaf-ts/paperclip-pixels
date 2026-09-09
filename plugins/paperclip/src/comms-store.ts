/**
 * Bounded rolling relay/feed communications store (R3-WS4a).
 *
 * The relay pushes feed-operation batches to the Pixel Agents embedding
 * surface; the Configuration UI needs a bounded, human-readable log of those
 * communications. This store keeps the last N relay/feed communications per
 * company (default {@link DEFAULT_RELAY_COMMS_LIMIT} = 100, adjustable per
 * company via the `relayCommsLimit` operator config), evicting the oldest on
 * overflow, and serves strictly-bounded paging queries.
 *
 * All capacity is a hard bound: no entry is ever retained beyond N, and a
 * paging query returns at most {@link DEFAULT_PAGE_LIMIT} (or the requested
 * `limit`) entries from a determined position. Nothing here grows without
 * bound, and no query can return more than the store currently holds.
 *
 * The store is restart-safe: a compact serializable form can be exported to /
 * restored from plugin `ctx.state` (see `persistence.ts`), exactly like the
 * temporal compact-bucket store.
 */

import type { PluginFeedOperation, PluginFeedDialogLine } from "@decaf-ts/paperclip-pixels-common";

/** Default number of communications retained per company (spec R3-WS4a). */
export const DEFAULT_RELAY_COMMS_LIMIT = 100;

/** Default page size for a paging query. */
export const DEFAULT_PAGE_LIMIT = 50;

/** Maximum page size a query may request (hard cap, fail-closed on larger). */
export const MAX_PAGE_LIMIT = 100;

/** A serializable summary of one feed operation carried in a communication. */
export interface FeedOpSummary {
  op: string;
  key?: string;
  agentId?: string;
  text?: string;
  lines?: string[];
  count?: number;
}

/** Direction of a recorded communication. */
export type RelayCommsDirection = "outbound";

/** One recorded relay/feed communication. */
export interface RelayCommsEntry {
  /** Monotonic per-company sequence id (newest is largest). */
  seq: number;
  companyId: string;
  /** ISO timestamp of when the communication was recorded. */
  occurredAt: string;
  direction: RelayCommsDirection;
  /** `feed-push` = one batch enqueued to the embedding surface; `dialog-line` =
   *  one redacted/truncated conversation extract it carried. */
  kind: "feed-push" | "dialog-line";
  /** Agent the communication concerned, when known. */
  agentId?: string;
  /** The composed dialog-line text (kind === "dialog-line"). */
  text?: string;
  /** Summarised operations carried by the batch (kind === "feed-push"). */
  operations?: FeedOpSummary[];
  /** `sent` = enqueued to the sink; `failed` = the sink recorded a push error. */
  status: "sent" | "failed";
  /** Sink error message when status === "failed". */
  error?: string;
}

/** A bounded page of communications (newest first) plus the next-page cursor. */
export interface RelayCommsPage {
  schemaVersion: 1;
  companyId: string;
  /** `null` when there are no older entries left. */
  nextBeforeSeq: number | null;
  entries: RelayCommsEntry[];
}

/** Input partial for a new communication (seq/companyId assigned by the store). */
export type RelayCommsAppend = Omit<RelayCommsEntry, "seq" | "companyId"> & {
  companyId: string;
};

/** Minimal serializable per-company store state for restart recovery. */
export interface CompactRelayComms {
  /** Current limit for the company. */
  limit: number;
  /** Retained entries, in oldest-first storage order. */
  entries: RelayCommsEntry[];
}

function summarizeOperation(op: PluginFeedOperation): FeedOpSummary {
  const out: FeedOpSummary = { op: op.op };
  switch (op.op) {
    case "declareAgents":
      out.count = op.agents.length;
      break;
    case "removeAgents":
      out.count = op.keys.length;
      break;
    case "updateAgentStatus":
    case "updateAgentActivity":
    case "assignAgentAppearance":
      out.key = op.key;
      break;
    case "dialogLines":
      out.lines = op.lines.map((line: PluginFeedDialogLine) => line.text);
      out.count = op.lines.length;
      break;
    default:
      break;
  }
  return out;
}

/** Summarise a batch of operations for a `feed-push` communication. */
export function summarizeOperations(operations: PluginFeedOperation[]): FeedOpSummary[] {
  return operations.map(summarizeOperation);
}

interface CompanyBuffer {
  seq: number;
  limit: number;
  /** Retained entries, oldest-first. */
  entries: RelayCommsEntry[];
}

export class RelayCommsStore {
  private readonly companies = new Map<string, CompanyBuffer>();

  /** The default storage limit for a company that has not had one set. */
  readonly defaultLimit: number;

  constructor(defaultLimit: number = DEFAULT_RELAY_COMMS_LIMIT) {
    this.defaultLimit = defaultLimit;
  }

  private ensure(companyId: string): CompanyBuffer {
    let cb = this.companies.get(companyId);
    if (!cb) {
      cb = { seq: 0, limit: this.defaultLimit, entries: [] };
      this.companies.set(companyId, cb);
    }
    return cb;
  }

  /**
   * Append one communication, evicting the oldest when the company is at its
   * limit. Returns the evicted entry, if any.
   */
  append(entry: RelayCommsAppend): RelayCommsEntry | undefined {
    const cb = this.ensure(entry.companyId);
    cb.seq += 1;
    const stored: RelayCommsEntry = {
      ...entry,
      seq: cb.seq,
      companyId: entry.companyId,
    };
    cb.entries.push(stored);
    if (cb.entries.length > cb.limit) {
      return cb.entries.shift();
    }
    return undefined;
  }

  /** The current storage limit for a company. */
  getLimit(companyId: string): number {
    return this.ensure(companyId).limit;
  }

  /** Set the storage limit for a company. Lowering it evicts the oldest entries
   *  that now exceed the new bound. */
  setLimit(companyId: string, limit: number): void {
    const cb = this.ensure(companyId);
    const normalized = clampLimit(limit);
    cb.limit = normalized;
    if (cb.entries.length > normalized) {
      cb.entries.splice(0, cb.entries.length - normalized);
    }
  }

  /** Number of retained communications for a company. */
  count(companyId: string): number {
    return this.ensure(companyId).entries.length;
  }

  /**
   * Query at most `opts.limit` communications, newest first, at or before
   * (exclusive) `opts.beforeSeq`. Bounded paging: the caller advances with the
   * returned `nextBeforeSeq`. When the company is unknown, returns an empty page.
   */
  list(
    companyId: string,
    opts: { limit?: number; beforeSeq?: number } = {},
  ): RelayCommsPage {
    const cb = this.companies.get(companyId);
    if (!cb) {
      return emptyPage(companyId);
    }
    const pageLimit = clampPageLimit(opts.limit);
    const beforeSeq = opts.beforeSeq;
    const descending = cb.entries.slice().reverse();
    const filtered = beforeSeq === undefined
      ? descending
      : descending.filter((e) => e.seq < beforeSeq);
    const entries = filtered.slice(0, pageLimit);
    let nextBeforeSeq: number | null = null;
    if (filtered.length > pageLimit) {
      nextBeforeSeq = entries[entries.length - 1]?.seq ?? null;
    }
    return {
      schemaVersion: 1,
      companyId,
      nextBeforeSeq,
      entries,
    };
  }

  /** Drop all communications for a company. Returns the removed entries. */
  clear(companyId: string): RelayCommsEntry[] {
    const cb = this.ensure(companyId);
    const removed = cb.entries;
    cb.entries = [];
    return removed;
  }

  /** Export a company's compact state for restart recovery. */
  exportCompact(companyId: string): CompactRelayComms {
    const cb = this.ensure(companyId);
    return {
      limit: cb.limit,
      entries: cb.entries.slice(),
    };
  }

  /** Restore a company's compact state. Any in-memory entries whose seq is
   *  newer than the restored tail are preserved (merge, newest wins); the
   *  store is re-bounded to the compact's limit, evicting the oldest. */
  restoreCompact(companyId: string, compact: CompactRelayComms): void {
    const cb = this.ensure(companyId);
    cb.limit = clampLimit(compact.limit);
    const restored = (compact.entries ?? []).slice(-cb.limit);
    const existing = cb.entries.filter((e) => e.seq > (restored[restored.length - 1]?.seq ?? -1));
    cb.entries = [...restored, ...existing];
    for (const e of cb.entries) {
      if (e.seq > cb.seq) cb.seq = e.seq;
    }
    if (cb.entries.length > cb.limit) {
      cb.entries.splice(0, cb.entries.length - cb.limit);
    }
  }

  exportAll(): Record<string, CompactRelayComms> {
    const out: Record<string, CompactRelayComms> = {};
    for (const companyId of this.companies.keys()) {
      out[companyId] = this.exportCompact(companyId);
    }
    return out;
  }

  restoreAll(data: Record<string, CompactRelayComms>): void {
    for (const [companyId, compact] of Object.entries(data)) {
      this.restoreCompact(companyId, compact);
    }
  }
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_RELAY_COMMS_LIMIT;
  const n = Math.max(1, Math.floor(limit));
  return n > MAX_PAGE_LIMIT * 10 ? DEFAULT_RELAY_COMMS_LIMIT : n;
}

function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
  const n = Math.max(1, Math.floor(limit));
  return n > MAX_PAGE_LIMIT ? MAX_PAGE_LIMIT : n;
}

function emptyPage(companyId: string): RelayCommsPage {
  return { schemaVersion: 1, companyId, nextBeforeSeq: null, entries: [] };
}
