/**
 * The archival status of the current file, shown in the status bar.
 *
 * @remarks
 * The {@link StatusBar} item tells whether the file in the active editor is
 * archived by Software Heritage. With no file editor open, it tells the same
 * for the workspace folder. It is checked when the user switches to a file,
 * each time the file is saved, and when the workspace or the `swh` settings
 * change. Answers are kept per path, together with the file's modification
 * time, so switching back to an unchanged file asks the archive nothing.
 *
 * Clicking the item runs `swh.statusBarCopy`, which copies the SWHID of the
 * file or folder shown. Without an API token, the item also shows how many
 * API requests have been used this hour.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { core, isPublicOrigin, type Maybe, RATE_LIMIT_MESSAGE, Swh } from '#core';
import { ARCHIVE_URL_SETTING, config, fileEditor, realCurrentDir } from './helpers';

/**
 * The archival status of a file or directory.
 *
 * @remarks
 * - `archived`: the archive holds this very content.
 * - `not-archived`: the archive does not hold it.
 * - `origin-archived`: the content is not archived, but its repository's
 *   origin is: a save request would likely archive it.
 * - `pending`: the check is under way.
 * - `error`: the check failed.
 */
export type Status = 'archived' | 'not-archived' | 'origin-archived' | 'pending' | 'error';

/** The id of the status bar item, by which the user can hide it. */
const ITEM_ID = 'swh.status';

/** The item's priority among the items on the right: higher is further left. */
const ITEM_PRIORITY = 100;

/** The command a click on the item runs, as `package.json` declares it: it copies the SWHID. */
const CLICK_COMMAND = 'swh.statusBarCopy';

/** The setting that shows or hides the item, under `swh.`. */
const ENABLED_SETTING = 'statusBar.enabled';

/**
 * Whether the user wants the item shown.
 *
 * @returns The `swh.statusBar.enabled` setting, `true` by default.
 */
function isEnabled(): boolean {
  return config().get<boolean>(ENABLED_SETTING, true);
}

/**
 * Whether a document is the one in the active editor.
 *
 * @param doc - The document.
 * @returns `true` when the active editor shows it.
 */
function isActiveDocument(doc: vscode.TextDocument): boolean {
  return doc === vscode.window.activeTextEditor?.document;
}

/**
 * The status bar texts by status, used when the `swh.statusBar.lighters`
 * setting does not override them.
 */
const DEFAULT_LIGHTERS: Record<Status, string> = {
  archived: '$(pass) SWH',
  'not-archived': '$(error) SWH',
  'origin-archived': '$(circle-large-outline) SWH',
  pending: '$(sync~spin) SWH',
  error: '$(warning) SWH',
};

/** Each status in words, for the item's tooltip. */
const DESCRIPTIONS: Record<Status, string> = {
  archived: 'Archived by Software Heritage',
  'not-archived': 'Not archived by Software Heritage',
  'origin-archived': 'Not archived, but its origin is',
  pending: 'Checking the Software Heritage archive…',
  error: 'Software Heritage: the check failed',
};

/** What the status bar shows the status of. */
export type Shown = {
  /** The real path of the file or directory. */
  path: string;
  /** Whether it is a directory. */
  dir: boolean;
};

/** What the status bar would show the status of, see `StatusBar.target`. */
type ShownCandidate = Shown & {
  /** Whether its editor has unsaved changes. */
  dirty: boolean;
};

/** A path inside a `.git` directory, which has no archival status. */
const GIT_DIR_PATH = /[/\\]\.git([/\\]|$)/;

/**
 * The file in the active editor, or without an active editor the workspace folder.
 *
 * @returns The real path, whether it is a directory, and whether its editor
 * has unsaved changes; undefined when the active editor shows something other
 * than a file on disk (an output panel, an untitled document).
 * @throws When the path cannot be resolved, e.g. the file was deleted.
 */
async function activeCandidate(): Promise<Maybe<ShownCandidate>> {
  const editor = fileEditor();
  if (editor) {
    return { path: await fs.realpath(editor.document.uri.fsPath), dir: false, dirty: editor.document.isDirty };
  }
  if (vscode.window.activeTextEditor) return undefined;
  return { path: await realCurrentDir(), dir: true, dirty: false };
}

/** What the status bar knows about one path. */
type Entry = {
  /** The path and modification time it was checked at, see `stampOf`. */
  stamp: string;
  /** The archival status found. */
  status: Status;
  /** The core SWHID of the file or directory, when known. */
  swhid?: string;
  /** Why the check failed, when the status is `error`. */
  error?: string;
  /** The number of the check that set this entry: a later check wins. */
  check: number;
};

/**
 * The status bar item showing whether the current file is archived.
 *
 * @remarks
 * Two counters guard against late answers. `updates` numbers the calls to
 * {@link StatusBar.update}: a call that finishes after a newer one started
 * leaves the item alone. `checks` numbers the requests to the archive: an
 * answer never overwrites the entry set by a newer check of the same path.
 */
export class StatusBar implements vscode.Disposable {
  /** The status bar item itself, on the right. */
  private readonly item = vscode.window.createStatusBarItem(ITEM_ID, vscode.StatusBarAlignment.Right, ITEM_PRIORITY);
  /** What is known per path, by real path. */
  private readonly entries = new Map<string, Entry>();
  /** The number of the latest archive check started. */
  private checks = 0;
  /** The number of the latest call to {@link StatusBar.update}. */
  private updates = 0;
  /** The path shown, and whether it is a directory; undefined when the item is hidden. */
  current?: Shown;
  /** The item and the event listeners, disposed of with the status bar. */
  private readonly disposables: vscode.Disposable[] = [];

  /**
   * Create the item and listen to the events that may change what it shows.
   *
   * @param swh - The backend that answers the archival questions.
   */
  constructor(private readonly swh: Swh) {
    this.item.name = 'Software Heritage';
    this.item.command = CLICK_COMMAND;
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => void this.update()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.update()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onEdit(event)),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChange(event)),
    );
  }

  /**
   * Checks the active file again when it is saved: its content on disk changed.
   *
   * @param doc - The document saved.
   */
  private onSave(doc: vscode.TextDocument): void {
    if (isActiveDocument(doc)) void this.update(true);
  }

  /**
   * Redraws the item when the active file is edited: it is modified, or back
   * to its saved state by undo. Only the tooltip changes, as the status is
   * that of the file on disk.
   *
   * @param event - The edit.
   */
  private onEdit(event: vscode.TextDocumentChangeEvent): void {
    if (isActiveDocument(event.document)) this.render();
  }

  /**
   * Follows the settings: another archive forgets every answer, as none of
   * the previous archive's hold; any other setting of the extension
   * redraws the item, after checking again if needed.
   *
   * @param event - What changed in the settings.
   */
  private onConfigurationChange(event: vscode.ConfigurationChangeEvent): void {
    if (event.affectsConfiguration(`swh.${ARCHIVE_URL_SETTING}`)) {
      this.swh.forgetAll();
      this.forget();
      return;
    }
    if (event.affectsConfiguration('swh')) void this.update();
  }

  /** Remove the item and stop listening to events. */
  dispose() {
    for (const disposable of this.disposables) disposable.dispose();
  }

  /**
   * Forget every status, and check the current file again.
   *
   * @remarks
   * Called after a save request or a refresh: what the archive holds may
   * have changed.
   */
  forget() {
    this.entries.clear();
    void this.update(true);
  }

  /**
   * The file, or without a file editor the workspace folder, whose status to show.
   *
   * @remarks
   * Paths inside a `.git` directory and paths outside a Git repository have
   * no status to show. When the active editor shows something other than a
   * file on disk (an output panel, an untitled document), nothing is shown
   * either.
   *
   * @returns The real path, whether it is a directory, and whether its editor
   * has unsaved changes; undefined when there is nothing to show.
   */
  private async target(): Promise<Maybe<ShownCandidate>> {
    const candidate = await activeCandidate().catch(() => undefined);
    if (!candidate || GIT_DIR_PATH.test(candidate.path)) return undefined;
    const inRepository = !!(await this.swh.git.root(candidate.path));
    return inRepository ? candidate : undefined;
  }

  /**
   * Show the status of the current file, checking it when it changed.
   *
   * @remarks
   * A file is checked again only when its modification time differs from
   * the one it was checked at, unless `force` is set. A file with unsaved
   * changes is not checked: the item keeps the status of the file on disk,
   * or stays hidden until the file is saved when no status is known yet.
   * The check runs in the background; the item shows `pending` meanwhile.
   *
   * @param force - Check the file even when it has not changed since its last check.
   */
  async update(force = false): Promise<void> {
    const update = ++this.updates;
    // update() may be called again (e.g. the user switches files) while this
    // call is still waiting. Each call gets a number; superseded() tells, after
    // each await, whether a newer call has started since. If so, this call
    // stops, so that it cannot overwrite the newer call's result with stale data.
    const superseded = () => update !== this.updates;

    const target = isEnabled() ? await this.target() : undefined;
    if (superseded()) return;
    this.current = target;

    if (target && !target.dirty) {
      const stamp = await stampOf(target.path);
      if (superseded()) return;
      const changed = this.entries.get(target.path)?.stamp !== stamp;
      if (force || changed) void this.check(target.path, target.dir, stamp);
    }
    this.render();
  }

  /**
   * Ask for the archival status of the file or directory at `targetPath`, and record it.
   *
   * @remarks
   * Failures are recorded as the `error` status, with their message in the
   * tooltip. Reaching the API's rate limit is also shown as a warning, since
   * it is the one failure the user can act on.
   *
   * @param targetPath - The real path to check.
   * @param dir - Whether `targetPath` is a directory.
   * @param stamp - The path's stamp at the time of the check, see `stampOf`.
   */
  private async check(targetPath: string, dir: boolean, stamp: string) {
    const check = ++this.checks;
    const set = (status: Status, swhid?: string, error?: string) => {
      const old = this.entries.get(targetPath);
      if (old && old.check > check) return;
      const knownSwhid = swhid ?? (status === 'pending' ? undefined : old?.swhid);
      this.entries.set(targetPath, { stamp, status, swhid: knownSwhid, error, check });
      if (this.current?.path === targetPath) this.render();
    };
    set('pending');
    try {
      const root = await this.swh.git.root(targetPath);
      if (!root) return;
      if (dir) await this.dirStatus(targetPath, root, set);
      else await this.fileStatus(targetPath, root, set);
    } catch (error) {
      const why = (error as Error)?.message ?? String(error);
      // the one failure the user can act on
      if (why.startsWith(RATE_LIMIT_MESSAGE)) void vscode.window.showWarningMessage(why);
      set('error', undefined, why);
    }
  }

  /**
   * Find the status of a file.
   *
   * @remarks
   * Without a public origin, the archive is not asked: the file is reported
   * as not archived, with the SWHID Git computes. Otherwise the file is
   * `archived` or `not-archived`, and a file not archived whose origin is
   * archived becomes `origin-archived`.
   *
   * @param file - The real path of the file.
   * @param root - The root of the file's Git repository.
   * @param set - Records a status, and the SWHID when known.
   */
  private async fileStatus(file: string, root: string, set: (status: Status, swhid?: string) => void) {
    if (!isPublicOrigin(await this.swh.originOf(root))) {
      // as qualifiedSwhid has it: the archive is not asked
      set('not-archived', await this.swh.contentSwhid(file, root).catch(() => undefined));
      return;
    }
    const result = await this.swh.fileStatus(file, await this.swh.contentSwhid(file, root));
    set(result.archived ? 'archived' : 'not-archived', result.swhid);
    if (!result.archived) {
      const info = await this.swh.originQuiet(root).catch(() => null);
      if (info?.archived) set('origin-archived');
    }
  }

  /**
   * Find the status of a directory.
   *
   * @remarks
   * A directory is `archived` when its origin is archived and its tree, with
   * no untracked or modified files, is the one the archive holds. It is
   * `origin-archived` when only its origin is archived, `not-archived`
   * otherwise.
   *
   * @param dir - The real path of the directory.
   * @param root - The root of the directory's Git repository.
   * @param set - Records a status, and the SWHID when known.
   */
  private async dirStatus(dir: string, root: string, set: (status: Status, swhid?: string) => void) {
    const info = await this.swh.originQuiet(root);
    const tree = info?.archived && !(await this.swh.untracked(dir)) ? await this.swh.headTree(dir, root) : undefined;
    if (tree) {
      const result = await this.swh.fileStatus(dir, core('dir', tree));
      set(result.archived ? 'archived' : 'origin-archived', result.swhid);
    } else {
      set(info?.archived ? 'origin-archived' : 'not-archived');
    }
  }

  /**
   * Show the known status of the current file, or hide the item when there is none.
   *
   * @remarks
   * The text comes from the `swh.statusBar.lighters` setting, followed by
   * the API requests used this hour when there is no token. The tooltip
   * tells the status in words, the SWHID, and what a click does.
   */
  render() {
    const entry = this.current && this.entries.get(this.current.path);
    if (!this.current || !entry) {
      this.item.hide();
      return;
    }
    const lighters = { ...DEFAULT_LIGHTERS, ...config().get<Record<string, string>>('statusBar.lighters', {}) };
    const used = this.swh.rateLimitText();
    const dirty = !this.current.dir && fileEditor()?.document.isDirty;
    this.item.text = lighters[entry.status] + (used ? ` ${used}` : '');
    const tip = new vscode.MarkdownString();
    tip.appendText((dirty ? 'Modified: the status is that of the file on disk\n\n' : '') + DESCRIPTIONS[entry.status]);
    if (entry.error) tip.appendText(`: ${entry.error}`);
    tip.appendText('\n\n' + (entry.swhid ?? 'Software Heritage'));
    if (used) tip.appendText(`\n\n${used} API requests this hour, no token`);
    tip.appendText(`\n\nClick: copy the SWHID of the ${this.current.dir ? 'folder' : 'file'}`);
    this.item.tooltip = tip;
    this.item.show();
  }
}

/**
 * A stamp that changes when the file or directory at `targetPath` changes.
 *
 * @param targetPath - The path to stamp.
 * @returns `targetPath` and its modification time; `targetPath` alone when it cannot be read.
 */
async function stampOf(targetPath: string): Promise<string> {
  try {
    return `${targetPath}@${(await fs.stat(targetPath)).mtimeMs}`;
  } catch {
    return targetPath;
  }
}
