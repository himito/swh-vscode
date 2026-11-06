import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ancestors,
  encodeOrigin,
  encodePath,
  findSwhids,
  normalizeOrigin,
  originCandidates,
  pathOrigin,
  qualifiers,
  qualify,
  shortSwhid,
  versionAtLeast,
} from '../src/swhid';
import { citation } from '../src/citation';
import { buildScan, scanSummary } from '../src/scanModel';

test('normalizeOrigin', () => {
  const cases: Array<[string, string]> = [
    ['https://github.com/bzg/swh.el.git', 'https://github.com/bzg/swh.el'],
    ['https://github.com/bzg/swh.el/', 'https://github.com/bzg/swh.el'],
    ['https://user@GitHub.com/bzg/swh.el.GIT', 'https://github.com/bzg/swh.el'],
    ['HTTP://example.org:8080/x', 'http://example.org:8080/x'],
    ['ssh://git@github.com:22/bzg/swh.el.git', 'https://github.com/bzg/swh.el'],
    ['git://example.org/repo', 'https://example.org/repo'],
    ['git+ssh://git@example.org/repo.git', 'https://example.org/repo'],
    ['git@github.com:bzg/swh.el.git', 'https://github.com/bzg/swh.el'],
    ['github.com:/bzg/swh.el', 'https://github.com/bzg/swh.el'],
    ['/srv/git/repo', '/srv/git/repo'],
    ['file:///srv/git/repo', 'file:///srv/git/repo'],
    ['C:\\repos\\x', 'C:\\repos\\x'],
    ['C:/repos/x', 'C:/repos/x'],
  ];
  for (const [url, origin] of cases) assert.equal(normalizeOrigin(url), origin, url);
  assert.deepEqual(originCandidates('git@h.org:a/b'), ['https://h.org/a/b', 'https://h.org/a/b.git']);
  assert.deepEqual(originCandidates('/srv/repo'), ['/srv/repo']);
});

// values from swhid-clj, which the daemon renders qualifiers with
test('qualify encoding', () => {
  assert.equal(encodeOrigin('https://h/o r\tx\u00a0é'), 'https://h/o%20r%09x%C2%A0é');
  assert.equal(encodePath('/src/my file é;%.el'), '/src/my%20file%20%C3%A9%3B%25.el');
  assert.equal(
    qualify('swh:1:cnt:x', 'https://h/o r', null, 'swh:1:rev:y', 'src/my file é.el', null),
    'swh:1:cnt:x;origin=https://h/o%20r;anchor=swh:1:rev:y;path=/src/my%20file%20%C3%A9.el',
  );
  assert.deepEqual(qualifiers('swh:1:cnt:x;origin=https://h/o%20r;path=/src/my%20file%20%C3%A9.el'), {
    origin: 'https://h/o r',
    path: '/src/my file é.el',
  });
  // the root, lines, a snapshot; a private origin is left out
  assert.equal(
    qualify('swh:1:dir:d', 'https://h/r', 'aa', 'swh:1:rev:y', '.', '3-4'),
    'swh:1:dir:d;origin=https://h/r;visit=swh:1:snp:aa;anchor=swh:1:rev:y;path=/;lines=3-4',
  );
  assert.equal(qualify('swh:1:cnt:x', '/srv/repo', 'aa', null, 'f', '2'), 'swh:1:cnt:x;lines=2');
  assert.equal(pathOrigin('https://h/a b?c#d'), 'https://h/a%20b%3Fc%23d');
});

test('helpers', () => {
  assert.deepEqual(ancestors('.'), []);
  assert.deepEqual(ancestors('a.txt'), ['.']);
  assert.deepEqual(ancestors('a/b/c.txt'), ['.', 'a', 'a/b']);
  assert.equal(shortSwhid('swh:1:cnt:0123456789abcdef0123456789abcdef01234567;lines=1'), 'swh:1:cnt:0123456789;lines=1');
  assert.ok(versionAtLeast('0.10.0', '0.8.0'));
  assert.ok(versionAtLeast('0.9.0-dev+abc', '0.8.0'));
  assert.ok(!versionAtLeast('0.1.9', '0.8.0'));
  assert.ok(!versionAtLeast('dev', '0.8.0'));
  assert.ok(!versionAtLeast(undefined, '0.8.0'));
});

test('findSwhids', () => {
  const h = '94a9ed024d3859793618152ea559a168bbcbb5e2';
  const text = `See swh:1:cnt:${h};origin=https://h/r;lines=2-3. And {swh:1:dir:${h}} or swh:1:cnt:abc.`;
  assert.deepEqual(
    findSwhids(text).map(([, s]) => s),
    [`swh:1:cnt:${h};origin=https://h/r;lines=2-3`, `swh:1:dir:${h}`],
  );
});

test('citation', () => {
  const swhid = 'swh:1:cnt:94a9ed024d3859793618152ea559a168bbcbb5e2;origin=https://example.org/me/repo';
  assert.deepEqual(citation('no-metadata', 'swh:1:cnt:94a9ed024d3859793618152ea559a168bbcbb5e2', swhid, 'repo', 'https://example.org/me/repo'), [
    '@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {https://example.org/me/repo},\n    swhid = {' + swhid + '}\n}\n',
    'no-metadata',
  ]);
  const [entry] = citation('failed', 'swh:1:snp:0000000000', 's', 'repo', undefined, '2026-07-01T10:00:00Z', undefined);
  assert.equal(entry, '@software{swh-snp-0000000,\n    title = {repo},\n    date = {2026-07-01},\n    year = {2026},\n    swhid = {s}\n}\n');
  assert.equal(citation('failed', 'swh:1:cnt:94a9ed0aa', 's', undefined, undefined, undefined, '2-3')[0].split(',')[0], '@codefragment{swh-cnt-94a9ed0-L2-L3');
  assert.equal(citation('failed', 'swh:1:dir:94a9ed0aa', 's')[0].split('{')[0], '@softwareversion');
  assert.deepEqual(citation({ entry: '@x{}' }, 'swh:1:cnt:a', 's'), ['@x{}', 'archive']);
});

test('scan model', () => {
  const scan = buildScan([
    { path: 'sub/b.txt', swhid: 'swh:1:cnt:b', dir: false, archived: true },
    { path: '.', swhid: 'swh:1:dir:r', dir: true, archived: false },
    { path: 'a.txt', swhid: 'swh:1:cnt:a', dir: false, archived: false },
    { path: 'sub', swhid: 'swh:1:dir:s', dir: true, archived: true },
    { path: 'z', swhid: 'swh:1:dir:z', dir: true, archived: false },
    { path: 'z/c.txt', swhid: 'swh:1:cnt:c', dir: false, archived: false },
  ]);
  assert.deepEqual(
    scan.items.map((i) => i.path),
    ['.', 'a.txt', 'sub', 'sub/b.txt', 'z', 'z/c.txt'],
  );
  assert.deepEqual(scan.root.children.map((i) => i.name), ['a.txt', 'sub/', 'z/']);
  assert.equal(scan.root.status, 'partial');
  assert.deepEqual(scan.root.counts, [3, 1]);
  assert.equal(scan.items[4].status, 'not-archived');
  assert.equal(
    scanSummary(scan),
    'Files: 3, archived 1 (33%)   Directories: 3, archived 1 (33%), partially 1 (33%)',
  );
});
