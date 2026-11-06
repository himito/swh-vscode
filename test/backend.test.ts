// The direct backend on a real Git repository, the archive faked.

import { test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { promises as fs, realpathSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Swh } from '../src/backend';
import { Git } from '../src/git';

let dir: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

/** What the fake archive holds, and what it was asked. */
let archived = new Set<string>();
let origins = new Set<string>();
let asked: string[][] = [];
let requests: string[] = [];
const realFetch = globalThis.fetch;

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

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
    if (u.port === '8642') throw new Error('ECONNREFUSED');
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

after(async () => {
  globalThis.fetch = realFetch;
  await fs.rm(dir, { recursive: true, force: true });
});

function swh(token?: string) {
  return new Swh({
    archiveUrl: () => 'https://archive.example.org',
    daemonUrl: () => 'http://127.0.0.1:8642',
    token: async () => token,
    warn: () => undefined,
    git: new Git(),
  });
}

const reset = (a: string[] = [], o: string[] = []) => {
  archived = new Set(a);
  origins = new Set(o);
  asked = [];
  requests = [];
};

test('git root and content SWHID', async () => {
  const s = swh();
  assert.equal(await s.git.root(path.join(dir, 'sub', 'b.txt')), dir);
  assert.equal(await s.git.root(os.tmpdir()), undefined);
  assert.equal(await s.contentSwhid(path.join(dir, 'a.txt'), dir), 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt'));
  assert.equal(await s.worktreeSwhid(path.join(dir, 'sub'), dir), 'swh:1:dir:' + git('rev-parse', 'HEAD:sub'));
  assert.equal(await s.originOf(dir), 'https://example.org/me/repo');
});

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

test('direct tree is Merkle-pruned', async () => {
  const rootSwhid = 'swh:1:dir:' + git('rev-parse', 'HEAD^{tree}');
  const subSwhid = 'swh:1:dir:' + git('rev-parse', 'HEAD:sub');
  const aSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt');
  const bSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:sub/b.txt');

  reset([rootSwhid]);
  let nodes = await swh().tree(dir);
  assert.deepEqual(nodes[0], { path: '.', swhid: rootSwhid, dir: true, archived: true });
  assert.deepEqual(nodes.slice(1).map((n) => n.swhid), [aSwhid, subSwhid, bSwhid]);
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

test('qualified SWHID, anchored and archived', async () => {
  const commit = git('rev-parse', 'HEAD');
  const aSwhid = 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt');
  reset([aSwhid, 'swh:1:rev:' + commit], ['https://example.org/me/repo']);
  const s = swh();
  const info = await s.qualifiedSwhid(path.join(dir, 'a.txt'), '1');
  assert.equal(
    info.swhid,
    `${aSwhid};origin=https://example.org/me/repo;visit=swh:1:snp:${'ab'.repeat(20)};anchor=swh:1:rev:${commit};path=/a.txt;lines=1`,
  );
  assert.equal(info.archived, true);
  assert.equal(info['origin-archived'], true);
  // the tokenless rate limit is tracked
  assert.equal(s.rateLimitText(), '20/120');

  // edited since: the archived version is that of the commit
  writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
  const archivedInfo = await s.qualifiedSwhid(path.join(dir, 'a.txt'), '1', true);
  assert.equal(archivedInfo.core, aSwhid);
  assert.equal(archivedInfo.version, 'swh:1:rev:' + commit);
  assert.ok(!archivedInfo.swhid.includes('lines='));
  const now = await s.qualifiedSwhid(path.join(dir, 'a.txt'));
  assert.equal(now.archived, false);
  assert.equal(await s.unarchivedWhy(path.join(dir, 'a.txt')), 'it has uncommitted changes');
  git('checkout', '-q', 'a.txt');
  assert.equal(await s.unarchivedWhy(path.join(dir, 'a.txt')), 'the commit holding it is not pushed');
});

test('status, unreachable archive, save', async () => {
  reset([], ['https://example.org/me/repo']);
  const s = swh();
  const info = await s.origin(dir, true);
  assert.equal(info.origin, 'https://example.org/me/repo');
  assert.equal(info.archived, true);
  // the branch tracks no remote branch: no upstream
  assert.equal(info.upstream, undefined);
  const saved = await s.saveOrigin('https://example.org/me/repo');
  assert.equal(saved.save_request_status, 'accepted');
  assert.equal(saved.origin, 'https://example.org/me/repo');
  await assert.rejects(s.saveOrigin('/srv/repo'), /not a public URL/);

  // the archive unreachable: the SWHID from Git alone
  const failing = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  try {
    const t = await swh().qualifiedSwhid(path.join(dir, 'a.txt'));
    assert.equal(t.swhid, 'swh:1:cnt:' + git('rev-parse', 'HEAD:a.txt'));
    assert.match(t.unchecked!, /Cannot reach/);
  } finally {
    globalThis.fetch = failing;
  }
});
