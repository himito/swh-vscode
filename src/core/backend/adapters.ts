/**
 * Adapters from the archive's API answers to the backend's own types.
 *
 * @remarks
 * The archive's JSON is not under our control: a field may be missing, `null`
 * or of another type. Each adapter checks the fields it needs and builds a
 * value of the type the rest of the code relies on.
 *
 * @packageDocumentation
 */

import { UserError } from '../http';
import type { Maybe } from '../types';
import type { SaveRequest, Visit } from './types';

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
  if (typeof raw !== 'object' || raw === null) return undefined;
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
  if (!Array.isArray(raw)) throw new UserError("Unexpected answer from the archive for the origin's visits");
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
  const status = typeof raw === 'object' && raw !== null ? (raw as ApiSaveRequest).save_request_status : undefined;
  if (typeof status !== 'string') throw new UserError('Unexpected answer from the archive for the save request');
  return { origin, status };
}
