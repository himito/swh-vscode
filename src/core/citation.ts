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
import type { ArchiveApi, CitationAnswer, Swh, SwhidInfo } from './backend';
import { UserError } from './errors';
import { isPublicOrigin, originName } from './origin';
import { Swhid } from './swhid';
import type { Maybe } from './types';

/**
 * Where a BibTeX entry comes from: `'archive'` for the archive's own, else
 * why it is a minimal one (see {@link CitationAnswer}).
 */
export type Why = 'archive' | 'no-metadata' | 'failed' | 'not-archived';

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
 * @param answer - What the archive answered, see {@link ArchiveApi.citation}.
 * @param swhid - The qualified SWHID cited, for the `swhid` field; its
 * object type gives the entry's type, its hash and lines the key.
 * @param title - The title, e.g. the repository's name.
 * @param url - The repository's public URL.
 * @param date - The date of the cited version, ISO 8601; it gives the `date`
 * and `year` fields.
 * @returns The entry, and where it comes from.
 *
 * @example
 * ```ts
 * citation('no-metadata', swhid, 'repo', 'https://example.org/me/repo');
 * // ['@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {…},\n    swhid = {…}\n}\n', 'no-metadata']
 * ```
 */
export function citation(answer: CitationAnswer, swhid: Swhid, title?: string, url?: string, date?: string): [string, Why] {
  if (typeof answer === 'object') return [answer.entry, 'archive'];
  const day = date?.substring(0, 10);
  const fields: Array<[string, Maybe<string>]> = [
    ['title', title],
    ['url', url],
    ['date', day],
    ['year', day?.substring(0, 4)],
    ['swhid', swhid.toString()],
  ];
  // the types the archive gives
  const type = swhid.type === 'cnt' ? 'codefragment' : swhid.type === 'snp' ? 'software' : 'softwareversion';
  // as the archive makes it, e.g. swh-cnt-67c1849-L1-L3
  const lines = swhid.qualifiers.lines;
  const key = `swh-${swhid.type}-${swhid.shortHash}${lines ? '-L' + lines.replace(/-/g, '-L') : ''}`;
  const body = fields
    .filter(([, value]) => value)
    .map(([field, value]) => `    ${field} = {${value}}`)
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
 * @param info - The SWHID to cite, see {@link Swh.qualifiedSwhid}; its
 * `lines` qualifier, if any, gives the cited lines.
 * @param root - The root of the repository holding it, if any.
 * @returns The entry, and where it comes from.
 * @throws {@link UserError} when the archive cannot be reached, or its rate
 * limit is reached.
 */
export async function bibtex(swh: Swh, info: SwhidInfo, root: Maybe<string>): Promise<[string, Why]> {
  const answer: CitationAnswer = info.archived ? await swh.archive.citation({ swhid: info.swhid.toString() }) : 'not-archived';
  const origin = info.origin;
  const anchor = info.swhid.qualifiers.anchor;
  const date =
    anchor && root && typeof answer !== 'object'
      ? await swh.git.get(root, ['show', '-s', '--no-show-signature', '--format=%cs', anchor.hash])
      : undefined;
  const title = origin ? originName(origin) : root ? path.basename(root) : undefined;
  return citation(answer, info.swhid, title, isPublicOrigin(origin) ? origin : undefined, date);
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
  const snapshot = Swhid.of('snp', info.snapshot).qualify({ origin: url });
  const answer = await swh.archive.citation({ origin: url });
  return citation(answer, snapshot, originName(url), url, info.date);
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
