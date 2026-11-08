/**
 * Tests of the client on a fake archive in memory, through {@link ArchiveApi}.
 *
 * @remarks
 * {@link Swh} talks to the archive only through {@link ArchiveApi}:
 * these tests give it a fake one, with neither HTTP nor `fetch`, and check
 * the client's own logic: memos, refresh, origin candidates, save requests.
 * Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { type ArchiveApi, type CitationTarget, Git, type LatestVisit, type SaveRequest, Swh, Swhid, UserError, type Visit } from '#core';

/** A fake archive in memory, which records what it is asked. */
class FakeArchive implements ArchiveApi {
  /** The SWHIDs of each `known` call, in order. */
  knownCalls: string[][] = [];
  /** The origins of each `latestVisit` call, in order. */
  latestCalls: string[] = [];
  /** Called during `known`, before answering, e.g. to refresh the client meanwhile. */
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
 * A client on a fake archive.
 *
 * @param archive - The fake archive.
 * @returns The client.
 */
const swhOn = (archive: ArchiveApi) => new Swh({ git: new Git(), archive });

/** Two content SWHIDs, and their texts as the archive is asked about them. */
const A = Swhid.of('cnt', 'a'.repeat(40));
const B = Swhid.of('cnt', 'b'.repeat(40));
const [a, b] = [A.toString(), B.toString()];

test('known SWHIDs are asked once, and remembered', async () => {
  const archive = new FakeArchive(new Set([a]));
  const s = swhOn(archive);
  await s.rememberKnown([A, B, A]);
  assert.deepEqual(archive.knownCalls, [[a, b]]);
  assert.equal(s.knownP(A), true);
  assert.equal(s.knownP(B), false);

  // remembered: not asked again
  assert.equal(await s.archivedP(A), true);
  assert.equal(archive.knownCalls.length, 1);

  // a refresh forgets what is not held, not what is
  s.refresh();
  await s.rememberKnown([A, B]);
  assert.deepEqual(archive.knownCalls[1], [b]);
});

test('an answer from before a refresh is not remembered', async () => {
  const archive = new FakeArchive(new Set([a]));
  const s = swhOn(archive);
  archive.duringKnown = () => s.refresh();
  await s.rememberKnown([A]);
  assert.equal(s.knownP(A), false);
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

// The visits of a repository need its root; another's, its URL: there is no
// way to ask with neither, which would ask about the process's directory.
test("an origin's visits, by URL", async () => {
  const visit = { date: '2026-07-01T10:00:00+00:00', status: 'full', snapshot: 'ab'.repeat(20) };
  const archive = new FakeArchive(new Set(), new Map([['https://example.org/me/repo.git', visit]]));
  const found = await swhOn(archive).visitsOf('https://example.org/me/repo');
  assert.deepEqual(found, { origin: 'https://example.org/me/repo.git', archived: true, visits: [visit] });
  // not archived: no visits, and the archive is not asked for them
  assert.deepEqual(await swhOn(archive).visitsOf('https://example.org/me/other'), { origin: 'https://example.org/me/other', archived: false, visits: [] });
  await assert.rejects(swhOn(archive).visitsOf('/srv/repo'), /Not a public repository URL/);
});

test('a save request forgets what it changes, even when it fails', async () => {
  const archive = new FakeArchive(new Set(), new Map());
  const s = swhOn(archive);
  await s.rememberKnown([B]);
  archive.saveAnswer = () => {
    throw new UserError('refused');
  };
  await assert.rejects(s.saveOrigin('https://example.org/me/repo'), /refused/);
  // the negative answer is forgotten: asked again
  await s.rememberKnown([B]);
  assert.equal(archive.knownCalls.length, 2);
});
