/**
 * Citations of archived code, as the {@link Citation} value object.
 *
 * @remarks
 * The archive makes a BibTeX entry from the repository's `codemeta.json` or
 * `CITATION.cff`. When it has no such metadata, or the code is not
 * archived, a minimal entry is made here, as the archive would make it,
 * from what is known: title, URL, date and SWHID. Gathering what is known
 * is {@link Citer}'s; writing BibTeX is {@link BibtexEntry}'s.
 *
 * Everything here is pure. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import type { ArchiveApi, CitationAnswer } from './backend';
import { BibtexEntry } from './bibtex';
import type { LineRange, ObjectType, Swhid } from './swhid';
import type { Maybe } from './types';

/**
 * Where a BibTeX entry comes from: `'archive'` for the archive's own, else
 * why it is a minimal one (see {@link CitationAnswer}).
 */
export type Why = 'archive' | 'no-metadata' | 'failed' | 'not-archived';

/** Why an entry is a minimal one: every {@link Why} but the archive's own. */
export type MinimalWhy = Exclude<Why, 'archive'>;

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
 * Each source of a BibTeX entry, in words.
 *
 * @remarks
 * One per {@link Why}: a source added there without its words here does not compile.
 */
const DESCRIPTIONS = {
  archive: "the archive's BibTeX entry",
  'no-metadata': 'a minimal BibTeX entry (no citation metadata in the archive)',
  failed: 'a minimal BibTeX entry (the archive failed to make one)',
  'not-archived': 'a minimal BibTeX entry',
} as const satisfies Record<Why, string>;

/**
 * A BibTeX entry citing archived code, and where it comes from: an immutable value.
 *
 * @remarks
 * Made by {@link Citation.fromArchive} from the archive's own entry, by
 * {@link Citation.minimal} when there is none, or by {@link Citation.of}
 * from whatever the archive answered.
 *
 * @example
 * ```ts
 * const cited = Citation.of('no-metadata', swhid, { title: 'repo', url: 'https://example.org/me/repo' });
 * cited.entry;       // '@codefragment{swh-cnt-94a9ed0,\n    title = {repo},\n    url = {…},\n    swhid = {…}\n}\n'
 * cited.description; // 'a minimal BibTeX entry (no citation metadata in the archive)'
 * ```
 */
export class Citation {
  /**
   * Makes a citation.
   *
   * @param entry - The BibTeX entry.
   * @param why - Where it comes from.
   */
  private constructor(
    readonly entry: string,
    readonly why: Why,
  ) {}

  /**
   * The citation the archive made.
   *
   * @param entry - The archive's BibTeX entry, used as is.
   * @returns The citation.
   */
  static fromArchive(entry: string): Citation {
    return new Citation(entry, 'archive');
  }

  /**
   * A minimal citation of a SWHID, as the archive would make it.
   *
   * @remarks
   * Of the type the archive would give (`@codefragment` for a file's
   * content, `@software` for a snapshot, `@softwareversion` otherwise), with
   * a key made as the archive makes it, e.g. `swh-cnt-67c1849-L1-L3`.
   * Fields without a value are left out; see {@link BibtexEntry} for how
   * the others are escaped.
   *
   * @param swhid - The qualified SWHID cited, for the `swhid` field; its
   * object type gives the entry's type, its hash and lines the key.
   * @param why - Why the entry is a minimal one.
   * @param metadata - What else it says: title, URL, date.
   * @returns The citation.
   */
  static minimal(swhid: Swhid, why: MinimalWhy, metadata: CitationMetadata = {}): Citation {
    const day = metadata.date?.substring(0, 10);
    const entry = new BibtexEntry(ENTRY_TYPES[swhid.type], Citation.key(swhid), {
      title: metadata.title,
      url: metadata.url,
      date: day,
      year: day?.substring(0, 4),
      swhid: swhid.toString(),
    });
    return new Citation(entry.toString(), why);
  }

  /**
   * The citation of a SWHID, from what the archive answered.
   *
   * @param answer - What the archive answered, see {@link ArchiveApi.citation}.
   * @param swhid - The qualified SWHID cited.
   * @param metadata - What a minimal entry says, when the archive gave no entry.
   * @returns The archive's entry when it gave one, else a minimal one.
   */
  static of(answer: CitationAnswer, swhid: Swhid, metadata: CitationMetadata = {}): Citation {
    if (typeof answer === 'object') return Citation.fromArchive(answer.entry);
    return Citation.minimal(swhid, answer, metadata);
  }

  /** Where the entry comes from, in words, for messages: e.g. `"the archive's BibTeX entry"`. */
  get description(): string {
    return DESCRIPTIONS[this.why];
  }

  /**
   * The BibTeX entry.
   *
   * @returns The same as {@link Citation.entry}.
   */
  toString(): string {
    return this.entry;
  }

  /**
   * The key of a minimal entry, as the archive makes it.
   *
   * @param swhid - The SWHID cited.
   * @returns E.g. `swh-cnt-67c1849-L1-L3`: its object type, its short hash, its lines.
   */
  private static key(swhid: Swhid): string {
    return `swh-${swhid.type}-${swhid.shortHash}${Citation.linesKey(swhid.qualifiers.lines)}`;
  }

  /**
   * The part of a key that gives the cited lines, as the archive makes it.
   *
   * @param lines - The cited lines, if any.
   * @returns E.g. `-L1-L3`, or `-L5` for one line; `""` without lines.
   */
  private static linesKey(lines: Maybe<LineRange>): string {
    if (!lines) return '';
    return lines.isSingle ? `-L${lines.first}` : `-L${lines.first}-L${lines.last}`;
  }
}
