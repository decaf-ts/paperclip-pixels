/**
 * Fixed-capacity ring buffer (spec §9.2, §11.2, NFR-1).
 *
 * Used to retain a bounded number of 5-minute buckets per agent (288 for 24h)
 * without retaining raw payloads indefinitely. O(1) push, O(n) iteration over
 * retained entries.
 */

export class RingBuffer<T> {
  private readonly buffer: Array<T | undefined>;
  private head = 0;
  private count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    if (capacity < 1) {
      throw new Error("RingBuffer capacity must be >= 1");
    }
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get isFull(): boolean {
    return this.count === this.capacity;
  }

  /** Append an entry, evicting the oldest when full. Returns the evicted entry. */
  push(entry: T): T | undefined {
    let evicted: T | undefined;
    if (this.count === this.capacity) {
      evicted = this.buffer[this.head];
    }
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
    return evicted;
  }

  /** Iterates from oldest retained entry to newest. */
  toArray(): T[] {
    const out: T[] = [];
    if (this.count < this.capacity) {
      for (let i = 0; i < this.count; i++) out.push(this.buffer[i] as T);
    } else {
      for (let i = 0; i < this.capacity; i++) {
        const idx = (this.head + i) % this.capacity;
        out.push(this.buffer[idx] as T);
      }
    }
    return out;
  }

  /** Newest retained entry, if any. */
  newest(): T | undefined {
    if (this.count === 0) return undefined;
    const idx = (this.head + this.capacity - 1) % this.capacity;
    return this.buffer[idx];
  }

  /** Oldest retained entry, if any. */
  oldest(): T | undefined {
    if (this.count === 0) return undefined;
    if (this.count < this.capacity) return this.buffer[0];
    return this.buffer[this.head];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.buffer.fill(undefined);
  }
}
