// HTTP, without VS Code: a response is {status, body, retryAfter, headers}.

/** The body of a response that is not JSON. */
export const NOT_JSON = Symbol('not-json');

/** An error to show the user as is: what went wrong, in words. */
export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserError';
  }
}

/** The user dismissed a prompt: nothing to report. */
export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

export interface Resp {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  retryAfter?: number;
  headers: Headers;
}

/** The number at the start of the header NAME, or undefined. */
export function headerNumber(headers: Headers, name: string): number | undefined {
  const m = /^ *([0-9]+)/.exec(headers.get(name) ?? '');
  return m ? Number(m[1]) : undefined;
}

export function is2xx(resp: Resp | null | undefined): boolean {
  return !!resp && resp.status >= 200 && resp.status <= 299;
}

/**
 * Send METHOD to URL with the JSON string BODY and HEADERS.
 * null when URL cannot be reached within TIMEOUT seconds.
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
