/**
 * The first layer of {@link Swh}: requests to the archive's Web API, and
 * the tokenless rate limit.
 *
 * @packageDocumentation
 */

import { Git } from '../git';
import { NOT_JSON, Resp, UserError, is2xx, headerNumber, retrieve } from '../http';
import { baseUrl } from '../swhid';
import { now } from './memo';
import type { SwhDeps } from './types';
import type { Maybe } from '../types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The start of the {@link UserError} message raised when the API's rate
 * limit is reached; callers test for it to tell that failure apart.
 */
export const RATE_LIMIT_MESSAGE = 'Software Heritage API rate limit reached';

/** Requests to the archive; see {@link Swh}. */
export class SwhClient {
  /**
   * The API's tokenless rate limit, from the headers of the latest anonymous
   * request; `undefined` until one is made.
   */
  rateLimit?: {
    /** Requests made in the current window. */
    used: number;
    /** Requests allowed per window. */
    limit: number;
    /** When the window ends, in epoch seconds. */
    reset: number;
  };
  /** The Git runner, shared with the rest of the extension. */
  readonly git: Git;

  /**
   * Create the client.
   *
   * @param deps - Its settings and callbacks.
   */
  constructor(protected deps: SwhDeps) {
    this.git = deps.git;
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * The URL of a path of the archive's Web API.
   *
   * @param p - The path, starting with `/`, e.g. `/known/`.
   * @returns The full URL, e.g. `https://archive.softwareheritage.org/api/1/known/`.
   */
  apiUrl(p: string) {
    return baseUrl(this.deps.archiveUrl()) + '/api/1' + p;
  }

  /**
   * Send a request, and track the rate limit of anonymous API requests.
   *
   * @remarks
   * Only requests to the archive's API without a token count against the
   * tokenless rate limit; {@link Swh.rateLimit} is updated from their
   * `X-RateLimit-*` headers.
   *
   * @param method - The HTTP method.
   * @param url - The URL.
   * @param body - The JSON body, if any.
   * @param headers - The request headers.
   * @param timeout - Seconds to wait for the answer.
   * @returns The response, or `null` when the server cannot be reached in time.
   */
  private async retrieve(method: string, url: string, body: Maybe<string>, headers: Record<string, string>, timeout = 60) {
    const tracked = url.startsWith(this.apiUrl('')) && !headers.Authorization;
    const resp = await retrieve(method, url, body, headers, timeout);
    if (resp && tracked) {
      const limit = headerNumber(resp.headers, 'X-RateLimit-Limit');
      const remaining = headerNumber(resp.headers, 'X-RateLimit-Remaining');
      if (limit !== undefined && remaining !== undefined) {
        this.rateLimit = {
          used: limit - remaining,
          limit,
          reset: headerNumber(resp.headers, 'X-RateLimit-Reset') ?? now() + 3600,
        };
        this.deps.onRateLimit?.();
      }
    }
    return resp;
  }

  /**
   * The tokenless rate limit, for display.
   *
   * @returns `used/limit`, e.g. `48/120`, or `undefined` when not known or
   * when its window has ended.
   */
  rateLimitText(): Maybe<string> {
    const r = this.rateLimit;
    return r && now() < r.reset ? `${r.used}/${r.limit}` : undefined;
  }

  /**
   * The headers of a request to the archive.
   *
   * @remarks
   * The token, when there is one, goes as a bearer token.
   *
   * @param body - The JSON body, if any: it adds a `Content-Type` header.
   * @returns The headers.
   */
  private async apiHeaders(body?: string): Promise<Record<string, string>> {
    const token = await this.deps.token();
    const h: Record<string, string> = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  /**
   * Signal that the rate limit is reached.
   *
   * @param retryAfter - Seconds until requests are allowed again, if known.
   * @throws {@link UserError} always, starting with {@link RATE_LIMIT_MESSAGE}.
   */
  private rateLimited(retryAfter: unknown): never {
    throw new UserError(`${RATE_LIMIT_MESSAGE}; retry in ${retryAfter ?? 'a few'} seconds`);
  }

  /**
   * Signal that the archive answered with an error.
   *
   * @param status - The HTTP status of the archive's answer.
   * @param about - What the request was about, and the archive's reason if any.
   * @throws {@link UserError} always.
   */
  private archiveAnswered(status: unknown, about: unknown): never {
    throw new UserError(`The Software Heritage archive answered HTTP ${status} (${about})`);
  }

  /**
   * Send a request to the archive's Web API.
   *
   * @param method - The HTTP method.
   * @param p - The API path, e.g. `/known/`.
   * @param body - The JSON body, if any.
   * @returns The response, whatever its status but 429.
   * @throws {@link UserError} when the archive cannot be reached, or when the
   * rate limit is reached.
   */
  async api(method: string, p: string, body?: string): Promise<Resp> {
    const resp = await this.retrieve(method, this.apiUrl(p), body, await this.apiHeaders(body));
    if (!resp) throw new UserError(`Cannot reach the Software Heritage archive at ${this.deps.archiveUrl()}`);
    if (resp.status === 429) this.rateLimited(resp.retryAfter);
    return resp;
  }

  /**
   * The parsed body of a successful API response.
   *
   * @param resp - The response.
   * @param what - What the request was about, for the error message, e.g. `the save request`.
   * @returns The parsed JSON body.
   * @throws {@link UserError} when the status is not 2xx (with the archive's
   * reason, if it gives one), or when the body is not JSON.
   */
  apiBody(resp: Resp, what: string): any {
    if (!is2xx(resp)) {
      const reason = resp.body && typeof resp.body === 'object' ? resp.body.reason : undefined;
      this.archiveAnswered(resp.status, typeof reason === 'string' ? `${what}: ${reason}` : what);
    }
    if (resp.body === NOT_JSON) throw new UserError(`The Software Heritage archive answered no JSON (${what})`);
    return resp.body;
  }
}
