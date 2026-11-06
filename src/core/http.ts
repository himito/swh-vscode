/**
 * HTTP requests, and the error types the extension uses.
 *
 * @remarks
 * Requests go through the global `fetch`, and come back as a {@link Resp}
 * with the body already parsed as JSON. This module must not import
 * `vscode`, so that the unit tests can run it with Node alone, and replace
 * `fetch` with a fake archive.
 *
 * @packageDocumentation
 */

/**
 * The {@link Resp.body} of a response whose body is not JSON.
 *
 * @remarks
 * A symbol, so that it cannot be confused with any JSON value, `null` included.
 */
export const NOT_JSON = Symbol('not-json');

/**
 * An error whose message is meant for the user, shown as is.
 *
 * @remarks
 * Throw it for every expected failure (no repository, no remote, archive
 * unreachable, rate limit reached…), with a message that says what went
 * wrong in plain words. Commands show it as a warning; any other error is
 * reported as an unexpected failure.
 */
export class UserError extends Error {
  /**
   * Creates the error.
   *
   * @param message - What went wrong, in words for the user.
   */
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * The error thrown when the user dismisses a prompt.
 *
 * @remarks
 * Commands stop silently on it: there is nothing to report.
 */
export class Cancelled extends Error {
  /** Creates the error. */
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

/** An HTTP response, as {@link retrieve} gives it. */
export interface Resp {
  /** The HTTP status code. */
  status: number;
  /** The parsed JSON body, or {@link NOT_JSON} when the body is not JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /** The seconds to wait before retrying, from the `Retry-After` header, if any. */
  retryAfter?: number;
  /** The response headers, e.g. for the rate limit. */
  headers: Headers;
}

/**
 * Reads the number at the start of a header.
 *
 * @param headers - The response headers.
 * @param name - The header name, e.g. `X-RateLimit-Remaining`.
 * @returns The number the header's value starts with, or `undefined` when
 * the header is missing or does not start with a number.
 */
export function headerNumber(headers: Headers, name: string): number | undefined {
  const m = /^ *([0-9]+)/.exec(headers.get(name) ?? '');
  return m ? Number(m[1]) : undefined;
}

/**
 * Tells whether a request succeeded.
 *
 * @param resp - A response, or nothing when the server could not be reached.
 * @returns `true` when there is a response and its status is 2xx.
 */
export function is2xx(resp: Resp | null | undefined): boolean {
  return !!resp && resp.status >= 200 && resp.status <= 299;
}

/**
 * Sends an HTTP request and reads its response.
 *
 * @remarks
 * Never throws: a network failure, a refused connection or a timeout all
 * give `null`. An HTTP error status is a response like any other: it is up
 * to the caller to check it, e.g. with {@link is2xx}.
 *
 * @param method - The HTTP method, e.g. `GET`.
 * @param url - The URL to request.
 * @param body - The request body, a JSON string, if any.
 * @param headers - The request headers.
 * @param timeout - The seconds to wait for the whole response, body included.
 * @returns The response, or `null` when `url` cannot be reached within `timeout` seconds.
 * @defaultValue `timeout` is 60 seconds.
 */
export async function retrieve(
  method: string,
  url: string,
  body: string | undefined,
  headers: Record<string, string>,
  timeout = 60,
): Promise<Resp | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);
  try {
    const r = await fetch(url, { method, body, headers, signal: ctrl.signal });
    const text = await r.text();
    let parsed: unknown = NOT_JSON;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: r.status, body: parsed, retryAfter: headerNumber(r.headers, 'Retry-After'), headers: r.headers };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
