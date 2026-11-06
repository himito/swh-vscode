// What the commands share: messages, progress, the current directory.

import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Cancelled, UserError } from './http';

export const config = () => vscode.workspace.getConfiguration('swh');

/** Show the information MESSAGE. */
export function info(message: string): void {
  void vscode.window.showInformationMessage(message);
}

/** Ask MESSAGE, a yes-or-no question: whether the user chose ACTION. */
export async function ask(message: string, action: string): Promise<boolean> {
  return (await vscode.window.showInformationMessage(message, action, 'No')) === action;
}

/** FN, with TITLE in the status bar while it runs. */
export function busy<T>(title: string, fn: () => Promise<T>): Promise<T> {
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, fn));
}

/** Open URL in the browser, as is. */
export async function openUrl(url: string): Promise<void> {
  // a string keeps the URL as is: a Uri would re-encode the percent-encoded
  // qualifiers of a SWHID
  await vscode.env.openExternal(url as unknown as vscode.Uri);
}

/** FN as a command handler that reports its errors. */
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

/** The true name of PATH; a UserError when it does not exist. */
export async function realpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    throw new UserError(`No such file or directory: ${p}`);
  }
}

/** The "current directory": the active file's, else the workspace folder's. */
export function currentDir(): string {
  const doc = vscode.window.activeTextEditor?.document;
  if (doc?.uri.scheme === 'file' && !doc.isUntitled) return path.dirname(doc.uri.fsPath);
  const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'file') ?? [];
  if (folders.length) return folders[0].uri.fsPath;
  throw new UserError('Open a folder or a file first');
}

/** The active editor, when it shows a file on disk. */
export function fileEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === 'file' && !editor.document.isUntitled ? editor : undefined;
}

/** Line range of the selection, as "A-B" or "A", or undefined when empty. */
export function selectionLines(editor: vscode.TextEditor): string | undefined {
  const sel = editor.selection;
  if (sel.isEmpty) return undefined;
  const from = sel.start.line + 1;
  // a selection ending at the start of a line does not hold it
  const to = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return from === to ? String(from) : `${from}-${to}`;
}
