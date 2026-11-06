/**
 * The Scan view: which parts of the repository the archive holds.
 *
 * @remarks
 * {@link ScanView} fills the `swh.scan` tree view, in the Software Heritage
 * side bar, with the tracked working tree of the current repository. Each
 * file and directory is marked archived, partially archived or not
 * archived, and each directory shows how many of its files are archived.
 * Archived directories start folded: everything under them is archived too.
 *
 * The tree itself is computed by {@link buildScan} from the nodes the
 * backend returns; this module only displays it and handles the actions on
 * its items: open the file, open the item in the archive, copy its SWHID.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { browseUrl, buildScan, Scan, ScanItem, scanSummary, shortSwhid, Swh, UserError } from '../core';
import { config, info, openUrl } from './helpers';
import { openSwhidUri } from './reports';

/** The icon and its theme color for each scan status: a codicon name and a theme color id. */
const ICONS = {
  archived: ['pass', 'testing.iconPassed'],
  partial: ['circle-large-outline', 'list.warningForeground'],
  'not-archived': ['error', 'list.errorForeground'],
} as const;

/**
 * The data provider of the Scan view, and the actions on its items.
 *
 * @remarks
 * Item ids carry the number of the scan they come from, so that VS Code
 * does not carry the folding state of an old scan over to a new one.
 */
export class ScanView implements vscode.TreeDataProvider<ScanItem>, vscode.Disposable {
  /** Fires when the tree changes: a scan starts, ends or fails. */
  private emitter = new vscode.EventEmitter<ScanItem | undefined>();
  /** The event VS Code listens to, to redraw the tree. */
  readonly onDidChangeTreeData = this.emitter.event;
  /** The tree view this provider fills. */
  private view: vscode.TreeView<ScanItem>;
  /** The latest scan's result; undefined before the first scan and while scanning. */
  private scan?: Scan;
  /** The root of the repository scanned last. */
  private root?: string;
  /** The number of the latest scan: late answers of earlier ones are ignored. */
  private scanId = 0;
  /** The directories shown expanded, followed as the user folds and unfolds them. */
  private expanded = new Set<ScanItem>();
  /** The view and the event listeners, disposed of with the provider. */
  private disposables: vscode.Disposable[] = [];

  /**
   * Create the Scan view, empty until the first scan.
   *
   * @param swh - The backend that computes the archival status of the tree.
   * @param repoRoot - Gives the root of the current repository, or throws a
   * {@link UserError} outside one.
   */
  constructor(
    private swh: Swh,
    private repoRoot: () => Promise<string>,
  ) {
    this.view = vscode.window.createTreeView('swh.scan', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      this.view.onDidExpandElement((e) => this.expanded.add(e.element)),
      this.view.onDidCollapseElement((e) => this.expanded.delete(e.element)),
    );
  }

  /** Dispose of the view and its listeners. */
  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  /** The archive's web root, from the `swh.archiveUrl` setting. */
  private get archiveUrl() {
    return config().get<string>('archiveUrl', 'https://archive.softwareheritage.org');
  }

  /**
   * The children of an item, for VS Code.
   *
   * @param item - The item whose children to give; undefined for the top level.
   * @returns The item's children; at the top level, the repository's root,
   * or nothing before a scan, which shows the view's welcome content.
   */
  getChildren(item?: ScanItem): ScanItem[] {
    if (!this.scan) return [];
    return item ? item.children : [this.scan.root];
  }

  /**
   * The parent of an item, for VS Code to reveal items.
   *
   * @param item - The item whose parent to give.
   * @returns Its parent directory; undefined for the root.
   */
  getParent(item: ScanItem): ScanItem | undefined {
    return item.parent;
  }

  /**
   * How VS Code shows an item.
   *
   * @remarks
   * The icon tells the status. A directory's description gives its archived
   * and total file counts, e.g. `3/5`. The tooltip gives the SWHID, as a
   * link to the archive when it is archived. The context value, made of
   * `swhItem`, `dir` or `file`, and `archived`, selects the actions of the
   * item's context menu in `package.json`. Clicking a file opens it.
   *
   * @param n - The item to show.
   * @returns The tree item for `n`.
   */
  getTreeItem(n: ScanItem): vscode.TreeItem {
    const item = new vscode.TreeItem(
      n.name,
      n.children.length
        ? this.expanded.has(n)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${this.scanId}:${n.path}`;
    const [icon, color] = ICONS[n.status];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    if (n.counts) item.description = `${n.counts[1]}/${n.counts[0]}`;
    item.contextValue = ['swhItem', n.dir ? 'dir' : 'file', n.status === 'archived' ? 'archived' : '']
      .filter(Boolean)
      .join(' ');
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = { enabledCommands: ['swh.openSwhid'] };
    const status = { archived: 'archived', partial: 'partially archived', 'not-archived': 'not archived' }[n.status];
    tip.appendMarkdown(`**${n.path === '.' ? './' : n.path}**: ${status}\n\n`);
    tip.appendMarkdown(n.status === 'archived' ? `[${n.swhid}](${openSwhidUri(n.swhid)})` : n.swhid);
    item.tooltip = tip;
    if (!n.dir) item.command = { command: 'swh.scan.openFile', title: 'Open the file', arguments: [n] };
    return item;
  }

  /**
   * Scan the current repository, and show the result in the view.
   *
   * @remarks
   * The view is focused and shows "Scanning…" while the backend works. The
   * view's message then gives the repository and the figures of the scan; its description gives the
   * number of archived files. A failure is shown in the view's message. When
   * a newer scan has started meanwhile, the result is dropped.
   *
   * @throws {@link UserError} when the current directory is not in a Git repository.
   */
  async run(): Promise<void> {
    const root = await this.repoRoot();
    const id = ++this.scanId;
    this.root = root;
    this.scan = undefined;
    this.expanded.clear();
    this.view.message = `Scanning ${root}…`;
    this.view.description = undefined;
    this.emitter.fire(undefined);
    await vscode.commands.executeCommand('swh.scan.focus');
    try {
      const nodes = await vscode.window.withProgress({ location: { viewId: 'swh.scan' } }, () => this.swh.tree(root));
      if (id !== this.scanId) return;
      const scan = buildScan(nodes);
      // archived directories start folded; the root always starts unfolded
      for (const i of scan.items) if (i.dir && (i.status !== 'archived' || i === scan.root)) this.expanded.add(i);
      this.scan = scan;
      this.view.message = `${root} (tracked working tree)\n${scanSummary(scan)}`;
      this.view.description = `${scan.archivedFiles} of ${scan.files} files archived`;
      this.emitter.fire(undefined);
    } catch (e) {
      if (id !== this.scanId) return;
      this.view.message = `Scan failed: ${(e as Error)?.message ?? e}`;
      this.emitter.fire(undefined);
    }
  }

  /**
   * The item an action is about.
   *
   * @param arg - The item the action was run on, when run from its context menu or inline.
   * @returns `arg`, else the item selected in the view.
   * @throws {@link UserError} when no item is given or selected.
   */
  private item(arg?: ScanItem): ScanItem {
    const item = arg ?? this.view.selection[0];
    if (!item) throw new UserError('No file or directory selected');
    return item;
  }

  /**
   * Open a file of the scan in an editor; do nothing for a directory.
   *
   * @param arg - The item to open, else the selected one.
   * @throws {@link UserError} when no item is given or selected.
   */
  async openFile(arg?: ScanItem) {
    const item = this.item(arg);
    if (item.dir || !this.root) return;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, item.path)), { preview: true });
  }

  /**
   * Open an item in the archive's web interface, by its core SWHID.
   *
   * @param arg - The item to open, else the selected one.
   * @throws {@link UserError} when no item is given or selected.
   */
  async openInArchive(arg?: ScanItem) {
    await openUrl(browseUrl(this.archiveUrl, this.item(arg).swhid));
  }

  /**
   * Copy the core SWHID of an item to the clipboard.
   *
   * @param arg - The item whose SWHID to copy, else the selected one.
   * @throws {@link UserError} when no item is given or selected.
   */
  async copySwhid(arg?: ScanItem) {
    const swhid = this.item(arg).swhid;
    await vscode.env.clipboard.writeText(swhid);
    info(`Copied ${shortSwhid(swhid)}`);
  }
}
