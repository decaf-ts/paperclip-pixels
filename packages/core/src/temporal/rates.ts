/**
 * Rate and statistics helpers (spec §11.5, §11.6, §25). Pure functions.
 */

/** Clamp a value into [0, 1]. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamp a value into [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Arithmetic mean of a numeric series; returns 0 for empty input. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population standard deviation; returns 0 for empty input. */
export function stddev(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    const d = v - m;
    acc += d * d;
  }
  return Math.sqrt(acc / values.length);
}

/** Weighted mean of [value, weight] pairs; weights need not be normalized. */
export function weightedMean(pairs: ReadonlyArray<readonly [number, number]>): number {
  let totalWeight = 0;
  let acc = 0;
  for (const [value, weight] of pairs) {
    totalWeight += weight;
    acc += value * weight;
  }
  if (totalWeight <= 0) return 0;
  return acc / totalWeight;
}

/** Linearly scale `count` by `1/norm` and clamp to [0,1]. */
export function ratioClamp(count: number, norm: number): number {
  const denom = Math.max(1, norm);
  return clamp01(count / denom);
}

/** Percentile (linear interpolation) of a numeric series. `p` in [0,1]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = clamp(p, 0, 1) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const frac = rank - lower;
  return sorted[lower] * (1 - frac) + sorted[upper] * frac;
}

/**
 * Exponentially-decayed recent count. Newer observations weigh more heavily
 * than older ones (spec §11.6). `halfLifeMs` controls the decay rate.
 */
export function weightedRecentCount(
  timestamps: readonly number[],
  now: number,
  halfLifeMs: number,
): number {
  if (timestamps.length === 0) return 0;
  const lambda = Math.LN2 / Math.max(1, halfLifeMs);
  let acc = 0;
  for (const ts of timestamps) {
    const age = Math.max(0, now - ts);
    acc += Math.exp(-lambda * age);
  }
  return acc;
}

/** Round to a fixed number of decimal places (for semantic-change checks). */
export function roundTo(value: number, places: number): number {
  const factor = Math.pow(10, places);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
