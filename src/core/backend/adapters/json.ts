/**
 * The mapping from the archive's JSON answers to the backend's own types.
 *
 * @remarks
 * Part of the HTTP implementation of `ArchiveApi` (see `httpArchiveApi.ts`).
 * The archive's JSON is not under our control: a field may be missing,
 * `null` or of another type. Each `Api*` type says what the answer may hold,
 * every field `unknown`; each `to*` function checks the fields it needs and
 * builds a value of the type the backend relies on. These functions are pure: they neither send
 * requests nor read settings.
 *
 * @packageDocumentation
 */

import { UserError } from '../../errors';
import type { Maybe } from '../../types';
import type { SaveRequest, Visit } from '../types';

/**
 * Whether a JSON value is an object, rather than a list, a scalar or `null`.
 *
 * @param raw - The value.
 * @returns `true` for an object.
 */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/**
 * The error raised for an answer that cannot be understood.
 *
 * @param what - What the request was about, e.g. `the save request`.
 * @returns The error.
 */
function unexpected(what: string): UserError {
  return new UserError(`Unexpected answer from the archive for ${what}`);
}

/** The answer of `/known/`, as the archive's API sends it: SWHID → `{ known }`. */
export type ApiKnown = Record<string, { known?: unknown } | null | undefined>;

/**
 * Adapts the archive's answer to a SWHID lookup.
 *
 * @param raw - The answer as the API sent it.
 * @returns Whether the archive holds each SWHID of the answer; anything but
 * `known: true` counts as not held.
 * @throws {@link UserError} when the answer is not an object.
 */
export function toKnown(raw: unknown): Map<string, boolean> {
  if (!isRecord(raw)) throw unexpected('the SWHID lookup');
  const answers = raw as ApiKnown;
  return new Map(Object.entries(answers).map(([swhid, answer]) => [swhid, answer?.known === true]));
}

/** A visit as the archive's API sends it: none of its fields is guaranteed. */
export type ApiVisit = {
  date?: unknown;
  status?: unknown;
  snapshot?: unknown;
};

/**
 * Adapts one visit of the archive's answer.
 *
 * @param raw - The visit as the API sent it.
 * @returns The visit, or `undefined` when it has no date or status as strings;
 * a snapshot that is not a string is left out.
 */
export function toVisit(raw: unknown): Maybe<Visit> {
  if (!isRecord(raw)) return undefined;
  const { date, status, snapshot } = raw as ApiVisit;
  if (typeof date !== 'string' || typeof status !== 'string') return undefined;
  return typeof snapshot === 'string' ? { date, status, snapshot } : { date, status };
}

/**
 * Adapts the archive's list of an origin's visits.
 *
 * @param raw - The list as the API sent it.
 * @returns The visits it holds, in its order; malformed visits are left out.
 * @throws {@link UserError} when the answer is not a list.
 */
export function toVisits(raw: unknown): Visit[] {
  if (!Array.isArray(raw)) throw unexpected("the origin's visits");
  return raw.map(toVisit).filter((visit): visit is Visit => visit !== undefined);
}

/** A save request as the archive's API sends it: none of its fields is guaranteed. */
export type ApiSaveRequest = {
  save_request_status?: unknown;
};

/**
 * Adapts the archive's answer to a save request.
 *
 * @param origin - The origin URL the request was sent for.
 * @param raw - The answer as the API sent it.
 * @returns The save request.
 * @throws {@link UserError} when the answer has no status as a string.
 */
export function toSaveRequest(origin: string, raw: unknown): SaveRequest {
  const status = isRecord(raw) ? (raw as ApiSaveRequest).save_request_status : undefined;
  if (typeof status !== 'string') throw unexpected('the save request');
  return { origin, status };
}

/** A citation as the archive's API sends it: none of its fields is guaranteed. */
export type ApiCitation = {
  content?: unknown;
};

/**
 * Adapts the archive's answer to a citation request.
 *
 * @param raw - The answer as the API sent it.
 * @returns The BibTeX entry, or `undefined` when the answer holds none.
 */
export function toCitationEntry(raw: unknown): Maybe<string> {
  const content = isRecord(raw) ? (raw as ApiCitation).content : undefined;
  return typeof content === 'string' ? content : undefined;
}
