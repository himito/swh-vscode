/**
 * Origins: the URLs the archive knows repositories by, and their encodings.
 *
 * @remarks
 * Every function here is pure: no I/O, no Git, no network. This module must
 * not import `vscode`.
 *
 * @packageDocumentation
 */

import { hexify } from './encoding';
import { UserError } from './errors';

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
  const strip = (candidate: string) => candidate.replace(/\/+$/, '').replace(/\.git$/i, '');
  let match = /^(https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:@]+)(:[0-9]+)?(\/.*)$/i.exec(url);
  if (match) {
    // ssh:// and git:// become https; their port is not the web one
    const scheme = match[1].toLowerCase();
    const convert = scheme !== 'http' && scheme !== 'https';
    return strip(`${convert ? 'https' : scheme}://${match[2].toLowerCase()}${convert ? '' : match[3] ?? ''}${match[4]}`);
  }
  if (!/^[a-z]:[/\\]/i.test(url)) {
    match = /^(?:[^@/:]+@)?([^@/:]+):([^:]+)$/.exec(url);
    if (match && !match[2].startsWith('//')) {
      return strip(`https://${match[1].toLowerCase()}/${match[2].replace(/^\/+/, '')}`);
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

/** A host name followed by a path, without a scheme: `github.com/owner/repo`. */
const SCHEMELESS_URL = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+\//u;

/** Characters no repository URL holds: blanks (a typo), a query or a fragment (a web page). */
const NON_REPOSITORY_CHARS = /[\s?#]/;

/**
 * Parses a repository URL typed by the user into an origin.
 *
 * @remarks
 * Surrounding blanks are ignored, and a URL without a scheme gets `https://`.
 * The URL is then normalized as the archive names origins (see
 * {@link normalizeOrigin}).
 *
 * @param input - What the user typed.
 * @returns The normalized origin.
 * @throws {@link UserError} when the input is empty, looks like a web page
 * rather than a repository, or is not a public URL.
 *
 * @example
 * ```ts
 * parseOrigin(' github.com/bzg/swh.el ');     // 'https://github.com/bzg/swh.el'
 * parseOrigin('git@github.com:bzg/swh.el');   // 'https://github.com/bzg/swh.el'
 * parseOrigin('https://github.com/bzg?tab=1'); // throws
 * ```
 */
export function parseOrigin(input: string): string {
  const url = input.trim();
  if (!url) throw new UserError('No origin');
  if (NON_REPOSITORY_CHARS.test(url)) throw new UserError(`Not a repository URL: ${url}`);

  const origin = normalizeOrigin(SCHEMELESS_URL.test(url) ? `https://${url}` : url);
  if (!isPublicOrigin(origin)) throw new UserError(`Not a public repository URL: ${url}`);
  return origin;
}

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
  const normalized = normalizeOrigin(url);
  return isPublicOrigin(normalized) ? [normalized, normalized + '.git'] : [normalized];
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
  return origin.replace(/[%;\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/gu, (char) => hexify(char));
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
