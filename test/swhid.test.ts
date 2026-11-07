/**
 * Unit tests of the pure functions: SWHIDs, origins, citations and the scan model.
 *
 * @remarks
 * These tests need neither VS Code, Git nor the network. Run them with
 * `npm test`, which compiles the project and runs `node --test` on the
 * compiled `*.test.js` files.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  ancestors,
  buildScan,
  citation,
  encodeOrigin,
  encodePath,
  findSwhids,
  isSwhid,
  lineRange,
  normalizeOrigin,
  originCandidates,
  originName,
  parseOrigin,
  pathOrigin,
  qualifiers,
  qualify,
  scanSummary,
  shortSwhid,
  UserError,
} from '#core';

// Git remote URLs of every form become the URLs the archive knows origins by.
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

// Repository URLs typed by the user become origins; anything else is refused.
test('parseOrigin', () => {
  const ok: Array<[string, string]> = [
    ['github.com/bzg/swh.el', 'https://github.com/bzg/swh.el'],
    ['  https://github.com/bzg/swh.el.git/ ', 'https://github.com/bzg/swh.el'],
    ['git@github.com:bzg/swh.el.git', 'https://github.com/bzg/swh.el'],
    ['gitlab.inria.fr/a/b', 'https://gitlab.inria.fr/a/b'],
  ];
  for (const [input, origin] of ok) assert.equal(parseOrigin(input), origin, input);
  const bad: Array<[string, RegExp]> = [
    ['   ', /^No origin$/],
    ['https://github.com/bzg/swh.el?tab=readme', /^Not a repository URL/],
    ['https://github.com/a b', /^Not a repository URL/],
    ['/srv/git/repo', /^Not a public repository URL/],
    ['file:///srv/git/repo', /^Not a public repository URL/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseOrigin(input), (e: unknown) => e instanceof UserError && message.test(e.message), input);
  }
});

// Qualifier values are percent-encoded as swh.model and swhid-clj encode
// them; the expected values come from swhid-clj.
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
  // a character outside the BMP, left unescaped, survives decoding
  assert.deepEqual(qualifiers('swh:1:cnt:x;origin=https://h/\u{1F600}%20r'), { origin: 'https://h/\u{1F600} r' });
  // the root, lines, a snapshot; a private origin is left out
  assert.equal(
    qualify('swh:1:dir:d', 'https://h/r', 'aa', 'swh:1:rev:y', '.', '3-4'),
    'swh:1:dir:d;origin=https://h/r;visit=swh:1:snp:aa;anchor=swh:1:rev:y;path=/;lines=3-4',
  );
  assert.equal(qualify('swh:1:cnt:x', '/srv/repo', 'aa', null, 'f', '2'), 'swh:1:cnt:x;lines=2');
  assert.equal(pathOrigin('https://h/a b?c#d'), 'https://h/a%20b%3Fc%23d');
});

// Path ancestors and shortened SWHIDs.
test('helpers', () => {
  assert.deepEqual(ancestors('.'), []);
  assert.deepEqual(ancestors('a.txt'), ['.']);
  assert.deepEqual(ancestors('a/b/c.txt'), ['.', 'a', 'a/b']);
  assert.equal(shortSwhid('swh:1:cnt:0123456789abcdef0123456789abcdef01234567;lines=1'), 'swh:1:cnt:0123456789;lines=1');
  assert.equal(originName('https://github.com/bzg/swh.el'), 'swh.el');
  assert.equal(originName('https://gitlab.com/a/repo.git/'), 'repo');
  assert.equal(originName('C:\\Users\\me\\repo.git'), 'repo');
});

test('lineRange', () => {
  assert.equal(lineRange(2, 3), '2-3');
  assert.equal(lineRange(5, 5), '5');
  assert.equal(lineRange(1, 120), '1-120');
});

test('isSwhid', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  for (const type of ['cnt', 'dir', 'rev', 'rel', 'snp']) assert.ok(isSwhid(`swh:1:${type}:${hash}`), type);
  assert.ok(!isSwhid(`swh:1:ori:${hash}`));
  assert.ok(isSwhid(`swh:1:cnt:${hash};origin=https://example.org/me/repo;lines=1-2`));
  assert.ok(!isSwhid(''));
  assert.ok(!isSwhid('swh:1:cnt:0123'));
  assert.ok(!isSwhid(`swh:1:xyz:${hash}`));
  assert.ok(!isSwhid(`swh:2:cnt:${hash}`));
  assert.ok(!isSwhid(`swh:1:cnt:${hash.toUpperCase()}`));
  assert.ok(!isSwhid(` swh:1:cnt:${hash}`));
});

// SWHIDs are found in text with their qualifiers but without trailing
// punctuation; malformed ones are skipped.
test('findSwhids', () => {
  const h = '94a9ed024d3859793618152ea559a168bbcbb5e2';
  const text = `See swh:1:cnt:${h};origin=https://h/r;lines=2-3. And {swh:1:dir:${h}} or swh:1:cnt:abc.`;
  assert.deepEqual(
    findSwhids(text).map(([, s]) => s),
    [`swh:1:cnt:${h};origin=https://h/r;lines=2-3`, `swh:1:dir:${h}`],
  );
});

// Minimal BibTeX entries: type and key by object type, optional fields left
// out, and the archive's own entry passed through as is.
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

// The scan tree: path order, parent links, per-directory counts, statuses and summary.
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
