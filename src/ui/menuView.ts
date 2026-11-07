/**
 * The Menu view: the extension's commands, in the Software Heritage side bar.
 *
 * @remarks
 * {@link MenuView} fills the `swh.actions` tree view with the commands, in
 * groups. Clicking an entry runs its command, on the current file,
 * selection or folder, as from the Command Palette. One entry is a
 * checkbox: *Without context* switches the `swh.swhidWithoutContext`
 * setting, which makes the SWHID commands give bare SWHIDs.
 *
 * To add a command to the menu, add an {@link Entry} to {@link MENU}.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { config } from './helpers';
import type { Maybe } from '../core/types';

/** An entry of the menu: a group, a command, or the *Without context* switch. */
type Entry = {
  /** The text shown. */
  label: string;
  /** Shown after the label, dimmed. */
  description?: string;
  /** The name of the codicon shown before the label, e.g. `copy`. */
  icon?: string;
  /** The id of the command the entry runs. */
  command?: string;
  /** Whether the entry is the "without context" switch, shown as a checkbox. */
  toggle?: boolean;
  /** The entries of a group; a group is shown expanded. */
  children?: Entry[];
};

/** The menu: its groups, and their entries in order. */
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

/**
 * Sets `swh.swhidWithoutContext`, as the Menu view's checkbox does.
 *
 * @remarks
 * The value is written to the workspace settings when they already define
 * it, else to the user's global settings: writing the global value under a
 * workspace value would change nothing. A failed write is reported to the
 * user.
 *
 * @param value - Whether to copy SWHIDs without their context qualifiers.
 */
async function setWithoutContext(value: boolean): Promise<void> {
  const inWorkspace = config().inspect<boolean>('swhidWithoutContext')?.workspaceValue !== undefined;
  const target = inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  try {
    await config().update('swhidWithoutContext', value, target);
  } catch (e) {
    void vscode.window.showErrorMessage(`Software Heritage: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * The data provider of the Menu view.
 *
 * @remarks
 * The *Without context* checkbox writes the `swh.swhidWithoutContext`
 * setting, see `setWithoutContext`. The view also redraws when that
 * setting changes elsewhere, so the checkbox always reflects it.
 */
export class MenuView implements vscode.TreeDataProvider<Entry>, vscode.Disposable {
  /** Fires when the menu must be redrawn: the switch's setting changed. */
  private emitter = new vscode.EventEmitter<Maybe<Entry>>();
  /** The event VS Code listens to, to redraw the menu. */
  readonly onDidChangeTreeData = this.emitter.event;
  /** The view and the event listeners, disposed of with the provider. */
  private disposables: vscode.Disposable[] = [];

  /** Create the Menu view, and follow its checkbox and the setting it switches. */
  constructor() {
    const view = vscode.window.createTreeView('swh.actions', { treeDataProvider: this });
    this.disposables.push(
      view,
      this.emitter,
      view.onDidChangeCheckboxState(async (e) => {
        for (const [entry, state] of e.items) {
          if (entry.toggle) await setWithoutContext(state === vscode.TreeItemCheckboxState.Checked);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('swh.swhidWithoutContext')) this.emitter.fire(undefined);
      }),
    );
  }

  /** Dispose of the view and its listeners. */
  dispose() {
    for (const d of this.disposables) d.dispose();
  }

  /**
   * The children of an entry, for VS Code.
   *
   * @param entry - The entry whose children to give; undefined for the top level.
   * @returns The entries of a group, nothing for a command, or the groups at the top level.
   */
  getChildren(entry?: Entry): Entry[] {
    return entry ? entry.children ?? [] : MENU;
  }

  /**
   * How VS Code shows an entry.
   *
   * @remarks
   * Groups are shown expanded. A command entry runs its command when
   * clicked. The switch is shown as a checkbox, checked when
   * `swh.swhidWithoutContext` is on, and its description tells which SWHIDs
   * the commands give.
   *
   * @param entry - The entry to show.
   * @returns The tree item for `entry`.
   */
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
