/**
 * Small helpers on paths, dates, time and arrays.
 *
 * @remarks
 * This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import type { Maybe } from './types';

/**
 * The current time.
 *
 * @returns The number of seconds since the epoch.
 */
export const now = () => Date.now() / 1000;

/**
 * The distinct elements of an array, in their first order.
 *
 * @param xs - The array.
 * @returns A new array without duplicates.
 */
export const uniq = <T>(xs: readonly T[]) => [...new Set(xs)];

/**
 * Splits an array into consecutive batches.
 *
 * @param xs - The array.
 * @param size - The size of each batch; the last one may be shorter.
 * @returns The batches, in order.
 *
 * @example
 * ```ts
 * partition([1, 2, 3, 4, 5], 2); // [[1, 2], [3, 4], [5]]
 * ```
 */
export function partition<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < xs.length; start += size) out.push(xs.slice(start, start + size));
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
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) return date;
  const twoDigits = (part: number) => String(part).padStart(2, '0');
  const day = `${parsed.getFullYear()}-${twoDigits(parsed.getMonth() + 1)}-${twoDigits(parsed.getDate())}`;
  const time = `${twoDigits(parsed.getHours())}:${twoDigits(parsed.getMinutes())}`;
  return `${day} ${time}`;
}
