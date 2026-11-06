/**
 * Remembered archive answers, and small helpers on time and arrays.
 *
 * @packageDocumentation
 */

/** Seconds during which an archive answer that may change is trusted. */
export const MEMO_TTL = 600;

/** What a memo returns for a key it knows nothing about, or no longer trusts. */
export const UNKNOWN = Symbol('unknown');

/**
 * A remembered answer.
 *
 * @typeParam T - The type of the answer.
 */
export type Entry<T> = {
  /** When the answer was received, in epoch seconds. */
  time: number;
  /** The answer itself. */
  value: T;
};

/**
 * Remembered answers, by key (a SWHID or a remote URL).
 *
 * @typeParam T - The type of the answers.
 */
export type Memo<T> = Map<string, Entry<T>>;

/**
 * The current time.
 *
 * @returns The number of seconds since the epoch.
 */
export const now = () => Date.now() / 1000;

/**
 * Whether a time is less than `ttl` seconds ago.
 *
 * @param time - The time, in epoch seconds; `undefined` is never fresh.
 * @param ttl - The time to live, in seconds.
 * @returns `true` when `time` is recent enough.
 */
export const fresh = (time: number | undefined, ttl: number) => time !== undefined && now() - time < ttl;

/**
 * The distinct elements of an array, in their first order.
 *
 * @param xs - The array.
 * @returns A new array without duplicates.
 */
export const uniq = <T>(xs: T[]) => [...new Set(xs)];

/**
 * Split an array into consecutive batches.
 *
 * @param xs - The array.
 * @param n - The size of each batch; the last one may be shorter.
 * @returns The batches, in order.
 *
 * @example
 * ```ts
 * partition([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
 * ```
 */
export function partition<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/**
 * What a memo says of a key.
 *
 * @remarks
 * A positive answer (truthy value) holds for the session: a SWHID is
 * immutable, and what the archive holds stays there. A negative answer
 * holds for `MEMO_TTL` seconds only, as the archive may get the artifact
 * later.
 *
 * @param memo - The memo.
 * @param key - The key, e.g. a SWHID.
 * @returns The remembered value; `null` for a negative answer still
 * trusted; {@link UNKNOWN} when the memo cannot tell.
 */
export function memoGet<T>(memo: Memo<T>, key: string): T | null | typeof UNKNOWN {
  // a SWHID is immutable, but the archive may get the artifact later
  const e = memo.get(key);
  if (!e) return UNKNOWN;
  if (e.value) return e.value;
  return fresh(e.time, MEMO_TTL) ? null : UNKNOWN;
}

/**
 * Remember an answer, timestamped now.
 *
 * @param memo - The memo.
 * @param key - The key.
 * @param value - The answer.
 * @returns `value`, for chaining.
 */
export function memoPut<T>(memo: Memo<T>, key: string, value: T): T {
  memo.set(key, { time: now(), value });
  return value;
}

/**
 * Forget the negative answers of a memo; the positive ones stay, as what
 * the archive holds stays there.
 *
 * @param memo - The memo.
 */
export function forgetNegatives<T>(memo: Memo<T>) {
  for (const [k, e] of memo) if (!e.value) memo.delete(k);
}
