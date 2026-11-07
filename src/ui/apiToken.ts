/**
 * The Software Heritage API token: from the environment, else from VS Code's
 * secret storage.
 *
 * @remarks
 * The `SWH_API_TOKEN` environment variable takes precedence and is read on
 * each use. The stored token is set with the `swh.setToken` command, read
 * once and cached until it changes, in this window or another.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import type { Token } from '../core';
import type { Maybe } from '../core/types';

/** The key of the API token in VS Code's secret storage. */
const TOKEN_KEY = 'swh.apiToken';

/** Trims a token; a blank one counts as no token. */
const normalizeToken = (raw: Token): Token => raw?.trim() || undefined;

/** The token set in the `SWH_API_TOKEN` environment variable; read on each call. */
export const envToken = (): Token => normalizeToken(process.env.SWH_API_TOKEN);

/** The API token: the environment's, else the one in VS Code's secret storage. */
export class ApiToken implements vscode.Disposable {
  /** The stored token's lookup; undefined until first read, or after it changes. */
  private storedLookup: Maybe<Promise<Token>>;
  /** The listener to the secret storage's changes. */
  private readonly listener: vscode.Disposable;

  /**
   * Follows the stored token's changes, in this window or another.
   *
   * @param secrets - The extension's secret storage.
   */
  constructor(private readonly secrets: vscode.SecretStorage) {
    this.listener = secrets.onDidChange((e) => {
      if (e.key === TOKEN_KEY) this.forget();
    });
  }

  /**
   * The token to use: the environment's, else the stored one.
   *
   * @returns The token, or `undefined` for anonymous requests.
   */
  async get(): Promise<Token> {
    return envToken() ?? (await this.stored());
  }

  /**
   * Stores a token in the secret storage.
   *
   * @param value - The token; it is trimmed, and a blank one removes the
   * stored token instead.
   * @returns `true` when a token was stored, `false` when it was removed.
   */
  async store(value: string): Promise<boolean> {
    const token = normalizeToken(value);

    // if the token is blank, remove it from the storage
    if (!token) {
      await this.clear();
      return false;
    }

    // store the token, and forget the cached lookup
    await this.secrets.store(TOKEN_KEY, token);
    this.forget();
    return true;
  }

  /** Removes the stored token. */
  async clear(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    this.forget();
  }

  /** Stops following the stored token's changes. */
  dispose(): void {
    this.listener.dispose();
  }

  /** The stored token, read once and cached. */
  private stored(): Promise<Token> {
    return (this.storedLookup ??= this.readStored());
  }

  /**
   * Reads the stored token.
   *
   * @remarks
   * When the secret storage cannot be read (e.g. no keyring on Linux), the
   * requests are made anonymously, and the failure is not cached: the next
   * call tries again.
   */
  private async readStored(): Promise<Token> {
    try {
      return normalizeToken(await this.secrets.get(TOKEN_KEY));
    } catch {
      this.forget();
      return undefined;
    }
  }

  /** Drops the cached lookup, so the next call reads the storage again. */
  private forget(): void {
    this.storedLookup = undefined;
  }
}
