/**
 * The registration of the commands with VS Code, and the reporting of their errors.
 *
 * @remarks
 * Commands throw {@link core!UserError} for problems the user can act on and
 * {@link core!Cancelled} when the user dismisses a prompt. Each command is
 * registered wrapped by `command`, which turns both into the right kind of
 * feedback, so command code never shows errors itself.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { Cancelled, UserError } from '#core';

/**
 * Wraps an async function as a command handler that reports its errors.
 *
 * @remarks
 * A {@link core!Cancelled} error is ignored, a {@link core!UserError} is shown as a
 * warning with its message, and any other error is shown as an error
 * prefixed with "Software Heritage:". The handler itself never rejects.
 *
 * @param fn - The command's implementation.
 * @returns A handler for `vscode.commands.registerCommand`.
 */
function command<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      if (e instanceof Cancelled) return;
      if (e instanceof UserError) {
        void vscode.window.showWarningMessage(e.message);
      } else {
        void vscode.window.showErrorMessage(`Software Heritage: ${(e as Error)?.message ?? e}`);
      }
    }
  };
}

/**
 * A command's implementation.
 *
 * @remarks
 * Its arguments come from VS Code untyped: a `Uri` from a context menu, an
 * item from a tree view, options from a keybinding, or nothing from the
 * command palette.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CommandHandler = (...args: any[]) => Promise<unknown>;

/**
 * Registers commands whose errors are reported to the user.
 *
 * @remarks
 * A {@link core!Cancelled} error is ignored, a {@link core!UserError} is shown
 * as a warning with its message, and any other error is shown as an error.
 *
 * @param context - The extension context, which disposes of the commands on deactivation.
 * @param handlers - Each command's implementation, by command id.
 */
export function registerCommands(context: vscode.ExtensionContext, handlers: Record<string, CommandHandler>): void {
  for (const [id, handler] of Object.entries(handlers)) {
    context.subscriptions.push(vscode.commands.registerCommand(id, command(handler)));
  }
}
