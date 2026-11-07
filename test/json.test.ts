/**
 * Unit tests of the mapping from the archive's JSON answers to the backend's types (`adapters/json.ts`).
 *
 * @remarks
 * These tests need neither VS Code, Git nor the network. Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { toCitationEntry, toKnown, toSaveRequest, toVisit, toVisits } from '#core/backend/adapters/json';
import { UserError } from '#core';

test('toVisit keeps the fields of a well-formed visit', () => {
  const raw = { date: '2024-01-02T03:04:05Z', status: 'full', snapshot: 'ab'.repeat(20), visit: 7, type: 'git' };
  assert.deepEqual(toVisit(raw), { date: raw.date, status: 'full', snapshot: raw.snapshot });
});

test('toVisit leaves out a snapshot that is not a string', () => {
  assert.deepEqual(toVisit({ date: '2024-01-02', status: 'failed', snapshot: null }), { date: '2024-01-02', status: 'failed' });
  assert.deepEqual(toVisit({ date: '2024-01-02', status: 'failed' }), { date: '2024-01-02', status: 'failed' });
});

test('toVisit rejects a visit without a date or status as strings', () => {
  for (const raw of [null, undefined, 'full', 42, [], { status: 'full' }, { date: '2024-01-02' }, { date: 1, status: 'full' }]) {
    assert.equal(toVisit(raw), undefined, JSON.stringify(raw));
  }
});

test('toVisits keeps the well-formed visits, in order', () => {
  const visits = toVisits([{ date: 'd1', status: 'full' }, { status: 'partial' }, { date: 'd3', status: 'partial' }]);
  assert.deepEqual(visits, [{ date: 'd1', status: 'full' }, { date: 'd3', status: 'partial' }]);
  assert.deepEqual(toVisits([]), []);
});

test('toVisits throws when the answer is not a list', () => {
  for (const raw of [null, undefined, {}, 'visits']) assert.throws(() => toVisits(raw), UserError);
});

test('toSaveRequest keeps the origin and the status', () => {
  const raw = { save_request_status: 'pending', id: 1, visit_type: 'git' };
  assert.deepEqual(toSaveRequest('https://example.org/me/repo', raw), { origin: 'https://example.org/me/repo', status: 'pending' });
});

test('toSaveRequest throws when the answer has no status as a string', () => {
  for (const raw of [null, undefined, 'accepted', {}, { save_request_status: 1 }]) {
    assert.throws(() => toSaveRequest('https://example.org/me/repo', raw), UserError);
  }
});

test('toKnown reads whether each SWHID is known', () => {
  const known = toKnown({ 'swh:1:cnt:a': { known: true }, 'swh:1:cnt:b': { known: false }, 'swh:1:cnt:c': null, 'swh:1:cnt:d': { known: 'yes' } });
  assert.deepEqual([...known], [['swh:1:cnt:a', true], ['swh:1:cnt:b', false], ['swh:1:cnt:c', false], ['swh:1:cnt:d', false]]);
  assert.deepEqual([...toKnown({})], []);
});

test('toKnown throws when the answer is not an object', () => {
  for (const raw of [null, undefined, [], 'known']) assert.throws(() => toKnown(raw), UserError);
});

test('toCitationEntry gives the entry, if any', () => {
  assert.equal(toCitationEntry({ content: '@software{x}' }), '@software{x}');
  for (const raw of [null, undefined, {}, { content: 1 }, ['@software{x}']]) assert.equal(toCitationEntry(raw), undefined);
});
