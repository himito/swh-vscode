/**
 * Unit tests of the pure code: SWHIDs, origins, citations and the scan model.
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
  Citation,
  encodeOrigin,
  encodePath,
  findSwhids,
  LineRange,
  normalizeOrigin,
  originCandidates,
  originName,
  parseOrigin,
  pathOrigin,
  scanSummary,
  Qualifiers,
  Swhid,
  UserError,
} from '#core';

/** A SHA-1 made of one hexadecimal digit, for readable test SWHIDs. */
const sha = (digit: string) => digit.repeat(40);

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
  const cnt = Swhid.of('cnt', sha('c'));
  const rev = Swhid.of('rev', sha('e'));
  const qualified = cnt.qualify({ origin: 'https://h/o r', anchor: rev, path: '/src/my file é.el' });
  assert.equal(qualified.toString(), `swh:1:cnt:${sha('c')};origin=https://h/o%20r;anchor=swh:1:rev:${sha('e')};path=/src/my%20file%20%C3%A9.el`);
  assert.deepEqual(Swhid.parse(qualified.toString()).qualifiers.values, { origin: 'https://h/o r', anchor: rev, path: '/src/my file é.el' });
  // a character outside the BMP, left unescaped, survives decoding
  assert.equal(Swhid.parse(`swh:1:cnt:${sha('c')};origin=https://h/\u{1F600}%20r`).qualifiers.origin, 'https://h/\u{1F600} r');
  // the root, lines, a snapshot
  const dir = Swhid.of('dir', sha('d')).qualify({ origin: 'https://h/r', visit: Swhid.of('snp', sha('a')), anchor: rev, path: '/', lines: LineRange.of(3, 4) });
  assert.equal(dir.toString(), `swh:1:dir:${sha('d')};origin=https://h/r;visit=swh:1:snp:${sha('a')};anchor=swh:1:rev:${sha('e')};path=/;lines=3-4`);
  // a private origin and its visit are left out, a path without an anchor too
  assert.equal(cnt.qualify({ origin: '/srv/repo', visit: Swhid.of('snp', sha('a')), path: '/f', lines: LineRange.of(2) }).toString(), `swh:1:cnt:${sha('c')};lines=2`);
  assert.equal(pathOrigin('https://h/a b?c#d'), 'https://h/a%20b%3Fc%23d');
});

// A SWHID is a value: made checked, parsed back to an equal one, qualified
// into a new one, and shown shortened.
test('Swhid value', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  const cnt = Swhid.of('cnt', hash);
  assert.equal(cnt.type, 'cnt');
  assert.equal(cnt.hash, hash);
  assert.equal(cnt.shortHash, '0123456');
  assert.equal(JSON.stringify({ cnt }), `{"cnt":"swh:1:cnt:${hash}"}`);
  assert.throws(() => Swhid.of('cnt', 'abc'), UserError);
  assert.throws(() => Swhid.of('cnt', 'a'.repeat(64)), /SHA-256/);

  const lines = cnt.qualify({ lines: LineRange.of(1) });
  assert.equal(lines.toShortString(), 'swh:1:cnt:0123456789;lines=1');
  assert.ok(lines.core.equals(cnt));
  assert.ok(!lines.equals(cnt));
  assert.ok(Swhid.parse(lines.toString()).equals(lines));
  // qualifying replaces the qualifiers, and leaves the original alone
  assert.equal(lines.qualify({}).toString(), cnt.toString());
  assert.deepEqual(lines.qualifiers.values, { lines: LineRange.of(1) });

  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};bytes=1`), /Unknown SWHID qualifier/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};lines=0-2`), /Not a line range/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};lines=5-2`), /Not a line range/);
  // what the text could not show again: an empty value, a qualifier given twice
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};origin=`), /has no value/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};lines`), /has no value/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};lines=1;lines=2`), /given twice/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};`), /Empty SWHID qualifier/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};;lines=1`), /Empty SWHID qualifier/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};anchor=swh:1:rev:${hash};path=src/a`), /A path starts with \//);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};visit=swh:1:rev:${hash}`), /A visit is a snapshot/);
  assert.throws(() => Swhid.parse(`swh:1:cnt:${hash};anchor=swh:1:cnt:${hash}`), /An anchor holds objects/);
  assert.equal(Swhid.tryParse('swh:1:cnt:0123'), undefined);
});

// Qualifiers are a value: filtered by their context, parsed back to equal
// ones, and empty for a core SWHID.
test('Qualifiers value', () => {
  const rev = Swhid.of('rev', sha('e'));
  const given = Qualifiers.of({ origin: 'https://h/r', anchor: rev, path: '/a', lines: LineRange.of(2, 3) });
  assert.equal(given.toString(), `;origin=https://h/r;anchor=swh:1:rev:${sha('e')};path=/a;lines=2-3`);
  assert.equal(given.anchor, rev);
  assert.ok(Qualifiers.parse(given.toString().substring(1)).equals(given));
  // a private origin and its visit, and a path without an anchor, are left out
  assert.ok(Qualifiers.of({ origin: '/srv/r', visit: Swhid.of('snp', sha('a')), path: '/a' }).isEmpty);
  // parsed as written: no context rule applies
  assert.equal(Qualifiers.parse('path=/a').path, '/a');
  assert.ok(Qualifiers.NONE.isEmpty);
  assert.equal(Qualifiers.NONE.toString(), '');
  assert.ok(Swhid.of('cnt', sha('c')).qualifiers.equals(Qualifiers.NONE));
  assert.ok(Object.isFrozen(given.values));
  // an empty value writes no qualifier, so none is kept
  assert.ok(Qualifiers.of({ origin: '' }).isEmpty);
  assert.deepEqual(Qualifiers.of({ anchor: rev, path: '' }).values, { anchor: rev });
});

// Path ancestors and origin names.
test('helpers', () => {
  assert.deepEqual(ancestors('.'), []);
  assert.deepEqual(ancestors('a.txt'), ['.']);
  assert.deepEqual(ancestors('a/b/c.txt'), ['.', 'a', 'a/b']);
  assert.equal(originName('https://github.com/bzg/swh.el'), 'swh.el');
  assert.equal(originName('https://gitlab.com/a/repo.git/'), 'repo');
  assert.equal(originName('C:\\Users\\me\\repo.git'), 'repo');
});

// A line range is a value: made checked from line numbers or text, and
// written as the `lines` qualifier writes it.
test('LineRange', () => {
  assert.equal(LineRange.of(2, 3).toString(), '2-3');
  assert.equal(LineRange.of(5).toString(), '5');
  assert.equal(LineRange.of(1, 120).toString(), '1-120');
  assert.ok(LineRange.of(5, 5).isSingle);
  assert.ok(LineRange.parse('2-3').equals(LineRange.of(2, 3)));
  assert.ok(LineRange.parse('7').equals(LineRange.of(7)));
  assert.equal(JSON.stringify({ lines: LineRange.of(2, 3) }), '{"lines":"2-3"}');
  for (const bad of ['0', '0-2', '5-2', '2-', '-2', 'a', '', '1-2-3', '9'.repeat(20)]) {
    assert.throws(() => LineRange.parse(bad), /Not a line range/, bad);
  }
  assert.throws(() => LineRange.of(3, 1), /Not a line range/);
  assert.throws(() => LineRange.of(1.5), /Not a line range/);
});

test('Swhid.isValid', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  for (const type of ['cnt', 'dir', 'rev', 'rel', 'snp']) assert.ok(Swhid.isValid(`swh:1:${type}:${hash}`), type);
  assert.ok(!Swhid.isValid(`swh:1:ori:${hash}`));
  assert.ok(Swhid.isValid(`swh:1:cnt:${hash};origin=https://example.org/me/repo;lines=1-2`));
  assert.ok(!Swhid.isValid(''));
  assert.ok(!Swhid.isValid('swh:1:cnt:0123'));
  assert.ok(!Swhid.isValid(`swh:1:xyz:${hash}`));
  assert.ok(!Swhid.isValid(`swh:2:cnt:${hash}`));
  assert.ok(!Swhid.isValid(`swh:1:cnt:${hash.toUpperCase()}`));
  assert.ok(!Swhid.isValid(` swh:1:cnt:${hash}`));
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

/**
 * A citation's entry and source, as a plain object, to compare.
 *
 * @param citation - The citation.
 * @returns Its entry and where it comes from.
 */
const plain = (citation: Citation) => ({ entry: citation.entry, why: citation.why });

// Minimal BibTeX entries: type and key by object type, optional fields left
// out, and the archive's own entry passed through as is.
test('Citation', () => {
  const cnt = Swhid.of('cnt', '94a9ed024d3859793618152ea559a168bbcbb5e2');
  const swhid = cnt.qualify({ origin: 'https://example.org/me/repo' });
  assert.deepEqual(plain(Citation.of('no-metadata', swhid, { title: 'repo', url: 'https://example.org/me/repo' })), {
    entry: '@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {https://example.org/me/repo},\n    swhid = {' + swhid + '}\n}\n',
    why: 'no-metadata',
  });
  const snp = Swhid.of('snp', sha('0'));
  const { entry } = Citation.minimal(snp, 'failed', { title: 'repo', date: '2026-07-01T10:00:00Z' });
  assert.equal(entry, `@software{swh-snp-0000000,\n    title = {repo},\n    date = {2026-07-01},\n    year = {2026},\n    swhid = {${snp}}\n}\n`);
  assert.equal(Citation.minimal(cnt.qualify({ lines: LineRange.of(2, 3) }), 'failed').entry.split(',')[0], '@codefragment{swh-cnt-94a9ed0-L2-L3');
  assert.equal(Citation.minimal(Swhid.of('dir', sha('9')), 'failed').entry.split('{')[0], '@softwareversion');
  assert.deepEqual(plain(Citation.of({ entry: '@x{}' }, cnt)), { entry: '@x{}', why: 'archive' });
  assert.equal(String(Citation.fromArchive('@x{}')), '@x{}');
  // LaTeX's special characters show as they are; braces stay balanced
  const awkward = Citation.minimal(cnt.qualify({ origin: 'https://h/a{b' }), 'failed', { title: 'my_repo{x} 50% & #1', url: 'https://h/a{b' }).entry;
  assert.match(awkward, /title = \{my\\_repo\\textbraceleft\{\}x\\textbraceright\{\} 50\\% \\& \\#1\},/);
  assert.match(awkward, /url = \{https:\/\/h\/a%7Bb\},/);
  assert.match(awkward, /swhid = \{swh:1:cnt:94a9ed0[0-9a-f]*;origin=https:\/\/h\/a%7Bb\}/);
  const depth = [...awkward].reduce((open, char) => open + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
  assert.equal(depth, 0);
  // one line, and a release, a version of the software
  assert.equal(Citation.minimal(cnt.qualify({ lines: LineRange.of(5) }), 'failed').entry.split(',')[0], '@codefragment{swh-cnt-94a9ed0-L5');
  assert.equal(Citation.minimal(Swhid.of('rel', sha('9')), 'failed').entry.split('{')[0], '@softwareversion');
});

// The scan tree: path order, parent links, per-directory counts, statuses and summary.
test('scan model', () => {
  const scan = buildScan([
    { path: 'sub/b.txt', swhid: Swhid.of('cnt', sha('b')), dir: false, archived: true },
    { path: '.', swhid: Swhid.of('dir', sha('0')), dir: true, archived: false },
    { path: 'a.txt', swhid: Swhid.of('cnt', sha('a')), dir: false, archived: false },
    { path: 'sub', swhid: Swhid.of('dir', sha('1')), dir: true, archived: true },
    { path: 'z', swhid: Swhid.of('dir', sha('2')), dir: true, archived: false },
    { path: 'z/c.txt', swhid: Swhid.of('cnt', sha('c')), dir: false, archived: false },
  ]);
  assert.deepEqual(
    scan.items.map((i) => i.path),
    ['.', 'a.txt', 'sub', 'sub/b.txt', 'z', 'z/c.txt'],
  );
  assert.deepEqual(scan.root.children.map((i) => i.name), ['a.txt', 'sub/', 'z/']);
  assert.equal(scan.root.status, 'partial');
  assert.deepEqual(scan.root.counts, { files: 3, archived: 1 });
  assert.equal(scan.items[4].status, 'not-archived');
  assert.equal(
    scanSummary(scan),
    'Files: 3, archived 1 (33%)   Directories: 3, archived 1 (33%), partially 1 (33%)',
  );

  // a submodule is not a file: archived, it makes its directory no more archived
  const withSubmodule = buildScan([
    { path: '.', swhid: Swhid.of('dir', sha('0')), dir: true, archived: false },
    { path: 'lib', swhid: Swhid.of('dir', sha('1')), dir: true, archived: false },
    { path: 'lib/vendor', swhid: Swhid.of('rev', sha('2')), dir: false, archived: true },
    { path: 'lib/a.txt', swhid: Swhid.of('cnt', sha('3')), dir: false, archived: false },
  ]);
  const lib = withSubmodule.items.find((item) => item.path === 'lib')!;
  assert.equal(lib.status, 'not-archived');
  assert.deepEqual(lib.counts, { files: 1, archived: 0 });
  assert.equal(withSubmodule.items.find((item) => item.path === 'lib/vendor')!.status, 'archived');
  assert.equal(scanSummary(withSubmodule), 'Files: 1, archived 0 (0%)   Directories: 2, archived 0 (0%), partially 0 (0%)');
  // a directory without files shares its counts: they cannot be changed
  assert.ok(Object.isFrozen(buildScan([{ path: '.', swhid: Swhid.of('dir', sha('0')), dir: true, archived: false }]).root.counts));
});
