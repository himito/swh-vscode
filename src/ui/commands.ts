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
  normalizeOrigin,
  originBibtex,
  type OriginInfo,
  qualifiers,
  shortHash,
  type Swh,
  type SwhidInfo,
  UserError,
} from '../core';
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

/**
 * Called after a save request or a refresh, when what the archive holds may
 * have changed, e.g. to recheck the status bar.
 */
export type ArchiveChangeHandler = () => void;

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
   * A URL without a scheme, like `github.com/owner/repo`, gets `https://`.
   * The URL is normalized as the archive names origins (see
   * {@link normalizeOrigin}).
   *
   * @param prompt - The prompt of the input box.
   * @param def - The URL proposed in the input box.
   * @returns The normalized origin.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   * @throws {@link core!UserError} when the input is empty, looks like a web page
   * rather than a repository, or is not a public URL.
   */
  async readOrigin(prompt: string, def?: string): Promise<string> {
    const input = await vscode.window.showInputBox({
      prompt,
      value: def,
      placeHolder: 'https://github.com/owner/repository',
      ignoreFocusOut: true,
    });
    if (input === undefined) throw new Cancelled();
    const url = input.trim();
    if (!url) throw new UserError('No origin');
    // a typo, or a web page rather than a repository
    if (/[\s?#]/.test(url)) throw new UserError(`Not a repository URL: ${url}`);
    const origin = normalizeOrigin(/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+\//u.test(url) ? 'https://' + url : url);
    if (!isPublicOrigin(origin)) throw new UserError(`Not a public repository URL: ${url}`);
    return origin;
  }

  /**
   * The origin a command about "another repository" works on.
   *
   * @remarks
   * Asks for a repository URL when `force` is set, or when the current
   * repository has no public origin; the current origin, if any, is proposed.
   *
   * @param verb - What the command does to the origin, for the prompt, e.g. "check".
   * @param force - Whether to ask even when there is a public origin here.
   * @returns The origin asked for, or `undefined` to use the current repository.
   * @throws {@link core!Cancelled} when the user dismisses the input box.
   * @throws {@link core!UserError} when the URL entered is not valid, see {@link Commands.readOrigin}.
   */
  async originArg(verb: string, force: boolean): Promise<Maybe<string>> {
    const local = await this.localOrigin();
    if (!force && local) return undefined;
    return this.readOrigin(local ? `Origin to ${verb}` : `No public origin here; origin to ${verb}`, local);
  }

  /**
   * The file (with its selected lines) or directory a SWHID command is about.
   *
   * @remarks
   * In order: the file or folder `arg` names, when it is not the active
   * editor's file; else the active editor's file, with its selected lines,
   * offering to save it first when modified; else the current directory.
   * Symbolic links are resolved.
   *
   * @param arg - A file or folder from a context menu or the status bar, if any.
   * @returns The target.
   * @throws {@link core!UserError} when `arg` is not a local file, the path does not
   * exist, the user declines to save a modified file, or the current
   * directory is not inside a Git repository.
   */
  async target(arg?: vscode.Uri | string): Promise<Target> {
    const editor = fileEditor();
    const uri = typeof arg === 'string' ? vscode.Uri.file(arg) : arg;
    const onEditor = editor && (!uri || uri.toString() === editor.document.uri.toString());
    if (uri && !onEditor) {
      if (uri.scheme !== 'file') throw new UserError('Remote files are not supported');
      return { path: await realpath(uri.fsPath) };
    }
    if (editor && onEditor) {
      const doc = editor.document;
      if (doc.isDirty) {
        if (!(await ask('The file is modified; save it first?', 'Save'))) {
          throw new UserError('A SWHID identifies the file on disk: save it first');
        }
        await doc.save();
      }
      // a symbolic link stands for its target
      return { path: await realpath(doc.uri.fsPath), lines: selectionLines(editor) };
    }
    const dir = await realCurrentDir();
    if (!(await this.swh.git.root(dir))) throw new UserError('Not inside a Git repository');
    return { path: dir };
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

  // ------------------------------------------------------------ status, visits, save

  /**
   * Describes an origin's archival status in words.
   *
   * @param info - The origin's archival status.
   * @returns The description, and whether a save request would help: the
   * origin is not archived, or its upstream commit is not yet.
   */
  statusText(info: OriginInfo): [string, boolean] {
    const date = info.date ? formatDate(info.date) : 'unknown';
    if (!info.archived) return [`${info.origin} is not archived`, true];
    if (info.upstream && !info['upstream-archived']) {
      return [`${info.origin} is archived (last visit ${date}), upstream ${shortHash(info.upstream)} not yet`, true];
    }
    return [`${info.origin} is archived${info.upstream ? ', upstream included' : ''} (last visit ${date})`, false];
  }

  /**
   * Reports an origin's archival status, offering a save request when it would help.
   *
   * @param origin - The archival status to report.
   * @param asked - The origin the user asked about, or `undefined` for the
   * current repository; it decides what a save request is for.
   */
  async reportStatus(origin: OriginInfo, asked?: string): Promise<void> {
    const [text, unsaved] = this.statusText(origin);
    if (unsaved) {
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
   * Implements `swh.status` and, with `force`, `swh.statusOther`.
   *
   * @param force - Whether to ask for another repository's URL.
   * @defaultValue `force` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async status(force = false): Promise<void> {
    const origin = await this.originArg('check', force);
    const result = await busy('Software Heritage: checking the archival status…', async () =>
      origin ? this.swh.originStatus(origin) : this.swh.origin(await this.repoRoot(), true),
    );
    await this.reportStatus(result, origin);
  }

  /**
   * The visits report's text: one line per visit, with its date, status and snapshot.
   *
   * @param origin - The origin visited.
   * @param visits - Its visits, most recent first, as the archive lists them.
   * @returns The report, its snapshots as full SWHIDs so that they become links.
   */
  visitsText(origin: string, visits: Array<{ date: string; status: string; snapshot?: string }>): string {
    return (
      `Last ${visits.length} archival visits of ${origin}\n\n` +
      visits
        .map((v) => `${formatDate(v.date)}  ${String(v.status).padEnd(8)} ${v.snapshot ? core('snp', v.snapshot) : ''}`.trimEnd() + '\n')
        .join('')
    );
  }

  /**
   * Lists the last archival visits of the repository's origin in a report.
   *
   * @remarks
   * Implements `swh.visits` and, with `force`, `swh.visitsOther`. When the
   * origin is not archived, says so instead of showing an empty report.
   *
   * @param force - Whether to ask for another repository's URL.
   * @defaultValue `force` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async visits(force = false): Promise<void> {
    const origin = await this.originArg('list the visits of', force);
    const r = await busy('Software Heritage: listing the visits…', async () =>
      this.swh.visits(origin ? undefined : await this.repoRoot(), origin),
    );
    if (!r.visits?.length) {
      info(`${r.origin} is not archived`);
      return;
    }
    await this.reports.show('swh visits.txt', this.visitsText(r.origin, r.visits));
  }

  /**
   * Asks Software Heritage to archive the repository now.
   *
   * @remarks
   * Implements `swh.save` and, with `force`, `swh.saveOther`.
   *
   * @param force - Whether to ask for another repository's URL.
   * @defaultValue `force` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} as {@link Commands.doSave} does.
   */
  async save(force = false): Promise<void> {
    await this.doSave(await this.originArg('save', force));
  }

  /**
   * Sends a save request and tells its answer.
   *
   * @remarks
   * A request is accepted at once, or waits for review by Software Heritage;
   * a refused request is an HTTP error. Either way, what the archive holds
   * may change, so {@link Commands.onArchiveChange} is called.
   *
   * @param origin - The public origin to save, or `undefined` for the current repository.
   * @throws {@link core!UserError} when there is no repository or remote, the
   * origin is not a public URL, or the archive cannot be reached or refuses
   * the request.
   */
  async doSave(origin?: string): Promise<void> {
    const request = await busy(`Software Heritage: sending the save request for ${origin ?? 'this repository'}…`, async () =>
      origin ? this.swh.saveOrigin(origin) : this.swh.save(await this.repoRoot()),
    );
    this.onArchiveChange();
    const o = request?.origin;
    switch (request?.save_request_status) {
      case 'accepted':
        info(`Save request accepted for ${o}`);
        break;
      // a refusal is an HTTP 403, an error
      case 'pending':
        info(`Save request for ${o} awaits review by Software Heritage`);
        break;
      default:
        info(`Save request for ${o}: ${request?.save_request_status}`);
    }
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

  // ------------------------------------------------------------ SWHIDs

  /**
   * The text a SWHID command produces, and a label saying what it is.
   *
   * @param info - The SWHID of the target, as the backend computed it.
   * @param lines - The lines to qualify the SWHID with, if any.
   * @param what - What to produce.
   * @param bare - Whether to use the bare SWHID rather than the qualified one.
   * @param p - The target's path, for the Markdown link's text and the citation's repository.
   * @returns The text, and its label for the messages, e.g. "qualified SWHID".
   */
  private async swhidText(info: SwhidInfo, lines: Maybe<string>, what: What, bare: boolean, p: string): Promise<[string, string]> {
    if (what === 'bibtex') {
      const [entry, why] = await bibtex(this.swh, info, lines, await this.swh.git.root(p));
      return [entry, citationWhat(why)];
    }
    const swhid = bare ? info.core + (lines ? `;lines=${lines}` : '') : info.swhid;
    if (what === 'link') {
      return [browseUrl(this.archiveUrl, swhid), bare ? 'permalink w/o context' : 'SWH archive permalink'];
    }
    if (what === 'markdown') {
      const desc = path.basename(p) + (lines ? `, lines ${lines}` : '');
      return [`[${desc}](${browseUrl(this.archiveUrl, swhid)})`, 'Markdown link to the SWH archive'];
    }
    // not archived, open opens nothing and archived finds no version: the SWHID is copied instead
    const label =
      info.archived && what === 'archived'
        ? bare
          ? 'SWHID w/o context of SWH-archived version'
          : 'SWHID of SWH-archived version'
        : bare
          ? 'SWHID w/o context'
          : 'qualified SWHID';
    return [swhid, label];
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
   * the user declines to save a modified file, or Git fails.
   */
  async swhidCopy(what: What, arg?: CommandArg): Promise<string> {
    const bare = this.bare(arg);
    const t = await this.target(this.uriOf(arg));
    const result = await busy('Software Heritage: computing the SWHID…', async () => {
      const info = await this.swh.qualifiedSwhid(t.path, t.lines, what === 'archived');
      // the lines the SWHID kept: dropped for an archived version that differs
      const lines = qualifiers(info.swhid).lines;
      return { info, text: await this.swhidText(info, lines, what, bare, t.path) };
    });
    const { info: i } = result;
    const [text, label] = result.text;
    if (i.archived && what === 'open') {
      await openUrl(browseUrl(this.archiveUrl, text));
      info('Opening in the Software Heritage archive');
      return text;
    }
    await vscode.env.clipboard.writeText(text);
    if (i.unchecked) {
      info(`Copied ${label} (not checked against the archive: ${i.unchecked})`);
    } else if (!i.archived) {
      await this.swhidUnarchived(label, t.path, i.origin);
    } else {
      info(`Copied ${label}${i.version ? ` (version of commit ${shortHash(i.version)})` : ''}`);
    }
    return text;
  }

  /**
   * Says why the archive does not hold a target just copied, or offers to save its origin.
   *
   * @remarks
   * Reasons are e.g. uncommitted changes or an unpushed commit. When there is
   * none and the origin is public, the archive has simply not visited it
   * since the last push: a save request is offered.
   *
   * @param what - The label of what was copied, for the message.
   * @param p - The target's path.
   * @param origin - The target's origin, if any.
   */
  private async swhidUnarchived(what: string, p: string, origin?: string): Promise<void> {
    const why = await this.swh.unarchivedWhy(p);
    if (why) {
      info(`Copied ${what} (version not archived: ${why})`);
    } else if (isPublicOrigin(origin)) {
      if (await ask(`Copied ${what}, not archived since the last push. Ask Software Heritage to save ${origin} now?`, 'Save now')) {
        // through a symbolic link, the file's repository may not be the current directory's
        await this.doSave(normalizeOrigin(origin) === (await this.localOrigin()) ? undefined : origin);
      }
    } else {
      info(`Copied ${what} (version not archived yet)`);
    }
  }

  // ------------------------------------------------------------ citations

  /**
   * Copies a BibTeX entry citing the current file, selection or directory,
   * or a repository, and shows it in a report.
   *
   * @remarks
   * Implements `swh.cite` and, with `force`, `swh.citeOther`. The archive
   * makes the entry from the repository's `codemeta.json` or `CITATION.cff`;
   * without them, or when the target is not archived, a minimal entry is
   * made. With no file or folder to cite, asks for a repository and cites
   * its latest snapshot.
   *
   * @param force - Whether to ask for another repository's URL.
   * @param arg - The command's argument: the file or folder to cite, if any.
   * @defaultValue `force` is `false`.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is nothing to cite, the repository
   * asked for is not archived, or the archive cannot be reached.
   */
  async cite(force = false, arg?: CommandArg): Promise<void> {
    const origin = force || (!fileEditor() && !this.uriOf(arg)) ? await this.originArg('cite', force) : undefined;
    let entry: string;
    if (origin) {
      const [text, why] = await busy('Software Heritage: making the citation…', () => originBibtex(this.swh, origin));
      await vscode.env.clipboard.writeText(text);
      info(`Copied ${citationWhat(why)} for ${origin}`);
      entry = text;
    } else {
      entry = await this.swhidCopy('bibtex', arg);
    }
    await this.reports.show('swh cite.bib', entry);
  }

  // ------------------------------------------------------------ misc

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
    if (!swhid) {
      swhid = (
        await vscode.window.showInputBox({
          prompt: 'SWHID to open in the archive',
          placeHolder: 'swh:1:cnt:…',
          validateInput: (v) => (/^swh:1:(cnt|dir|rev|rel|snp|ori):[0-9a-f]{40}(;.*)?$/.test(v.trim()) ? undefined : 'Not a SWHID'),
        })
      )?.trim();
      if (!swhid) return;
    }
    await openUrl(browseUrl(this.archiveUrl, swhid));
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
    // cmd: the command to run; swhid: whether it takes the bare option; toggle: the switch
    type Item = vscode.QuickPickItem & { cmd?: string; swhid?: boolean; toggle?: boolean };
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    for (; ;) {
      const items: Item[] = [
        sep('SWH Archive'),
        { label: '$(cloud-upload) Save', description: 'ask SWH to save code now', cmd: 'swh.save' },
        { label: '$(info) Status', description: 'is the repo archived?', cmd: 'swh.status' },
        { label: '$(list-tree) Scan', description: 'show what is archived', cmd: 'swh.scan' },
        { label: '$(history) Visits', description: 'list its last visits', cmd: 'swh.visits' },
        { label: '$(refresh) Refresh', description: 'forget what may have changed', cmd: 'swh.refresh' },
        sep('SWHID'),
        {
          label: `$(${bare ? 'pass-filled' : 'circle-large-outline'}) Without context`,
          description: bare ? 'on: bare SWHIDs' : 'off: qualified SWHIDs',
          toggle: true,
        },
        { label: '$(copy) Copy', description: 'SWHID of the file, selection or directory', cmd: 'swh.swhidCopy', swhid: true },
        { label: '$(versions) Copy the archived version', description: 'SWHID of the version SWH holds', cmd: 'swh.swhidCopyArchived', swhid: true },
        { label: '$(link-external) Open in the archive', cmd: 'swh.swhidOpen', swhid: true },
        { label: '$(link) Copy the archive link', cmd: 'swh.swhidCopyLink', swhid: true },
        { label: '$(markdown) Copy as a Markdown link', cmd: 'swh.swhidCopyMarkdown', swhid: true },
        { label: '$(quote) Cite', description: 'show a BibTeX entry', cmd: 'swh.cite' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Software Heritage', matchOnDescription: true });
      if (!pick) return;
      if (pick.toggle) {
        bare = !bare;
        continue;
      }
      await vscode.commands.executeCommand(pick.cmd!, pick.swhid ? { bare } : undefined);
      return;
    }
  }
}
