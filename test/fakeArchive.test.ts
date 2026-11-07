/**
 * Tests of the backend on a fake archive in memory, through {@link ArchiveApi}.
 *
 * @remarks
 * {@link Swh} talks to the archive only through {@link ArchiveApi}:
 * these tests give it a fake one, with neither HTTP nor `fetch`, and check
 * the backend's own logic: memos, refresh, origin candidates, save requests.
 * Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { type ArchiveApi, type CitationTarget, Git, type LatestVisit, type SaveRequest, Swh, UserError, type Visit } from '../src/core';

/** A fake archive in memory, which records what it is asked. */
class FakeArchive implements ArchiveApi {
  /** The SWHIDs of each `known` call, in order. */
  knownCalls: string[][] = [];
  /** The origins of each `latestVisit` call, in order. */
  latestCalls: string[] = [];
  /** Called during `known`, before answering, e.g. to refresh the backend meanwhile. */
  duringKnown?: () => void;
  /** What `save` does: answer, or throw. */
  saveAnswer: () => SaveRequest = () => ({ origin: '', status: 'accepted' });

  /**
   * Creates the fake archive.
   *
   * @param held - The SWHIDs it holds.
   * @param visited - Origin URL → its latest visit, for the origins it holds.
   */
  constructor(
    private held = new Set<string>(),
    private visited = new Map<string, Visit>(),
  ) { }

  async known(swhids: readonly string[]): Promise<Map<string, boolean>> {
    this.knownCalls.push([...swhids]);
    this.duringKnown?.();
    return new Map(swhids.map((s) => [s, this.held.has(s)]));
  }

  async latestVisit(origin: string): Promise<LatestVisit> {
    this.latestCalls.push(origin);
    const visit = this.visited.get(origin);
    return visit ? { archived: true, visit } : { archived: false };
  }

  async visits(origin: string, count: number): Promise<Visit[]> {
    const visit = this.visited.get(origin);
    return visit ? [visit].slice(0, count) : [];
  }

  async save(): Promise<SaveRequest> {
    return this.saveAnswer();
  }

  async citation(target: CitationTarget) {
    return 'swhid' in target ? { entry: `@software{${target.swhid}}` } : ('no-metadata' as const);
  }

  rateLimit() {
    return undefined;
  }
}

/**
 * A backend on a fake archive.
 *
 * @param archive - The fake archive.
 * @returns The backend.
 */
const swhOn = (archive: ArchiveApi) => new Swh({ git: new Git(), archive });

test('known SWHIDs are asked once, and remembered', async () => {
  const archive = new FakeArchive(new Set(['swh:1:cnt:a']));
  const s = swhOn(archive);
  await s.rememberKnown(['swh:1:cnt:a', 'swh:1:cnt:b', 'swh:1:cnt:a']);
  assert.deepEqual(archive.knownCalls, [['swh:1:cnt:a', 'swh:1:cnt:b']]);
  assert.equal(s.knownP('swh:1:cnt:a'), true);
  assert.equal(s.knownP('swh:1:cnt:b'), false);

  // remembered: not asked again
  assert.equal(await s.archivedP('swh:1:cnt:a'), true);
  assert.equal(archive.knownCalls.length, 1);

  // a refresh forgets what is not held, not what is
  s.refresh();
  await s.rememberKnown(['swh:1:cnt:a', 'swh:1:cnt:b']);
  assert.deepEqual(archive.knownCalls[1], ['swh:1:cnt:b']);
});

test('an answer from before a refresh is not remembered', async () => {
  const archive = new FakeArchive(new Set(['swh:1:cnt:a']));
  const s = swhOn(archive);
  archive.duringKnown = () => s.refresh();
  await s.rememberKnown(['swh:1:cnt:a']);
  assert.equal(s.knownP('swh:1:cnt:a'), false);
});

test("an origin's status tries its candidates in order", async () => {
  const visit = { date: '2026-07-01T10:00:00+00:00', status: 'full', snapshot: 'ab'.repeat(20) };
  const archive = new FakeArchive(new Set(), new Map([['https://example.org/me/repo.git', visit]]));
  const info = await swhOn(archive).originStatus('https://example.org/me/repo');
  assert.deepEqual(archive.latestCalls, ['https://example.org/me/repo', 'https://example.org/me/repo.git']);
  assert.deepEqual(info, { origin: 'https://example.org/me/repo.git', archived: true, ...visit });

  const none = await swhOn(new FakeArchive()).originStatus('https://example.org/me/other');
  assert.deepEqual(none, { origin: 'https://example.org/me/other', archived: false });
});

test('a save request forgets what it changes, even when it fails', async () => {
  const archive = new FakeArchive(new Set(), new Map());
  const s = swhOn(archive);
  await s.rememberKnown(['swh:1:cnt:b']);
  archive.saveAnswer = () => {
    throw new UserError('refused');
  };
  await assert.rejects(s.saveOrigin('https://example.org/me/repo'), /refused/);
  // the negative answer is forgotten: asked again
  await s.rememberKnown(['swh:1:cnt:b']);
  assert.equal(archive.knownCalls.length, 2);
});
