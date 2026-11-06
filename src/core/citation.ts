/**
 * BibTeX citations of archived code.
 *
 * @remarks
 * The archive makes a BibTeX entry from the repository's `codemeta.json` or
 * `CITATION.cff`. When it has no such metadata, or the code is not
 * archived, a minimal entry is made here from what is known: title, URL,
 * date and SWHID. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import type { Swh, SwhidInfo } from './backend';
import { is2xx, UserError } from './http';
import { core, encodeOrigin, hashOf, isPublicOrigin, originName, qualifiers, queryString, shortHash, typeOf } from './swhid';

/**
 * What the archive answered to a citation request.
 *
 * @remarks
 * - `{ entry }`: the archive's BibTeX entry.
 * - `'no-metadata'`: the archive has no citation metadata for it.
 * - `'failed'`: the archive failed to make one.
 * - `'not-archived'`: the archive was not asked, as it does not hold the code.
 */
export type CitationAnswer = { entry: string } | 'no-metadata' | 'failed' | 'not-archived';

/**
 * Where a BibTeX entry comes from: `'archive'` for the archive's own, else
 * why it is a minimal one (see {@link CitationAnswer}).
 */
export type Why = 'archive' | 'no-metadata' | 'failed' | 'not-archived';

/**
 * Asks the archive for a BibTeX entry citing a SWHID or an origin.
 *
 * @param swh - The backend, to send the request.
 * @param target - The SWHID, or with `originP` the origin URL, to cite.
 * @param originP - Whether `target` is an origin URL rather than a SWHID.
 * @returns The archive's entry; `'no-metadata'` when it answers 400 or 404,
 * `'failed'` for any other error.
 * @throws {@link UserError} when the archive cannot be reached, or its rate
 * limit is reached.
 */
export async function archiveCitation(swh: Swh, target: string, originP = false): Promise<CitationAnswer> {
  const q = queryString([
    ['citation_format', 'bibtex'],
    [originP ? 'origin_url' : 'target_swhid', target],
  ]);
  const resp = await swh.api('GET', `/raw-intrinsic-metadata/citation/${originP ? 'origin' : 'swhid'}/?${q}`);
  if (is2xx(resp) && typeof resp.body?.content === 'string') return { entry: resp.body.content };
  if (resp.status === 400 || resp.status === 404) return 'no-metadata';
  return 'failed';
}

/**
 * Makes the BibTeX entry citing a qualified SWHID.
 *
 * @remarks
 * When the archive gave an entry, it is used as is. Otherwise a minimal one
 * is made, of the type the archive would give (`@codefragment` for a file's
 * content, `@software` for a snapshot, `@softwareversion` otherwise), with a
 * key made as the archive makes it, e.g. `swh-cnt-67c1849-L1-L3`. Fields
 * without a value are left out.
 *
 * @param answer - What the archive answered, see {@link archiveCitation}.
 * @param coreSwhid - The core SWHID cited.
 * @param swhid - The qualified SWHID cited, for the `swhid` field.
 * @param title - The title, e.g. the repository's name.
 * @param url - The repository's public URL.
 * @param date - The date of the cited version, ISO 8601; it gives the `date`
 * and `year` fields.
 * @param lines - The cited line range, `"A-B"` or `"A"`, if any.
 * @returns The entry, and where it comes from.
 *
 * @example
 * ```ts
 * citation('no-metadata', 'swh:1:cnt:94a9ed0…', swhid, 'repo', 'https://example.org/me/repo');
 * // ['@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {…},\n    swhid = {…}\n}\n', 'no-metadata']
 * ```
 */
export function citation(
  answer: CitationAnswer,
  coreSwhid: string,
  swhid: string,
  title?: string,
  url?: string,
  date?: string,
  lines?: string,
): [string, Why] {
  if (typeof answer === 'object') return [answer.entry, 'archive'];
  const d = date?.substring(0, 10);
  const fields: Array<[string, string | undefined]> = [
    ['title', title],
    ['url', url],
    ['date', d],
    ['year', d?.substring(0, 4)],
    ['swhid', swhid],
  ];
  // the types the archive gives
  const type = { cnt: 'codefragment', snp: 'software' }[typeOf(coreSwhid) as 'cnt' | 'snp'] ?? 'softwareversion';
  // as the archive makes it, e.g. swh-cnt-67c1849-L1-L3
  const key = `swh-${typeOf(coreSwhid)}-${shortHash(coreSwhid)}${lines ? '-L' + lines.replace(/-/g, '-L') : ''}`;
  const body = fields
    .filter(([, v]) => v)
    .map(([k, v]) => `    ${k} = {${v}}`)
    .join(',\n');
  return [`@${type}{${key},\n${body}\n}\n`, answer];
}

/**
 * Makes the BibTeX entry citing a file, its lines, or a directory.
 *
 * @remarks
 * The archive is asked only when it holds the SWHID. For a minimal entry,
 * the title is the origin's name (else the repository directory's), the URL
 * the origin when public, and the date that of the anchor commit when it is
 * a local one.
 *
 * @param swh - The backend.
 * @param info - The SWHID to cite, see {@link Swh.qualifiedSwhid}.
 * @param lines - The cited line range, `"A-B"` or `"A"`, if any.
 * @param root - The root of the repository holding it, if any.
 * @returns The entry, and where it comes from.
 * @throws {@link UserError} when the archive cannot be reached, or its rate
 * limit is reached.
 */
export async function bibtex(swh: Swh, info: SwhidInfo, lines: string | undefined, root: string | undefined): Promise<[string, Why]> {
  const answer: CitationAnswer = info.archived ? await archiveCitation(swh, info.swhid) : 'not-archived';
  const origin = info.origin;
  const anchor = qualifiers(info.swhid).anchor;
  const date =
    anchor && root && typeof answer !== 'object'
      ? await swh.git.get(root, ['show', '-s', '--no-show-signature', '--format=%cs', hashOf(anchor)])
      : undefined;
  return citation(
    answer,
    info.core,
    info.swhid,
    origin ? originName(origin) : root ? path.basename(root) : undefined,
    isPublicOrigin(origin) ? origin : undefined,
    date,
    lines,
  );
}

/**
 * Makes the BibTeX entry citing the latest archived snapshot of a public
 * repository.
 *
 * @param swh - The backend.
 * @param origin - The repository's public URL.
 * @returns The entry, and where it comes from.
 * @throws {@link UserError} when `origin` is not a public URL, the archive
 * does not hold it, cannot be reached, or its rate limit is reached.
 */
export async function originBibtex(swh: Swh, origin: string): Promise<[string, Why]> {
  const info = await swh.originStatus(origin);
  if (!info.archived || !info.snapshot) throw new UserError(`Software Heritage has not archived ${origin}`);
  const url = info.origin;
  const c = core('snp', info.snapshot);
  return citation(await archiveCitation(swh, url, true), c, `${c};origin=${encodeOrigin(url)}`, originName(url), url, info.date);
}

/**
 * Describes a BibTeX entry in words, for messages.
 *
 * @param why - Where the entry comes from, as {@link citation} gives it.
 * @returns E.g. `"a minimal BibTeX entry (no citation metadata in the archive)"`.
 */
export function citationWhat(why: Why): string {
  switch (why) {
    case 'archive':
      return "the archive's BibTeX entry";
    case 'no-metadata':
      return 'a minimal BibTeX entry (no citation metadata in the archive)';
    case 'failed':
      return 'a minimal BibTeX entry (the archive failed to make one)';
    default:
      return 'a minimal BibTeX entry';
  }
}
