/**
 * The other commands: open a SWHID in the archive, and the Quick Pick menu.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { browseUrl, type Maybe, Swhid, SWHID_PREFIX } from '#core';
import { archiveUrl, openUrl, withoutContext } from '#ui/helpers';
import { MENU, type MenuEntry } from '#ui/menu';

/**
 * Checks a SWHID as the user types it.
 *
 * @param input - The text of the input box.
 * @returns Why it is not a SWHID, or `undefined` when it is.
 */
function swhidInputError(input: string): Maybe<string> {
  return Swhid.isValid(input.trim()) ? undefined : 'Not a SWHID';
}

/** An item of the Quick Pick menu: a separator, a command to run, or the "Without context" switch. */
type MenuItem = vscode.QuickPickItem & {
  /** The command to run when picked. */
  command?: string;
  /** Whether the command is a SWHID command, which takes the `bare` option. */
  takesBare?: boolean;
  /** Whether the item is the "Without context" switch. */
  toggle?: boolean;
};

/**
 * A separator of the Quick Pick menu.
 *
 * @param label - The separator's title.
 * @returns The separator.
 */
function menuSeparator(label: string): MenuItem {
  return { label, kind: vscode.QuickPickItemKind.Separator };
}

/**
 * The Quick Pick item of a menu entry.
 *
 * @remarks
 * The *Without context* switch shows its state in its icon, filled when
 * on, and in its description; it changes nothing but this use of the menu.
 *
 * @param entry - The entry, from {@link MENU}.
 * @param bare - The state of the *Without context* switch.
 * @returns The item.
 */
function menuItem(entry: MenuEntry, bare: boolean): MenuItem {
  if (entry.toggle) {
    const icon = bare ? entry.iconOn : entry.icon;
    return {
      label: `$(${icon}) ${entry.label}`,
      description: bare ? 'on: bare SWHIDs' : 'off: qualified SWHIDs',
      toggle: true,
    };
  }
  const label = entry.icon ? `$(${entry.icon}) ${entry.label}` : entry.label;
  return { label, description: entry.description, command: entry.command, takesBare: entry.takesBare };
}

/**
 * Shows the Quick Pick menu: the groups of {@link MENU} marked for it.
 *
 * @param bare - The state of the *Without context* switch.
 * @returns The item picked, or `undefined` when the menu is dismissed.
 */
function pickMenuItem(bare: boolean): Thenable<Maybe<MenuItem>> {
  const items = MENU.filter((group) => group.inQuickPick).flatMap((group) => [
    menuSeparator(group.label),
    ...group.entries.map((entry) => menuItem(entry, bare)),
  ]);
  return vscode.window.showQuickPick(items, { placeHolder: 'Software Heritage', matchOnDescription: true });
}

/** Implements the other commands: opening a SWHID, and the Quick Pick menu. */
export class MiscCommands {
  /**
   * Opens a SWHID in the archive's web interface.
   *
   * @remarks
   * Implements `swh.openSwhid`, also the target of the links on SWHIDs.
   * Without a SWHID, asks for one; dismissing the input box does nothing.
   *
   * @param swhid - The SWHID to open, with or without qualifiers.
   */
  async openSwhid(swhid?: string): Promise<void> {
    const toOpen = swhid || (await this.readSwhid());
    if (!toOpen) return;
    await openUrl(browseUrl(archiveUrl(), toOpen));
  }

  /**
   * Asks the user for a SWHID.
   *
   * @remarks
   * The input box checks the SWHID as it is typed (see {@link core!Swhid.isValid}),
   * and stays open when the focus moves away, e.g. to copy a SWHID elsewhere.
   *
   * @returns The SWHID typed, trimmed, or `undefined` when the input box is dismissed.
   */
  private async readSwhid(): Promise<Maybe<string>> {
    const input = await vscode.window.showInputBox({
      prompt: 'SWHID to open in the archive',
      placeHolder: `${SWHID_PREFIX}cnt:…`,
      ignoreFocusOut: true,
      validateInput: swhidInputError,
    });
    return input?.trim() || undefined;
  }

  /**
   * Shows a Quick Pick menu of the main commands, and runs the one picked.
   *
   * @remarks
   * Implements `swh.menu`. The "Without context" item toggles, for this use
   * of the menu only, whether the SWHID commands give bare SWHIDs; it starts
   * from the `swh.swhidWithoutContext` setting.
   */
  async menu(): Promise<void> {
    let bare = withoutContext();
    let pick = await pickMenuItem(bare);
    while (pick?.toggle) {
      bare = !bare;
      pick = await pickMenuItem(bare);
    }
    if (!pick?.command) return;
    await vscode.commands.executeCommand(pick.command, pick.takesBare ? { bare } : undefined);
  }
}
