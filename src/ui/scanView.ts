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
import { browseUrl, buildScan, type Maybe, Scan, ScanItem, type ScanStatus, scanSummary, shortSwhid, Swh, typeOf, UserError } from '#core';
import { archiveUrl, info, openUrl } from './helpers';
import { openSwhidUri } from './reports';

/** The icon and its theme color for each scan status: a codicon name and a theme color id. */
const ICONS = {
  archived: ['pass', 'testing.iconPassed'],
  partial: ['circle-large-outline', 'list.warningForeground'],
  'not-archived': ['error', 'list.errorForeground'],
} as const satisfies Record<ScanStatus, readonly [string, string]>;

/** Each scan status in words, for the tooltips. */
const STATUS_WORDS = {
  archived: 'archived',
  partial: 'partially archived',
  'not-archived': 'not archived',
} as const satisfies Record<ScanStatus, string>;

/** What a scan item is: a directory, a file, or a submodule's commit. */
type ItemKind = 'dir' | 'file' | 'submodule';

/**
 * What a scan item is.
 *
 * @param scanItem - The item.
 * @returns Its kind; a submodule is a commit, not a file to open.
 */
function itemKind(scanItem: ScanItem): ItemKind {
  if (scanItem.dir) return 'dir';
  return typeOf(scanItem.swhid) === 'rev' ? 'submodule' : 'file';
}

/**
 * The icon of a scan item: its status, as a codicon in the status's color.
 *
 * @param scanItem - The item.
 * @returns The icon.
 */
function itemIcon(scanItem: ScanItem): vscode.ThemeIcon {
  const [icon, color] = ICONS[scanItem.status];
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
}

/**
 * The description of a scan item: a directory's archived and total file counts.
 *
 * @param scanItem - The item.
 * @returns E.g. `3/5`, or `undefined` for a file.
 */
function itemDescription(scanItem: ScanItem): Maybe<string> {
  if (!scanItem.counts) return undefined;
  const [total, archived] = scanItem.counts;
  return `${archived}/${total}`;
}

/**
 * The context value of a scan item, which selects the actions of its
 * context menu in `package.json` (`viewItem =~ /archived/`, `/file/`).
 *
 * @param scanItem - The item.
 * @returns `swhItem`, the item's kind, and `archived` when it is, separated by spaces.
 */
function itemContextValue(scanItem: ScanItem): string {
  const words = ['swhItem', itemKind(scanItem)];
  if (scanItem.status === 'archived') words.push('archived');
  return words.join(' ');
}

/**
 * The tooltip of a scan item: its path and status, and its SWHID, as a link
 * to the archive when it is archived.
 *
 * @param scanItem - The item.
 * @returns The tooltip, whose links may run `swh.openSwhid` only.
 */
function itemTooltip(scanItem: ScanItem): vscode.MarkdownString {
  const tip = new vscode.MarkdownString(undefined, true);
  tip.isTrusted = { enabledCommands: ['swh.openSwhid'] };

  const shownPath = scanItem.path === '.' ? './' : scanItem.path;
  tip.appendMarkdown(`**${shownPath}**: ${STATUS_WORDS[scanItem.status]}\n\n`);
  tip.appendMarkdown(scanItem.status === 'archived' ? `[${scanItem.swhid}](${openSwhidUri(scanItem.swhid)})` : scanItem.swhid);

  return tip;
}

/**
 * The data provider of the Scan view, and the actions on its items.
 *
 * @remarks
 * Item ids carry the number of the scan they come from, so that VS Code
 * does not carry the folding state of an old scan over to a new one.
 */
export class ScanView implements vscode.TreeDataProvider<ScanItem>, vscode.Disposable {
  /** Fires when the tree changes: a scan starts, ends or fails. */
  private emitter = new vscode.EventEmitter<Maybe<ScanItem>>();
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
   * {@link core!UserError} outside one.
   */
  constructor(
    private swh: Swh,
    private repoRoot: () => Promise<string>,
  ) {
    this.view = vscode.window.createTreeView('swh.scan', { treeDataProvider: this, showCollapseAll: true });
    this.disposables.push(
      this.view,
      this.emitter,
      this.view.onDidExpandElement((event) => this.expanded.add(event.element)),
      this.view.onDidCollapseElement((event) => this.expanded.delete(event.element)),
    );
  }

  /** Dispose of the view and its listeners. */
  dispose() {
    for (const disposable of this.disposables) disposable.dispose();
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
  getParent(item: ScanItem): Maybe<ScanItem> {
    return item.parent;
  }

  /**
   * How VS Code shows an item.
   *
   * @remarks
   * The icon tells the status. A directory's description gives its archived
   * and total file counts, e.g. `3/5`. The tooltip gives the SWHID, as a
   * link to the archive when it is archived. The context value, made of
   * `swhItem`, `dir`, `file` or `submodule`, and `archived`, selects the actions of the
   * item's context menu in `package.json`. Clicking a file opens it.
   *
   * @param scanItem - The scan item to show.
   * @returns The tree item for `scanItem`.
   */
  getTreeItem(scanItem: ScanItem): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(scanItem.name, this.collapsibleState(scanItem));
    treeItem.id = `${this.scanId}:${scanItem.path}`;
    treeItem.iconPath = itemIcon(scanItem);
    treeItem.description = itemDescription(scanItem);
    treeItem.contextValue = itemContextValue(scanItem);
    treeItem.tooltip = itemTooltip(scanItem);

    if (itemKind(scanItem) === 'file') {
      treeItem.command = { command: 'swh.scan.openFile', title: 'Open the file', arguments: [scanItem] };
    }

    return treeItem;
  }

  /**
   * Whether a scan item is shown folded, unfolded, or cannot be.
   *
   * @param scanItem - The item.
   * @returns `None` without children, else `Expanded` for the items unfolded
   * after a scan, `Collapsed` for the others.
   */
  private collapsibleState(scanItem: ScanItem): vscode.TreeItemCollapsibleState {
    if (!scanItem.children.length) return vscode.TreeItemCollapsibleState.None;
    return this.expanded.has(scanItem) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
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
   * @throws {@link core!UserError} when the current directory is not in a Git repository.
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
      for (const scanItem of scan.items) {
        const unfolded = scanItem.dir && (scanItem.status !== 'archived' || scanItem === scan.root);
        if (unfolded) this.expanded.add(scanItem);
      }
      this.scan = scan;
      this.view.message = `${root} (tracked working tree)\n${scanSummary(scan)}`;
      this.view.description = `${scan.archivedFiles} of ${scan.files} files archived`;
      this.emitter.fire(undefined);
    } catch (error) {
      if (id !== this.scanId) return;
      this.view.message = `Scan failed: ${(error as Error)?.message ?? error}`;
      this.emitter.fire(undefined);
    }
  }

  /**
   * The item an action is about.
   *
   * @param arg - The item the action was run on, when run from its context menu or inline.
   * @returns `arg`, else the item selected in the view.
   * @throws {@link core!UserError} when no item is given or selected.
   */
  private item(arg?: ScanItem): ScanItem {
    const item = arg ?? this.view.selection[0];
    if (!item) throw new UserError('No file or directory selected');
    return item;
  }

  /**
   * Open a file of the scan in an editor; do nothing for a directory or a submodule.
   *
   * @param arg - The item to open, else the selected one.
   * @throws {@link core!UserError} when no item is given or selected.
   */
  async openFile(arg?: ScanItem) {
    const item = this.item(arg);
    if (item.dir || typeOf(item.swhid) === 'rev' || !this.root) return;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, item.path)), { preview: true });
  }

  /**
   * Open an item in the archive's web interface, by its core SWHID.
   *
   * @param arg - The item to open, else the selected one.
   * @throws {@link core!UserError} when no item is given or selected.
   */
  async openInArchive(arg?: ScanItem) {
    await openUrl(browseUrl(archiveUrl(), this.item(arg).swhid));
  }

  /**
   * Copy the core SWHID of an item to the clipboard.
   *
   * @param arg - The item whose SWHID to copy, else the selected one.
   * @throws {@link core!UserError} when no item is given or selected.
   */
  async copySwhid(arg?: ScanItem) {
    const swhid = this.item(arg).swhid;
    await vscode.env.clipboard.writeText(swhid);
    info(`Copied ${shortSwhid(swhid)}`);
  }
}
