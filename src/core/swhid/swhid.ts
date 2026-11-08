/**
 * SWHIDs, as the {@link Swhid} value object, and the scheme they follow.
 *
 * @remarks
 * A SWHID (SoftWare Hash IDentifier, https://www.swhid.org) names an
 * artifact of the Software Heritage archive: `swh:1:<type>:<sha1>`, the
 * "core" SWHID, optionally followed by `;key=value` qualifiers that give
 * its context (origin, visit, anchor, path, lines), see {@link Qualifiers}.
 *
 * Everything here is pure: no I/O, no Git, no network. This module must
 * not import `vscode`, so that the unit tests can run it with Node alone.
 *
 * @packageDocumentation
 */

import { baseUrl, type Maybe, UserError } from '../shared';
import { Qualifiers, type QualifierValues } from './qualifiers';

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

/** The hash of an object in {@link SWHID_VERSION}, as part of a regular expression: a SHA-1 in hexadecimal, as Git writes it. */
const HASH = '[0-9a-f]{40}';

/** A hash, alone. */
const SHA1 = new RegExp(`^${HASH}$`);

/** The object types, as a regular expression's alternatives: `cnt|dir|…`. */
const TYPES = OBJECT_TYPES.join('|');

/**
 * The text of a SWHID, core or qualified, its qualifiers not checked but for
 * their having no blank: a SWHID never holds one, its origin's are encoded.
 */
const SWHID_SYNTAX = new RegExp(`^${SWHID_PREFIX}(${TYPES}):(${HASH})(;\\S*)?$`);

/**
 * The text of a SWHID within other text; see {@link findSwhids}. Its
 * qualifiers end at a blank, a quote, a backtick or a bracket.
 */
const SWHID_IN_TEXT = new RegExp(`${SWHID_PREFIX}(?:${TYPES}):${HASH}(?:;[^\\s"'\`<>()[\\]{}]*)?`, 'g');

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
   * The qualifiers are not checked, but must hold no blank, as no SWHID
   * does: this is for text the user types, which
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
