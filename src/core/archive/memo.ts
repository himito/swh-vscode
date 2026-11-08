/**
 * Remembered archive answers, as the {@link Memo} class.
 *
 * @packageDocumentation
 */

import { type Maybe, now } from '#core/shared';

/** Seconds during which an archive answer that may change is trusted. */
export const MEMO_TTL = 600;

/** How long a {@link Memo} trusts its answers. */
export type MemoPolicy = {
  /** The seconds an answer is trusted. */
  ttl: number;
  /**
   * Whether a positive answer, a truthy one, is trusted for the whole
   * session instead: e.g. what the archive holds stays there, while what it
   * does not hold may be archived later.
   */
  keepPositives: boolean;
};

/**
 * The state of a memo's answers, as {@link Memo.generation} gives it: it
 * changes each time the memo forgets answers.
 */
export type Generation = number;

/**
 * Tells whether to forget an answer, as given to {@link Memo.forget}.
 *
 * @typeParam T - The type of the answers.
 */
export type ForgetWhich<T> = (value: T) => boolean;

/**
 * A remembered answer.
 *
 * @typeParam T - The type of the answer.
 */
type Entry<T> = {
  /** When the answer was received, in epoch seconds. */
  time: number;
  /** The answer itself. */
  value: T;
};

/**
 * Answers of the archive, remembered by key (a SWHID, a remote URL) and
 * trusted as a {@link MemoPolicy} says.
 *
 * @remarks
 * Asking the archive takes time, during which the memo may forget answers,
 * e.g. on a refresh: an answer asked for before then may be out of date. So
 * take the memo's {@link Memo.generation} before asking, and give it back
 * to {@link Memo.put}, which then ignores the answer if the memo forgot
 * since what it would have forgotten of it: a refresh that forgets the
 * negative answers ignores a negative answer in flight, not a positive one.
 *
 * @typeParam T - The type of the answers; never `undefined`, which means
 * "not known".
 *
 * @example
 * ```ts
 * const known = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });
 * const asOf = known.generation;
 * const answer = await archive.known([swhid]);
 * known.put(swhid, answer.get(swhid)!, asOf); // ignored if forgotten meanwhile
 * ```
 */
export class Memo<T> {
  /** The answers, by key. */
  private readonly entries = new Map<string, Entry<T>>();
  /**
   * What the memo forgot each time, in order: the generation is their
   * number, and those since an answer was asked for tell whether to ignore
   * it. A few closures a session, one for each refresh or save request.
   */
  private readonly forgotten: Array<ForgetWhich<T>> = [];

  /**
   * Creates an empty memo.
   *
   * @param policy - How long it trusts its answers.
   */
  constructor(private readonly policy: MemoPolicy) {}

  /** The state of the memo's answers, to give back to {@link Memo.put}. */
  get generation(): Generation {
    return this.forgotten.length;
  }

  /**
   * The answer remembered for a key, if it is still trusted.
   *
   * @param key - The key.
   * @returns The answer; `undefined` when there is none, or it is no longer trusted.
   */
  get(key: string): Maybe<T> {
    const entry = this.entries.get(key);
    return entry && this.trusts(entry) ? entry.value : undefined;
  }

  /**
   * Tells whether the memo has a trusted answer for a key.
   *
   * @param key - The key.
   * @returns `true` when {@link Memo.get} gives an answer, even a negative one.
   */
  has(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && this.trusts(entry);
  }

  /**
   * Remembers an answer, received now.
   *
   * @param key - The key.
   * @param value - The answer.
   * @param asOf - The memo's {@link Memo.generation} when the answer was
   * asked for; the answer is ignored when the memo has forgotten answers
   * since that include it.
   * @returns Whether the answer was remembered.
   */
  put(key: string, value: T, asOf: Generation = this.generation): boolean {
    if (this.forgottenSince(asOf, value)) return false;
    this.entries.set(key, { time: now(), value });
    return true;
  }

  /**
   * Forgets some answers.
   *
   * @remarks
   * The {@link Memo.generation} changes even when no answer matches: an
   * answer asked for before, that it matches, must still be ignored, as it
   * may be out of date.
   *
   * @param which - Tells whether to forget an answer.
   */
  forget(which: ForgetWhich<T>): void {
    this.forgotten.push(which);
    for (const [key, entry] of this.entries) if (which(entry.value)) this.entries.delete(key);
  }

  /** Forgets every answer, and every answer asked for before. */
  clear(): void {
    this.forget(() => true);
  }

  /**
   * Tells whether the memo forgot an answer while it was asked for.
   *
   * @param asOf - The memo's {@link Memo.generation} when it was asked for.
   * @param value - The answer.
   * @returns `true` when what the memo forgot since includes it.
   */
  private forgottenSince(asOf: Generation, value: T): boolean {
    return this.forgotten.slice(asOf).some((which) => which(value));
  }

  /**
   * Tells whether an answer is still trusted.
   *
   * @param entry - The answer, and when it was received.
   * @returns `true` for a positive answer the policy keeps for the session,
   * or one received less than the policy's `ttl` seconds ago.
   */
  private trusts(entry: Entry<T>): boolean {
    if (this.policy.keepPositives && entry.value) return true;
    return now() - entry.time < this.policy.ttl;
  }
}
