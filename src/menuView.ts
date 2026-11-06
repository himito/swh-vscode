// The menu of the commands, in the Software Heritage side bar.

import * as vscode from 'vscode';
import { config } from './ui';

interface Entry {
  label: string;
  description?: string;
  icon?: string;
  command?: string;
  /** The "without context" switch. */
  toggle?: boolean;
  children?: Entry[];
}

const MENU: Entry[] = [
  {
    label: 'SWH Archive',
    children: [
      { label: 'Save', description: 'ask SWH to save code now', icon: 'cloud-upload', command: 'swh.save' },
      { label: 'Status', description: 'is the repo archived?', icon: 'info', command: 'swh.status' },
      { label: 'Scan', description: 'show what is archived', icon: 'list-tree', command: 'swh.scan' },
      { label: 'Visits', description: 'list its last visits', icon: 'history', command: 'swh.visits' },
      { label: 'Refresh', description: 'forget what may have changed', icon: 'refresh', command: 'swh.refresh' },
    ],
  },
  {
    label: 'SWHID',
    children: [
      { label: 'Without context', toggle: true },
      { label: 'Copy', description: 'of the file, selection or directory', icon: 'copy', command: 'swh.swhidCopy' },
      { label: 'Copy the archived version', description: 'the version SWH holds', icon: 'versions', command: 'swh.swhidCopyArchived' },
      { label: 'Open in the archive', icon: 'link-external', command: 'swh.swhidOpen' },
      { label: 'Copy the archive link', icon: 'link', command: 'swh.swhidCopyLink' },
      { label: 'Copy as a Markdown link', icon: 'markdown', command: 'swh.swhidCopyMarkdown' },
      { label: 'Cite', description: 'show a BibTeX entry', icon: 'quote', command: 'swh.cite' },
    ],
  },
  {
    label: 'Another repository',
    children: [
      { label: 'Status…', icon: 'info', command: 'swh.statusOther' },
      { label: 'Visits…', icon: 'history', command: 'swh.visitsOther' },
      { label: 'Save…', icon: 'cloud-upload', command: 'swh.saveOther' },
      { label: 'Cite…', icon: 'quote', command: 'swh.citeOther' },
      { label: 'Open a SWHID…', icon: 'go-to-file', command: 'swh.openSwhid' },
    ],
  },
  {
    label: 'API token',
    children: [
      { label: 'Set API token', icon: 'key', command: 'swh.setToken' },
      { label: 'Clear API token', icon: 'trash', command: 'swh.clearToken' },
    ],
  },
];

export class MenuView implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  private emitter = new vscode.EventEmitter<Entry | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private disposables: vscode.Disposable[] = [];

  constructor() {
    const view = vscode.window.createTreeView('swh.actions', { treeDataProvider: this });
    this.disposables.push(
      view,
      view.onDidChangeCheckboxState(async (e) => {
        for (const [entry, state] of e.items) {
          if (entry.toggle) {
            await config().update(
              'swhidWithoutContext',
              state === vscode.TreeItemCheckboxState.Checked,
              vscode.ConfigurationTarget.Global,
            );
          }
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('swh.swhidWithoutContext')) this.emitter.fire(undefined);
      }),
    );
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  getChildren(entry?: Entry): Entry[] {
    return entry ? entry.children ?? [] : MENU;
  }

  getTreeItem(entry: Entry): vscode.TreeItem {
    const item = new vscode.TreeItem(
      entry.label,
      entry.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `${entry.label}:${entry.command ?? ''}`;
    item.description = entry.description;
    if (entry.icon) item.iconPath = new vscode.ThemeIcon(entry.icon);
    if (entry.command) {
      item.command = { command: entry.command, title: entry.label };
      item.tooltip = `${entry.label}${entry.description ? `: ${entry.description}` : ''}`;
    }
    if (entry.toggle) {
      const bare = config().get<boolean>('swhidWithoutContext', false);
      item.checkboxState = bare ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
      item.description = bare ? 'bare SWHIDs' : 'qualified SWHIDs';
      item.tooltip = 'Whether the SWHID commands give the bare SWHID, without its context (swh.swhidWithoutContext)';
    }
    return item;
  }
}
