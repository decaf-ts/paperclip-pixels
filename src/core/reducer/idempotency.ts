/**
 * Event idempotency (spec §12.3).
 *
 * Paperclip event delivery is at-least-once and globally unordered. Use
 * `eventId` as the first-line dedupe key with a 1h garbage-collection window.
 *
 * Dedupe alone is NOT sufficient — authoritative reconciliation is required
 * (spec §12.3, §12.4).
 */

const GC_WINDOW_MS = 60 * 60 * 1000;

export class EventDeduper {
  private readonly recent = new Map<string, number>();

  /** Returns true if `eventId` has already been seen. */
  seen(eventId: string): boolean {
    if (this.recent.has(eventId)) return true;
    this.recent.set(eventId, Date.now());
    this.gc();
    return false;
  }

  /** Number of tracked event ids (after GC). */
  get size(): number {
    return this.recent.size;
  }

  /** Drop entries older than the 1h GC window. */
  private gc(): void {
    const cutoff = Date.now() - GC_WINDOW_MS;
    for (const [id, ts] of this.recent) {
      if (ts < cutoff) this.recent.delete(id);
    }
  }

  /** Force a garbage-collection pass (useful after time jumps / for tests). */
  forceGc(now = Date.now()): void {
    const cutoff = now - GC_WINDOW_MS;
    for (const [id, ts] of this.recent) {
      if (ts < cutoff) this.recent.delete(id);
    }
  }

  clear(): void {
    this.recent.clear();
  }
}
