/**
 * The extension's user-facing commands: archival status, visits, save
 * requests, SWHIDs, citations and the Quick Pick menu.
 *
 * @remarks
 * Each public method of {@link Commands} implements one or more commands
 * registered in `extension.ts`. They work on "where the user is": the file
 * in the active editor (and its selected lines), a file or folder given by a
 * context menu, or else the current folder (see {@link Commands.target}).
 * They talk to the archive through {@link Swh}, show their results with the
 * helpers of `helpers.ts`, and report problems by throwing {@link core!UserError}.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as vscode from 'vscode';
import {
  bibtex,
  browseUrl,
  Cancelled,
  citationWhat,
  core,
  formatDate,
  isPublicOrigin,
  isSwhid,
  normalizeOrigin,
  originBibtex,
  parseOrigin,
  type OriginInfo,
  type OriginVisits,
  type SaveRequest,
  qualifiers,
  shortHash,
  type Swh,
  type SwhidInfo,
  UserError,
  type Visit,
} from '../core';
import { MENU, type MenuEntry } from './menu';
import type { Reports } from './reports';
import { ask, busy, config, fileEditor, info, openUrl, realCurrentDir, realpath, selectionLines } from './helpers';
import type { Maybe } from '../core/types';

/**
 * What a SWHID command produces.
 *
 * @remarks
 * - `swhid`: the SWHID, qualified or bare.
 * - `link`: the archive's permalink to it.
 * - `open`: opens it in the archive; copies the SWHID when not archived.
 * - `bibtex`: a BibTeX entry citing it.
 * - `archived`: the SWHID of the version the archive holds.
 * - `markdown`: a Markdown link to it, `[file, lines A-B](permalink)`.
 */
export type What = 'swhid' | 'link' | 'open' | 'bibtex' | 'archived' | 'markdown';

/**
 * The options a SWHID command accepts when not run on a `Uri`.
 *
 * @remarks
 * Passed from a keybinding (`"args": { "bare": true }`), the menus, or the
 * status bar item (`path`).
 */
export type CommandOptions = {
  /** Whether to give the bare SWHID, without its context; overrides `swh.swhidWithoutContext`. */
  bare?: boolean;
  /** The path of the file or directory to act on. */
  path?: string;
};

/**
 * The argument a SWHID command receives.
 *
 * @remarks
 * A `Uri` when run from the editor's or the Explorer's context menu;
 * {@link CommandOptions} from a keybinding, the menus, or the status bar item;
 * `undefined` from the Command Palette.
 */
export type CommandArg = vscode.Uri | CommandOptions | undefined;

/** What a SWHID command is about: a file, possibly some of its lines, or a directory. */
export type Target = {
  /** The real path of the file or directory. */
  path: string;
  /** The selected lines, `"A-B"` or `"A"`, for a file in the active editor. */
  lines?: string;
};

/** What a SWHID command asks {@link Commands.swhidText} to produce. */
type SwhidRequest = {
  /** What to produce. */
  what: What;
  /** Whether to use the bare SWHID rather than the qualified one. */
  bare: boolean;
  /** The target's path, for the Markdown link's text and the citation's repository. */
  targetPath: string;
};

/** A SWHID command's text, and a label saying what it is for the messages. */
type LabeledText = {
  /** The text copied or opened: a SWHID, a permalink, a Markdown link or a BibTeX entry. */
  text: string;
  /** What the text is, e.g. "qualified SWHID"; messages read `Copied ${label}`. */
  label: string;
};

/** A SWHID command's text and label, with the SWHID it comes from. */
type SwhidResult = LabeledText & {
  /** The target's SWHID, as the backend computed it. */
  swhidInfo: SwhidInfo;
};

/** An origin's archival status in words, from {@link Commands.statusText}. */
export type StatusText = {
  /** The description, e.g. `https://github.com/owner/repo is archived (last visit …)`. */
  text: string;
  /** Whether a save request would help: the origin is not archived, or its upstream commit is not yet. */
  saveWouldHelp: boolean;
};

/**
 * Called after a save request or a refresh, when what the archive holds may
 * have changed, e.g. to recheck the status bar.
 */
export type ArchiveChangeHandler = () => void;

/**
 * Whether a SWHID command is about the active editor's file.
 *
 * @param editor - The active editor, on a local file.
 * @param uri - The file or folder the command names, if any.
 * @returns `true` when no file or folder is named, or it is the editor's file.
 */
function isEditorTarget(editor: vscode.TextEditor, uri?: vscode.Uri): boolean {
  if (!uri) return true;
  return uri.toString() === editor.document.uri.toString();
}

/** The width of the status column in the visits report, so that the snapshots line up. */
const VISIT_STATUS_WIDTH = 8;

/**
 * One line of the visits report: the visit's date, status and snapshot.
 *
 * @param visit - The visit.
 * @returns The line, its snapshot as a full SWHID so that it becomes a link.
 */
function visitLine(visit: Visit): string {
  const date = formatDate(visit.date);
  const status = visit.status.padEnd(VISIT_STATUS_WIDTH);
  const snapshot = visit.snapshot ? core('snp', visit.snapshot) : '';
  return `${date}  ${status} ${snapshot}`.trimEnd();
}

/**
 * Tells a save request's answer in words.
 *
 * @remarks
 * A refused request never gets here: the archive answers it with an HTTP 403, an error.
 *
 * @param request - The save request, as the archive answered it.
 * @returns The message for the user.
 */
function saveRequestText({ origin, status }: SaveRequest): string {
  switch (status) {
    case 'accepted':
      return `Save request accepted for ${origin}`;
    case 'pending':
      return `Save request for ${origin} awaits review by Software Heritage`;
    default:
      return `Save request for ${origin}: ${status}`;
  }
}

/**
 * A SWHID without its context qualifiers, but with its lines.
 *
 * @param coreSwhid - The core SWHID, e.g. `swh:1:cnt:…`.
 * @param lines - The lines, if any.
 * @returns The SWHID, e.g. `swh:1:cnt:…;lines=3-7`.
 */
function bareSwhid(coreSwhid: string, lines: Maybe<string>): string {
  return lines ? `${coreSwhid};lines=${lines}` : coreSwhid;
}

/**
 * A Markdown link to a target in the archive, `[file, lines A-B](url)`.
 *
 * @param targetPath - The target's path; its base name is the link's text.
 * @param lines - The lines, if any.
 * @param url - The archive's permalink.
 * @returns The link.
 */
function markdownLink(targetPath: string, lines: Maybe<string>, url: string): string {
  const name = path.basename(targetPath);
  const text = lines ? `${name}, lines ${lines}` : name;
  return `[${text}](${url})`;
}

/**
 * Says which kind of SWHID was produced, for the messages.
 *
 * @param bare - Whether it is the bare SWHID.
 * @param ofArchivedVersion - Whether it is the SWHID of the version the archive holds.
 * @returns The label, e.g. "qualified SWHID".
 */
function swhidLabel(bare: boolean, ofArchivedVersion: boolean): string {
  if (ofArchivedVersion) return bare ? 'SWHID w/o context of SWH-archived version' : 'SWHID of SWH-archived version';
  return bare ? 'SWHID w/o context' : 'qualified SWHID';
}

/**
 * Checks a SWHID as the user types it.
 *
 * @param input - The text of the input box.
 * @returns Why it is not a SWHID, or `undefined` when it is.
 */
function swhidInputError(input: string): Maybe<string> {
  return isSwhid(input.trim()) ? undefined : 'Not a SWHID';
}

/**
 * Checks a repository URL as the user types it.
 *
 * @param input - The text of the input box.
 * @returns Why it is not a valid repository URL, or `undefined` when it is.
 */
function originInputError(input: string): Maybe<string> {
  try {
    parseOrigin(input);
    return undefined;
  } catch (e) {
    if (e instanceof UserError) return e.message;
    throw e;
  }
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
 * The *Without context* switch shows its state in its icon and description;
 * it changes nothing but this use of the menu.
 *
 * @param entry - The entry, from {@link MENU}.
 * @param bare - The state of the *Without context* switch.
 * @returns The item.
 */
function menuItem(entry: MenuEntry, bare: boolean): MenuItem {
  if (entry.toggle) {
    return {
      label: `$(${bare ? 'pass-filled' : 'circle-large-outline'}) ${entry.label}`,
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

/** Implements the extension's commands. */
export class Commands {
  /**
   * Creates the commands.
   *
   * @param swh - The backend that talks to Git and the archive.
   * @param reports - Where the visits and citation reports are shown.
   * @param onArchiveChange - Called when what the archive holds may have changed.
   */
  constructor(
    private swh: Swh,
    private reports: Reports,
    private onArchiveChange: ArchiveChangeHandler,
  ) { }

  /** The archive's web root, from the `swh.archiveUrl` setting. */
  private get archiveUrl() {
    return config().get<string>('archiveUrl', 'https://archive.softwareheritage.org');
  }

  /**
   * The root of the Git repository of the current directory.
   *
   * @returns The repository's root.
   * @throws {@link core!UserError} when no file or folder is open, or the current
   * directory is not inside a Git repository.
   */
  async repoRoot(): Promise<string> {
    const root = await this.swh.git.root(await realCurrentDir());
    if (!root) throw new UserError('Not inside a Git repository');
    return root;
  }

  /**
   * The public origin of the current directory's repository.
   *
   * @returns The origin, normalized as the archive names it, or `undefined`
   * when there is no repository, no remote, or the remote is not a public
   * URL.
   */
  async localOrigin(): Promise<Maybe<string>> {
    let root: string;
    try {
      root = await this.repoRoot();
    } catch (e) {
      if (e instanceof UserError) return undefined;
      throw e;
    }

    const origin = await this.swh.originOf(root);
    return isPublicOrigin(origin) ? origin : undefined;
  }

  /**
   * Asks the user for the URL of a public repository.
   *
   * @remarks
   * The input box checks the URL as it is typed (see {@link core!parseOrigin}),
   * so it cannot be accepted until it is a valid repository URL.
   *
   * @param prompt - The prompt of the input box.
   * @param def - The URL proposed in the input box.
   * @returns The normalized origin.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   */
  async readOrigin(prompt: string, def?: string): Promise<string> {
    const input = await vscode.window.showInputBox({
      prompt,
      value: def,
      placeHolder: 'https://github.com/owner/repository',
      ignoreFocusOut: true,
      validateInput: originInputError,
    });
    if (input === undefined) throw new Cancelled();
    return parseOrigin(input);
  }

  /**
   * The origin a command about "another repository" works on.
   *
   * @remarks
   * Asks for a repository URL when `askOrigin` is set, or when the current
   * repository has no public origin; the current origin, if any, is proposed.
   *
   * @param action - What the command does to the origin, for the prompt, e.g. "check".
   * @param askOrigin - Whether to ask even when there is a public origin here.
   * @returns The origin asked for, or `undefined` to use the current repository.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   */
  async originArg(action: string, askOrigin: boolean): Promise<Maybe<string>> {
    const local = await this.localOrigin();
    if (!askOrigin && local) return undefined;
    const prompt = local ? `Origin to ${action}` : `No public origin here; origin to ${action}`;
    return this.readOrigin(prompt, local);
  }

  /**
   * The file (with its selected lines) or directory a SWHID command is about.
   *
   * @remarks
   * In order: the file or folder `resource` names, when it is not the active
   * editor's file; else the active editor's file, with its selected lines;
   * else the current directory. A modified file is offered to be saved first.
   * Symbolic links are resolved.
   *
   * @param resource - A file or folder from a context menu or the status bar, if any.
   * @returns The target.
   * @throws {@link core!UserError} when `resource` is not a local file, the path does not
   * exist, the user declines to save a modified file, or the current
   * directory is not inside a Git repository.
   */
  async target(resource?: vscode.Uri | string): Promise<Target> {
    const uri = typeof resource === 'string' ? vscode.Uri.file(resource) : resource;
    const editor = fileEditor();
    if (editor && isEditorTarget(editor, uri)) return this.editorTarget(editor);
    if (uri) return this.uriTarget(uri);
    return this.currentDirTarget();
  }

  /**
   * The target for a file or folder given explicitly.
   *
   * @remarks
   * A file open in an editor, though not the active one, may be modified:
   * it is offered to be saved first, as the active editor's file is.
   *
   * @param uri - The file or folder.
   * @returns Its real path.
   * @throws {@link core!UserError} when `uri` is not a local file, does not
   * exist, or the user declines to save it when modified.
   */
  private async uriTarget(uri: vscode.Uri): Promise<Target> {
    if (uri.scheme !== 'file') throw new UserError('Remote files are not supported');
    const openDoc = vscode.workspace.textDocuments.find((doc) => doc.uri.toString() === uri.toString());
    if (openDoc) await this.ensureSaved(openDoc);
    return { path: await realpath(uri.fsPath) };
  }

  /**
   * The target for the active editor's file, with its selected lines.
   *
   * @param editor - The active editor, on a local file.
   * @returns The file's real path (a symbolic link stands for its target) and selected lines.
   * @throws {@link core!UserError} when the user declines to save a modified file.
   */
  private async editorTarget(editor: vscode.TextEditor): Promise<Target> {
    await this.ensureSaved(editor.document);
    return { path: await realpath(editor.document.uri.fsPath), lines: selectionLines(editor) };
  }

  /**
   * The target for the current directory.
   *
   * @returns The current directory's real path.
   * @throws {@link core!UserError} when the current directory is not inside a Git repository.
   */
  private async currentDirTarget(): Promise<Target> {
    const dir = await realCurrentDir();
    if (!(await this.swh.git.root(dir))) throw new UserError('Not inside a Git repository');
    return { path: dir };
  }

  /**
   * Saves a modified document, after asking, since a SWHID identifies the file on disk.
   *
   * @param doc - The document.
   * @throws {@link core!UserError} when the user declines to save it.
   */
  private async ensureSaved(doc: vscode.TextDocument): Promise<void> {
    if (!doc.isDirty) return;
    if (!(await ask('The file is modified; save it first?', 'Save'))) {
      throw new UserError('A SWHID identifies the file on disk: save it first');
    }
    await doc.save();
  }

  /**
   * Whether a SWHID command gives the bare SWHID, without its context.
   *
   * @param arg - The command's argument; its `bare` option wins.
   * @returns The `bare` option when given, else the `swh.swhidWithoutContext` setting.
   */
  private bare(arg: CommandArg): boolean {
    if (arg && !(arg instanceof vscode.Uri) && typeof arg.bare === 'boolean') return arg.bare;
    return config().get<boolean>('swhidWithoutContext', false);
  }

  /**
   * The file or folder a command's argument names, if any.
   *
   * @param arg - The command's argument.
   * @returns The `Uri` from a context menu, the `path` option, or `undefined`.
   */
  private uriOf(arg: CommandArg): vscode.Uri | string | undefined {
    if (arg instanceof vscode.Uri) return arg;
    return arg?.path;
  }

  /**
   * Describes an origin's archival status in words.
   *
   * @param origin - The origin's archival status.
   * @returns The description, and whether a save request would help.
   */
  statusText(origin: OriginInfo): StatusText {
    const url = origin.origin;
    if (!origin.archived) return { text: `${url} is not archived`, saveWouldHelp: true };

    const { upstream } = origin;
    const lastVisit = `last visit ${origin.date ? formatDate(origin.date) : 'unknown'}`;

    if (upstream && !origin['upstream-archived']) {
      return { text: `${url} is archived (${lastVisit}), upstream ${shortHash(upstream)} not yet`, saveWouldHelp: true };
    }

    const upstreamNote = upstream ? ', upstream included' : '';
    return { text: `${url} is archived${upstreamNote} (${lastVisit})`, saveWouldHelp: false };
  }

  /**
   * Reports an origin's archival status, offering a save request when it would help.
   *
   * @param origin - The archival status to report.
   * @param asked - The origin the user asked about, or `undefined` for the
   * current repository; it decides what a save request is for.
   * @throws {@link core!UserError} as {@link Commands.doSave} does, when the
   * user accepts the save request.
   */
  async reportStatus(origin: OriginInfo, asked?: string): Promise<void> {
    const { text, saveWouldHelp } = this.statusText(origin);
    if (saveWouldHelp) {
      if (await ask(`${text}. Ask Software Heritage to save it now?`, 'Save now')) {
        await this.doSave(asked ? origin.origin : undefined);
      }
    } else {
      info(text);
    }
  }

  /**
   * Tells whether the repository is archived, and its upstream commit too.
   *
   * @remarks
   * Implements `swh.status` and, with `askOrigin`, `swh.statusOther`.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @defaultValue `askOrigin` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async status(askOrigin = false): Promise<void> {
    const origin = await this.originArg('check', askOrigin);
    const originInfo = await busy('Software Heritage: checking the archival status…', () => this.fetchOriginInfo(origin));
    await this.reportStatus(originInfo, origin);
  }

  /**
   * Asks the archive for an origin's archival status.
   *
   * @param origin - The repository URL the user gave, or `undefined` for the
   * current repository, whose upstream commit is then checked too.
   * @returns The origin's archival status.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  private async fetchOriginInfo(origin: Maybe<string>): Promise<OriginInfo> {
    if (origin) return this.swh.originStatus(origin);
    const withUpstream = true;
    return this.swh.origin(await this.repoRoot(), withUpstream);
  }

  /**
   * The visits report's text: one line per visit, with its date, status and snapshot.
   *
   * @param origin - The origin visited.
   * @param visits - Its visits, most recent first, as the archive lists them.
   * @returns The report, its snapshots as full SWHIDs so that they become links.
   */
  visitsText(origin: string, visits: Visit[]): string {
    const header = `Last ${visits.length} archival visits of ${origin}`;
    const lines = visits.map(visitLine);
    return `${header}\n\n` + lines.map((line) => `${line}\n`).join('');
  }

  /**
   * Lists the last archival visits of the repository's origin in a report.
   *
   * @remarks
   * Implements `swh.visits` and, with `askOrigin`, `swh.visitsOther`. When the
   * origin is not archived, says so instead of showing an empty report.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @defaultValue `askOrigin` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async visits(askOrigin = false): Promise<void> {
    const origin = await this.originArg('list the visits of', askOrigin);
    const originVisits = await busy('Software Heritage: listing the visits…', () => this.fetchVisits(origin));

    if (!originVisits.visits.length) {
      info(`${originVisits.origin} is not archived`);
      return;
    }
    await this.reports.show('swh visits.txt', this.visitsText(originVisits.origin, originVisits.visits));
  }

  /**
   * Asks the archive for an origin's visits.
   *
   * @param origin - The repository URL the user gave, or `undefined` for the current repository.
   * @returns The origin URL and its visits, most recent first; none when it is not archived.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  private async fetchVisits(origin: Maybe<string>): Promise<OriginVisits> {
    if (origin) return this.swh.visits(undefined, origin);
    return this.swh.visits(await this.repoRoot());
  }

  /**
   * Asks Software Heritage to archive the repository now.
   *
   * @remarks
   * Implements `swh.save` and, with `askOrigin`, `swh.saveOther`.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @defaultValue `askOrigin` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} as {@link Commands.doSave} does.
   */
  async save(askOrigin = false): Promise<void> {
    await this.doSave(await this.originArg('save', askOrigin));
  }

  /**
   * Sends a save request and tells its answer.
   *
   * @remarks
   * A request is accepted at once, or waits for review by Software Heritage;
   * a refused request is an HTTP error. Once the archive has answered, what it
   * holds may change, so {@link Commands.onArchiveChange} is called.
   *
   * @param origin - The public origin to save, or `undefined` for the current repository.
   * @throws {@link core!UserError} when there is no repository or remote, the
   * origin is not a public URL, or the archive cannot be reached or refuses
   * the request.
   */
  async doSave(origin?: string): Promise<void> {
    const what = origin ?? 'this repository';
    const request = await busy(`Software Heritage: sending the save request for ${what}…`, () => this.sendSaveRequest(origin));
    this.onArchiveChange();
    info(saveRequestText(request));
  }

  /**
   * Sends a save request to the archive.
   *
   * @param origin - The public origin to save, or `undefined` for the current repository.
   * @returns The save request, as the archive answered it.
   * @throws {@link core!UserError} as {@link Commands.doSave} does.
   */
  private async sendSaveRequest(origin: Maybe<string>): Promise<SaveRequest> {
    if (origin) return this.swh.saveOrigin(origin);
    return this.swh.save(await this.repoRoot());
  }

  /**
   * Forgets what may have changed in the archive, and checks the status bar again.
   *
   * @remarks
   * Implements `swh.refresh`. What the archive holds stays remembered; the
   * negative answers and the origins' statuses are forgotten.
   */
  async refresh(): Promise<void> {
    this.swh.refresh();
    this.onArchiveChange();
    info('Forgot what may have changed in the Software Heritage archive');
  }

  /**
   * The text a SWHID command produces, and a label saying what it is.
   *
   * @param swhidInfo - The SWHID of the target, as the backend computed it.
   * @param request - What to produce, and for which target.
   * @returns The text, and its label for the messages.
   * @throws {@link core!UserError} as {@link Commands.bibtexText} does, for a citation.
   */
  private async swhidText(swhidInfo: SwhidInfo, { what, bare, targetPath }: SwhidRequest): Promise<LabeledText> {
    // the lines the SWHID kept: dropped for an archived version that differs
    const lines: Maybe<string> = qualifiers(swhidInfo.swhid).lines;
    if (what === 'bibtex') return this.bibtexText(swhidInfo, lines, targetPath);

    const swhid = bare ? bareSwhid(swhidInfo.core, lines) : swhidInfo.swhid;
    switch (what) {
      case 'link':
        return { text: browseUrl(this.archiveUrl, swhid), label: bare ? 'permalink w/o context' : 'SWH archive permalink' };
      case 'markdown':
        return { text: markdownLink(targetPath, lines, browseUrl(this.archiveUrl, swhid)), label: 'Markdown link to the SWH archive' };
      default:
        // not archived, open opens nothing and archived finds no version: the SWHID is copied instead
        return { text: swhid, label: swhidLabel(bare, swhidInfo.archived && what === 'archived') };
    }
  }

  /**
   * A BibTeX entry citing a SWHID, and a label saying what it cites.
   *
   * @param swhidInfo - The SWHID to cite.
   * @param lines - The cited lines, if any.
   * @param targetPath - The target's path, to find the repository whose metadata the entry uses.
   * @returns The entry, and its label for the messages.
   * @throws {@link core!UserError} when Git fails.
   */
  private async bibtexText(swhidInfo: SwhidInfo, lines: Maybe<string>, targetPath: string): Promise<LabeledText> {
    const repoRoot = await this.swh.git.root(targetPath);
    const [entry, why] = await bibtex(this.swh, swhidInfo, lines, repoRoot);
    return { text: entry, label: citationWhat(why) };
  }

  /**
   * Copies the SWHID, link, citation or Markdown link of the current file,
   * selection or directory, or opens it in the archive.
   *
   * @remarks
   * Implements the `swh.swhid*` commands. The message tells what was copied
   * and, when the archive does not hold it, why; when nothing explains it,
   * it offers a save request. With `open`, a target the archive does not
   * hold is copied instead of opened. For `archived`, the selected lines are
   * dropped when the archived version differs from the working tree's.
   *
   * @param what - What to produce.
   * @param arg - The command's argument: the target, or the `bare` option.
   * @returns The text copied or opened.
   * @throws {@link core!UserError} when there is no target, it is not a local file,
   * the user declines to save a modified file, Git fails, or a save request
   * the user accepts fails.
   */
  async swhidCopy(what: What, arg?: CommandArg): Promise<string> {
    const bare = this.bare(arg);
    const target = await this.target(this.uriOf(arg));
    const { swhidInfo, text, label } = await busy('Software Heritage: computing the SWHID…', () =>
      this.computeSwhidText(target, { what, bare, targetPath: target.path }),
    );

    if (what === 'open' && swhidInfo.archived) {
      await openUrl(browseUrl(this.archiveUrl, text));
      info('Opening in the Software Heritage archive');
      return text;
    }

    await vscode.env.clipboard.writeText(text);
    await this.reportCopied(swhidInfo, label, target.path);
    return text;
  }

  /**
   * Computes a target's SWHID, and the text a SWHID command produces from it.
   *
   * @param target - The file (with its selected lines) or directory.
   * @param request - What to produce.
   * @returns The SWHID as the backend computed it, the text, and its label.
   * @throws {@link core!UserError} when Git fails.
   */
  private async computeSwhidText(target: Target, request: SwhidRequest): Promise<SwhidResult> {
    const swhidInfo = await this.swh.qualifiedSwhid(target.path, target.lines, request.what === 'archived');
    const labeled = await this.swhidText(swhidInfo, request);
    return { swhidInfo, ...labeled };
  }

  /**
   * Tells what was just copied: whether the archive holds it, and which version.
   *
   * @param swhidInfo - The SWHID copied, as the backend computed it.
   * @param label - What was copied, for the message.
   * @param targetPath - The target's path.
   * @throws {@link core!UserError} as {@link Commands.swhidUnarchived} does.
   */
  private async reportCopied(swhidInfo: SwhidInfo, label: string, targetPath: string): Promise<void> {
    if (swhidInfo.unchecked) {
      info(`Copied ${label} (not checked against the archive: ${swhidInfo.unchecked})`);
      return;
    }
    if (!swhidInfo.archived) {
      await this.swhidUnarchived(label, targetPath, swhidInfo.origin);
      return;
    }
    const version = swhidInfo.version ? ` (version of commit ${shortHash(swhidInfo.version)})` : '';
    info(`Copied ${label}${version}`);
  }

  /**
   * Says why the archive does not hold a target just copied, or offers to save its origin.
   *
   * @remarks
   * Reasons are e.g. uncommitted changes or an unpushed commit. When there is
   * none and the origin is public, the archive has simply not visited it
   * since the last push: a save request is offered.
   *
   * @param label - What was copied, for the message.
   * @param targetPath - The target's path.
   * @param origin - The target's origin, if any.
   * @throws {@link core!UserError} when Git fails, or as {@link Commands.doSave}
   * does when the user accepts the save request.
   */
  private async swhidUnarchived(label: string, targetPath: string, origin?: string): Promise<void> {
    const why = await this.swh.unarchivedWhy(targetPath);
    if (why) {
      info(`Copied ${label} (version not archived: ${why})`);
      return;
    }
    if (!isPublicOrigin(origin)) {
      info(`Copied ${label} (version not archived yet)`);
      return;
    }
    await this.offerSave(label, origin);
  }

  /**
   * Offers a save request for the origin of a target just copied, which the
   * archive has not visited since the last push.
   *
   * @param label - What was copied, for the message.
   * @param origin - The target's public origin.
   * @throws {@link core!UserError} as {@link Commands.doSave} does.
   */
  private async offerSave(label: string, origin: string): Promise<void> {
    const question = `Copied ${label}, not archived since the last push. Ask Software Heritage to save ${origin} now?`;
    if (!(await ask(question, 'Save now'))) return;

    // through a symbolic link, the file's repository may not be the current directory's
    const isCurrentRepo = normalizeOrigin(origin) === (await this.localOrigin());
    await this.doSave(isCurrentRepo ? undefined : origin);
  }

  /**
   * Copies a BibTeX entry citing the current file, selection or directory,
   * or a repository, and shows it in a report.
   *
   * @remarks
   * Implements `swh.cite` and, with `askOrigin`, `swh.citeOther`. The archive
   * makes the entry from the repository's `codemeta.json` or `CITATION.cff`;
   * without them, or when the target is not archived, a minimal entry is
   * made. With no file or folder to cite, asks for a repository and cites
   * its latest snapshot.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @param arg - The command's argument: the file or folder to cite, if any.
   * @defaultValue `askOrigin` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is nothing to cite, the repository
   * asked for is not archived, or the archive cannot be reached.
   */
  async cite(askOrigin = false, arg?: CommandArg): Promise<void> {
    const origin = await this.citedOrigin(askOrigin, arg);
    const entry = origin ? await this.citeOrigin(origin) : await this.swhidCopy('bibtex', arg);
    await this.reports.show('swh cite.bib', entry);
  }

  /**
   * The repository a citation is about, when it is not a file or folder.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @param arg - The command's argument: the file or folder to cite, if any.
   * @returns The repository URL to cite, or `undefined` to cite the file,
   * selection or directory instead.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   */
  private async citedOrigin(askOrigin: boolean, arg: CommandArg): Promise<Maybe<string>> {
    const hasFileToCite = Boolean(fileEditor() || this.uriOf(arg));
    if (hasFileToCite && !askOrigin) return undefined;
    return this.originArg('cite', askOrigin);
  }

  /**
   * Copies a BibTeX entry citing a repository's latest snapshot.
   *
   * @param origin - The repository's public URL.
   * @returns The entry.
   * @throws {@link core!UserError} when the repository is not archived, or the
   * archive cannot be reached.
   */
  private async citeOrigin(origin: string): Promise<string> {
    const [entry, why] = await busy('Software Heritage: making the citation…', () => originBibtex(this.swh, origin));
    await vscode.env.clipboard.writeText(entry);
    info(`Copied ${citationWhat(why)} for ${origin}`);
    return entry;
  }

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
    await openUrl(browseUrl(this.archiveUrl, toOpen));
  }

  /**
   * Asks the user for a SWHID.
   *
   * @remarks
   * The input box checks the SWHID as it is typed (see {@link core!isSwhid}),
   * and stays open when the focus moves away, e.g. to copy a SWHID elsewhere.
   *
   * @returns The SWHID typed, trimmed, or `undefined` when the input box is dismissed.
   */
  private async readSwhid(): Promise<Maybe<string>> {
    const input = await vscode.window.showInputBox({
      prompt: 'SWHID to open in the archive',
      placeHolder: 'swh:1:cnt:…',
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
    let bare = config().get<boolean>('swhidWithoutContext', false);
    let pick = await pickMenuItem(bare);
    while (pick?.toggle) {
      bare = !bare;
      pick = await pickMenuItem(bare);
    }
    if (!pick?.command) return;
    await vscode.commands.executeCommand(pick.command, pick.takesBare ? { bare } : undefined);
  }
}
