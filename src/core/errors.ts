/**
 * The error types the extension uses.
 *
 * @remarks
 * Every layer throws them: the backend, its HTTP implementation, and the commands.
 * This module must not import `vscode`.
 *
 * @packageDocumentation
 */

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

/**
 * The message of a thrown value, for display.
 *
 * @param error - Whatever was thrown: an `Error` or anything else.
 * @returns The error's message, or the value as a string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
