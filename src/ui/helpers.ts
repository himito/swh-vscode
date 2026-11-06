/**
 * Helpers that every command shares: messages, prompts, progress, error
 * reporting, and where the user is (the current file or folder).
 *
 * @remarks
 * This is the thin layer between the commands and the VS Code window API.
 * Commands throw {@link UserError} for problems the user can act on and
 * {@link Cancelled} when the user dismisses a prompt; {@link command} turns
 * both into the right kind of feedback, so command code never shows errors
 * itself.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cancelled, UserError } from '../core';

/**
 * The extension's settings, the `swh.*` section of the configuration.
 *
 * @remarks
 * Read anew at each call, so a changed setting takes effect at once.
 *
 * @returns The `swh` configuration section.
 */
export const config = () => vscode.workspace.getConfiguration('swh');

/**
 * Shows an information message, without waiting for it to be dismissed.
 *
 * @param message - The text to show.
 */
export function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

/**
 * Asks the user a yes-or-no question in an information message.
 *
 * @param message - The question.
 * @param action - The label of the "yes" button; the other button is "No".
 * @returns Whether the user chose `action`; `false` when they chose "No" or
 * dismissed the message.
 */
export async function ask(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showInformationMessage(message, action, 'No')) === action;
}

/**
 * Runs `fn` while a progress indicator with `title` shows in the status bar.
 *
 * @param title - What is being done, e.g. "Software Heritage: listing the visits…".
 * @param fn - The work to run.
 * @returns What `fn` returns; its errors propagate.
 */
export function busy<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn));
}

/**
 * Opens a URL in the user's browser, exactly as given.
 *
 * @param url - The URL to open, e.g. an archive link to a qualified SWHID.
 */
export async function openUrl(url: string): Promise<void> {
  // a string keeps the URL as is: a Uri would re-encode the percent-encoded
  // qualifiers of a SWHID
  await vscode.env.openExternal(url as unknown as vscode.Uri);
}

/**
 * Wraps an async function as a command handler that reports its errors.
 *
 * @remarks
 * A {@link Cancelled} error is ignored, a {@link UserError} is shown as a
 * warning with its message, and any other error is shown as an error
 * prefixed with "Software Heritage:". The handler itself never rejects.
 *
 * @param fn - The command's implementation.
 * @returns A handler for `vscode.commands.registerCommand`.
 */
export function command<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
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
 * Resolves a path to its true name, following symbolic links.
 *
 * @param p - The path to resolve.
 * @returns The canonical absolute path.
 * @throws {@link UserError} when the path does not exist.
 */
export async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    throw new UserError(`No such file or directory: ${p}`);
  }
}

/**
 * The directory the user is working in.
 *
 * @remarks
 * The directory of the file in the active editor when it is a file on disk,
 * else the first workspace folder on disk.
 *
 * @returns The directory's path, not resolved through symbolic links.
 * @throws {@link UserError} when no file on disk is active and no folder is open.
 */
export function currentDir(): string {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file' && !doc.isUntitled) return path.dirname(doc.uri.fsPath);
  const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
  if (folders.length) return folders[0].uri.fsPath;
  throw new UserError('Open a folder or a file first');
}

/**
 * The active editor, when it shows a file saved on disk.
 *
 * @returns The active editor, or `undefined` when there is none or it shows
 * an untitled, virtual or remote document.
 */
export function fileEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === 'file' && !editor.document.isUntitled ? editor : undefined;
}

/**
 * The lines the editor's primary selection covers, in the form of the
 * `lines` qualifier of a SWHID.
 *
 * @remarks
 * Lines are numbered from 1. A selection that ends at the very start of a
 * line does not include that line.
 *
 * @example
 * ```ts
 * selectionLines(editor); // "2-3", or "5" for one line
 * ```
 *
 * @param editor - The editor whose selection to read.
 * @returns `"A-B"`, `"A"` for a single line, or `undefined` when the
 * selection is empty.
 */
export function selectionLines(editor: vscode.TextEditor): string | undefined {
  const sel = editor.selection;
  if (sel.isEmpty) return undefined;
  const from = sel.start.line + 1;
  // a selection ending at the start of a line does not hold it
  const to = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return from === to ? String(from) : `${from}-${to}`;
}
