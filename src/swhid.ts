// SWHIDs, origins and their encodings: pure functions.

import { UserError } from './http';

export type ObjectType = 'cnt' | 'dir' | 'rev' | 'rel' | 'snp';

/** Core SWHID of TYPE for HASH, a SHA-1. */
export function core(type: ObjectType, hash: string): string {
  if (hash.length > 40) {
    throw new UserError('SWHIDs are SHA-1 based: this repository uses SHA-256');
  }
  return `swh:1:${type}:${hash}`;
}

/** The object type of SWHID, e.g. "cnt". */
export const typeOf = (swhid: string) => swhid.substring(6, 9);
/** The hash of the core SWHID. */
export const hashOf = (swhid: string) => swhid.substring(10);
/** The first seven digits of the hash of SWHID. */
export const shortHash = (swhid: string) => swhid.substring(10, 17);

/** SWHID with its hash cut to its first ten digits. */
export function shortSwhid(swhid: string): string {
  return swhid.replace(/^(swh:1:[a-z]{3}:[0-9a-f]{10})[0-9a-f]*/, '$1');
}

/** URL, a base URL option, without its trailing slashes. */
export const baseUrl = (url: string) => url.replace(/\/+$/, '');

/** URL of SWHID in the archive's web interface. */
export const browseUrl = (archiveUrl: string, swhid: string) => `${baseUrl(archiveUrl)}/${swhid}`;

const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~';

/** STR with every character but ALLOWED ones percent-encoded, as UTF-8. */
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

/** STR with its %XX sequences decoded, as UTF-8. */
export function unhex(str: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const m = /^%([0-9a-fA-F]{2})/.exec(str.substring(i, i + 3));
    if (m) {
      bytes.push(parseInt(m[1], 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(str[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/** A query string of [KEY, VALUE] or [KEY] PARAMS. */
export function queryString(params: Array<[string, string?]>): string {
  return params.map(([k, v]) => (v === undefined ? hexify(k) : `${hexify(k)}=${hexify(v)}`)).join('&');
}

/**
 * The Git remote URL in the archive's form: no user, slash or ".git" suffix.
 * ssh://, git:// and "git@host:path" URLs become https ones; local paths
 * and file:// URLs are returned as is.
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

/** Whether ORIGIN is a public URL Software Heritage can fetch. */
export const isPublicOrigin = (origin: string | undefined | null): origin is string =>
  !!origin && /^https?:\/\//i.test(origin);

/** Origin URLs to look up for the remote URL: normalized, then with ".git". */
export function originCandidates(url: string): string[] {
  const n = normalizeOrigin(url);
  return isPublicOrigin(n) ? [n, n + '.git'] : [n];
}

/** ORIGIN as it goes in a Web API path: all but its pchars percent-encoded. */
export const pathOrigin = (origin: string) => hexify(origin, "/:@!$&'()*+,;=");

/** ORIGIN as a qualifier value: "%", ";", blanks and controls escaped. */
export function encodeOrigin(origin: string): string {
  return origin.replace(/[%;\p{Zs}\p{Zl}\p{Zp}\p{Cc}]/gu, (c) => hexify(c));
}

/** PATH as a qualifier value, as the daemon and swh.model encode it. */
export const encodePath = (path: string) => hexify(path, '/');

/** CORE qualified with ORIGIN when public, SNAPSHOT, ANCHOR, REL and LINES. */
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

/** The qualifiers of SWHID, decoded. */
export function qualifiers(swhid: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const q of swhid.split(';').slice(1)) {
    const pos = q.indexOf('=') < 0 ? q.length : q.indexOf('=');
    out[q.substring(0, pos)] = unhex(q.substring(Math.min(pos + 1, q.length)));
  }
  return out;
}

/** The directories above the relative PATH, the root "." first. */
export function ancestors(path: string): string[] {
  if (path === '.') return [];
  const acc = ['.'];
  let dir: string | undefined;
  for (const part of path.split('/').slice(0, -1)) {
    dir = dir ? `${dir}/${part}` : part;
    acc.push(dir);
  }
  return acc;
}

/** The ISO 8601 DATE in local time, as is when it does not parse. */
export function formatDate(date: string): string {
  const d = new Date(date);
  if (isNaN(d.getTime())) return date;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The repository's name in the URL ORIGIN, e.g. swh.el. */
export function originName(origin: string): string {
  const parts = origin.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1].replace(/\.git$/, '');
}

/** Whether VERSION (0.9.0-dev counts as 0.9.0) is MIN or later. */
export function versionAtLeast(version: unknown, min: string): boolean {
  if (typeof version !== 'string') return false;
  const m = /^[0-9]+(\.[0-9]+)*/.exec(version);
  if (!m) return false;
  const a = m[0].split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** The SWHIDs of a text, with their qualifiers: [start, swhid]. */
export function findSwhids(text: string): Array<[number, string]> {
  const re = /swh:1:(?:cnt|dir|rev|rel|snp|ori):[0-9a-f]{40}(?:;[^\s"'`<>()[\]{}]*)?/g;
  const out: Array<[number, string]> = [];
  for (const m of text.matchAll(re)) {
    out.push([m.index!, m[0].replace(/[.,:;]+$/, '')]);
  }
  return out;
}
