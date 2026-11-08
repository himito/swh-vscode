/**
 * BibTeX entries, as the {@link BibtexEntry} value object.
 *
 * @remarks
 * Only the format: what an entry cites, and from what, is `citation.ts`'s.
 * Everything here is pure. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import type { Maybe } from '../shared';

/**
 * The fields of a BibTeX entry, by name, in the order they are written; a
 * field without a value is left out.
 *
 * @remarks
 * An object keeps its string keys in the order they were added, which is
 * the order of the entry's fields.
 */
export type BibtexFields = { readonly [name: string]: Maybe<string> };

/**
 * The fields taken verbatim, as biblatex takes URLs and SWHIDs: LaTeX does
 * not typeset them, so only their braces need care.
 */
const VERBATIM_FIELDS: ReadonlySet<string> = new Set(['url', 'swhid']);

/**
 * How LaTeX's special characters are written in text, so that they show as they are.
 *
 * @remarks
 * Braces are written with commands, not as `\{` and `\}`: BibTeX counts a
 * brace even after a backslash, and an unbalanced one breaks the whole entry.
 */
const LATEX_SPECIALS: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '{': '\\textbraceleft{}',
  '}': '\\textbraceright{}',
  '#': '\\#',
  $: '\\$',
  '%': '\\%',
  '&': '\\&',
  _: '\\_',
  '^': '\\textasciicircum{}',
  '~': '\\textasciitilde{}',
};

/** The characters of {@link LATEX_SPECIALS}. */
const LATEX_SPECIAL = /[\\{}#$%&_^~]/g;

/**
 * A BibTeX entry: an immutable value.
 *
 * @remarks
 * Its fields are given as they are, and escaped when it is written (see
 * {@link BibtexEntry.toString}): LaTeX's special characters in the fields
 * LaTeX typesets, such as `title`, show as they are; the braces of the
 * fields taken verbatim, `url` and `swhid`, are percent-encoded. Either way,
 * the entry's braces stay balanced.
 *
 * @example
 * ```ts
 * new BibtexEntry('software', 'swh-snp-abababa', { title: 'my_repo', url: 'https://h/r' }).toString();
 * // '@software{swh-snp-abababa,\n    title = {my\\_repo},\n    url = {https://h/r}\n}\n'
 * ```
 */
export class BibtexEntry {
  /** The fields, frozen. */
  private readonly fields: BibtexFields;

  /**
   * Makes an entry.
   *
   * @param type - The entry type, e.g. `software`.
   * @param key - The citation key, e.g. `swh-cnt-67c1849`.
   * @param fields - The fields, in the order to write them, not escaped.
   */
  constructor(
    readonly type: string,
    readonly key: string,
    fields: BibtexFields,
  ) {
    this.fields = Object.freeze({ ...fields });
  }

  /**
   * The entry as written in a `.bib` file.
   *
   * @returns The entry, its fields escaped, those without a value left out,
   * ending with a newline.
   */
  toString(): string {
    const body = Object.entries(this.fields)
      .filter((field): field is [string, string] => Boolean(field[1]))
      .map(([name, value]) => `    ${name} = {${BibtexEntry.escape(name, value)}}`)
      .join(',\n');
    return `@${this.type}{${this.key},\n${body}\n}\n`;
  }

  /**
   * Escapes a field's value as its kind needs.
   *
   * @param name - The field's name.
   * @param value - Its value.
   * @returns The value, verbatim but for its braces in a verbatim field,
   * escaped for LaTeX in any other.
   */
  private static escape(name: string, value: string): string {
    return VERBATIM_FIELDS.has(name) ? BibtexEntry.verbatim(value) : BibtexEntry.latex(value);
  }

  /**
   * Writes text that LaTeX typesets, such as a title.
   *
   * @param text - The text, e.g. a repository's name.
   * @returns `text` with LaTeX's special characters escaped, e.g. `my\_repo`.
   */
  private static latex(text: string): string {
    return text.replace(LATEX_SPECIAL, (char) => LATEX_SPECIALS[char]);
  }

  /**
   * Writes a URL or a SWHID, taken verbatim.
   *
   * @remarks
   * Only its braces are encoded, as `%7B` and `%7D`: BibTeX needs them
   * balanced, and the URL, or the SWHID once its qualifiers are decoded, is
   * the same.
   *
   * @param text - The URL or SWHID.
   * @returns `text` without braces.
   */
  private static verbatim(text: string): string {
    return text.replace(/[{}]/g, (brace) => (brace === '{' ? '%7B' : '%7D'));
  }
}
