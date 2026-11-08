/**
 * Unit tests of {@link Memo}, the remembered archive answers.
 *
 * @remarks
 * The time is controlled: `Date.now` is replaced while each test runs, so
 * that answers age without waiting. Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { afterEach, beforeEach, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Memo, MEMO_TTL } from '#core/archive/memo';

/** The real `Date.now`, put back after each test. */
const realNow = Date.now;

/** The current time of the tests, in milliseconds. */
let clock = 0;

/**
 * Lets the test time pass.
 *
 * @param seconds - How long.
 */
const wait = (seconds: number) => {
  clock += seconds * 1000;
};

beforeEach(() => {
  clock = 1_700_000_000_000;
  Date.now = () => clock;
});

afterEach(() => {
  Date.now = realNow;
});

// What the archive holds stays there: a positive answer is kept for the
// session, a negative one for the TTL only.
test('keeps positives for the session', () => {
  const memo = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });
  memo.put('held', true);
  memo.put('not held', false);
  // a negative answer is an answer: known, and `false`
  assert.equal(memo.get('not held'), false);
  assert.ok(memo.has('not held'));
  assert.equal(memo.get('never asked'), undefined);
  assert.ok(!memo.has('never asked'));

  wait(MEMO_TTL - 1);
  assert.ok(memo.has('not held'));
  wait(1);
  assert.ok(!memo.has('not held'));
  assert.equal(memo.get('not held'), undefined);
  assert.equal(memo.get('held'), true);
});

// An origin's status may change at any time: every answer for the TTL only.
test('trusts every answer for the TTL', () => {
  const memo = new Memo<{ archived: boolean }>({ ttl: 10, keepPositives: false });
  memo.put('origin', { archived: true });
  wait(9);
  assert.deepEqual(memo.get('origin'), { archived: true });
  wait(1);
  assert.equal(memo.get('origin'), undefined);
});

// An answer asked for before the memo forgot may be out of date: it is
// ignored if what the memo forgot since would have included it.
test('ignores an answer asked for before the memo forgot it', () => {
  const memo = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });
  const asOf = memo.generation;
  memo.forget((known) => !known);
  // the generation changes even when nothing is forgotten
  assert.notEqual(memo.generation, asOf);
  assert.equal(memo.put('swhid', false, asOf), false, 'would have been forgotten');
  assert.ok(!memo.has('swhid'));
  assert.equal(memo.put('held', true, asOf), true, 'would have been kept');
  assert.ok(memo.has('held'));

  const afterClear = memo.generation;
  memo.clear();
  assert.equal(memo.put('swhid', true, afterClear), false);
  // asked for now: remembered
  assert.equal(memo.put('swhid', true, memo.generation), true);
  assert.equal(memo.put('other', true), true);
  assert.ok(memo.has('swhid') && memo.has('other'));
});

// Forgetting picks its answers; clearing forgets them all.
test('forgets what it is told to', () => {
  const memo = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });
  memo.put('held', true);
  memo.put('not held', false);
  memo.forget((known) => !known);
  assert.ok(memo.has('held'));
  assert.ok(!memo.has('not held'));
  memo.clear();
  assert.ok(!memo.has('held'));
});
