/**
 * BibTeX citations of archived code.
 *
 * @remarks
 * The archive makes a BibTeX entry from the repository's `codemeta.json` or
 * `CITATION.cff`. When it has no such metadata, or the code is not
 * archived, a minimal entry is made here from what is known: title, URL,
 * date and SWHID. Each function gives a {@link Citation}: the entry, and
 * where it comes from. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import type { ArchiveApi, CitationAnswer, OriginInfo, Swh, SwhidInfo } from './backend';
import { UserError } from './errors';
import type { Git } from './git';
import { isPublicOrigin, originName } from './origin';
import { type LineRange, type ObjectType, Swhid } from './swhid';
import type { Maybe } from './types';

/**
 * Where a BibTeX entry comes from: `'archive'` for the archive's own, else
 * why it is a minimal one (see {@link CitationAnswer}).
 */
export type Why = 'archive' | 'no-metadata' | 'failed' | 'not-archived';

/** A BibTeX entry, and where it comes from. */
export type Citation = {
  /** The entry. */
  entry: string;
  /** Where it comes from: the archive, or why it is a minimal one. */
  why: Why;
};

/** What a minimal entry says of the code it cites, besides its SWHID; each field is left out when missing. */
export type CitationMetadata = {
  /** The title, e.g. the repository's name. */
  title?: string;
  /** The repository's public URL. */
  url?: string;
  /** The date of the cited version, ISO 8601; it gives the `date` and `year` fields. */
  date?: string;
};

/**
 * The BibTeX entry type of each object type, as the archive gives it: a
 * file's content is a code fragment, a snapshot the software, and anything
 * else a version of it.
 */
const ENTRY_TYPES = {
  cnt: 'codefragment',
  dir: 'softwareversion',
  rev: 'softwareversion',
  rel: 'softwareversion',
  snp: 'software',
} as const satisfies Record<ObjectType, string>;

/**
 * The part of a citation key that gives the cited lines, as the archive makes it.
 *
 * @param lines - The cited lines, if any.
 * @returns E.g. `-L1-L3`, or `-L5` for one line; `""` without lines.
 */
function linesKey(lines: Maybe<LineRange>): string {
  if (!lines) return '';
  return lines.isSingle ? `-L${lines.first}` : `-L${lines.first}-L${lines.last}`;
}

/**
 * The key of a minimal entry, as the archive makes it.
 *
 * @param swhid - The SWHID cited.
 * @returns E.g. `swh-cnt-67c1849-L1-L3`: its object type, its short hash, its lines.
 */
const citationKey = (swhid: Swhid) => `swh-${swhid.type}-${swhid.shortHash}${linesKey(swhid.qualifiers.lines)}`;

/**
 * The fields of a BibTeX entry, by name, in the order they are written.
 *
 * @remarks
 * An object keeps its string keys in the order they were added, which is
 * the order of the entry's fields.
 */
type BibtexFields = { readonly [name: string]: Maybe<string> };

/**
 * Writes a BibTeX entry.
 *
 * @param type - The entry type, e.g. `software`.
 * @param key - The citation key.
 * @param fields - The fields, in the order to write them; those without a value are left out.
 * @returns The entry, ending with a newline.
 */
function bibtexEntry(type: string, key: string, fields: BibtexFields): string {
  const body = Object.entries(fields)
    .filter(([, value]) => value)
    .map(([name, value]) => `    ${name} = {${value}}`)
    .join(',\n');
  return `@${type}{${key},\n${body}\n}\n`;
}

/**
 * Makes the BibTeX entry citing a qualified SWHID.
 *
 * @remarks
 * When the archive gave an entry, it is used as is. Otherwise a minimal one
 * is made, of the type the archive would give (`@codefragment` for a file's
 * content, `@software` for a snapshot, `@softwareversion` otherwise), with a
 * key made as the archive makes it, e.g. `swh-cnt-67c1849-L1-L3` (see
 * `ENTRY_TYPES` and `citationKey`). Fields without a value are left out.
 *
 * @param answer - What the archive answered, see {@link ArchiveApi.citation}.
 * @param swhid - The qualified SWHID cited, for the `swhid` field; its
 * object type gives the entry's type, its hash and lines the key.
 * @param metadata - What else the minimal entry says: title, URL, date.
 * @returns The entry, and where it comes from.
 *
 * @example
 * ```ts
 * citation('no-metadata', swhid, { title: 'repo', url: 'https://example.org/me/repo' });
 * // { entry: '@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {…},\n    swhid = {…}\n}\n', why: 'no-metadata' }
 * ```
 */
export function citation(answer: CitationAnswer, swhid: Swhid, metadata: CitationMetadata = {}): Citation {
  if (typeof answer === 'object') return { entry: answer.entry, why: 'archive' };

  const day = metadata.date?.substring(0, 10);
  const entry = bibtexEntry(ENTRY_TYPES[swhid.type], citationKey(swhid), {
    title: metadata.title,
    url: metadata.url,
    date: day,
    year: day?.substring(0, 4),
    swhid: swhid.toString(),
  });
  return { entry, why: answer };
}

/**
 * Makes the BibTeX entry citing a file, its lines, or a directory.
 *
 * @remarks
 * The archive is asked only when it holds the SWHID. For a minimal entry,
 * the title is the origin's name (else the repository directory's), the URL
 * the origin when public, and the date that of the anchor, when it is a
 * commit the repository has.
 *
 * @param swh - The backend.
 * @param info - The SWHID to cite, see {@link Swh.qualifiedSwhid}; its
 * `lines` qualifier, if any, gives the cited lines.
 * @param root - The root of the repository holding it, if any.
 * @returns The entry, and where it comes from.
 * @throws {@link UserError} when the archive cannot be reached, or its rate
 * limit is reached.
 */
export async function bibtex(swh: Swh, info: SwhidInfo, root: Maybe<string>): Promise<Citation> {
  const answer = await archiveCitation(swh, info);
  // the archive's own entry needs nothing from the repository
  if (typeof answer === 'object') return citation(answer, info.swhid);
  return citation(answer, info.swhid, await repositoryMetadata(swh.git, info, root));
}

/**
 * What the archive answers to a citation request for a SWHID.
 *
 * @param swh - The backend.
 * @param info - The SWHID to cite.
 * @returns The archive's answer; `'not-archived'`, without asking, when it
 * does not hold the SWHID, as it makes entries only for what it holds.
 * @throws {@link UserError} when the archive cannot be reached, or its rate
 * limit is reached.
 */
async function archiveCitation(swh: Swh, info: SwhidInfo): Promise<CitationAnswer> {
  if (!info.archived) return 'not-archived';
  return swh.archive.citation({ swhid: info.swhid.toString() });
}

/**
 * What a minimal entry says of a file or directory, from its repository.
 *
 * @param git - The Git runner.
 * @param info - The SWHID cited.
 * @param root - The root of the repository holding it, if any.
 * @returns Its title, the origin when public, and the date of the anchor commit.
 */
async function repositoryMetadata(git: Git, info: SwhidInfo, root: Maybe<string>): Promise<CitationMetadata> {
  const { origin } = info;
  return {
    title: citationTitle(origin, root),
    url: isPublicOrigin(origin) ? origin : undefined,
    date: root ? await commitDate(git, root, info.swhid.qualifiers.anchor) : undefined,
  };
}

/**
 * The title of a minimal entry: the repository's name.
 *
 * @param origin - The repository's origin, if any.
 * @param root - The repository's root, if any.
 * @returns The origin's name, else the root directory's; `undefined` without either.
 */
function citationTitle(origin: Maybe<string>, root: Maybe<string>): Maybe<string> {
  if (origin) return originName(origin);
  return root ? path.basename(root) : undefined;
}

/**
 * The date of a commit, as the repository has it.
 *
 * @remarks
 * Only a commit has a date: a SWHID's anchor may also be a directory, a
 * release or a snapshot, of which `git show` would print the content instead.
 *
 * @param git - The Git runner.
 * @param root - The repository's root.
 * @param anchor - A SWHID's anchor, if any.
 * @returns The committer date, `YYYY-MM-DD`, of an anchor that is a commit
 * the repository has; `undefined` otherwise.
 */
async function commitDate(git: Git, root: string, anchor: Maybe<Swhid>): Promise<Maybe<string>> {
  if (anchor?.type !== 'rev') return undefined;
  return git.get(root, ['show', '-s', '--no-show-signature', '--format=%cs', anchor.hash]);
}

/**
 * Makes the BibTeX entry citing the latest archived snapshot of a public
 * repository.
 *
 * @remarks
 * The repository is cited as the archive holds it, e.g. with a `.git`
 * suffix when that is how it was saved: that origin is what the archive
 * makes its entry for, and what the minimal entry's URL and SWHID give.
 *
 * @param swh - The backend.
 * @param origin - The repository's public URL.
 * @returns The entry, and where it comes from.
 * @throws {@link UserError} when `origin` is not a public URL, the archive
 * does not hold it or has no snapshot of it to cite, cannot be reached, or
 * its rate limit is reached.
 */
export async function originBibtex(swh: Swh, origin: string): Promise<Citation> {
  const info = await swh.originStatus(origin);
  const snapshot = latestSnapshot(info);
  const archivedOrigin = info.origin;
  const answer = await swh.archive.citation({ origin: archivedOrigin });
  return citation(answer, snapshot, { title: originName(archivedOrigin), url: archivedOrigin, date: info.date });
}

/**
 * The SWHID of an origin's latest archived snapshot, qualified with the origin.
 *
 * @param info - The origin's archival status.
 * @returns The snapshot's SWHID, e.g. `swh:1:snp:…;origin=https://…`.
 * @throws {@link UserError} when the archive does not hold the origin, or its
 * latest visit gives no snapshot to cite.
 */
function latestSnapshot(info: OriginInfo): Swhid {
  if (!info.archived) throw new UserError(`Software Heritage has not archived ${info.origin}`);
  if (!info.snapshot) throw new UserError(`The latest archival visit of ${info.origin} has no snapshot to cite`);
  return Swhid.of('snp', info.snapshot).qualify({ origin: info.origin });
}

/**
 * Each source of a BibTeX entry, in words.
 *
 * @remarks
 * One per {@link Why}: a source added there without its words here does not compile.
 */
const CITATION_WHAT = {
  archive: "the archive's BibTeX entry",
  'no-metadata': 'a minimal BibTeX entry (no citation metadata in the archive)',
  failed: 'a minimal BibTeX entry (the archive failed to make one)',
  'not-archived': 'a minimal BibTeX entry',
} as const satisfies Record<Why, string>;

/**
 * Describes a BibTeX entry in words, for messages.
 *
 * @param why - Where the entry comes from, as {@link citation} gives it.
 * @returns E.g. `"a minimal BibTeX entry (no citation metadata in the archive)"`.
 */
export function citationWhat(why: Why): string {
  return CITATION_WHAT[why];
}
