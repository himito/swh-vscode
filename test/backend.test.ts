/**
 * Tests of the backend on a real Git repository with a fake archive.
 *
 * @remarks
 * One temporary repository serves the whole file, and `globalThis.fetch` is
 * replaced with a fake Software Heritage archive. It answers the `/known/`,
 * latest visit and save requests from {@link archived} and {@link origins}.
 * No network is needed. Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { promises as fs, realpathSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Git, HttpArchiveApi, Swh, Swhid } from '#core';

/** The temporary Git repository the tests run on, created before them. */
let dir: string;

/**
 * Run git in the temporary repository.
 *
 * @param args - The git arguments.
 * @returns Git's standard output, trimmed.
 */
const git =(...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** The SWHIDs the fake archive holds. */
let archived = new Set<string>();
/** The origin URLs the fake archive has visited. */
let origins = new Set<string>();
/** The SWHIDs of each `/known/` request the fake archive received, in order. */
let asked: string[][] = [];
/** Every request the fake archive received, as `METHOD URL`. */
let requests: string[] = [];
/** The real `fetch`, put back after the tests. */
const realFetch = globalThis.fetch;

/**
 * A JSON response of the fake archive.
 *
 * @param status - The HTTP status.
 * @param body - The body, serialized as JSON.
 * @param headers - Extra headers, e.g. the rate limit ones.
 * @returns The response.
 */
function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

// Create the repository: a.txt and sub/b.txt in one commit, and a remote that
// is never contacted. Then replace `fetch` with the fake archive.
before(() => {
  dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-test-')));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.org');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  git('remote', 'add', 'origin', 'git@example.org:me/repo.git');

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    const u = new URL(url);
    const p = u.pathname.replace(/^\/api\/1/, '');
    const rate = { 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '100', 'X-RateLimit-Reset': String(Date.now() / 1000 + 3600) };
    if (p === '/known/') {
      const swhids = JSON.parse(String(init?.body)) as string[];
      asked.push(swhids);
      return json(200, Object.fromEntries(swhids.map((s) => [s, { known: archived.has(s) }])), rate);
    }
    let m = /^\/origin\/(.*)\/visit\/latest\/$/.exec(p);
    if (m) {
      const origin = decodeURIComponent(m[1]);
      return origins.has(origin)
        ? json(200, { date: '2026-07-01T10:00:00+00:00', status: 'full', snapshot: 'ab'.repeat(20) })
        : json(404, { reason: 'not found' });
    }
    m = /^\/origin\/save\/git\/url\/(.*)\/$/.exec(p);
    if (m) return json(200, { save_request_status: 'accepted' });
    return json(404, {});
  }) as typeof fetch;
});

// Put the real `fetch` back and delete the repository.
after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A backend talking to the fake archive.
 *
 * @param token - The API token it sends, if any.
 * @returns A fresh backend, its memos empty.
 */
function swh(token?: string) {
  return new Swh({
    git: new Git(),
    archive: new HttpArchiveApi({ archiveUrl: () => 'https://archive.example.org', token: async () => token }),
  });
}

/**
 * Reset the fake archive, and forget the requests it received.
 *
 * @param a - The SWHIDs it holds.
 * @param o - The origins it has visited.
 */
const reset = (a: string[] = [], o: string[] = []) => {
  archived = new Set(a);
  origins = new Set(o);
  asked = [];
  requests = [];
};

// Repository root, content and directory SWHIDs as Git computes them, and the
// remote normalized into an origin.
test('git root and content SWHID', async () => {
  const s = swh();
  assert.equal(await s.git.root(path.join(dir, 'sub', 'b.txt')), dir);
  assert.equal(await s.git.root(os.tmpdir()), undefined);
  assert.equal(String(await s.contentSwhid(path.join(dir, 'a.txt'), dir)), 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt'));
  assert.equal(String(await s.worktreeSwhid(path.join(dir, 'sub'), dir)), 'swh:1:dir:' + git('rev-parse', 'HEAD:sub'));
  assert.equal(await s.originOf(dir), 'https://example.org/me/repo');
});

// The working tree's tree includes edits but not untracked files; computing it,
// or the HEAD tree of a directory, never touches the repository's index.
test('worktree tree leaves the index alone', async () => {
  const s = swh();
  const head = git('rev-parse', 'HEAD^{tree}');
  assert.equal(await s.worktreeTree(dir), head);
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  writeFileSync(path.join(dir, 'untracked.txt'), 'u\n');
  const tree = await s.worktreeTree(dir);
  assert.notEqual(tree, head);
  assert.equal(git('rev-parse', `${tree}:a.txt`), git('hash-object', 'a.txt'));
  assert.equal(git('diff', '--cached', '--name-only'), '');
  assert.equal(await s.headTree(dir, dir), undefined);
  assert.equal(await s.headTree(path.join(dir, 'sub'), dir), git('rev-parse', 'HEAD:sub'));
  assert.ok(await s.untracked(dir));
  git('checkout', '-q', 'a.txt');
  await fs.rm(path.join(dir, 'untracked.txt'));
  assert.equal(await s.headTree(dir, dir), head);
});

// An archived directory covers everything under it: the archive is asked only
// about what no archived directory covers, directories first.
test('direct tree is Merkle-pruned', async () => {
  const rootSwhid = 'swh:1:dir:' + git('rev-parse', 'HEAD^{tree}');
  const subSwhid = 'swh:1:dir:' + git('rev-parse', 'HEAD:sub');
  const aSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt');
  const bSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:sub/b.txt');

  reset([rootSwhid]);
  let nodes = await swh().tree(dir);
  assert.deepEqual({ ...nodes[0], swhid: String(nodes[0].swhid) }, { path: '.', swhid: rootSwhid, dir: true, archived: true });
  assert.deepEqual(nodes.slice(1).map((n) => String(n.swhid)), [aSwhid, subSwhid, bSwhid]);
  assert.ok(nodes.every((n) => n.archived));
  // the archived root covers everything: one request, directories only
  assert.equal(asked.length, 1);
  assert.deepEqual([...asked[0]].sort(), [rootSwhid, subSwhid].sort());

  reset([subSwhid, aSwhid]);
  nodes = await swh().tree(dir);
  assert.deepEqual(nodes.map((n) => n.archived), [false, true, true, true]);
  // directories, then the files no directory covers: a.txt only
  assert.equal(asked.length, 2);
  assert.deepEqual(asked[1], [aSwhid]);
});

// The full qualified SWHID (origin, visit, anchor, path, lines), the archived
// version of an edited file, the rate limit, and why a file is not archived.
test('qualified SWHID, anchored and archived', async () => {
  const commit = git('rev-parse', 'HEAD');
  const aSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt');
  reset([aSwhid, 'swh:1:rev:' + commit], ['https://example.org/me/repo']);
  const s = swh();
  const info = await s.qualifiedSwhid(path.join(dir, 'a.txt'), '1');
  assert.equal(
    String(info.swhid),
    `${aSwhid};origin=https://example.org/me/repo;visit=swh:1:snp:${'ab'.repeat(20)};anchor=swh:1:rev:${commit};path=/a.txt;lines=1`,
  );
  assert.equal(info.archived, true);
  assert.equal(info['origin-archived'], true);
  // the tokenless rate limit is tracked
  assert.equal(s.rateLimitText(), '20/120');

  // unedited: the archived version is the working tree's, its lines hold
  const same = await s.qualifiedSwhid(path.join(dir, 'a.txt'), '1', true);
  assert.ok(same.version?.equals(Swhid.of('rev', commit)));
  assert.equal(same.swhid.qualifiers.lines, '1');

  // edited since: the archived version is that of the commit
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  const archivedInfo = await s.qualifiedSwhid(path.join(dir, 'a.txt'), '1', true);
  assert.equal(String(archivedInfo.core), aSwhid);
  assert.ok(archivedInfo.version?.equals(Swhid.of('rev', commit)));
  assert.equal(archivedInfo.swhid.qualifiers.lines, undefined);
  const now = await s.qualifiedSwhid(path.join(dir, 'a.txt'));
  assert.equal(now.archived, false);
  assert.equal(await s.unarchivedWhy(path.join(dir, 'a.txt')), 'it has uncommitted changes');
  git('checkout', '-q', 'a.txt');
  assert.equal(await s.unarchivedWhy(path.join(dir, 'a.txt')), 'the commit holding it is not pushed');
});

// The origin's status, save requests, and the SWHID from Git alone when the
// archive cannot be reached.
test('status, unreachable archive, save', async () => {
  reset([], ['https://example.org/me/repo']);
  const s = swh();
  const info = await s.origin(dir, true);
  assert.equal(info.origin, 'https://example.org/me/repo');
  assert.equal(info.archived, true);
  // the branch tracks no remote branch: no upstream
  assert.equal(info.upstream, undefined);
  const saved = await s.saveOrigin('https://example.org/me/repo');
  assert.deepEqual(saved, { origin: 'https://example.org/me/repo', status: 'accepted' });
  await assert.rejects(s.saveOrigin('/srv/repo'), /not a public URL/);

  // the archive unreachable: the SWHID from Git alone
  const failing = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  try {
    const t = await swh().qualifiedSwhid(path.join(dir, 'a.txt'));
    assert.equal(String(t.swhid), 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt'));
    assert.match(t.unchecked!, /Cannot reach/);
  } finally {
    globalThis.fetch = failing;
  }
});

// The tokenless rate limit is shown only while it applies: not once a token
// is set, nor for another archive than the current one.
test('rate limit forgotten with a token, or another archive', async () => {
  reset();
  let token: string | undefined;
  let archiveUrl = 'https://archive.example.org';
  let updates = 0;
  const archive = new HttpArchiveApi({ archiveUrl: () => archiveUrl, token: async () => token, onRateLimit: () => updates++ });
  const s = new Swh({ git: new Git(), archive });

  await archive.known(['swh:1:cnt:' + '0'.repeat(40)]);
  assert.equal(s.rateLimitText(), '20/120');
  assert.equal(updates, 1);

  // another archive: its rate limit is not known yet
  archiveUrl = 'https://other.example.org';
  assert.equal(s.rateLimitText(), undefined);
  archiveUrl = 'https://archive.example.org';
  assert.equal(s.rateLimitText(), '20/120');

  // with a token, the tokenless rate limit no longer applies
  token = 'secret';
  await archive.known(['swh:1:cnt:' + '1'.repeat(40)]);
  assert.equal(s.rateLimitText(), undefined);
  assert.equal(updates, 2);
});
