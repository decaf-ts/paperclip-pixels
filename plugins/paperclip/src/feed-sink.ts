/**
 * Plugin feed HTTP sink (push side of the feed wire contract, spec
 * PAPERCLIP_PIXELS-2, WS2-C).
 *
 * Replaces the retired `HttpPushSink` (which serialized every event into the
 * Claude hook JSON body and POSTed it to `/api/hooks/claude`). This sink POSTs
 * feed-operation batches to the embedding surface's `POST /api/plugin-feed`
 * endpoint — the same operator-configured sidecar destination, the same
 * ordered-queue discipline (a snapshot's declares must never race ahead of
 * each other), the same fire-and-forget error capture via `lastPushError`.
 */

import type {
  PluginFeedBatch,
  PluginFeedOperation,
} from "@decaf-ts/paperclip-pixels-common";
import { PLUGIN_FEED_SCHEMA_VERSION } from "@decaf-ts/paperclip-pixels-common";

/** Minimal fetch-like function (injectable so the package stays pure-TS). */
export type FeedFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

export interface PluginFeedSinkOptions {
  /** Base URL of the embedding surface serving `POST /api/plugin-feed`. */
  baseUrl: string;
  /** Bearer auth token sent on each request (optional). */
  authToken?: string;
  /** Injected fetch implementation (keeps the package free of node globals). */
  fetch: FeedFetchLike;
}

/** Pushes feed-operation batches, strictly ordered. */
export class PluginFeedHttpSink {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly fetch: FeedFetchLike;
  private lastError: string | undefined;
  private pushQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: PluginFeedSinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.authToken = options.authToken;
    this.fetch = options.fetch;
  }

  /** Most recent push error, if any (cleared on a successful push). */
  get lastPushError(): string | undefined {
    return this.lastError;
  }

  /** Enqueue one batch. Operations within a batch are applied in order by the
   *  receiving surface; batches themselves are pushed strictly ordered. */
  push(companyId: string, operations: PluginFeedOperation[]): Promise<void> {
    if (operations.length === 0) return Promise.resolve();
    const batch: PluginFeedBatch = {
      schemaVersion: PLUGIN_FEED_SCHEMA_VERSION,
      companyId,
      operations,
    };
    const url = `${this.baseUrl}/api/plugin-feed`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    const body = JSON.stringify(batch);
    const send = async (): Promise<void> => {
      if (this.disposed) return;
      try {
        const res = await this.fetch(url, { method: "POST", headers, body });
        if (!res.ok) {
          this.lastError = `feed push failed: ${res.status} ${res.statusText}`;
        } else {
          this.lastError = undefined;
        }
      } catch (err) {
        this.lastError = `feed push error: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    const pending = this.pushQueue.then(send);
    this.pushQueue = pending.catch(() => undefined);
    return pending;
  }

  /** Stop queued, not-yet-started pushes when the sink is replaced or shut down. */
  dispose(): void {
    this.disposed = true;
  }
}
