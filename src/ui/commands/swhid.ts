/**
 * The SWHID commands: copy a file's, selection's or directory's SWHID, its
 * permalink, a Markdown link or a BibTeX entry, or open it in the archive.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { bibtex, browseUrl, citationWhat, isPublicOrigin, type Maybe, normalizeOrigin, qualifiers, shortHash, type SwhidInfo } from '#core';
import { archiveUrl, ask, busy, info, openUrl } from '../helpers';
import type { ArchiveCommands } from './archive';
import type { CommandArg, CommandContext, Target } from './context';

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

/** What a SWHID command asks {@link SwhidCommands.swhidText} to produce. */
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

/** Implements the SWHID commands. */
export class SwhidCommands {
  /**
   * Creates the commands.
   *
   * @param ctx - The backend, and what the commands are about.
   * @param archive - The archive commands, to send the save requests offered.
   */
  constructor(
    private readonly ctx: CommandContext,
    private readonly archive: ArchiveCommands,
  ) { }

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
    const bare = this.ctx.bare(arg);
    const target = await this.ctx.target(this.ctx.uriOf(arg));
    const { swhidInfo, text, label } = await busy('Software Heritage: computing the SWHID…', () =>
      this.computeSwhidText(target, { what, bare, targetPath: target.path }),
    );

    if (what === 'open' && swhidInfo.archived) {
      await openUrl(browseUrl(archiveUrl(), text));
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
    const swhidInfo = await this.ctx.swh.qualifiedSwhid(target.path, target.lines, request.what === 'archived');
    const labeled = await this.swhidText(swhidInfo, request);
    return { swhidInfo, ...labeled };
  }

  /**
   * The text a SWHID command produces, and a label saying what it is.
   *
   * @param swhidInfo - The SWHID of the target, as the backend computed it.
   * @param request - What to produce, and for which target.
   * @returns The text, and its label for the messages.
   * @throws {@link core!UserError} as {@link SwhidCommands.bibtexText} does, for a citation.
   */
  private async swhidText(swhidInfo: SwhidInfo, { what, bare, targetPath }: SwhidRequest): Promise<LabeledText> {
    // the lines the SWHID kept: dropped for an archived version that differs
    const lines: Maybe<string> = qualifiers(swhidInfo.swhid).lines;
    if (what === 'bibtex') return this.bibtexText(swhidInfo, lines, targetPath);

    const swhid = bare ? bareSwhid(swhidInfo.core, lines) : swhidInfo.swhid;
    switch (what) {
      case 'link':
        return { text: browseUrl(archiveUrl(), swhid), label: bare ? 'permalink w/o context' : 'SWH archive permalink' };
      case 'markdown':
        return { text: markdownLink(targetPath, lines, browseUrl(archiveUrl(), swhid)), label: 'Markdown link to the SWH archive' };
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
    const repoRoot = await this.ctx.swh.git.root(targetPath);
    const [entry, why] = await bibtex(this.ctx.swh, swhidInfo, lines, repoRoot);
    return { text: entry, label: citationWhat(why) };
  }

  /**
   * Tells what was just copied: whether the archive holds it, and which version.
   *
   * @param swhidInfo - The SWHID copied, as the backend computed it.
   * @param label - What was copied, for the message.
   * @param targetPath - The target's path.
   * @throws {@link core!UserError} as {@link SwhidCommands.swhidUnarchived} does.
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
   * @throws {@link core!UserError} when Git fails, or as {@link ArchiveCommands.doSave}
   * does when the user accepts the save request.
   */
  private async swhidUnarchived(label: string, targetPath: string, origin?: string): Promise<void> {
    const why = await this.ctx.swh.unarchivedWhy(targetPath);
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
   * @throws {@link core!UserError} as {@link ArchiveCommands.doSave} does.
   */
  private async offerSave(label: string, origin: string): Promise<void> {
    const question = `Copied ${label}, not archived since the last push. Ask Software Heritage to save ${origin} now?`;
    if (!(await ask(question, 'Save now'))) return;

    // through a symbolic link, the file's repository may not be the current directory's
    const isCurrentRepo = normalizeOrigin(origin) === (await this.ctx.localOrigin());
    await this.archive.doSave(isCurrentRepo ? undefined : origin);
  }
}
