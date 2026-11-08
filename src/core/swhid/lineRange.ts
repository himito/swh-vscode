/**
 * Ranges of lines, as the {@link LineRange} value object: the value of a
 * SWHID's `lines` qualifier.
 *
 * @remarks
 * Everything here is pure. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import { type Maybe, UserError } from '#core/shared';

/** The text of a line range: a line, or two separated by `-`, numbered from 1. */
const LINES = /^(?<first>[1-9][0-9]*)(?:-(?<last>[1-9][0-9]*))?$/;

/**
 * A range of lines of a content, numbered from 1: the value of a SWHID's
 * `lines` qualifier. An immutable value.
 *
 * @remarks
 * Made by {@link LineRange.of} from line numbers, or by
 * {@link LineRange.parse} from the qualifier's text, which check it: its
 * first line is 1 or after, and its last line is its first or after.
 *
 * @example
 * ```ts
 * LineRange.of(2, 3).toString(); // '2-3'
 * LineRange.of(5).toString();    // '5'
 * LineRange.parse('5-2');        // throws
 * ```
 */
export class LineRange {
  /**
   * Makes a range from line numbers already checked.
   *
   * @param first - The first line.
   * @param last - The last line.
   */
  private constructor(
    readonly first: number,
    readonly last: number,
  ) { }

  /**
   * The range of lines from `first` to `last`.
   *
   * @param first - The first line, numbered from 1.
   * @param last - The last line, numbered from 1; `first` by default, for a single line.
   * @returns The range.
   * @throws {@link UserError} when a line is not an integer from 1, or `last` comes before `first`.
   */
  static of(first: number, last = first): LineRange {
    return LineRange.checked(first, last, `${first}-${last}`);
  }

  /**
   * Parses the value of a `lines` qualifier.
   *
   * @param text - `"A-B"`, or `"A"` for a single line.
   * @returns The range.
   * @throws {@link UserError} when `text` is not a line range, or `B` comes before `A`.
   */
  static parse(text: string): LineRange {
    const groups = LINES.exec(text)?.groups;
    if (!groups) throw new UserError(`Not a line range: ${text}`);

    // a single line, `A`, is the range `A-A`
    const { first, last = first } = groups;
    return LineRange.checked(Number(first), Number(last), text);
  }

  /** Whether the range is a single line. */
  get isSingle(): boolean {
    return this.first === this.last;
  }

  /**
   * Tells whether two ranges are the same.
   *
   * @param other - The other range.
   * @returns `true` when they have the same first and last lines.
   */
  equals(other: Maybe<LineRange>): boolean {
    return other !== undefined && this.first === other.first && this.last === other.last;
  }

  /**
   * The range as the value of a `lines` qualifier.
   *
   * @returns `"A-B"`, or `"A"` for a single line.
   */
  toString(): string {
    return this.isSingle ? String(this.first) : `${this.first}-${this.last}`;
  }

  /**
   * The range in JSON: its text.
   *
   * @returns The same as {@link LineRange.toString}.
   */
  toJSON(): string {
    return this.toString();
  }

  /**
   * Makes a range, after checking its lines.
   *
   * @param first - The first line.
   * @param last - The last line.
   * @param shown - The range as given, for the error.
   * @returns The range.
   * @throws {@link UserError} when a line is not an integer from 1, or `last` comes before `first`.
   */
  private static checked(first: number, last: number, shown: string): LineRange {
    const isRange = LineRange.isLine(first) && LineRange.isLine(last) && first <= last;
    if (!isRange) throw new UserError(`Not a line range: ${shown}`);
    return new LineRange(first, last);
  }

  /**
   * Tells whether a number is a line number.
   *
   * @param line - The number.
   * @returns `true` for an integer from 1, exactly represented.
   */
  private static isLine(line: number): boolean {
    return Number.isSafeInteger(line) && line >= 1;
  }
}
