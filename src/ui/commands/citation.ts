/**
 * The citation commands: a BibTeX entry citing a file, selection, directory or repository.
 *
 * @packageDocumentation
 */

import * as vscode from 'vscode';
import { citationWhat, type Maybe, originBibtex } from '#core';
import { busy, fileEditor, info } from '../helpers';
import type { CommandInput, CommandContext } from './context';
import type { SwhidCommands } from './swhid';

/** Implements the citation commands. */
export class CitationCommands {
  /**
   * Creates the commands.
   *
   * @param ctx - The backend, and what the commands are about.
   * @param swhid - The SWHID commands, to cite a file, selection or directory.
   */
  constructor(
    private readonly ctx: CommandContext,
    private readonly swhid: SwhidCommands,
  ) { }

  /**
   * Copies a BibTeX entry citing the current file, selection or directory,
   * or a repository, and shows it in a report.
   *
   * @remarks
   * Implements `swh.cite` and, with `askOrigin`, `swh.citeOther`. The archive
   * makes the entry from the repository's `codemeta.json` or `CITATION.cff`;
   * without them, or when the target is not archived, a minimal entry is
   * made. With no file open and no file or folder given, cites the current
   * directory when its repository has a public origin; otherwise asks for a
   * repository and cites its latest snapshot.
   *
   * @param askOrigin - Whether to ask for another repository's URL; `false` by default.
   * @param input - What the command was run with: the file or folder to cite, if any.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is nothing to cite, the repository
   * asked for is not archived, or the archive cannot be reached.
   */
  async cite(askOrigin = false, input?: CommandInput): Promise<void> {
    const origin = await this.citedOrigin(askOrigin, input);
    const entry = origin ? await this.citeOrigin(origin) : await this.swhid.swhidCopy('bibtex', input);
    await this.ctx.reports.show('swh cite.bib', entry);
  }

  /**
   * The repository a citation is about, when it is not a file or folder.
   *
   * @param askOrigin - Whether to ask for another repository's URL.
   * @param input - What the command was run with: the file or folder to cite, if any.
   * @returns The repository URL to cite, or `undefined` to cite the file,
   * selection or directory instead.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   */
  private async citedOrigin(askOrigin: boolean, input: CommandInput): Promise<Maybe<string>> {
    const hasFileToCite = Boolean(fileEditor() || this.ctx.uriOf(input));
    if (hasFileToCite && !askOrigin) return undefined;
    return this.ctx.originArg('cite', askOrigin);
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
    const { entry, why } = await busy('Software Heritage: making the citation…', () => originBibtex(this.ctx.swh, origin));
    await vscode.env.clipboard.writeText(entry);
    info(`Copied ${citationWhat(why)} for ${origin}`);
    return entry;
  }
}
