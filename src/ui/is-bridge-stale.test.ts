/**
 * `isBridgeStale` pure staleness computation tests (spec PAPERCLIP_PIXELS-1,
 * §30.1), added 2026-08-31 alongside the polling fallback in use-bridge.ts.
 *
 * See use-bridge.ts's HOST GAP doc comment: Paperclip hosts that never wire
 * up `bridgeDeps.streamBus` make `stream.connected` permanently false, so
 * staleness can no longer be computed from stream connectivity alone without
 * making the "stale" banner permanently stuck regardless of actual data
 * freshness. These tests cover the freshness-based fallback directly,
 * React-free, per this module's own design (see state.test.ts for the same
 * pattern applied to the reducer).
 */

import { isBridgeStale, STALE_AFTER_MS } from "./use-bridge";

const NOW = new Date("2026-08-31T12:00:00.000Z").getTime();

describe("isBridgeStale", () => {
  it("is never stale with no snapshot loaded yet, regardless of connection or timestamp", () => {
    expect(isBridgeStale(false, false, null, NOW)).toBe(false);
    expect(isBridgeStale(false, true, null, NOW)).toBe(false);
    expect(isBridgeStale(false, false, new Date(NOW - 1_000_000).toISOString(), NOW)).toBe(false);
  });

  it("is never stale while the stream is connected, no matter how old the last sync was", () => {
    const veryOld = new Date(NOW - 10 * STALE_AFTER_MS).toISOString();
    expect(isBridgeStale(true, true, veryOld, NOW)).toBe(false);
    expect(isBridgeStale(true, true, null, NOW)).toBe(false);
  });

  it("is stale when disconnected and no successful sync has ever happened", () => {
    expect(isBridgeStale(true, false, null, NOW)).toBe(true);
  });

  it("is not stale when disconnected but the last sync is within STALE_AFTER_MS (the polling fallback keeping data fresh)", () => {
    const recentlySynced = new Date(NOW - (STALE_AFTER_MS - 1)).toISOString();
    expect(isBridgeStale(true, false, recentlySynced, NOW)).toBe(false);
  });

  it("becomes stale once disconnected and the last sync exceeds STALE_AFTER_MS", () => {
    const tooOld = new Date(NOW - (STALE_AFTER_MS + 1)).toISOString();
    expect(isBridgeStale(true, false, tooOld, NOW)).toBe(true);
  });

  it("treats exactly STALE_AFTER_MS as not yet stale (strict greater-than)", () => {
    const exact = new Date(NOW - STALE_AFTER_MS).toISOString();
    expect(isBridgeStale(true, false, exact, NOW)).toBe(false);
  });
});
