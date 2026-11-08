/**
 * Helpers that every command shares: settings, messages, prompts, progress,
 * and where the user is (the current file or folder).
 *
 * @remarks
 * This is the thin layer between the commands and the VS Code window API.
 * Commands do not report their errors themselves: they throw them, and
 * `registerCommands` (see `commands/register.ts`) reports them.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { type Git, LineRange, type Maybe, UserError } from '#core';

/**
 * The extension's settings, the `swh.*` section of the configuration.
 *
 * @remarks
 * Read anew at each call, so a changed setting takes effect at once.
 *
 * @returns The `swh` configuration section.
 */
export const config = () => vscode.workspace.getConfiguration('swh');

/** The name, in the `swh` section, of the setting of the archive's web root: `swh.archiveUrl`. */
export const ARCHIVE_URL_SETTING = 'archiveUrl';

/** The archive's web root when `swh.archiveUrl` is not set: Software Heritage's own. */
export const DEFAULT_ARCHIVE_URL = 'https://archive.softwareheritage.org';

/**
 * The archive's web root, as the `swh.archiveUrl` setting says.
 *
 * @returns The URL, e.g. `https://archive.softwareheritage.org`;
 * {@link DEFAULT_ARCHIVE_URL} when it is not set, or blank, as the Settings
 * UI stores a cleared field.
 */
export function archiveUrl(): string {
  const setting = config().get<string>(ARCHIVE_URL_SETTING, DEFAULT_ARCHIVE_URL).trim();
  return setting || DEFAULT_ARCHIVE_URL;
}

/**
 * The name, in the `swh` section, of the setting that makes the SWHID
 * commands give bare SWHIDs: `swh.swhidWithoutContext`.
 */
export const WITHOUT_CONTEXT_SETTING = 'swhidWithoutContext';

/**
 * Whether the SWHID commands give bare SWHIDs, without their context
 * qualifiers, as the `swh.swhidWithoutContext` setting says.
 *
 * @returns The setting; `false` when it is not set.
 */
export function withoutContext(): boolean {
  return config().get<boolean>(WITHOUT_CONTEXT_SETTING, false);
}

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
 * Resolves a path to its true name, following symbolic links.
 *
 * @param fsPath - The path of a file or directory to resolve.
 * @returns The canonical absolute path.
 * @throws {@link core!UserError} when the path does not exist.
 */
export async function realpath(fsPath: string): Promise<string> {
  try {
    return await fs.realpath(fsPath);
  } catch {
    throw new UserError(`No such file or directory: ${fsPath}`);
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
 * @throws {@link core!UserError} when no file on disk is active and no folder is open.
 */
export function currentDir(): string {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file' && !doc.isUntitled) return path.dirname(doc.uri.fsPath);

  const folders = vscode.workspace.workspaceFolders?.filter((folder) => folder.uri.scheme === 'file') ?? [];
  if (folders.length) return folders[0].uri.fsPath;

  throw new UserError('Open a folder or a file first');
}

/**
 * The directory the user is working in, resolved through symbolic links.
 *
 * @returns The canonical path of {@link currentDir}.
 * @throws {@link core!UserError} when no file on disk is active and no folder
 * is open, or the directory does not exist.
 */
export async function realCurrentDir(): Promise<string> {
  return realpath(currentDir());
}

/**
 * The root of the Git repository of the current directory.
 *
 * @param git - The Git runner.
 * @returns The repository's root.
 * @throws {@link core!UserError} when no file or folder is open, or the current
 * directory is not inside a Git repository.
 */
export async function currentRepoRoot(git: Git): Promise<string> {
  const root = await git.root(await realCurrentDir());
  if (!root) throw new UserError('Not inside a Git repository');
  return root;
}

/**
 * The active editor, when it shows a file saved on disk.
 *
 * @returns The active editor, or `undefined` when there is none or it shows
 * an untitled, virtual or remote document.
 */
export function fileEditor(): Maybe<vscode.TextEditor> {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === 'file' && !editor.document.isUntitled ? editor : undefined;
}

/**
 * The lines the editor's primary selection covers, as the `lines` qualifier
 * of a SWHID takes them.
 *
 * @remarks
 * Lines are numbered from 1. A selection that ends at the very start of a
 * line does not include that line.
 *
 * @example
 * ```ts
 * selectionLines(editor)?.toString(); // "2-3", or "5" for one line
 * ```
 *
 * @param editor - The editor whose selection to read.
 * @returns The range of lines, or `undefined` when the
 * selection is empty.
 */
export function selectionLines(editor: vscode.TextEditor): Maybe<LineRange> {
  const { selection } = editor;
  if (selection.isEmpty) return undefined;
  const firstLine = selection.start.line + 1;
  return LineRange.of(firstLine, lastSelectedLine(selection));
}

/**
 * The last line a non-empty selection holds, numbered from 1.
 *
 * @remarks
 * A selection that ends at the very start of a line, as when whole lines
 * are selected, does not hold that line.
 *
 * @param selection - The selection, not empty.
 * @returns The line number.
 */
function lastSelectedLine(selection: vscode.Selection): number {
  const { start, end } = selection;
  const endsAtLineStart = end.character === 0 && end.line > start.line;
  // positions count lines from 0: the line before `end` is `end.line` counted from 1
  return endsAtLineStart ? end.line : end.line + 1;
}
