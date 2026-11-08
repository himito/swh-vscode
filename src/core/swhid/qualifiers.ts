/**
 * The context qualifiers of a SWHID, as the {@link Qualifiers} value object.
 *
 * @remarks
 * Everything here is pure. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import { encodeOrigin, isPublicOrigin } from '#core/origin';
import { hexify, type Maybe, unhex, UserError } from '#core/shared';
import { LineRange } from './lineRange';
import { type ObjectType, Swhid } from './swhid';

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

/** The object types a `visit` qualifier may name: a snapshot. */
const VISIT_TYPES: readonly ObjectType[] = ['snp'];

/** The object types an `anchor` qualifier may name: those that hold other objects. */
const ANCHOR_TYPES: readonly ObjectType[] = ['dir', 'rev', 'rel', 'snp'];

/**
 * Encodes a path as the value of a `path` qualifier, as swh.model and
 * swhid-clj do.
 *
 * @param path - A path with `/` separators.
 * @returns The path with every character but `/` and the unreserved ones percent-encoded.
 */
export const encodePath = (path: string) => hexify(path, '/');

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
