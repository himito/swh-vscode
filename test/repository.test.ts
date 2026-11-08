/**
 * Tests of the client on a real Git repository, and of its HTTP adapter,
 * both on a fake archive.
 *
 * @remarks
 * One temporary repository serves the whole file, and `globalThis.fetch` is
 * replaced with a fake Software Heritage archive. It answers the `/known/`,
 * latest visit and save requests from {@link archived} and {@link origins},
 * and the citation requests with {@link citationReply}, which a test sets to
 * any status, body and headers, e.g. a 429 or rate limit headers. No
 * network is needed. Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { promises as fs, realpathSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ANCHOR_CANDIDATES_MAX, Git, HttpArchiveApi, KNOWN_BATCH_SIZE, LineRange, RATE_LIMIT_MESSAGE, Swh, Swhid, UserError } from '#core';

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
/** How the fake archive answers a citation request: its status, body and headers. */
let citationReply: [number, unknown, Record<string, string>?] = [404, {}];
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
    if (p.startsWith('/raw-intrinsic-metadata/citation/')) return json(...citationReply);
    return json(404, {});
  }) as typeof fetch;
});

// Put the real `fetch` back and delete the repository.
after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * A client talking to the fake archive.
 *
 * @param token - The API token it sends, if any.
 * @returns A fresh client, its memos empty.
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
  citationReply = [404, {}];
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

// A directory's tree in HEAD only when its tracked files are HEAD's: a change
// only staged counts, a file whose date alone changed does not; the user's
// index is left as it was.
test('head tree: staged changes and dates', async () => {
  const s = swh();
  const head = git('rev-parse', 'HEAD^{tree}');
  const index = () => git('ls-files', '--stage', '--debug');
  try {
    // only staged: the working tree matches the index, the index not HEAD
    writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    git('add', 'a.txt');
    const staged = index();
    assert.equal(await s.headTree(dir, dir), undefined);
    assert.equal(index(), staged, 'the index is left alone');
  } finally {
    git('reset', '-q', '--', 'a.txt');
    git('checkout', '-q', 'a.txt');
  }
  // the date alone changed: unchanged
  const later = new Date(Date.now() + 60_000);
  await fs.utimes(path.join(dir, 'a.txt'), later, later);
  assert.equal(await s.headTree(dir, dir), head);
});

// Untracked files count only when Git does not ignore them; an empty
// directory, which Git cannot track, does not count either.
test('untracked files', async () => {
  const s = swh();
  const scratch = path.join(dir, 'scratch');
  mkdirSync(scratch);
  try {
    assert.equal(await s.untracked(scratch), false, 'an empty directory');
    writeFileSync(path.join(scratch, '.gitignore'), '*\n');
    writeFileSync(path.join(scratch, 'ignored.log'), 'ignored\n');
    assert.equal(await s.untracked(scratch), false, 'only ignored files');
    await fs.rm(path.join(scratch, '.gitignore'));
    assert.equal(await s.untracked(scratch), true, 'a file Git does not ignore');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
  assert.equal(await s.untracked(dir), false, 'a clean repository');
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
  const info = await s.qualifiedSwhid(path.join(dir, 'a.txt'), LineRange.of(1));
  assert.equal(
    String(info.swhid),
    `${aSwhid};origin=https://example.org/me/repo;visit=swh:1:snp:${'ab'.repeat(20)};anchor=swh:1:rev:${commit};path=/a.txt;lines=1`,
  );
  assert.equal(info.archived, true);
  assert.equal(info['origin-archived'], true);
  // the tokenless rate limit is tracked
  assert.equal(s.rateLimitText(), '20/120');

  // unedited: the archived version is the working tree's, its lines hold
  const same = await s.qualifiedSwhid(path.join(dir, 'a.txt'), LineRange.of(1), true);
  assert.ok(same.version?.equals(Swhid.of('rev', commit)));
  assert.equal(String(same.swhid.qualifiers.lines), '1');

  // edited since: the archived version is that of the commit
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  const archivedInfo = await s.qualifiedSwhid(path.join(dir, 'a.txt'), LineRange.of(1), true);
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
  const info = await s.originWithUpstream(dir);
  assert.equal(info.origin, 'https://example.org/me/repo');
  assert.equal(info.archived, true);
  // the branch tracks no remote branch: no upstream
  assert.equal(info.upstream, undefined);
  const saved = await s.saveOrigin('https://example.org/me/repo');
  assert.deepEqual(saved, { origin: 'https://example.org/me/repo', status: 'accepted' });
  await assert.rejects(s.saveOrigin('/srv/repo'), /^UserError: The origin \/srv\/repo is not a public URL$/);

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

// The archive is asked about at most KNOWN_BATCH_SIZE SWHIDs per request, and
// the answers of all the batches come back together; no SWHID, no request.
test('known SWHIDs are asked in batches', async () => {
  const swhids = Array.from({ length: KNOWN_BATCH_SIZE + 1 }, (_, n) => 'swh:1:cnt:' + n.toString(16).padStart(40, '0'));
  reset([swhids[0], swhids[KNOWN_BATCH_SIZE]]);
  const archive = new HttpArchiveApi({ archiveUrl: () => 'https://archive.example.org', token: async () => undefined });
  const answers = await archive.known(swhids);
  assert.deepEqual(asked.map((batch) => batch.length), [KNOWN_BATCH_SIZE, 1]);
  assert.deepEqual(asked.flat(), swhids);
  assert.equal(answers.size, swhids.length);
  assert.deepEqual([...answers].filter(([, known]) => known).map(([swhid]) => swhid), [swhids[0], swhids[KNOWN_BATCH_SIZE]]);

  reset();
  assert.equal((await archive.known([])).size, 0);
  assert.equal(asked.length, 0);
});

// A citation is asked for by SWHID or by origin, in BibTeX; the archive's
// entry is given as it is, a 400 or 404 means it has no metadata to cite,
// and anything else, an answer without an entry included, that it failed.
test('citations: the request, and the answer', async () => {
  reset();
  const archive = new HttpArchiveApi({ archiveUrl: () => 'https://archive.example.org', token: async () => undefined });
  const lastRequest = () => new URL(requests[requests.length - 1].split(' ')[1]);
  const swhid = 'swh:1:cnt:' + '0'.repeat(40) + ';origin=https://example.org/a%20b';

  citationReply = [200, { content: '@software{x}' }];
  assert.deepEqual(await archive.citation({ swhid }), { entry: '@software{x}' });
  assert.equal(lastRequest().pathname, '/api/1/raw-intrinsic-metadata/citation/swhid/');
  assert.equal(lastRequest().searchParams.get('citation_format'), 'bibtex');
  assert.equal(lastRequest().searchParams.get('target_swhid'), swhid);

  citationReply = [404, { reason: 'no metadata' }];
  assert.equal(await archive.citation({ origin: 'https://example.org/me/repo' }), 'no-metadata');
  assert.equal(lastRequest().pathname, '/api/1/raw-intrinsic-metadata/citation/origin/');
  assert.equal(lastRequest().searchParams.get('origin_url'), 'https://example.org/me/repo');

  citationReply = [400, {}];
  assert.equal(await archive.citation({ swhid }), 'no-metadata');
  citationReply = [500, {}];
  assert.equal(await archive.citation({ swhid }), 'failed');
  citationReply = [200, { other: 'no entry' }];
  assert.equal(await archive.citation({ swhid }), 'failed');
});

// The rate limit reached is an error the user can act on: it says when to
// retry, as the archive tells it, and starts with RATE_LIMIT_MESSAGE.
test('the rate limit reached', async () => {
  reset();
  const archive = new HttpArchiveApi({ archiveUrl: () => 'https://archive.example.org', token: async () => undefined });
  const swhid = 'swh:1:cnt:' + '0'.repeat(40);
  citationReply = [429, {}, { 'Retry-After': '30' }];
  await assert.rejects(archive.citation({ swhid }), (error) => error instanceof UserError && error.message === `${RATE_LIMIT_MESSAGE}; retry in 30 seconds`);
  citationReply = [429, {}];
  await assert.rejects(archive.citation({ swhid }), (error) => error instanceof UserError && error.message === `${RATE_LIMIT_MESSAGE}; retry in a few seconds`);
});

// The rate limit is read from the answer's X-RateLimit-* headers; without a
// reset time, its window ends in an hour; without them, it is left as it was.
test('the rate limit, from the headers', async () => {
  reset();
  const archive = new HttpArchiveApi({ archiveUrl: () => 'https://archive.example.org', token: async () => undefined });
  const swhid = 'swh:1:cnt:' + '0'.repeat(40);
  const before = Date.now() / 1000;
  citationReply = [200, { content: '@x{}' }, { 'X-RateLimit-Limit': '120', 'X-RateLimit-Remaining': '119' }];
  await archive.citation({ swhid });
  const limit = archive.rateLimit()!;
  assert.deepEqual([limit.used, limit.limit], [1, 120]);
  assert.ok(limit.reset >= before + 3600 && limit.reset <= Date.now() / 1000 + 3600, 'an hour from now');

  citationReply = [200, { content: '@x{}' }, { 'X-RateLimit-Limit': '120' }];
  await archive.citation({ swhid });
  assert.deepEqual(archive.rateLimit(), limit);
});

// A file last changed long ago, under more commits than are looked at: the
// commit that last changed it is still a candidate anchor, the surest one.
test('the anchor of a file changed long ago', async () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-long-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.org');
    run('config', 'user.name', 'T');
    run('config', 'commit.gpgsign', 'false');
    run('remote', 'add', 'origin', 'git@example.org:me/repo.git');
    writeFileSync(path.join(repo, 'old.txt'), 'unchanged since\n');
    run('add', '.');
    run('commit', '-q', '-m', 'old.txt');
    const lastChange = run('rev-parse', 'HEAD');
    // more commits on top than the anchor candidates look at, none touching old.txt
    let tree = run('rev-parse', 'HEAD^{tree}');
    let parent = lastChange;
    for (let n = 0; n <= ANCHOR_CANDIDATES_MAX; n++) {
      parent = execFileSync('git', ['commit-tree', tree, '-p', parent, '-m', `empty ${n}`], { cwd: repo, encoding: 'utf8' }).trim();
    }
    run('update-ref', 'refs/heads/main', parent);

    const blob = run('rev-parse', 'HEAD:old.txt');
    // the archive holds only the commit that last changed old.txt
    reset(['swh:1:cnt:' + blob, 'swh:1:rev:' + lastChange], ['https://example.org/me/repo']);
    const info = await swh().qualifiedSwhid(path.join(repo, 'old.txt'));
    assert.ok(info.swhid.qualifiers.anchor?.equals(Swhid.of('rev', lastChange)));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// The archived version of a path is that of the same kind: when `p` was a
// file in the archived commit and is a directory now, the archived version of
// the directory is none, not the old file's content passed off as a directory.
test('the archived version of a path that changed kind', async () => {
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-kind-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.org');
    run('config', 'user.name', 'T');
    run('config', 'commit.gpgsign', 'false');
    run('remote', 'add', 'origin', 'git@example.org:me/repo.git');
    writeFileSync(path.join(repo, 'p'), 'a file\n');
    run('add', '.');
    run('commit', '-q', '-m', 'p is a file');
    const archivedCommit = run('rev-parse', 'HEAD');
    await fs.rm(path.join(repo, 'p'));
    mkdirSync(path.join(repo, 'p'));
    writeFileSync(path.join(repo, 'p', 'inside.txt'), 'in a directory\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'p is a directory');

    reset(['swh:1:rev:' + archivedCommit], ['https://example.org/me/repo']);
    const info = await swh().qualifiedSwhid(path.join(repo, 'p'), undefined, true);
    assert.equal(info.version, undefined, 'no archived commit holds p as a directory');
    assert.equal(info.core.type, 'dir');
    assert.equal(info.core.hash, run('rev-parse', 'HEAD:p'));
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// Whether the archive is asked about a file: outside a repository, yes, as
// its content may have been archived from elsewhere; in a repository without
// a public origin, no, as such a repository cannot be archived.
test('when the archive is asked about a file', async () => {
  const loose = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-ask-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: loose, encoding: 'utf8' }).trim();
  try {
    const file = path.join(loose, 'loose.txt');
    writeFileSync(file, 'archived from elsewhere\n');
    const swhid = 'swh:1:cnt:' + execFileSync('git', ['hash-object', '--no-filters', file], { encoding: 'utf8' }).trim();

    reset([swhid]);
    const outside = await swh().qualifiedSwhid(file);
    assert.equal(outside.archived, true);
    assert.equal(String(outside.swhid), swhid, 'no context outside a repository');
    assert.deepEqual(asked, [[swhid]]);

    run('init', '-q', '-b', 'main');
    run('remote', 'add', 'origin', '/srv/git/private');
    reset([swhid]);
    const unpublished = await swh().qualifiedSwhid(file);
    assert.equal(unpublished.archived, false);
    assert.deepEqual(asked, [], 'not asked without a public origin');
  } finally {
    await fs.rm(loose, { recursive: true, force: true });
  }
});

// Why the archive cannot hold a file, each reason in turn: outside a
// repository there is none to tell; then the remote, the origin, tracking,
// changes, and the commit that last changed it being pushed.
test('why a file is not archived', async () => {
  const s = swh();
  const repo = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-why-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const file = path.join(repo, 'f.txt');
  try {
    writeFileSync(file, 'f\n');
    assert.equal(await s.unarchivedWhy(file), undefined, 'outside a repository');

    run('init', '-q', '-b', 'main');
    run('config', 'user.email', 't@example.org');
    run('config', 'user.name', 'T');
    run('config', 'commit.gpgsign', 'false');
    assert.equal(await s.unarchivedWhy(file), 'the repository has no remote');

    run('remote', 'add', 'origin', '/srv/git/private');
    assert.equal(await s.unarchivedWhy(file), 'the origin /srv/git/private is not a public URL');

    run('remote', 'set-url', 'origin', 'git@example.org:me/why.git');
    assert.equal(await s.unarchivedWhy(file), 'Git does not track it');

    run('add', 'f.txt');
    run('commit', '-q', '-m', 'f');
    assert.equal(await s.unarchivedWhy(file), 'the commit holding it is not pushed');

    run('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.equal(await s.unarchivedWhy(file), undefined, 'pushed: nothing prevents it');
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

// A file's content SWHID outside a repository: its bytes as they are on disk,
// as `git hash-object --no-filters` hashes them; a file Git cannot read is
// an error the user is told about.
test('a content SWHID outside a repository', async () => {
  const s = swh();
  const loose = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-loose-')));
  try {
    const file = path.join(loose, 'notes.txt');
    writeFileSync(file, 'line one\r\nline two\r\n');
    const expected = execFileSync('git', ['hash-object', '--no-filters', file], { encoding: 'utf8' }).trim();
    assert.equal(String(await s.contentSwhid(file, undefined)), 'swh:1:cnt:' + expected);
    await assert.rejects(s.contentSwhid(path.join(loose, 'missing.txt'), undefined), /^UserError: Cannot hash .*missing\.txt with git$/);
  } finally {
    await fs.rm(loose, { recursive: true, force: true });
  }
});

// The branch's upstream, when it is a remote branch: its commit, and whether
// the archive holds it; asked only of an archived origin.
test("the branch's upstream commit", async () => {
  const head = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', head);
  git('branch', '-q', '--set-upstream-to=origin/main');
  try {
    reset(['swh:1:rev:' + head], ['https://example.org/me/repo']);
    const status = await swh().originWithUpstream(dir);
    assert.ok(status.upstream?.equals(Swhid.of('rev', head)));
    assert.equal(status['upstream-archived'], true);

    reset([], ['https://example.org/me/repo']);
    assert.equal((await swh().originWithUpstream(dir))['upstream-archived'], false);

    // the origin not archived: the upstream is not asked about
    reset(['swh:1:rev:' + head]);
    const unarchived = await swh().originWithUpstream(dir);
    assert.equal(unarchived.upstream, undefined);
    assert.ok(!asked.flat().includes('swh:1:rev:' + head));
  } finally {
    git('branch', '-q', '--unset-upstream');
    git('update-ref', '-d', 'refs/remotes/origin/main');
  }
});

// A repository's remote: the one Git would fetch from (here `origin`), else
// the only remote, whatever its name; none when there are several others,
// or none at all.
test("a repository's remote", async () => {
  const s = swh();
  assert.equal(await s.originOf(dir), 'https://example.org/me/repo');

  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swh-remote-')));
  const run = (...args: string[]) => execFileSync('git', args, { cwd: other, encoding: 'utf8' });
  try {
    run('init', '-q', '-b', 'main');
    assert.equal(await s.originOf(other), undefined, 'no remote');
    run('remote', 'add', 'upstream', 'https://example.org/up/repo.git');
    assert.equal(await s.originOf(other), 'https://example.org/up/repo', 'the only remote, not named origin');
    run('remote', 'add', 'fork', 'https://example.org/fork/repo.git');
    assert.equal(await s.originOf(other), undefined, 'several remotes, none named origin');
    run('remote', 'add', 'origin', 'git@example.org:me/other.git');
    assert.equal(await s.originOf(other), 'https://example.org/me/other', 'origin among several');
  } finally {
    await fs.rm(other, { recursive: true, force: true });
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
