/**
 * SWHIDs, origins and their encodings.
 *
 * @remarks
 * A SWHID (SoftWare Hash IDentifier, https://www.swhid.org) names an
 * artifact of the Software Heritage archive: `swh:1:<type>:<sha1>`, the
 * "core" SWHID, optionally followed by `;key=value` qualifiers that give
 * its context (origin, visit, anchor, path, lines).
 *
 * Every function here is pure: no I/O, no Git, no network. This module must
 * not import `vscode`, so that the unit tests can run it with Node alone.
 *
 * @packageDocumentation
 */

import { UserError } from './http';
import type { Maybe } from './types';

/**
 * The object types a core SWHID can name.
 *
 * @remarks
 * `cnt` a file's content, `dir` a directory, `rev` a commit, `rel` a release,
 * `snp` a snapshot of all the branches of an origin at a visit.
 */
export type ObjectType = 'cnt' | 'dir' | 'rev' | 'rel' | 'snp';

/**
 * Builds the core SWHID of an object from its Git hash.
 *
 * @param type - The object type.
 * @param hash - The object's SHA-1, in hexadecimal.
 * @returns The core SWHID, `swh:1:<type>:<hash>`.
 * @throws {@link UserError} when `hash` is longer than a SHA-1: the
 * repository uses SHA-256, which SWHIDs do not support.
 *
 * @example
 * ```ts
 * core('cnt', '94a9ed024d3859793618152ea559a168bbcbb5e2');
 * // 'swh:1:cnt:94a9ed024d3859793618152ea559a168bbcbb5e2'
 * ```
 */
export function core(type: ObjectType, hash: string): string {
  if (hash.length > 40) {
    throw new UserError('SWHIDs are SHA-1 based: this repository uses SHA-256');
  }
  return `swh:1:${type}:${hash}`;
}

/**
 * Gives the object type of a SWHID.
 *
 * @param swhid - A core or qualified SWHID.
 * @returns Its object type, e.g. `"cnt"`.
 */
export const typeOf = (swhid: string) => swhid.substring(6, 9);

/**
 * Gives the hash of a core SWHID.
 *
 * @param swhid - A core SWHID: with qualifiers, they would be included.
 * @returns Its 40-digit hexadecimal hash.
 */
export const hashOf = (swhid: string) => swhid.substring(10);

/**
 * Gives the first seven digits of the hash of a SWHID, as Git abbreviates commits.
 *
 * @param swhid - A core or qualified SWHID.
 * @returns The first seven hexadecimal digits of its hash.
 */
export const shortHash = (swhid: string) => swhid.substring(10, 17);

/**
 * Shortens the hash of a SWHID to its first ten digits, for messages.
 *
 * @param swhid - A core or qualified SWHID; its qualifiers are kept.
 * @returns The SWHID with a ten-digit hash.
 *
 * @example
 * ```ts
 * shortSwhid('swh:1:cnt:0123456789abcdef0123456789abcdef01234567;lines=1');
 * // 'swh:1:cnt:0123456789;lines=1'
 * ```
 */
export function shortSwhid(swhid: string): string {
  return swhid.replace(/^(swh:1:[a-z]{3}:[0-9a-f]{10})[0-9a-f]*/, '$1');
}

/**
 * Removes the trailing slashes of a base URL setting.
 *
 * @param url - A base URL, such as the `swh.archiveUrl` setting.
 * @returns `url` without its trailing slashes.
 */
export const baseUrl = (url: string) => url.replace(/\/+$/, '');

/**
 * Gives the URL of a SWHID in the archive's web interface.
 *
 * @param archiveUrl - The archive's web root, e.g. `https://archive.softwareheritage.org`.
 * @param swhid - A core or qualified SWHID, inserted as is.
 * @returns The URL where the archive shows the SWHID.
 */
export const browseUrl = (archiveUrl: string, swhid: string) => `${baseUrl(archiveUrl)}/${swhid}`;

/** The characters that URLs never need to percent-encode (RFC 3986 "unreserved"). */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~';

/**
 * Percent-encodes a string, as UTF-8, except for the unreserved characters
 * and the `allowed` ones.
 *
 * @param str - The string to encode.
 * @param allowed - Further characters to leave as they are.
 * @returns `str` with every other character encoded as `%XX` (uppercase hexadecimal).
 *
 * @example
 * ```ts
 * hexify('/src/my file é;%.el', '/');
 * // '/src/my%20file%20%C3%A9%3B%25.el'
 * ```
 */
export function hexify(str: string, allowed = ''): string {
  const ok = new Set(UNRESERVED + allowed);
  let out = '';
  for (const c of str) {
    if (ok.has(c)) {
      out += c;
    } else {
      for (const b of Buffer.from(c, 'utf8')) {
        out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

/**
 * Decodes the `%XX` sequences of a string, as UTF-8.
 *
 * @remarks
 * Unlike `decodeURIComponent`, it never throws: a `%` that does not start a
 * valid sequence is kept as is.
 *
 * @param str - The percent-encoded string.
 * @returns The decoded string.
 */
export function unhex(str: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; ) {
    const m = /^%([0-9a-fA-F]{2})/.exec(str.substring(i, i + 3));
    if (m) {
      bytes.push(parseInt(m[1], 16));
      i += 3;
    } else {
      // a whole code point: a lone half of a surrogate pair would not encode
      const c = String.fromCodePoint(str.codePointAt(i)!);
      bytes.push(...Buffer.from(c, 'utf8'));
      i += c.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Builds a URL query string, its keys and values percent-encoded.
 *
 * @param params - `[key, value]` pairs, or `[key]` for a key without a value.
 * @returns The query string, without the leading `?`.
 *
 * @example
 * ```ts
 * queryString([['path', '/a b'], ['upstream']]);
 * // 'path=%2Fa%20b&upstream'
 * ```
 */
export function queryString(params: Array<[string, string?]>): string {
  return params.map(([k, v]) => (v === undefined ? hexify(k) : `${hexify(k)}=${hexify(v)}`)).join('&');
}

/**
 * Converts a Git remote URL into the origin URL the archive knows it by.
 *
 * @remarks
 * The user name, the trailing slashes and the `.git` suffix are removed, and
 * the host is lowercased. `ssh://`, `git://` and scp-like `git@host:path`
 * URLs become `https://` ones, without their port, which is not the web
 * one. Local paths (including Windows drive paths) and `file://` URLs are
 * returned as they are: they are not public origins.
 *
 * @param url - A Git remote URL.
 * @returns The origin URL.
 *
 * @example
 * ```ts
 * normalizeOrigin('git@github.com:bzg/swh.el.git');     // 'https://github.com/bzg/swh.el'
 * normalizeOrigin('ssh://git@github.com:22/bzg/x.git'); // 'https://github.com/bzg/x'
 * normalizeOrigin('/srv/git/repo');                      // '/srv/git/repo'
 * ```
 */
export function normalizeOrigin(url: string): string {
  const strip = (u: string) => u.replace(/\/+$/, '').replace(/\.git$/i, '');
  let m = /^(https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:@]+)(:[0-9]+)?(\/.*)$/i.exec(url);
  if (m) {
    // ssh:// and git:// become https; their port is not the web one
    const scheme = m[1].toLowerCase();
    const convert = scheme !== 'http' && scheme !== 'https';
    return strip(`${convert ? 'https' : scheme}://${m[2].toLowerCase()}${convert ? '' : m[3] ?? ''}${m[4]}`);
  }
  if (!/^[a-z]:[/\\]/i.test(url)) {
    m = /^(?:[^@/:]+@)?([^@/:]+):([^:]+)$/.exec(url);
    if (m && !m[2].startsWith('//')) {
      return strip(`https://${m[1].toLowerCase()}/${m[2].replace(/^\/+/, '')}`);
    }
  }
  return url;
}

/**
 * Tells whether an origin is a public URL that Software Heritage can fetch.
 *
 * @param origin - An origin URL, as {@link normalizeOrigin} gives it, or nothing.
 * @returns `true` for an `http://` or `https://` URL.
 */
export const isPublicOrigin = (origin: string | undefined | null): origin is string =>
  !!origin && /^https?:\/\//i.test(origin);

/**
 * Gives the origin URLs to look up in the archive for a remote URL.
 *
 * @remarks
 * The archive may know a repository with or without its `.git` suffix, so a
 * public origin has two candidates, tried in order.
 *
 * @param url - A Git remote URL.
 * @returns The normalized origin, then the same with `.git`; only the
 * normalized one when it is not public.
 *
 * @example
 * ```ts
 * originCandidates('git@h.org:a/b'); // ['https://h.org/a/b', 'https://h.org/a/b.git']
 * originCandidates('/srv/repo');     // ['/srv/repo']
 * ```
 */
export function originCandidates(url: string): string[] {
  const n = normalizeOrigin(url);
  return isPublicOrigin(n) ? [n, n + '.git'] : [n];
}

/**
 * Encodes an origin URL for use as a segment of a Web API path.
 *
 * @remarks
 * Every character but the unreserved ones and the path characters
 * (`/:@!$&'()*+,;=`) is percent-encoded: a remote URL may hold `?`, `#`,
 * blanks or non-ASCII characters.
 *
 * @param origin - An origin URL.
 * @returns The encoded origin.
 *
 * @example
 * ```ts
 * pathOrigin('https://h/a b?c#d'); // 'https://h/a%20b%3Fc%23d'
 * ```
 */
export const pathOrigin = (origin: string) => hexify(origin, "/:@!$&'()*+,;=");

/**
 * Encodes an origin URL as the value of an `origin` qualifier.
 *
 * @remarks
 * Only `%`, `;` (the qualifier separator), blanks and control characters
 * are escaped, as swh.model and swhid-clj do.
 *
 * @param origin - An origin URL.
 * @returns The qualifier value.
 *
 * @example
 * ```ts
 * encodeOrigin('https://h/o r\tx\u00a0é'); // 'https://h/o%20r%09x%C2%A0é'
 * ```
 */
export function encodeOrigin(origin: string): string {
  return origin.replace(/[%;\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/gu, (c) => hexify(c));
}

/**
 * Encodes a path as the value of a `path` qualifier, as swh.model and
 * swhid-clj do.
 *
 * @param path - A path with `/` separators.
 * @returns The path with every character but `/` and the unreserved ones percent-encoded.
 */
export const encodePath = (path: string) => hexify(path, '/');

/**
 * Qualifies a core SWHID with its context.
 *
 * @remarks
 * The `origin` and `visit` qualifiers are added only for a public origin,
 * and the `path` qualifier only with an `anchor`, which it is relative to.
 * The qualifiers come in the order the SWHID specification gives.
 *
 * @param coreSwhid - The core SWHID to qualify.
 * @param origin - The origin URL; left out when it is not public.
 * @param snapshot - The hash of the snapshot of the origin's visit.
 * @param anchor - The SWHID of the commit (or release) holding the object.
 * @param rel - The object's path relative to the repository root, `"."` for the root.
 * @param lines - A line range, `"A-B"` or `"A"`.
 * @returns The qualified SWHID.
 *
 * @example
 * ```ts
 * qualify('swh:1:dir:d', 'https://h/r', 'aa', 'swh:1:rev:y', '.', '3-4');
 * // 'swh:1:dir:d;origin=https://h/r;visit=swh:1:snp:aa;anchor=swh:1:rev:y;path=/;lines=3-4'
 * ```
 */
export function qualify(
  coreSwhid: string,
  origin?: string | null,
  snapshot?: string | null,
  anchor?: string | null,
  rel?: string | null,
  lines?: string | null,
): string {
  const pub = isPublicOrigin(origin);
  let s = coreSwhid;
  if (pub) s += ';origin=' + encodeOrigin(origin);
  if (pub && snapshot) s += ';visit=' + core('snp', snapshot);
  if (anchor) s += ';anchor=' + anchor;
  if (anchor && rel) s += ';path=/' + (rel === '.' ? '' : encodePath(rel));
  if (lines) s += ';lines=' + lines;
  return s;
}

/**
 * Parses the qualifiers of a SWHID.
 *
 * @param swhid - A qualified SWHID.
 * @returns The qualifiers by name, their values percent-decoded; an empty
 * object for a core SWHID.
 *
 * @example
 * ```ts
 * qualifiers('swh:1:cnt:x;origin=https://h/o%20r;path=/src/my%20file%20%C3%A9.el');
 * // { origin: 'https://h/o r', path: '/src/my file é.el' }
 * ```
 */
export function qualifiers(swhid: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of swhid.split(';').slice(1)) {
    const pos = q.indexOf('=') < 0 ? q.length : q.indexOf('=');
    out[q.substring(0, pos)] = unhex(q.substring(Math.min(pos + 1, q.length)));
  }
  return out;
}

/**
 * Lists the directories above a path relative to the repository root.
 *
 * @param path - A relative path with `/` separators, or `"."` for the root.
 * @returns The ancestor directories from the root `"."` down; none for the root itself.
 *
 * @example
 * ```ts
 * ancestors('a/b/c.txt'); // ['.', 'a', 'a/b']
 * ancestors('.');         // []
 * ```
 */
export function ancestors(path: string): string[] {
  if (path === '.') return [];
  const acc = ['.'];
  let dir: Maybe<string>;
  for (const part of path.split('/').slice(0, -1)) {
    dir = dir ? `${dir}/${part}` : part;
    acc.push(dir);
  }
  return acc;
}

/**
 * Formats an ISO 8601 date in local time, for messages.
 *
 * @param date - An ISO 8601 date, as the archive gives it.
 * @returns The date as `YYYY-MM-DD HH:MM` in local time, or `date` unchanged
 * when it does not parse.
 */
export function formatDate(date: string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return date;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Gives the repository's name in an origin URL: its last path segment.
 *
 * @remarks
 * Splits on `\\` too, so that a local Windows path names its directory.
 *
 * @param origin - An origin URL, or a local path for a non-public remote.
 * @returns The last segment, without a `.git` suffix.
 *
 * @example
 * ```ts
 * originName('https://github.com/bzg/swh.el'); // 'swh.el'
 * ```
 */
export function originName(origin: string): string {
  const parts = origin.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1].replace(/\.git$/, '');
}

/**
 * Finds the SWHIDs in a text, with their qualifiers.
 *
 * @remarks
 * A SWHID ends at a blank, a quote, a backtick or a bracket. Trailing
 * punctuation (`.`, `,`, `:`, `;`) is left out, as it more likely ends the
 * sentence than the SWHID.
 *
 * @param text - The text to search, e.g. a whole document.
 * @returns `[offset, swhid]` pairs, `offset` being the SWHID's position in `text`.
 */
export function findSwhids(text: string): Array<[number, string]> {
  const re = /swh:1:(?:cnt|dir|rev|rel|snp|ori):[0-9a-f]{40}(?:;[^\s"'`<>()[\]{}]*)?/g;
  const out: Array<[number, string]> = [];
  for (const m of text.matchAll(re)) {
    out.push([m.index!, m[0].replace(/[.,:;]+$/, '')]);
  }
  return out;
}
