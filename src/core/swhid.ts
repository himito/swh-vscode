/**
 * SWHIDs, as the {@link Swhid} value object.
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
 * The object types a core SWHID can name.
 *
 * @remarks
 * `cnt` a file's content, `dir` a directory, `rev` a commit, `rel` a release,
 * `snp` a snapshot of all the branches of an origin at a visit.
 */
export type ObjectType = 'cnt' | 'dir' | 'rev' | 'rel' | 'snp';

/** The context qualifiers of a SWHID, their values decoded. */
export type Qualifiers = {
  /** The URL of the origin the object was found in. */
  origin?: string;
  /** The snapshot of the origin's visit the object was found in. */
  visit?: Swhid;
  /** The commit, release, directory or snapshot that holds the object. */
  anchor?: Swhid;
  /** The object's path from the anchor's root directory, starting with `/`. */
  path?: string;
  /** A range of lines of a content, `"A-B"` or `"A"`, see {@link lineRange}. */
  lines?: string;
};

/** A SHA-1 in hexadecimal, as Git writes it. */
const SHA1 = /^[0-9a-f]{40}$/;

/** The text of a SWHID, core or qualified, its qualifiers not checked. */
const SWHID_SYNTAX = /^swh:1:(cnt|dir|rev|rel|snp):([0-9a-f]{40})(;.*)?$/;

/** The text of a SWHID within other text; see {@link findSwhids}. */
const SWHID_IN_TEXT = /swh:1:(?:cnt|dir|rev|rel|snp):[0-9a-f]{40}(?:;[^\s"'`<>()[\]{}]*)?/g;

/** A line range qualifier: a line, or two separated by `-`, numbered from 1. */
const LINES = /^[1-9][0-9]*(-[1-9][0-9]*)?$/;

/**
 * Encodes a path as the value of a `path` qualifier, as swh.model and
 * swhid-clj do.
 *
 * @param path - A path with `/` separators.
 * @returns The path with every character but `/` and the unreserved ones percent-encoded.
 */
export const encodePath = (path: string) => hexify(path, '/');

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
 * file.qualify({ lines: '3-5' }).toString();
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
   * @param qualifiers - The qualifiers, already filtered; those `undefined` are dropped.
   */
  private constructor(
    readonly type: ObjectType,
    readonly hash: string,
    readonly qualifiers: Readonly<Qualifiers> = {},
  ) {
    const given = Object.entries(qualifiers).filter(([, value]) => value !== undefined);
    this.qualifiers = Object.freeze(Object.fromEntries(given) as Qualifiers);
    this.text = `swh:1:${type}:${hash}${encodeQualifiers(this.qualifiers)}`;
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
   * Swhid.parse('swh:1:cnt:94a9…;origin=https://h/o%20r;lines=2').qualifiers;
   * // { origin: 'https://h/o r', lines: '2' }
   * ```
   */
  static parse(text: string): Swhid {
    const match = SWHID_SYNTAX.exec(text);
    if (!match) throw new UserError(`Not a SWHID: ${text}`);
    const qualifiers = match[3] ? parseQualifiers(match[3].substring(1)) : {};
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
    return Object.keys(this.qualifiers).length ? new Swhid(this.type, this.hash) : this;
  }

  /** The first seven digits of the hash, as Git abbreviates commits. */
  get shortHash(): string {
    return this.hash.substring(0, 7);
  }

  /**
   * The core SWHID qualified with a context, its previous qualifiers dropped.
   *
   * @remarks
   * The `origin` and `visit` qualifiers are kept only for a public origin,
   * and `path` only with an `anchor`, which it is relative to.
   *
   * @param context - The qualifiers; missing ones are left out.
   * @returns The qualified SWHID.
   *
   * @example
   * ```ts
   * dir.qualify({ origin: 'https://h/r', visit: snp, anchor: rev, path: '/', lines: '3-4' }).toString();
   * // 'swh:1:dir:…;origin=https://h/r;visit=swh:1:snp:…;anchor=swh:1:rev:…;path=/;lines=3-4'
   * ```
   */
  qualify(context: Qualifiers): Swhid {
    const pub = isPublicOrigin(context.origin);
    return new Swhid(this.type, this.hash, {
      origin: pub ? context.origin : undefined,
      visit: pub ? context.visit : undefined,
      anchor: context.anchor,
      path: context.anchor ? context.path : undefined,
      lines: context.lines,
    });
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
 * Encodes qualifiers, in the order the SWHID specification gives.
 *
 * @param qualifiers - The qualifiers, their values decoded.
 * @returns `;key=value` for each qualifier given, or `""` for none.
 */
function encodeQualifiers({ origin, visit, anchor, path, lines }: Qualifiers): string {
  const parts: Array<[string, Maybe<string>]> = [
    ['origin', origin && encodeOrigin(origin)],
    ['visit', visit?.toString()],
    ['anchor', anchor?.toString()],
    ['path', path && encodePath(path)],
    ['lines', lines],
  ];
  return parts.map(([key, value]) => (value ? `;${key}=${value}` : '')).join('');
}

/**
 * Parses the qualifiers of a SWHID.
 *
 * @param text - The qualifiers, without the leading `;`.
 * @returns The qualifiers, their values percent-decoded.
 * @throws {@link UserError} for an unknown qualifier, or a malformed value:
 * a line range that is not one, a visit that is not a snapshot, an anchor
 * that is a content.
 */
function parseQualifiers(text: string): Qualifiers {
  const qualifiers: Qualifiers = {};
  for (const part of text.split(';')) {
    const equals = part.indexOf('=');
    const key = equals < 0 ? part : part.substring(0, equals);
    const value = equals < 0 ? '' : part.substring(equals + 1);
    switch (key) {
      case 'origin':
        qualifiers.origin = unhex(value);
        break;
      case 'visit':
        qualifiers.visit = Swhid.parse(value);
        if (qualifiers.visit.type !== 'snp') throw new UserError(`A visit is a snapshot, not ${value}`);
        break;
      case 'anchor':
        qualifiers.anchor = Swhid.parse(value);
        if (qualifiers.anchor.type === 'cnt') throw new UserError(`An anchor holds objects, not ${value}`);
        break;
      case 'path':
        qualifiers.path = unhex(value);
        break;
      case 'lines':
        if (!LINES.test(value)) throw new UserError(`Not a line range: ${value}`);
        qualifiers.lines = value;
        break;
      default:
        throw new UserError(`Unknown SWHID qualifier: ${key}`);
    }
  }
  return qualifiers;
}

/**
 * The value of a SWHID's `lines` qualifier for a range of lines.
 *
 * @param first - The first line, numbered from 1.
 * @param last - The last line, numbered from 1; `first` or after.
 * @returns `"A-B"`, or `"A"` for a single line.
 *
 * @example
 * ```ts
 * lineRange(2, 3); // '2-3'
 * lineRange(5, 5); // '5'
 * ```
 */
export function lineRange(first: number, last: number): string {
  return first === last ? String(first) : `${first}-${last}`;
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
