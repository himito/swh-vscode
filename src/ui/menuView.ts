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
 * The menu's groups and entries are defined in {@link MENU}, shared with
 * the Quick Pick menu.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { config } from './helpers';
import { MENU, type MenuEntry, type MenuGroup } from './menu';
import type { Maybe } from '../core/types';

/** A node of the Menu view's tree: a group, or one of its entries. */
type MenuNode = MenuGroup | MenuEntry;

/**
 * Whether a node of the tree is a group.
 *
 * @param node - The node.
 * @returns `true` for a group, `false` for an entry.
 */
function isGroup(node: MenuNode): node is MenuGroup {
  return 'entries' in node;
}

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
 * The tree item of a group: its title, shown expanded.
 *
 * @param group - The group.
 * @returns The tree item.
 */
function groupItem(group: MenuGroup): vscode.TreeItem {
  const item = new vscode.TreeItem(group.label, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `${group.label}:`;
  return item;
}

/**
 * The tree item of an entry.
 *
 * @remarks
 * A command entry runs its command when clicked. The switch is shown as a
 * checkbox, checked when `swh.swhidWithoutContext` is on, and its
 * description tells which SWHIDs the commands give.
 *
 * @param entry - The entry.
 * @returns The tree item.
 */
function entryItem(entry: MenuEntry): vscode.TreeItem {
  const item = new vscode.TreeItem(entry.label, vscode.TreeItemCollapsibleState.None);
  item.id = `${entry.label}:${entry.command ?? ''}`;
  item.description = entry.description;
  if (entry.icon) item.iconPath = new vscode.ThemeIcon(entry.icon);
  if (entry.command) {
    item.command = { command: entry.command, title: entry.label };
    item.tooltip = entry.description ? `${entry.label}: ${entry.description}` : entry.label;
  }
  if (entry.toggle) {
    const bare = config().get<boolean>('swhidWithoutContext', false);
    item.checkboxState = bare ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked;
    item.description = bare ? 'bare SWHIDs' : 'qualified SWHIDs';
    item.tooltip = 'Whether the SWHID commands give the bare SWHID, without its context (swh.swhidWithoutContext)';
  }
  return item;
}

/**
 * The data provider of the Menu view.
 *
 * @remarks
 * The *Without context* checkbox writes the `swh.swhidWithoutContext`
 * setting, see `setWithoutContext`. The view also redraws when that
 * setting changes elsewhere, so the checkbox always reflects it.
 */
export class MenuView implements vscode.TreeDataProvider<MenuNode>, vscode.Disposable {
  /** Fires when the menu must be redrawn: the switch's setting changed. */
  private emitter = new vscode.EventEmitter<Maybe<MenuNode>>();
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
        for (const [node, state] of e.items) {
          if (!isGroup(node) && node.toggle) await setWithoutContext(state === vscode.TreeItemCheckboxState.Checked);
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
   * The children of a node, for VS Code.
   *
   * @param node - The node whose children to give; `undefined` for the top level.
   * @returns The groups at the top level, a group's entries, or nothing for an entry.
   */
  getChildren(node?: MenuNode): MenuNode[] {
    // VS Code takes a mutable array: give copies of the shared, read-only menu
    if (!node) return [...MENU];
    return isGroup(node) ? [...node.entries] : [];
  }

  /**
   * How VS Code shows a node.
   *
   * @param node - The node to show.
   * @returns The tree item for `node`: a group shown expanded, or an entry
   * that runs its command or, for the switch, is a checkbox.
   */
  getTreeItem(node: MenuNode): vscode.TreeItem {
    return isGroup(node) ? groupItem(node) : entryItem(node);
  }
}
