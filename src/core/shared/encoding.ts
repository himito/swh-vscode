/**
 * Percent-encoding and the URLs built with it, and Markdown's escaping.
 *
 * @remarks
 * Every function here is pure. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

/**
 * The characters Markdown gives a meaning to in text: escapes, emphasis,
 * code, link text, HTML and its entities.
 */
const MARKDOWN_SPECIAL = /[\\`*_[\]<>&]/g;

/**
 * Escapes text for Markdown, so that it shows as it is, e.g. as a link's text.
 *
 * @param text - The text, e.g. a file name.
 * @returns `text` with each of Markdown's special characters escaped with a backslash.
 *
 * @example
 * ```ts
 * markdownText('__init__.py'); // '\\_\\_init\\_\\_.py', not the bold "init"
 * ```
 */
export const markdownText = (text: string) => text.replace(MARKDOWN_SPECIAL, (char) => `\\${char}`);

/**
 * Writes a URL as the destination of a Markdown link.
 *
 * @remarks
 * Its parentheses are percent-encoded: a `)` would end the destination,
 * e.g. in a SWHID whose origin holds one. The URL is the same.
 *
 * @param url - The URL, without blanks, as a SWHID's permalink is.
 * @returns `url` without parentheses.
 */
export const markdownUrl = (url: string) => url.replace(/[()]/g, (paren) => (paren === '(' ? '%28' : '%29'));

/**
 * Removes the trailing slashes of a base URL setting.
 *
 * @param url - A base URL, such as the `swh.archiveUrl` setting.
 * @returns `url` without its trailing slashes.
 */
export const baseUrl = (url: string) => url.replace(/\/+$/, '');

/** The characters that URLs never need to percent-encode (RFC 3986 "unreserved"). */
const UNRESERVED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.~';

/**
 * Percent-encodes a string, as UTF-8, except for the unreserved characters
 * and the `allowed` ones.
 *
 * @param str - The string to encode.
 * @param allowed - Further characters to leave as they are.
 * @returns `str` with every other character encoded as `%XX` (uppercase hexadecimal).
 *
 * @example
 * ```ts
 * hexify('/src/my file é;%.el', '/');
 * // '/src/my%20file%20%C3%A9%3B%25.el'
 * ```
 */
export function hexify(str: string, allowed = ''): string {
  const ok = new Set(UNRESERVED + allowed);
  let out = '';
  for (const char of str) {
    if (ok.has(char)) {
      out += char;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

/**
 * Decodes the `%XX` sequences of a string, as UTF-8.
 *
 * @remarks
 * Unlike `decodeURIComponent`, it never throws: a `%` that does not start a
 * valid sequence is kept as is.
 *
 * @param str - The percent-encoded string.
 * @returns The decoded string.
 */
export function unhex(str: string): string {
  const bytes: number[] = [];
  for (let index = 0; index < str.length; ) {
    const escape = /^%([0-9a-fA-F]{2})/.exec(str.substring(index, index + 3));
    if (escape) {
      bytes.push(parseInt(escape[1], 16));
      index += 3;
    } else {
      // a whole code point: a lone half of a surrogate pair would not encode
      const char = String.fromCodePoint(str.codePointAt(index)!);
      bytes.push(...Buffer.from(char, 'utf8'));
      index += char.length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Builds a URL query string, its keys and values percent-encoded.
 *
 * @param params - `[key, value]` pairs, or `[key]` for a key without a value.
 * @returns The query string, without the leading `?`.
 *
 * @example
 * ```ts
 * queryString([['path', '/a b'], ['upstream']]);
 * // 'path=%2Fa%20b&upstream'
 * ```
 */
export function queryString(params: Array<[string, string?]>): string {
  return params.map(([key, value]) => (value === undefined ? hexify(key) : `${hexify(key)}=${hexify(value)}`)).join('&');
}
