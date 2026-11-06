// The scan of the repository as a tree view: swh-scan.

import * as path from 'path';
import * as vscode from 'vscode';
import { Swh } from './backend';
import { UserError } from './http';
import { openSwhidUri } from './reports';
import { buildScan, Scan, ScanItem, scanSummary } from './scanModel';
import { browseUrl, shortSwhid } from './swhid';
import { config, info, openUrl } from './ui';

const ICONS = {
  archived: ['pass', 'testing.iconPassed'],
  partial: ['circle-large-outline', 'list.warningForeground'],
  'not-archived': ['error', 'list.errorForeground'],
} as const;

export class ScanView implements vscode.TreeDataProvider<ScanItem>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<ScanItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private view: vscode.TreeView<ScanItem>;
  private scan?: Scan;
  private root?: string;
  /** The latest scan: late answers of earlier ones are ignored. */
  private scanId = 0;
  private expanded = new Set<ScanItem>();
  private disposables: vscode.Disposable[] = [];

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

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  private get archiveUrl() {
    return config().get<string>('archiveUrl', 'https://archive.softwareheritage.org');
  }

  getChildren(item?: ScanItem): ScanItem[] {
    if (!this.scan) return [];
    return item ? item.children : [this.scan.root];
  }

  getParent(item: ScanItem): ScanItem | undefined {
    return item.parent;
  }

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

  /** Scan the current repository. */
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
    // now: a scan may outlast what the daemon's ping is remembered for
    const via = (await this.swh.daemonAvailable()) ? 'via swhd' : "via the archive's API";
    try {
      const nodes = await vscode.window.withProgress({ location: { viewId: 'swh.scan' } }, () => this.swh.tree(root));
      if (id !== this.scanId) return;
      const scan = buildScan(nodes);
      // archived directories folded
      for (const i of scan.items) if (i.dir && (i.status !== 'archived' || i === scan.root)) this.expanded.add(i);
      this.scan = scan;
      this.view.message = `${root} (tracked working tree, ${via})\n${scanSummary(scan)}`;
      this.view.description = `${scan.archivedFiles} of ${scan.files} files archived`;
      this.emitter.fire(undefined);
    } catch (e) {
      if (id !== this.scanId) return;
      this.view.message = `Scan failed: ${(e as Error)?.message ?? e}`;
      this.emitter.fire(undefined);
    }
  }

  private item(arg?: ScanItem): ScanItem {
    const item = arg ?? this.view.selection[0];
    if (!item) throw new UserError('No file or directory selected');
    return item;
  }

  async openFile(arg?: ScanItem) {
    const item = this.item(arg);
    if (item.dir || !this.root) return;
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, item.path)), { preview: true });
  }

  async openInArchive(arg?: ScanItem) {
    await openUrl(browseUrl(this.archiveUrl, this.item(arg).swhid));
  }

  async copySwhid(arg?: ScanItem) {
    const swhid = this.item(arg).swhid;
    await vscode.env.clipboard.writeText(swhid);
    info(`Copied ${shortSwhid(swhid)}`);
  }
}
