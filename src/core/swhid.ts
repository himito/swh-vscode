/**
 * SWHIDs, as the {@link Swhid}, {@link Qualifiers} and {@link LineRange} value objects.
 *
 * @remarks
 * A SWHID (SoftWare Hash IDentifier, https://www.swhid.org) names an
 * artifact of the Software Heritage archive: `swh:1:<type>:<sha1>`, the
 * "core" SWHID, optionally followed by `;key=value` qualifiers that give
 * its context (origin, visit, anchor, path, lines).
 *
 * Everything here is pure: no I/O, no Git, no network. This module must
 * not import `vscode`, so that the unit tests can run it with Node alone.
 *
 * @packageDocumentation
 */

import { baseUrl, hexify, unhex } from './encoding';
import { UserError } from './errors';
import { encodeOrigin, isPublicOrigin } from './origin';
import type { Maybe } from './types';

/**
 * The version of the SWHID scheme this module reads and writes: the `1` of
 * `swh:1:…`.
 *
 * @remarks
 * Every SWHID is made with it, and only SWHIDs of it are recognized. A new
 * version of the scheme may change more than this number, e.g. the hash
 * (SHA-1 in version 1, see `HASH`) or the object types (see
 * {@link OBJECT_TYPES}): check those too when changing it.
 */
export const SWHID_VERSION = 1;

/** What every SWHID of {@link SWHID_VERSION} starts with: `swh:1:`. */
export const SWHID_PREFIX = `swh:${SWHID_VERSION}:`;

/**
 * The object types a core SWHID can name, in {@link SWHID_VERSION}.
 *
 * @remarks
 * `cnt` a file's content, `dir` a directory, `rev` a commit, `rel` a release,
 * `snp` a snapshot of all the branches of an origin at a visit.
 */
export const OBJECT_TYPES = ['cnt', 'dir', 'rev', 'rel', 'snp'] as const;

/** An object type a core SWHID can name, see {@link OBJECT_TYPES}. */
export type ObjectType = (typeof OBJECT_TYPES)[number];

/**
 * The values of a SWHID's context qualifiers, decoded: what
 * {@link Swhid.qualify} and {@link Qualifiers.of} take.
 */
export type QualifierValues = {
  /** The URL of the origin the object was found in. */
  origin?: string;
  /** The snapshot of the origin's visit the object was found in. */
  visit?: Swhid;
  /** The commit, release, directory or snapshot that holds the object. */
  anchor?: Swhid;
  /** The object's path from the anchor's root directory, starting with `/`. */
  path?: string;
  /** The range of lines of a content. */
  lines?: LineRange;
};

/** The hash of an object in {@link SWHID_VERSION}, as part of a regular expression: a SHA-1 in hexadecimal, as Git writes it. */
const HASH = '[0-9a-f]{40}';

/** A hash, alone. */
const SHA1 = new RegExp(`^${HASH}$`);

/** The object types, as a regular expression's alternatives: `cnt|dir|…`. */
const TYPES = OBJECT_TYPES.join('|');

/** The text of a SWHID, core or qualified, its qualifiers not checked. */
const SWHID_SYNTAX = new RegExp(`^${SWHID_PREFIX}(${TYPES}):(${HASH})(;.*)?$`);

/**
 * The text of a SWHID within other text; see {@link findSwhids}. Its
 * qualifiers end at a blank, a quote, a backtick or a bracket.
 */
const SWHID_IN_TEXT = new RegExp(`${SWHID_PREFIX}(?:${TYPES}):${HASH}(?:;[^\\s"'\`<>()[\\]{}]*)?`, 'g');

/** The object types a `visit` qualifier may name: a snapshot. */
const VISIT_TYPES: readonly ObjectType[] = ['snp'];

/** The object types an `anchor` qualifier may name: those that hold other objects. */
const ANCHOR_TYPES: readonly ObjectType[] = ['dir', 'rev', 'rel', 'snp'];

/** The text of a line range: a line, or two separated by `-`, numbered from 1. */
const LINES = /^(?<first>[1-9][0-9]*)(?:-(?<last>[1-9][0-9]*))?$/;

/**
 * Encodes a path as the value of a `path` qualifier, as swh.model and
 * swhid-clj do.
 *
 * @param path - A path with `/` separators.
 * @returns The path with every character but `/` and the unreserved ones percent-encoded.
 */
export const encodePath = (path: string) => hexify(path, '/');

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

/**
 * A SWHID: an immutable value, core or qualified.
 *
 * @remarks
 * Instances are made only by {@link Swhid.of} and {@link Swhid.parse}, which
 * check them: a `Swhid` is always valid. Qualifying one gives a new one.
 *
 * Two instances of the same SWHID are different objects: compare them with
 * {@link Swhid.equals}, and key maps by {@link Swhid.toString}, the
 * canonical text.
 *
 * @example
 * ```ts
 * const file = Swhid.of('cnt', '94a9ed024d3859793618152ea559a168bbcbb5e2');
 * file.qualify({ lines: LineRange.of(3, 5) }).toString();
 * // 'swh:1:cnt:94a9ed024d3859793618152ea559a168bbcbb5e2;lines=3-5'
 * ```
 */
export class Swhid {
  /** The canonical text, computed once. */
  private readonly text: string;

  /**
   * Makes a SWHID from parts already checked.
   *
   * @param type - The object type.
   * @param hash - The object's SHA-1, in hexadecimal.
   * @param qualifiers - The qualifiers; none by default.
   */
  private constructor(
    readonly type: ObjectType,
    readonly hash: string,
    readonly qualifiers: Qualifiers = Qualifiers.NONE,
  ) {
    this.text = `${SWHID_PREFIX}${type}:${hash}${qualifiers}`;
  }

  /**
   * The core SWHID of an object, from its Git hash.
   *
   * @param type - The object type.
   * @param hash - The object's SHA-1, in hexadecimal.
   * @returns The core SWHID, `swh:1:<type>:<hash>`.
   * @throws {@link UserError} when `hash` is longer than a SHA-1 (the
   * repository uses SHA-256, which SWHIDs do not support), or is not a SHA-1.
   *
   * @example
   * ```ts
   * Swhid.of('cnt', '94a9ed024d3859793618152ea559a168bbcbb5e2').toString();
   * // 'swh:1:cnt:94a9ed024d3859793618152ea559a168bbcbb5e2'
   * ```
   */
  static of(type: ObjectType, hash: string): Swhid {
    if (hash.length > 40) throw new UserError('SWHIDs are SHA-1 based: this repository uses SHA-256');
    if (!SHA1.test(hash)) throw new UserError(`Not a SHA-1: ${hash}`);
    return new Swhid(type, hash);
  }

  /**
   * Parses the text of a SWHID, core or qualified.
   *
   * @param text - The SWHID's text, e.g. as the user typed it.
   * @returns The SWHID, its qualifier values decoded.
   * @throws {@link UserError} when `text` is not a SWHID, or holds an
   * unknown or malformed qualifier: e.g. a visit that is not a snapshot, or
   * an anchor that is a content.
   *
   * @example
   * ```ts
   * Swhid.parse('swh:1:cnt:94a9…;origin=https://h/o%20r;lines=2').qualifiers.origin;
   * // 'https://h/o r'
   * ```
   */
  static parse(text: string): Swhid {
    const match = SWHID_SYNTAX.exec(text);
    if (!match) throw new UserError(`Not a SWHID: ${text}`);
    const qualifiers = match[3] ? Qualifiers.parse(match[3].substring(1)) : Qualifiers.NONE;
    return new Swhid(match[1] as ObjectType, match[2], qualifiers);
  }

  /**
   * Like {@link Swhid.parse}, but `undefined` rather than an error.
   *
   * @param text - The SWHID's text.
   * @returns The SWHID, or `undefined` when `text` is not a valid one.
   */
  static tryParse(text: string): Maybe<Swhid> {
    try {
      return Swhid.parse(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Tells whether a text has the syntax of a SWHID, with or without qualifiers.
   *
   * @remarks
   * The qualifiers are not checked: this is for text the user types, which
   * is then passed on to the archive as is.
   *
   * @param text - The text.
   * @returns `true` for a SWHID.
   *
   * @example
   * ```ts
   * Swhid.isValid('swh:1:cnt:0123456789abcdef0123456789abcdef01234567;lines=1'); // true
   * Swhid.isValid('swh:1:cnt:0123'); // false
   * ```
   */
  static isValid(text: string): boolean {
    return SWHID_SYNTAX.test(text);
  }

  /** The core SWHID: this one without its qualifiers. */
  get core(): Swhid {
    return this.qualifiers.isEmpty ? this : new Swhid(this.type, this.hash);
  }

  /** The first seven digits of the hash, as Git abbreviates commits. */
  get shortHash(): string {
    return this.hash.substring(0, 7);
  }

  /**
   * The core SWHID qualified with a context, its previous qualifiers dropped.
   *
   * @remarks
   * The qualifiers are filtered as {@link Qualifiers.of} says: `origin` and
   * `visit` only for a public origin, `path` only with an `anchor`.
   *
   * @param context - The qualifiers' values; missing ones are left out.
   * @returns The qualified SWHID.
   *
   * @example
   * ```ts
   * dir.qualify({ origin: 'https://h/r', visit: snp, anchor: rev, path: '/', lines: LineRange.of(3, 4) }).toString();
   * // 'swh:1:dir:…;origin=https://h/r;visit=swh:1:snp:…;anchor=swh:1:rev:…;path=/;lines=3-4'
   * ```
   */
  qualify(context: QualifierValues): Swhid {
    return new Swhid(this.type, this.hash, Qualifiers.of(context));
  }

  /**
   * Tells whether two SWHIDs are the same, qualifiers included.
   *
   * @param other - The other SWHID.
   * @returns `true` when their canonical texts are equal.
   */
  equals(other: Maybe<Swhid>): boolean {
    return other !== undefined && this.text === other.text;
  }

  /**
   * The canonical text of the SWHID.
   *
   * @remarks
   * The qualifiers come in the order the SWHID specification gives, their
   * values percent-encoded as swh.model and swhid-clj encode them.
   *
   * @returns E.g. `swh:1:cnt:…;origin=https://h/r;lines=3`.
   */
  toString(): string {
    return this.text;
  }

  /**
   * The SWHID with its hash shortened to ten digits, for messages.
   *
   * @returns E.g. `swh:1:cnt:0123456789;lines=1`; the qualifiers are kept.
   */
  toShortString(): string {
    return this.text.replace(this.hash, this.hash.substring(0, 10));
  }

  /**
   * The SWHID in JSON: its canonical text.
   *
   * @returns The same as {@link Swhid.toString}.
   */
  toJSON(): string {
    return this.text;
  }
}

/** A qualifier as written in a SWHID, not checked yet. */
type WrittenQualifier = {
  /** Its key, e.g. `origin`; maybe not that of a known qualifier. */
  key: string;
  /** Its value, still percent-encoded. */
  value: string;
};

/** The key of a qualifier, e.g. `origin`. */
type QualifierKey = keyof QualifierValues;

/** Each qualifier's value as its parser returns it: every key, none `undefined`. */
type ParsedValues = Required<QualifierValues>;

/**
 * Decodes and checks the value of a qualifier, as written in a SWHID.
 *
 * @typeParam T - The value it gives.
 */
type QualifierParser<T> = (value: string) => T;

/**
 * A parser for each qualifier, giving the type of that qualifier's value.
 *
 * @remarks
 * A mapped type, not a plain record: indexing it with a key gives that key's
 * parser, which lets `Qualifiers.parseInto` type-check.
 */
type QualifierParsers = { readonly [Key in QualifierKey]: QualifierParser<ParsedValues[Key]> };

/**
 * The context qualifiers of a SWHID: an immutable value.
 *
 * @remarks
 * Made by {@link Qualifiers.of} from values, or by {@link Qualifiers.parse}
 * from a SWHID's text; {@link Qualifiers.NONE} for a core SWHID. Their text
 * (see {@link Qualifiers.toString}) is what follows the core SWHID.
 *
 * @example
 * ```ts
 * Qualifiers.of({ origin: 'https://h/o r', lines: LineRange.of(2) }).toString();
 * // ';origin=https://h/o%20r;lines=2'
 * ```
 */
export class Qualifiers {
  /** No qualifiers: those of a core SWHID. */
  static readonly NONE = new Qualifiers({});

  /**
   * The parser of each qualifier's value: it decodes and checks it.
   *
   * @remarks
   * One parser per key of {@link QualifierValues}: a qualifier added there
   * without a parser here does not compile.
   */
  private static readonly PARSERS: QualifierParsers = {
    origin: unhex,
    visit: (value) => Qualifiers.swhidOf(value, VISIT_TYPES, 'A visit is a snapshot'),
    anchor: (value) => Qualifiers.swhidOf(value, ANCHOR_TYPES, 'An anchor holds objects'),
    path: (value) => Qualifiers.pathOf(value),
    lines: LineRange.parse,
  };

  /** The values given, frozen. */
  private readonly given: Readonly<QualifierValues>;
  /** The text, computed once. */
  private readonly text: string;

  /**
   * Makes qualifiers from values already checked.
   *
   * @param values - The values; those `undefined` or empty are dropped, as no
   * qualifier is written for them.
   */
  private constructor(values: QualifierValues) {
    const given = Object.entries(values).filter(([, value]) => value !== undefined && value !== '');
    this.given = Object.freeze(Object.fromEntries(given) as QualifierValues);
    this.text = Qualifiers.encode(this.given);
  }

  /**
   * The qualifiers of a context.
   *
   * @remarks
   * `origin` and `visit` are kept only for a public origin: the archive
   * holds no other. `path` is kept only with an `anchor`, which it is
   * relative to.
   *
   * @param values - The context's values; missing ones are left out.
   * @returns The qualifiers.
   */
  static of(values: QualifierValues): Qualifiers {
    const pub = isPublicOrigin(values.origin);
    return new Qualifiers({
      origin: pub ? values.origin : undefined,
      visit: pub ? values.visit : undefined,
      anchor: values.anchor,
      path: values.anchor ? values.path : undefined,
      lines: values.lines,
    });
  }

  /**
   * Parses the qualifiers of a SWHID's text, as they are written.
   *
   * @param text - The qualifiers, without the leading `;`, e.g. `origin=https://h/r;lines=2`.
   * @returns The qualifiers, their values percent-decoded.
   * @throws {@link UserError} for an empty or unknown qualifier, one given
   * twice or without a value, or a malformed value: a line range that is not
   * one, a visit that is not a snapshot, an anchor that is a content, a path
   * that does not start with `/`.
   */
  static parse(text: string): Qualifiers {
    const values: QualifierValues = {};
    for (const { key, value } of text.split(';').map(Qualifiers.split)) {
      if (!key) throw new UserError('Empty SWHID qualifier: two `;` in a row, or one at the end');
      if (!Qualifiers.isKey(key)) throw new UserError(`Unknown SWHID qualifier: ${key}`);
      // the text would keep only one of the values
      if (key in values) throw new UserError(`The ${key} qualifier is given twice`);
      if (!value) throw new UserError(`The ${key} qualifier has no value`);
      Qualifiers.parseInto(values, key, value);
    }
    return new Qualifiers(values);
  }

  /** The URL of the origin the object was found in. */
  get origin(): Maybe<string> {
    return this.given.origin;
  }

  /** The snapshot of the origin's visit the object was found in. */
  get visit(): Maybe<Swhid> {
    return this.given.visit;
  }

  /** The commit, release, directory or snapshot that holds the object. */
  get anchor(): Maybe<Swhid> {
    return this.given.anchor;
  }

  /** The object's path from the anchor's root directory, starting with `/`. */
  get path(): Maybe<string> {
    return this.given.path;
  }

  /** The range of lines of a content. */
  get lines(): Maybe<LineRange> {
    return this.given.lines;
  }

  /** Whether there are none: the qualifiers of a core SWHID. */
  get isEmpty(): boolean {
    return this.text === '';
  }

  /** The values given, e.g. to compare them in tests; missing ones are left out. */
  get values(): Readonly<QualifierValues> {
    return this.given;
  }

  /**
   * Tells whether two sets of qualifiers are the same.
   *
   * @param other - The other qualifiers.
   * @returns `true` when their texts are equal.
   */
  equals(other: Maybe<Qualifiers>): boolean {
    return other !== undefined && this.text === other.text;
  }

  /**
   * The text of the qualifiers, as it follows the core SWHID.
   *
   * @remarks
   * The qualifiers come in the order the SWHID specification gives, their
   * values percent-encoded as swh.model and swhid-clj encode them.
   *
   * @returns `;key=value` for each qualifier, e.g. `;origin=https://h/r;lines=3`; `""` for none.
   */
  toString(): string {
    return this.text;
  }

  /**
   * Encodes qualifiers, in the order the SWHID specification gives.
   *
   * @param values - The values, decoded.
   * @returns `;key=value` for each value given, or `""` for none.
   */
  private static encode({ origin, visit, anchor, path, lines }: QualifierValues): string {
    const parts: Array<[string, Maybe<string>]> = [
      ['origin', origin && encodeOrigin(origin)],
      ['visit', visit?.toString()],
      ['anchor', anchor?.toString()],
      ['path', path && encodePath(path)],
      ['lines', lines?.toString()],
    ];
    return parts.map(([key, value]) => (value ? `;${key}=${value}` : '')).join('');
  }

  /**
   * Splits a qualifier into its key and its value, still encoded.
   *
   * @param qualifier - A qualifier, `key=value`.
   * @returns Its key and its value; the value is `""` when there is no `=`.
   */
  private static split(qualifier: string): WrittenQualifier {
    const equals = qualifier.indexOf('=');
    if (equals < 0) return { key: qualifier, value: '' };
    return { key: qualifier.substring(0, equals), value: qualifier.substring(equals + 1) };
  }

  /**
   * Tells whether a key is that of a known qualifier.
   *
   * @param key - The key, as written in the SWHID.
   * @returns `true` for a key of {@link QualifierValues}.
   */
  private static isKey(key: string): key is QualifierKey {
    return Object.hasOwn(Qualifiers.PARSERS, key);
  }

  /**
   * Parses the value of a qualifier, and records it.
   *
   * @param values - Where to record it.
   * @param key - The qualifier's key.
   * @param value - Its value, still encoded.
   * @throws {@link UserError} when the value is malformed.
   */
  private static parseInto<Key extends QualifierKey>(values: QualifierValues, key: Key, value: string): void {
    values[key] = Qualifiers.PARSERS[key](value);
  }

  /**
   * Parses a qualifier's value that is a SWHID, of the types the qualifier allows.
   *
   * @param value - The qualifier's value.
   * @param allowed - The object types the qualifier allows.
   * @param rule - What the qualifier must be, for the error, e.g. `A visit is a snapshot`.
   * @returns The SWHID.
   * @throws {@link UserError} when `value` is not a SWHID, or not of a type allowed.
   */
  private static swhidOf(value: string, allowed: readonly ObjectType[], rule: string): Swhid {
    const swhid = Swhid.parse(value);
    if (!allowed.includes(swhid.type)) throw new UserError(`${rule}, not ${value}`);
    return swhid;
  }

  /**
   * Parses the value of a `path` qualifier.
   *
   * @param value - The qualifier's value.
   * @returns The path, decoded.
   * @throws {@link UserError} when the path does not start with `/`: it is
   * from the anchor's root directory.
   */
  private static pathOf(value: string): string {
    const path = unhex(value);
    if (!path.startsWith('/')) throw new UserError(`A path starts with /, not ${value}`);
    return path;
  }
}

/**
 * Gives the URL of a SWHID in the archive's web interface.
 *
 * @param archiveUrl - The archive's web root, e.g. `https://archive.softwareheritage.org`.
 * @param swhid - A SWHID, or the text of one as the user typed it, inserted as is.
 * @returns The URL where the archive shows the SWHID.
 */
export const browseUrl = (archiveUrl: string, swhid: Swhid | string) => `${baseUrl(archiveUrl)}/${swhid}`;

/**
 * Finds the SWHIDs in a text, with their qualifiers.
 *
 * @remarks
 * A SWHID ends at a blank, a quote, a backtick or a bracket. Trailing
 * punctuation (`.`, `,`, `:`, `;`) is left out, as it more likely ends the
 * sentence than the SWHID. The SWHIDs are given as written, not parsed:
 * their qualifiers are not checked.
 *
 * @param text - The text to search, e.g. a whole document.
 * @returns `[offset, text]` pairs, `offset` being the SWHID's position in `text`.
 */
export function findSwhids(text: string): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const match of text.matchAll(SWHID_IN_TEXT)) {
    out.push([match.index!, match[0].replace(/[.,:;]+$/, '')]);
  }
  return out;
}
