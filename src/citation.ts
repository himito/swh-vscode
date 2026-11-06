// BibTeX citations.

import * as path from 'path';
import type { Swh, SwhidInfo } from './backend';
import { is2xx, UserError } from './http';
import { core, encodeOrigin, hashOf, isPublicOrigin, originName, qualifiers, queryString, shortHash, typeOf } from './swhid';

export type CitationAnswer = { entry: string } | 'no-metadata' | 'failed' | 'not-archived';
export type Why = 'archive' | 'no-metadata' | 'failed' | 'not-archived';

/** The archive's BibTeX entry citing the SWHID, or with ORIGIN_P the origin, TARGET. */
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
 * [ENTRY, WHY] citing the qualified SWHID, of core CORE and LINES.
 * When ANSWER is not an entry, a minimal one from TITLE, URL and DATE.
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

/** BibTeX entry citing the SWHID INFO of LINES in ROOT. */
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

/** BibTeX entry citing the latest snapshot of ORIGIN. */
export async function originBibtex(swh: Swh, origin: string): Promise<[string, Why]> {
  const info = await swh.originStatus(origin);
  if (!info.archived || !info.snapshot) throw new UserError(`Software Heritage has not archived ${origin}`);
  const url = info.origin;
  const c = core('snp', info.snapshot);
  return citation(await archiveCitation(swh, url, true), c, `${c};origin=${encodeOrigin(url)}`, originName(url), url, info.date);
}

/** The BibTeX entry citation() gives for WHY, in words. */
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
