/**
 * The implementation of {@link ArchiveApi} over the archive's Web API.
 *
 * @remarks
 * {@link HttpArchiveApi} turns each question of the interface into a request to
 * the archive's Web API (`/api/1`), and its answer back into the backend's
 * types (see `json.ts`). Everything about HTTP stays here: URLs, headers, the
 * API token, status codes, the size of the batches, and the tokenless rate
 * limit, read from the answers' `X-RateLimit-*` headers.
 *
 * @packageDocumentation
 */

import { UserError } from '../../errors';
import { headerNumber, is2xx, NOT_JSON, type Resp, retrieve } from '../../http';
import { baseUrl, queryString } from '../../encoding';
import { pathOrigin } from '../../origin';
import type { Maybe } from '../../types';
import { now, partition } from '../memo';
import { type ArchiveApi, type CitationTarget, type LatestVisit, RATE_LIMIT_MESSAGE, type RateLimit } from '../archiveApi';
import type { CitationAnswer, SaveRequest, Token, Visit } from '../types';
import { toCitationEntry, toKnown, toSaveRequest, toVisit, toVisits } from './json';

/** The most SWHIDs one `/known/` request may ask about, as the archive allows. */
export const KNOWN_BATCH_SIZE = 1000;

/** The seconds to wait for an answer of the archive. */
const TIMEOUT = 60;

/**
 * What {@link HttpArchiveApi} needs from its host: settings and callbacks.
 *
 * @remarks
 * The extension passes functions that read VS Code's settings and secret
 * storage; the tests pass fixed values.
 */
export type HttpArchiveDeps = {
  /** The archive's web root, e.g. `https://archive.softwareheritage.org`; read at each request. */
  archiveUrl(): string;
  /** The API token to send with each request. */
  token(): Promise<Token>;
  /** Called whenever the tokenless rate limit is updated, see {@link HttpArchiveApi.rateLimit}. */
  onRateLimit?(): void;
};

/** {@link ArchiveApi}, over the archive's Web API. */
export class HttpArchiveApi implements ArchiveApi {
  /**
   * The tokenless rate limit, from the headers of the latest anonymous
   * request, and the API it is of; `undefined` until one is made, and again
   * once a request is made with a token.
   */
  private lastRateLimit?: {
    /** The API it is of, as {@link HttpArchiveApi.apiUrl} gives its root. */
    api: string;
    /** The rate limit. */
    limit: RateLimit;
  };

  /**
   * Creates the implementation.
   *
   * @param deps - Its settings and callbacks.
   */
  constructor(private readonly deps: HttpArchiveDeps) { }

  // ---------------------------------------------------------------- ArchiveApi

  /**
   * Which SWHIDs the archive holds, from its `/known/` endpoint.
   *
   * @remarks
   * Asks {@link KNOWN_BATCH_SIZE} SWHIDs per request.
   *
   * @param swhids - Core SWHIDs.
   * @returns Whether the archive holds each SWHID it answered about.
   * @throws {@link UserError} as {@link ArchiveApi} says.
   */
  async known(swhids: readonly string[]): Promise<Map<string, boolean>> {
    const answers = new Map<string, boolean>();
    for (const batch of partition([...swhids], KNOWN_BATCH_SIZE)) {
      const body = this.body(await this.request('POST', '/known/', JSON.stringify(batch)), 'the SWHID lookup');
      for (const [swhid, known] of toKnown(body)) answers.set(swhid, known);
    }
    return answers;
  }

  /**
   * The latest visit of an origin that took a snapshot.
   *
   * @param origin - The origin URL.
   * @returns The visit; not archived when the archive answers 404.
   * @throws {@link UserError} as {@link ArchiveApi} says.
   */
  async latestVisit(origin: string): Promise<LatestVisit> {
    const resp = await this.request('GET', `/origin/${pathOrigin(origin)}/visit/latest/?require_snapshot=true`);
    if (resp.status === 404) return { archived: false };
    return { archived: true, visit: toVisit(this.body(resp, "the origin's visits")) };
  }

  /**
   * The latest visits of an origin.
   *
   * @param origin - The origin URL.
   * @param count - How many visits to give, at most.
   * @returns The visits, most recent first.
   * @throws {@link UserError} as {@link ArchiveApi} says.
   */
  async visits(origin: string, count: number): Promise<Visit[]> {
    const resp = await this.request('GET', `/origin/${pathOrigin(origin)}/visits/?per_page=${count}`);
    return toVisits(this.body(resp, "the origin's visits"));
  }

  /**
   * Asks the archive to save a Git repository now.
   *
   * @param origin - The repository's public URL.
   * @returns The save request; a refused one is an HTTP 403, an error.
   * @throws {@link UserError} as {@link ArchiveApi} says.
   */
  async save(origin: string): Promise<SaveRequest> {
    const resp = await this.request('POST', `/origin/save/git/url/${pathOrigin(origin)}/`);
    return toSaveRequest(origin, this.body(resp, 'the save request'));
  }

  /**
   * A BibTeX entry citing a SWHID or an origin.
   *
   * @param target - What to cite.
   * @returns The entry; `'no-metadata'` when the archive answers 400 or 404,
   * `'failed'` for any other error or an answer without an entry.
   * @throws {@link UserError} when the archive cannot be reached, or its rate
   * limit is reached.
   */
  async citation(target: CitationTarget): Promise<CitationAnswer> {
    const [kind, param, value] = 'swhid' in target ? ['swhid', 'target_swhid', target.swhid] : ['origin', 'origin_url', target.origin];
    const query = queryString([
      ['citation_format', 'bibtex'],
      [param, value],
    ]);
    const resp = await this.request('GET', `/raw-intrinsic-metadata/citation/${kind}/?${query}`);
    const entry = is2xx(resp) ? toCitationEntry(resp.body) : undefined;
    if (entry !== undefined) return { entry };
    if (resp.status === 400 || resp.status === 404) return 'no-metadata';
    return 'failed';
  }

  /**
   * The tokenless rate limit, from the headers of the latest anonymous request.
   *
   * @returns The rate limit, or `undefined` until an anonymous request is
   * made, after a request with a token, or when it is of another archive
   * than the current `archiveUrl`.
   */
  rateLimit(): Maybe<RateLimit> {
    const last = this.lastRateLimit;
    return last && last.api === this.apiUrl('') ? last.limit : undefined;
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * The URL of a path of the archive's Web API.
   *
   * @param apiPath - The path, starting with `/`, e.g. `/known/`.
   * @returns The full URL, e.g. `https://archive.softwareheritage.org/api/1/known/`.
   */
  private apiUrl(apiPath: string): string {
    return baseUrl(this.deps.archiveUrl()) + '/api/1' + apiPath;
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
  private async headers(body?: string): Promise<Record<string, string>> {
    const token = await this.deps.token();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /**
   * Sends a request to the archive's Web API.
   *
   * @remarks
   * A request without a token counts against the tokenless rate limit, which
   * is then read from the answer's headers.
   *
   * @param method - The HTTP method.
   * @param apiPath - The API path, e.g. `/known/`.
   * @param body - The JSON body, if any.
   * @returns The response, whatever its status but 429.
   * @throws {@link UserError} when the archive cannot be reached, or when the
   * rate limit is reached.
   */
  private async request(method: string, apiPath: string, body?: string): Promise<Resp> {
    const headers = await this.headers(body);
    const resp = await retrieve(method, this.apiUrl(apiPath), body, headers, TIMEOUT);
    if (!resp) throw new UserError(`Cannot reach the Software Heritage archive at ${this.deps.archiveUrl()}`);
    if (headers.Authorization) this.forgetRateLimit();
    else this.trackRateLimit(resp);
    if (resp.status === 429) throw new UserError(`${RATE_LIMIT_MESSAGE}; retry in ${resp.retryAfter ?? 'a few'} seconds`);
    return resp;
  }

  /**
   * Reads the tokenless rate limit from an answer's `X-RateLimit-*` headers.
   *
   * @param resp - The answer to a request without a token.
   */
  private trackRateLimit(resp: Resp): void {
    const limit = headerNumber(resp.headers, 'X-RateLimit-Limit');
    const remaining = headerNumber(resp.headers, 'X-RateLimit-Remaining');
    if (limit === undefined || remaining === undefined) return;
    this.lastRateLimit = {
      api: this.apiUrl(''),
      limit: { used: limit - remaining, limit, reset: headerNumber(resp.headers, 'X-RateLimit-Reset') ?? now() + 3600 },
    };
    this.deps.onRateLimit?.();
  }

  /**
   * Forgets the tokenless rate limit, once requests are made with a token:
   * it no longer applies to them.
   */
  private forgetRateLimit(): void {
    if (!this.lastRateLimit) return;
    this.lastRateLimit = undefined;
    this.deps.onRateLimit?.();
  }

  /**
   * The parsed body of a successful answer.
   *
   * @param resp - The answer.
   * @param what - What the request was about, for the error message, e.g. `the save request`.
   * @returns The parsed JSON body, still to be checked (see `json.ts`).
   * @throws {@link UserError} when the status is not 2xx (with the archive's
   * reason, if it gives one), or when the body is not JSON.
   */
  private body(resp: Resp, what: string): unknown {
    if (!is2xx(resp)) {
      const reason: unknown = resp.body && typeof resp.body === 'object' ? resp.body.reason : undefined;
      const about = typeof reason === 'string' ? `${what}: ${reason}` : what;
      throw new UserError(`The Software Heritage archive answered HTTP ${resp.status} (${about})`);
    }
    if (resp.body === NOT_JSON) throw new UserError(`The Software Heritage archive answered no JSON (${what})`);
    return resp.body;
  }
}
