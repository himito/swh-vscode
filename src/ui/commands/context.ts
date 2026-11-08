/**
 * What every group of commands shares: the backend, and "where the user is".
 *
 * @remarks
 * {@link CommandContext} finds what a command is about: the file in the active
 * editor (and its selected lines), a file or folder given by a context menu,
 * or else the current folder (see {@link CommandContext.target}); and the
 * repository's origin, or another one the user types (see
 * {@link CommandContext.originArg}).
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { Cancelled, isPublicOrigin, type Maybe, parseOrigin, type Swh, UserError } from '#core';
import type { Reports } from '../reports';
import { ask, fileEditor, realCurrentDir, realpath, selectionLines, withoutContext } from '../helpers';

/**
 * The options a SWHID command accepts when not run on a `Uri`.
 *
 * @remarks
 * Passed from a keybinding (`"args": { "bare": true }`), the menus, or the
 * status bar item (`path`).
 */
export type CommandOptions = {
  /** Whether to give the bare SWHID, without its context; overrides `swh.swhidWithoutContext`. */
  bare?: boolean;
  /** The path of the file or directory to act on. */
  path?: string;
};

/**
 * The argument a SWHID command receives.
 *
 * @remarks
 * A `Uri` when run from the editor's or the Explorer's context menu;
 * {@link CommandOptions} from a keybinding, the menus, or the status bar item;
 * `undefined` from the Command Palette.
 */
export type CommandArg = vscode.Uri | CommandOptions | undefined;

/** What a SWHID command is about: a file, possibly some of its lines, or a directory. */
export type Target = {
  /** The real path of the file or directory. */
  path: string;
  /** The selected lines, `"A-B"` or `"A"`, for a file in the active editor. */
  lines?: string;
};

/**
 * Called after a save request or a refresh, when what the archive holds may
 * have changed, e.g. to recheck the status bar.
 */
export type ArchiveChangeHandler = () => void;

/**
 * Whether a SWHID command is about the active editor's file.
 *
 * @param editor - The active editor, on a local file.
 * @param uri - The file or folder the command names, if any.
 * @returns `true` when no file or folder is named, or it is the editor's file.
 */
function isEditorTarget(editor: vscode.TextEditor, uri?: vscode.Uri): boolean {
  if (!uri) return true;
  return uri.toString() === editor.document.uri.toString();
}

/**
 * Checks a repository URL as the user types it.
 *
 * @param input - The text of the input box.
 * @returns Why it is not a valid repository URL, or `undefined` when it is.
 */
function originInputError(input: string): Maybe<string> {
  try {
    parseOrigin(input);
    return undefined;
  } catch (error) {
    if (error instanceof UserError) return error.message;
    throw error;
  }
}

/** The backend, and what the commands are about: the target, the repository, its origin. */
export class CommandContext {
  /**
   * Creates the context.
   *
   * @param swh - The backend that talks to Git and the archive.
   * @param reports - Where the visits and citation reports are shown.
   * @param onArchiveChange - Called when what the archive holds may have changed.
   */
  constructor(
    readonly swh: Swh,
    readonly reports: Reports,
    readonly onArchiveChange: ArchiveChangeHandler,
  ) { }

  /**
   * The root of the Git repository of the current directory.
   *
   * @returns The repository's root.
   * @throws {@link core!UserError} when no file or folder is open, or the current
   * directory is not inside a Git repository.
   */
  async repoRoot(): Promise<string> {
    const root = await this.swh.git.root(await realCurrentDir());
    if (!root) throw new UserError('Not inside a Git repository');
    return root;
  }

  /**
   * The public origin of the current directory's repository.
   *
   * @returns The origin, normalized as the archive names it, or `undefined`
   * when there is no repository, no remote, or the remote is not a public
   * URL.
   */
  async localOrigin(): Promise<Maybe<string>> {
    let root: string;
    try {
      root = await this.repoRoot();
    } catch (error) {
      if (error instanceof UserError) return undefined;
      throw error;
    }

    const origin = await this.swh.originOf(root);
    return isPublicOrigin(origin) ? origin : undefined;
  }

  /**
   * Asks the user for the URL of a public repository.
   *
   * @remarks
   * The input box checks the URL as it is typed (see {@link core!parseOrigin}),
   * so it cannot be accepted until it is a valid repository URL.
   *
   * @param prompt - The prompt of the input box.
   * @param def - The URL proposed in the input box.
   * @returns The normalized origin.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   */
  async readOrigin(prompt: string, def?: string): Promise<string> {
    const input = await vscode.window.showInputBox({
      prompt,
      value: def,
      placeHolder: 'https://github.com/owner/repository',
      ignoreFocusOut: true,
      validateInput: originInputError,
    });
    if (input === undefined) throw new Cancelled();
    return parseOrigin(input);
  }

  /**
   * The origin a command about "another repository" works on.
   *
   * @remarks
   * Asks for a repository URL when `askOrigin` is set, or when the current
   * repository has no public origin; the current origin, if any, is proposed.
   *
   * @param action - What the command does to the origin, for the prompt, e.g. "check".
   * @param askOrigin - Whether to ask even when there is a public origin here.
   * @returns The origin asked for, or `undefined` to use the current repository.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   */
  async originArg(action: string, askOrigin: boolean): Promise<Maybe<string>> {
    const local = await this.localOrigin();
    if (!askOrigin && local) return undefined;
    const prompt = local ? `Origin to ${action}` : `No public origin here; origin to ${action}`;
    return this.readOrigin(prompt, local);
  }

  /**
   * The file (with its selected lines) or directory a SWHID command is about.
   *
   * @remarks
   * In order: the file or folder `resource` names, when it is not the active
   * editor's file; else the active editor's file, with its selected lines;
   * else the current directory. A modified file is offered to be saved first.
   * Symbolic links are resolved.
   *
   * @param resource - A file or folder from a context menu or the status bar, if any.
   * @returns The target.
   * @throws {@link core!UserError} when `resource` is not a local file, the path does not
   * exist, the user declines to save a modified file, or the current
   * directory is not inside a Git repository.
   */
  async target(resource?: vscode.Uri | string): Promise<Target> {
    const uri = typeof resource === 'string' ? vscode.Uri.file(resource) : resource;
    const editor = fileEditor();
    if (editor && isEditorTarget(editor, uri)) return this.editorTarget(editor);
    if (uri) return this.uriTarget(uri);
    return this.currentDirTarget();
  }

  /**
   * The target for a file or folder given explicitly.
   *
   * @remarks
   * A file open in an editor, though not the active one, may be modified:
   * it is offered to be saved first, as the active editor's file is.
   *
   * @param uri - The file or folder.
   * @returns Its real path.
   * @throws {@link core!UserError} when `uri` is not a local file, does not
   * exist, or the user declines to save it when modified.
   */
  private async uriTarget(uri: vscode.Uri): Promise<Target> {
    if (uri.scheme !== 'file') throw new UserError('Remote files are not supported');
    const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (openDoc) await this.ensureSaved(openDoc);
    return { path: await realpath(uri.fsPath) };
  }

  /**
   * The target for the active editor's file, with its selected lines.
   *
   * @param editor - The active editor, on a local file.
   * @returns The file's real path (a symbolic link stands for its target) and selected lines.
   * @throws {@link core!UserError} when the user declines to save a modified file, or the save fails.
   */
  private async editorTarget(editor: vscode.TextEditor): Promise<Target> {
    await this.ensureSaved(editor.document);
    return { path: await realpath(editor.document.uri.fsPath), lines: selectionLines(editor) };
  }

  /**
   * The target for the current directory.
   *
   * @returns The current directory's real path.
   * @throws {@link core!UserError} when the current directory is not inside a Git repository.
   */
  private async currentDirTarget(): Promise<Target> {
    const dir = await realCurrentDir();
    if (!(await this.swh.git.root(dir))) throw new UserError('Not inside a Git repository');
    return { path: dir };
  }

  /**
   * Saves a modified document, after asking, since a SWHID identifies the file on disk.
   *
   * @param doc - The document.
   * @throws {@link core!UserError} when the user declines to save it, or the
   * save fails, e.g. on a read-only file.
   */
  private async ensureSaved(doc: vscode.TextDocument): Promise<void> {
    if (!doc.isDirty) return;
    if (!(await ask('The file is modified; save it first?', 'Save'))) {
      throw new UserError('A SWHID identifies the file on disk: save it first');
    }
    if (!(await doc.save())) throw new UserError(`Could not save ${doc.fileName}`);
  }

  /**
   * Whether a SWHID command gives the bare SWHID, without its context.
   *
   * @param arg - The command's argument; its `bare` option wins.
   * @returns The `bare` option when given, else the `swh.swhidWithoutContext` setting.
   */
  bare(arg: CommandArg): boolean {
    if (arg && !(arg instanceof vscode.Uri) && typeof arg.bare === 'boolean') return arg.bare;
    return withoutContext();
  }

  /**
   * The file or folder a command's argument names, if any.
   *
   * @param arg - The command's argument.
   * @returns The `Uri` from a context menu, the `path` option, or `undefined`.
   */
  uriOf(arg: CommandArg): vscode.Uri | string | undefined {
    if (arg instanceof vscode.Uri) return arg;
    return arg?.path;
  }
}
