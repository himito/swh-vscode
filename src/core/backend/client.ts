/**
 * The first layer of {@link Swh}: requests to the archive's Web API and to
 * swhd, and the tokenless rate limit.
 *
 * @packageDocumentation
 */

import { Git } from '../git';
import { NOT_JSON, Resp, UserError, is2xx, headerNumber, retrieve } from '../http';
import { baseUrl, queryString, versionAtLeast } from '../swhid';
import { fresh, now } from './memo';
import type { SwhDeps } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The oldest swhd version the extension works with; an older daemon is ignored. */
export const DAEMON_MIN_VERSION = '0.8.0';

/**
 * Seconds to wait for an answer of swhd in the background.
 *
 * @remarks
 * The daemon may itself make three calls of 60 seconds to the archive.
 */
const DAEMON_TIMEOUT = 190;

/**
 * The start of the {@link UserError} message raised when the API's rate
 * limit is reached; callers test for it to tell that failure apart.
 */
export const RATE_LIMIT_MESSAGE = 'Software Heritage API rate limit reached';

/** Requests to the archive and to swhd; see {@link Swh}. */
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
  /** The latest ping of swhd, and when it was sent; see {@link Swh.daemonPong}. */
  protected daemonChecked?: { time: number; pong: Promise<any | null> };
  /** Whether the user has been warned that swhd is too old; they are warned once. */
  private daemonOutdatedWarned = false;
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
  private async retrieve(method: string, url: string, body: string | undefined, headers: Record<string, string>, timeout = 60) {
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
  rateLimitText(): string | undefined {
    const r = this.rateLimit;
    return r && now() < r.reset ? `${r.used}/${r.limit}` : undefined;
  }

  /**
   * The headers of a request to the archive or to swhd.
   *
   * @remarks
   * The token, when there is one, goes as a bearer token; swhd receives it
   * too, unencrypted, which is why its URL should stay local.
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

  // ---------------------------------------------------------------- daemon

  /**
   * swhd's base URL, without trailing slashes.
   *
   * @returns The URL, or an empty string when the daemon is disabled.
   */
  private daemonBase() {
    return baseUrl(this.deps.daemonUrl().trim());
  }

  /**
   * Ping swhd.
   *
   * @remarks
   * The ping waits two seconds at most. A daemon older than
   * {@link DAEMON_MIN_VERSION} counts as absent, and the user is warned
   * once.
   *
   * @returns The daemon's answer to `/ping`, or `null` when it is disabled,
   * does not answer, or is too old.
   */
  private async daemonPing(): Promise<any | null> {
    if (!this.daemonBase()) return null;
    const resp = await this.retrieve('GET', this.daemonBase() + '/ping', undefined, {}, 2);
    if (!resp || resp.status !== 200) return null;
    const pong = resp.body;
    if (versionAtLeast(pong?.version, DAEMON_MIN_VERSION)) return pong;
    if (!this.daemonOutdatedWarned) {
      this.daemonOutdatedWarned = true;
      this.deps.warn(
        `swhd ${typeof pong?.version === 'string' ? pong.version : '< 0.2.0'} is older than ${DAEMON_MIN_VERSION}; going without it`,
      );
    }
    return null;
  }

  /**
   * swhd's answer to `/ping`, remembered for 30 seconds.
   *
   * @remarks
   * The promise itself is remembered, so concurrent callers share one ping.
   *
   * @returns The answer, e.g. `{ pong: true, version: '0.10.0', authenticated: true }`,
   * or `null` when the daemon is not usable.
   */
  daemonPong(): Promise<any | null> {
    if (!this.daemonChecked || !fresh(this.daemonChecked.time, 30)) {
      this.daemonChecked = { time: now(), pong: this.daemonPing() };
    }
    return this.daemonChecked.pong;
  }

  /**
   * Whether to go through swhd.
   *
   * @returns `true` when the daemon answers and is recent enough, see {@link Swh.daemonPong}.
   */
  async daemonAvailable(): Promise<boolean> {
    return !!(await this.daemonPong());
  }

  /**
   * Send a request to swhd.
   *
   * @param method - The HTTP method.
   * @param route - The daemon's route, e.g. `/origin`.
   * @param opts - The request's details.
   * @param opts.path - The local file or repository the request is about, sent as the `path` parameter.
   * @param opts.params - More query parameters: `[key, value]`, or `[key]` for a flag.
   * @param opts.body - The JSON body, if any.
   * @param opts.timeout - Seconds to wait; {@link DAEMON_TIMEOUT} by default.
   * @returns The parsed body of the daemon's 2xx answer.
   * @throws {@link UserError} when the daemon cannot be reached or answers an
   * error, see {@link Swh.daemonAnswer}.
   */
  async daemon(
    method: string,
    route: string,
    opts: { path?: string; params?: Array<[string, string?]>; body?: string; timeout?: number } = {},
  ): Promise<any> {
    const params: Array<[string, string?]> = [...(opts.path ? [['path', opts.path] as [string, string]] : []), ...(opts.params ?? [])];
    const q = queryString(params);
    const url = this.daemonBase() + route + (q ? '?' + q : '');
    const resp = await this.retrieve(method, url, opts.body, await this.apiHeaders(opts.body), opts.timeout ?? DAEMON_TIMEOUT);
    return this.daemonAnswer(method, route, resp);
  }

  /**
   * The body of swhd's answer, or the error it tells.
   *
   * @param method - The HTTP method of the request.
   * @param route - The route of the request.
   * @param resp - The daemon's response, or `null` when it did not answer.
   * @returns The parsed body, when the status is 2xx.
   * @throws {@link UserError} when the daemon is gone (it is then pinged
   * again at the next request), answers no JSON, is rate-limited, does not
   * know the route, relays an error of the archive, or reports an error of
   * its own.
   */
  private async daemonAnswer(method: string, route: string, resp: Resp | null): Promise<any> {
    if (!resp) {
      // gone: ping it again next time
      this.daemonChecked = undefined;
      throw new UserError(`Cannot reach swhd at ${this.deps.daemonUrl()}, or it is too slow (is it still running?)`);
    }
    const body = resp.body;
    const upstream = body && typeof body === 'object' ? body['upstream-status'] : undefined;
    if (body === NOT_JSON) throw new UserError(`Invalid response from swhd (HTTP ${resp.status}, not JSON)`);
    if (is2xx(resp)) return body;
    if (resp.status === 429) this.rateLimited(body?.['retry-after']);
    if (resp.status === 404) throw new UserError(`Unknown to swhd, ${method} ${route} (needs swhd ${DAEMON_MIN_VERSION})`);
    if (upstream) this.archiveAnswered(upstream, body?.error);
    if (body?.error) throw new UserError(String(body.error));
    throw new UserError(`Unexpected response from swhd: ${resp.status}`);
  }
}
