// The commands.

import * as path from 'path';
import * as vscode from 'vscode';
import type { OriginInfo, Swh, SwhidInfo } from './backend';
import { bibtex, citationWhat, originBibtex } from './citation';
import { Cancelled, UserError } from './http';
import type { Reports } from './reports';
import {
  browseUrl,
  core,
  formatDate,
  isPublicOrigin,
  normalizeOrigin,
  shortHash,
} from './swhid';
import { ask, busy, config, currentDir, fileEditor, info, openUrl, realpath, selectionLines } from './ui';

export type What = 'swhid' | 'link' | 'open' | 'bibtex' | 'archived' | 'markdown';

/** What a SWHID command gets: a Uri from a menu, or options from a keybinding or the menu. */
export type CommandArg = vscode.Uri | { bare?: boolean; path?: string } | undefined;

export interface Target {
  path: string;
  lines?: string;
}

export class Commands {
  constructor(
    private swh: Swh,
    private reports: Reports,
    private onArchiveChange: () => void,
  ) {}

  private get archiveUrl() {
    return config().get<string>('archiveUrl', 'https://archive.softwareheritage.org');
  }

  // ------------------------------------------------------------ where we are

  /** Root of the Git repository of the current directory, or a UserError. */
  async repoRoot(): Promise<string> {
    const root = await this.swh.git.root(await realpath(currentDir()));
    if (!root) throw new UserError('Not inside a Git repository');
    return root;
  }

  /** Public origin of the current directory's repository, undefined without one. */
  async localOrigin(): Promise<string | undefined> {
    let dir: string;
    try {
      dir = await realpath(currentDir());
    } catch {
      return undefined;
    }
    const root = await this.swh.git.root(dir);
    const origin = root ? await this.swh.originOf(root) : undefined;
    return isPublicOrigin(origin) ? origin : undefined;
  }

  /** Ask with PROMPT for the URL of a public repository, DEFAULT proposed. */
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

  /** The origin of a command that can VERB another origin: asked when FORCE, or without a public origin here. */
  async originArg(verb: string, force: boolean): Promise<string | undefined> {
    const local = await this.localOrigin();
    if (!force && local) return undefined;
    return this.readOrigin(local ? `Origin to ${verb}` : `No public origin here; origin to ${verb}`, local);
  }

  /** The file (and selected lines) or directory a SWHID command is about. */
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
    const dir = await realpath(currentDir());
    if (!(await this.swh.git.root(dir))) throw new UserError('Not inside a Git repository');
    return { path: dir };
  }

  /** Whether a SWHID command goes without context. */
  private bare(arg: CommandArg): boolean {
    if (arg && !(arg instanceof vscode.Uri) && typeof arg.bare === 'boolean') return arg.bare;
    return config().get<boolean>('swhidWithoutContext', false);
  }

  private uriOf(arg: CommandArg): vscode.Uri | string | undefined {
    if (arg instanceof vscode.Uri) return arg;
    return arg?.path;
  }

  // ------------------------------------------------------------ status, visits, save

  statusText(info: OriginInfo): [string, boolean] {
    const date = info.date ? formatDate(info.date) : 'unknown';
    if (!info.archived) return [`${info.origin} is not archived`, true];
    if (info.upstream && !info['upstream-archived']) {
      return [`${info.origin} is archived (last visit ${date}), upstream ${shortHash(info.upstream)} not yet`, true];
    }
    return [`${info.origin} is archived${info.upstream ? ', upstream included' : ''} (last visit ${date})`, false];
  }

  /** Report INFO, of an origin ASKED for or of the repository; offer to save it when it would help. */
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

  async status(force = false): Promise<void> {
    const origin = await this.originArg('check', force);
    const result = await busy('Software Heritage: checking the archival status…', async () =>
      origin ? this.swh.originStatus(origin) : this.swh.origin(await this.repoRoot(), true),
    );
    await this.reportStatus(result, origin);
  }

  visitsText(origin: string, visits: Array<{ date: string; status: string; snapshot?: string }>): string {
    return (
      `Last ${visits.length} archival visits of ${origin}\n\n` +
      visits
        .map((v) => `${formatDate(v.date)}  ${String(v.status).padEnd(8)} ${v.snapshot ? core('snp', v.snapshot) : ''}`.trimEnd() + '\n')
        .join('')
    );
  }

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

  async save(force = false): Promise<void> {
    await this.doSave(await this.originArg('save', force));
  }

  /** Ask to save ORIGIN, or the current repository. */
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

  async refresh(): Promise<void> {
    const why = await this.swh.refresh();
    this.onArchiveChange();
    info(`Forgot what may have changed in the Software Heritage archive${why ? `, but swhd did not (${why})` : ''}`);
  }

  // ------------------------------------------------------------ SWHIDs

  /** [TEXT, LABEL]: WHAT of INFO, for PATH or its LINES; LABEL says what TEXT is. */
  private async swhidText(info: SwhidInfo, lines: string | undefined, what: What, bare: boolean, p: string): Promise<[string, string]> {
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

  /** Copy WHAT of the current file, selection or directory; return it. */
  async swhidCopy(what: What, arg?: CommandArg): Promise<string> {
    const bare = this.bare(arg);
    const t = await this.target(this.uriOf(arg));
    const result = await busy('Software Heritage: computing the SWHID…', async () => {
      const info = await this.swh.qualifiedSwhid(t.path, t.lines, what === 'archived');
      // the selection's lines are those of the working tree's version
      const lines = info.version ? undefined : t.lines;
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

  /** Say why the archive does not hold PATH, WHAT of which was just copied; or offer to save ORIGIN. */
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

  /** A menu of the main commands, with the "without context" switch. */
  async menu(): Promise<void> {
    let bare = config().get<boolean>('swhidWithoutContext', false);
    type Item = vscode.QuickPickItem & { cmd?: string; swhid?: boolean; toggle?: boolean };
    const sep = (label: string): Item => ({ label, kind: vscode.QuickPickItemKind.Separator });
    for (;;) {
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
