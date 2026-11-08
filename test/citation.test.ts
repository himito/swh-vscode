/**
 * Unit tests of the citations of files, directories and repositories.
 *
 * @remarks
 * {@link bibtex} and {@link originBibtex} ask the archive and Git: these
 * tests give them a stub backend instead, which answers as told and records
 * what it is asked. They check which questions are asked, and what the
 * entries hold. The minimal entry itself is tested in `swhid.test.ts`.
 * Run them with `npm test`.
 *
 * @packageDocumentation
 */

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  bibtex,
  type CitationAnswer,
  type CitationTarget,
  citationWhat,
  LineRange,
  type OriginInfo,
  originBibtex,
  type Swh,
  Swhid,
  type SwhidInfo,
  UserError,
} from '#core';

/** A SHA-1 made of one hexadecimal digit, for readable test SWHIDs. */
const sha = (digit: string) => digit.repeat(40);

/** The date the stub's Git gives for any commit. */
const COMMIT_DATE = '2026-07-01';

/** What the stub backend answers. */
type Answers = {
  /** The archive's answer to any citation request. */
  citation?: CitationAnswer;
  /** The origin's status, for {@link originBibtex}. */
  origin?: OriginInfo;
};

/** What the stub backend was asked. */
type Asked = {
  /** The citation requests sent to the archive. */
  citations: CitationTarget[];
  /** The arguments of each Git command run. */
  git: string[][];
};

/**
 * A backend that answers as told, and records what it is asked.
 *
 * @param answers - What it answers.
 * @returns The backend, as the citation functions use it, and what it was asked.
 */
function stubSwh(answers: Answers = {}): { swh: Swh; asked: Asked } {
  const asked: Asked = { citations: [], git: [] };
  const swh = {
    archive: {
      citation: async (target: CitationTarget) => {
        asked.citations.push(target);
        return answers.citation ?? 'no-metadata';
      },
    },
    git: {
      get: async (_root: string, args: string[]) => {
        asked.git.push(args);
        return COMMIT_DATE;
      },
    },
    originStatus: async () => answers.origin ?? { origin: 'https://h/me/repo', archived: false },
  };
  return { swh: swh as unknown as Swh, asked };
}

/**
 * The fields of a BibTeX entry, by name.
 *
 * @param entry - The entry.
 * @returns Each field's value.
 */
function fields(entry: string): Record<string, string> {
  return Object.fromEntries([...entry.matchAll(/^ {4}(\w+) = \{(.*)\},?$/gm)].map((match) => [match[1], match[2]]));
}

const anchor = Swhid.of('rev', sha('e'));
const file = Swhid.of('cnt', sha('c'));

/** A file's SWHID info, archived in a public repository, anchored on a commit. */
const archivedFile: SwhidInfo = {
  swhid: file.qualify({ origin: 'https://h/me/repo', anchor, path: '/a.txt' }),
  core: file,
  archived: true,
  origin: 'https://h/me/repo',
};

// The archive's own entry is used as is: nothing is asked of the repository.
test('bibtex: the archive entry', async () => {
  const { swh, asked } = stubSwh({ citation: { entry: '@software{archive}' } });
  const cited = await bibtex(swh, archivedFile, '/r/repo');
  assert.deepEqual(cited, { entry: '@software{archive}', why: 'archive' });
  // asked about the qualified SWHID, as text
  assert.deepEqual(asked.citations, [{ swhid: archivedFile.swhid.toString() }]);
  assert.deepEqual(asked.git, []);
});

// Without the archive's entry, a minimal one from the repository: its name,
// its public origin, and the date of the anchor commit.
test('bibtex: a minimal entry from the repository', async () => {
  const { swh, asked } = stubSwh({ citation: 'no-metadata' });
  const cited = await bibtex(swh, archivedFile, '/r/repo');
  assert.equal(cited.why, 'no-metadata');
  assert.deepEqual(fields(cited.entry), {
    title: 'repo',
    url: 'https://h/me/repo',
    date: COMMIT_DATE,
    year: '2026',
    swhid: archivedFile.swhid.toString(),
  });
  // the anchor commit's date, from Git
  assert.equal(asked.git.length, 1);
  assert.equal(asked.git[0].at(-1), anchor.hash);
});

// What the archive does not hold, it is not asked about; a local origin
// names the entry but is no URL, and without an anchor there is no date.
test('bibtex: not archived', async () => {
  const { swh, asked } = stubSwh();
  const local: SwhidInfo = { swhid: file, core: file, archived: false, origin: '/srv/git/local' };
  const cited = await bibtex(swh, local, '/r/repo');
  assert.equal(cited.why, 'not-archived');
  assert.deepEqual(fields(cited.entry), { title: 'local', swhid: file.toString() });
  assert.deepEqual(asked.citations, []);
  assert.deepEqual(asked.git, []);
});

// Only a commit has a date: an anchor that is a directory gives none, and
// Git is not asked about it.
test('bibtex: an anchor that is no commit', async () => {
  const { swh, asked } = stubSwh({ citation: 'no-metadata' });
  const dirAnchor = Swhid.of('dir', sha('d'));
  const info: SwhidInfo = { ...archivedFile, swhid: file.qualify({ origin: 'https://h/me/repo', anchor: dirAnchor, path: '/a.txt' }) };
  const cited = await bibtex(swh, info, '/r/repo');
  assert.equal(fields(cited.entry).date, undefined);
  assert.deepEqual(asked.git, []);
});

// Without an origin, the repository's directory names the entry; without a
// repository, only the SWHID is left; the lines cited are in the key.
test('bibtex: no origin, no repository', async () => {
  const lines = file.qualify({ lines: LineRange.of(2, 3) });
  const noOrigin = await bibtex(stubSwh().swh, { swhid: lines, core: file, archived: false }, '/r/my-repo');
  assert.equal(fields(noOrigin.entry).title, 'my-repo');
  assert.match(noOrigin.entry, /^@codefragment\{swh-cnt-ccccccc-L2-L3,/);

  const nothing = await bibtex(stubSwh().swh, { swhid: lines, core: file, archived: false }, undefined);
  assert.deepEqual(fields(nothing.entry), { swhid: lines.toString() });
});

// A repository is cited as the archive holds it, `.git` included: the
// archive is asked about that origin, which the entry's SWHID qualifies.
test('originBibtex: the latest snapshot', async () => {
  const snapshot = sha('a');
  const origin: OriginInfo = { origin: 'https://h/me/repo.git', archived: true, snapshot, date: '2026-07-01T10:00:00Z' };
  const { swh, asked } = stubSwh({ origin });
  const cited = await originBibtex(swh, 'https://h/me/repo');
  assert.equal(cited.why, 'no-metadata');
  assert.deepEqual(asked.citations, [{ origin: 'https://h/me/repo.git' }]);
  assert.deepEqual(fields(cited.entry), {
    title: 'repo',
    url: 'https://h/me/repo.git',
    date: '2026-07-01',
    year: '2026',
    swhid: `swh:1:snp:${snapshot};origin=https://h/me/repo.git`,
  });
  assert.match(cited.entry, /^@software\{swh-snp-aaaaaaa,/);
});

// Nothing to cite: an origin not archived, or archived without a snapshot;
// the archive is then not asked for an entry.
test('originBibtex: nothing to cite', async () => {
  const notArchived = stubSwh({ origin: { origin: 'https://h/me/repo', archived: false } });
  await assert.rejects(originBibtex(notArchived.swh, 'https://h/me/repo'), (error) => error instanceof UserError && /has not archived/.test(error.message));
  assert.deepEqual(notArchived.asked.citations, []);

  const noSnapshot = stubSwh({ origin: { origin: 'https://h/me/repo', archived: true } });
  await assert.rejects(originBibtex(noSnapshot.swh, 'https://h/me/repo'), /has no snapshot to cite/);
  assert.deepEqual(noSnapshot.asked.citations, []);
});

// Each origin of an entry is told in words.
test('citationWhat', () => {
  assert.equal(citationWhat('archive'), "the archive's BibTeX entry");
  assert.match(citationWhat('no-metadata'), /^a minimal BibTeX entry \(no citation metadata/);
  assert.match(citationWhat('failed'), /^a minimal BibTeX entry \(the archive failed/);
  assert.equal(citationWhat('not-archived'), 'a minimal BibTeX entry');
});
