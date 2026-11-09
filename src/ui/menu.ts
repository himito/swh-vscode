/**
 * The extension's menu of commands, shared by the Menu view and the Quick Pick menu.
 *
 * @remarks
 * {@link MENU} is the one definition of the menu: its groups, and their
 * entries in order. The Menu view (see `menuView.ts`) shows every group in
 * the side bar; the Quick Pick menu (see {@link MiscCommands.menu}) shows the
 * groups marked {@link MenuGroup.inQuickPick}. Each draws the entries its own
 * way, including the *Without context* switch.
 *
 * To add a command to both menus, add a {@link MenuEntry} to {@link MENU}.
 *
 * @packageDocumentation
 */

/** An entry of the menu: a command, or the *Without context* switch. */
export type MenuEntry = {
  /** The text shown. */
  label: string;
  /** Shown after the label, dimmed. */
  description?: string;
  /** The name of the codicon shown before the label, e.g. `copy`; for the switch, when off. */
  icon?: string;
  /** For the switch, the codicon shown when on. */
  iconOn?: string;
  /** The id of the command the entry runs. */
  command?: string;
  /** Whether the command is a SWHID command, which takes the `bare` option. */
  takesBare?: boolean;
  /** Whether the entry is the *Without context* switch. */
  toggle?: boolean;
};

/** A group of the menu, shown under its title. */
export type MenuGroup = {
  /** The group's title. */
  label: string;
  /** Whether the Quick Pick menu shows the group too, not only the Menu view. */
  inQuickPick: boolean;
  /** The group's entries, in order. */
  entries: readonly MenuEntry[];
};

/** The menu: its groups, and their entries in order. */
export const MENU: readonly MenuGroup[] = [
  {
    label: 'SWH Archive',
    inQuickPick: true,
    entries: [
      { label: 'Save', description: 'ask SWH to save code now', icon: 'cloud-upload', command: 'swh.save' },
      { label: 'Status', description: 'is the repo archived?', icon: 'info', command: 'swh.status' },
      { label: 'Scan', description: 'show what is archived', icon: 'list-tree', command: 'swh.scan' },
      { label: 'Visits', description: 'list its last visits', icon: 'history', command: 'swh.visits' },
      { label: 'Refresh', description: 'forget what may have changed', icon: 'refresh', command: 'swh.refresh' },
    ],
  },
  {
    label: 'SWHID',
    inQuickPick: true,
    entries: [
      { label: 'Without context', icon: 'filter', iconOn: 'filter-filled', toggle: true },
      { label: 'Copy', description: 'SWHID of the file, selection or directory', icon: 'copy', command: 'swh.swhidCopy', takesBare: true },
      { label: 'Copy the archived version', description: 'SWHID of the version SWH holds', icon: 'versions', command: 'swh.swhidCopyArchived', takesBare: true },
      { label: 'Open in the archive', icon: 'link-external', command: 'swh.swhidOpen', takesBare: true },
      { label: 'Copy the archive link', icon: 'link', command: 'swh.swhidCopyLink', takesBare: true },
      { label: 'Copy as a Markdown link', icon: 'markdown', command: 'swh.swhidCopyMarkdown', takesBare: true },
      { label: 'Cite', description: 'show a BibTeX entry', icon: 'quote', command: 'swh.cite' },
    ],
  },
  {
    label: 'Another repository',
    inQuickPick: false,
    entries: [
      { label: 'Status…', icon: 'info', command: 'swh.statusOther' },
      { label: 'Visits…', icon: 'history', command: 'swh.visitsOther' },
      { label: 'Save…', icon: 'cloud-upload', command: 'swh.saveOther' },
      { label: 'Cite…', icon: 'quote', command: 'swh.citeOther' },
      { label: 'Open a SWHID…', icon: 'go-to-file', command: 'swh.openSwhid' },
    ],
  },
  {
    label: 'API token',
    inQuickPick: false,
    entries: [
      { label: 'Set API token', icon: 'key', command: 'swh.setToken' },
      { label: 'Clear API token', icon: 'trash', command: 'swh.clearToken' },
    ],
  },
];
