// The archival status of the current file in the status bar.

import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { RATE_LIMIT_MESSAGE, Swh } from './backend';
import { core, isPublicOrigin } from './swhid';
import { config, currentDir, fileEditor } from './ui';

export type Status = 'archived' | 'not-archived' | 'origin-archived' | 'pending' | 'error';

const DEFAULT_LIGHTERS: Record<Status, string> = {
  archived: 'SWH✓',
  'not-archived': 'SWH✗',
  'origin-archived': 'SWH~',
  pending: 'SWH…',
  error: 'SWH!',
};

const DESCRIPTIONS: Record<Status, string> = {
  archived: 'Archived by Software Heritage',
  'not-archived': 'Not archived by Software Heritage',
  'origin-archived': 'Not archived, but its origin is',
  pending: 'Checking the Software Heritage archive…',
  error: 'Software Heritage: the check failed',
};

interface Entry {
  stamp: string;
  status: Status;
  swhid?: string;
  error?: string;
  check: number;
}

export class StatusBar implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem('swh.status', vscode.StatusBarAlignment.Right, 100);
  private entries = new Map<string, Entry>();
  private checks = 0;
  private updates = 0;
  /** The path shown, and whether it is a directory. */
  current?: { path: string; dir: boolean };
  private disposables: vscode.Disposable[] = [];

  constructor(private swh: Swh) {
    this.item.name = 'Software Heritage';
    this.item.command = 'swh.statusBarCopy';
    this.disposables.push(
      this.item,
      vscode.window.onDidChangeActiveTextEditor(() => this.update()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc === vscode.window.activeTextEditor?.document) void this.update(true);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // a modified file: nothing to tell until it is saved
        if (e.document === vscode.window.activeTextEditor?.document && e.document.isDirty) this.render();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('swh')) void this.update();
      }),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  /** Forget every status: what the archive holds may have changed. */
  forget() {
    this.entries.clear();
    void this.update(true);
  }

  /** The file, or without one the workspace folder, whose status to show. */
  private async modePath(): Promise<{ path: string; dir: boolean; dirty: boolean } | undefined> {
    const editor = fileEditor();
    let p: string;
    let dir = false;
    let dirty = false;
    try {
      if (editor) {
        p = await fs.realpath(editor.document.uri.fsPath);
        dirty = editor.document.isDirty;
      } else if (!vscode.window.activeTextEditor) {
        p = await fs.realpath(currentDir());
        dir = true;
      } else {
        return undefined;
      }
    } catch {
      return undefined;
    }
    if (/[/\\]\.git([/\\]|$)/.test(p)) return undefined;
    if (!(await this.swh.git.root(p))) return undefined;
    return { path: p, dir, dirty };
  }

  /** Show the status of the current file, checking it when it changed, or with FORCE. */
  async update(force = false): Promise<void> {
    const update = ++this.updates;
    if (!config().get<boolean>('statusBar.enabled', true)) {
      this.current = undefined;
      this.item.hide();
      return;
    }
    const target = await this.modePath();
    if (update !== this.updates) return;
    this.current = target;
    if (!target) {
      this.item.hide();
      return;
    }
    const entry = this.entries.get(target.path);
    if (target.dirty) {
      this.render();
      return;
    }
    const stamp = await stampOf(target.path);
    if (update !== this.updates) return;
    if (force || !entry || entry.stamp !== stamp) {
      void this.check(target.path, target.dir, stamp);
    }
    this.render();
  }

  /** Ask for the archival status of the file, or directory, at P. */
  private async check(p: string, dir: boolean, stamp: string) {
    const check = ++this.checks;
    const set = (status: Status, swhid?: string, error?: string) => {
      const old = this.entries.get(p);
      if (old && old.check > check) return;
      this.entries.set(p, { stamp, status, swhid: swhid ?? (status === 'pending' ? undefined : old?.swhid), error, check });
      if (this.current?.path === p) this.render();
    };
    set('pending');
    try {
      const root = await this.swh.git.root(p);
      if (!root) return;
      if (dir) await this.dirStatus(p, root, set);
      else await this.fileStatus(p, root, set);
    } catch (e) {
      const why = (e as Error)?.message ?? String(e);
      // the one failure the user can act on
      if (why.startsWith(RATE_LIMIT_MESSAGE)) void vscode.window.showWarningMessage(why);
      set('error', undefined, why);
    }
  }

  private async fileStatus(file: string, root: string, set: (s: Status, swhid?: string) => void) {
    if (!isPublicOrigin(await this.swh.originOf(root))) {
      // as qualifiedSwhid has it: the archive is not asked
      set('not-archived', await this.swh.contentSwhid(file, root).catch(() => undefined));
      return;
    }
    const r = await this.swh.fileStatus(file);
    set(r.archived ? 'archived' : 'not-archived', r.swhid);
    if (!r.archived) {
      const info = await this.swh.originQuiet(root).catch(() => null);
      if (info?.archived) set('origin-archived');
    }
  }

  /** Archived when the origin and the unchanged tree are, origin-archived when only the origin is. */
  private async dirStatus(dir: string, root: string, set: (s: Status, swhid?: string) => void) {
    const info = await this.swh.originQuiet(root);
    const tree = info?.archived && !(await this.swh.untracked(dir)) ? await this.swh.headTree(dir, root) : undefined;
    if (tree) {
      const r = await this.swh.fileStatus(dir, core('dir', tree));
      set(r.archived ? 'archived' : 'origin-archived', r.swhid);
    } else {
      set(info?.archived ? 'origin-archived' : 'not-archived');
    }
  }

  /** Show the status of the current file. */
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

/** What tells that P changed: P and its modification time. */
async function stampOf(p: string): Promise<string> {
  try {
    return `${p}@${(await fs.stat(p)).mtimeMs}`;
  } catch {
    return p;
  }
}
