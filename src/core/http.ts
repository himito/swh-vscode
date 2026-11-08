/**
 * HTTP requests.
 *
 * @remarks
 * Requests go through the global `fetch`, and come back as a {@link Resp}
 * with the body already parsed as JSON. This module must not import
 * `vscode`, so that the unit tests can run it with Node alone, and replace
 * `fetch` with a fake archive.
 *
 * @packageDocumentation
 */

import type { Maybe } from './types';

/**
 * The {@link Resp.body} of a response whose body is not JSON.
 *
 * @remarks
 * A symbol, so that it cannot be confused with any JSON value, `null` included.
 */
export const NOT_JSON = Symbol('not-json');

/** An HTTP response, as {@link retrieve} gives it. */
export type Resp = {
  /** The HTTP status code. */
  status: number;
  /** The parsed JSON body, or {@link NOT_JSON} when the body is not JSON. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  /** The seconds to wait before retrying, from the `Retry-After` header, if any. */
  retryAfter?: number;
  /** The response headers, e.g. for the rate limit. */
  headers: Headers;
};

/**
 * Reads the number at the start of a header.
 *
 * @param headers - The response headers.
 * @param name - The header name, e.g. `X-RateLimit-Remaining`.
 * @returns The number the header's value starts with, or `undefined` when
 * the header is missing or does not start with a number.
 */
export function headerNumber(headers: Headers, name: string): Maybe<number> {
  const match = /^ *([0-9]+)/.exec(headers.get(name) ?? '');
  return match ? Number(match[1]) : undefined;
}

/**
 * Tells whether a request succeeded.
 *
 * @param resp - A response, or `undefined` when the server could not be reached.
 * @returns `true` when there is a response and its status is 2xx.
 */
export function is2xx(resp: Maybe<Resp>): boolean {
  return !!resp && resp.status >= 200 && resp.status <= 299;
}

/**
 * Sends an HTTP request and reads its response.
 *
 * @remarks
 * Never throws: a network failure, a refused connection or a timeout all
 * give `undefined`. An HTTP error status is a response like any other: it is up
 * to the caller to check it, e.g. with {@link is2xx}.
 *
 * @param method - The HTTP method, e.g. `GET`.
 * @param url - The URL to request.
 * @param body - The request body, a JSON string, if any.
 * @param headers - The request headers.
 * @param timeout - The seconds to wait for the whole response, body included.
 * @returns The response, or `undefined` when `url` cannot be reached within `timeout` seconds.
 * @defaultValue `timeout` is 60 seconds.
 */
export async function retrieve(
  method: string,
  url: string,
  body: Maybe<string>,
  headers: Record<string, string>,
  timeout = 60,
): Promise<Maybe<Resp>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout * 1000);

  try {
    const response = await fetch(url, { method, body, headers, signal: ctrl.signal });
    const text = await response.text();

    let parsed: unknown = NOT_JSON;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }

    return {
      status: response.status,
      body: parsed,
      retryAfter: headerNumber(response.headers, 'Retry-After'),
      headers: response.headers,
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
