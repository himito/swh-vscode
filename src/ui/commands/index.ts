/**
 * The extension's user-facing commands, in groups: the archive, SWHIDs,
 * citations, and the others.
 *
 * @remarks
 * {@link Commands} builds the groups; those that need it share one
 * {@link CommandContext}, which finds "where the user is" and holds the
 * Software Heritage client. Each public method of a
 * group implements one or more commands registered in `extension.ts`, except
 * {@link ArchiveCommands.doSave}, which the SWHID commands also use. They talk
 * to the archive through {@link Swh}, show their results with the helpers of
 * `helpers.ts`, and report problems by throwing {@link core!UserError}:
 * {@link registerCommands}, which registers them, shows the errors.
 *
 * The groups depend on each other in one direction only: citations use the
 * SWHID commands, which use the archive commands to send save requests.
 *
 * @packageDocumentation
 */

import type { Swh } from '#core';
import type { Reports } from '#ui/reports';
import { ArchiveCommands } from './archive';
import { CitationCommands } from './citation';
import { type ArchiveChangeHandler, CommandContext } from './context';
import { MiscCommands } from './misc';
import { SwhidCommands } from './swhid';

export * from './archive';
export * from './citation';
export * from './context';
export * from './misc';
export * from './register';
export * from './swhid';

/** The extension's commands, by group, sharing one context. */
export class Commands {
  /** The client, and what the commands are about. */
  readonly context: CommandContext;
  /** Archival status, visits, save requests and refresh. */
  readonly archive: ArchiveCommands;
  /** The SWHID, permalink, Markdown link or BibTeX entry of a file, selection or directory. */
  readonly swhid: SwhidCommands;
  /** BibTeX entries citing a file, selection, directory or repository. */
  readonly citation: CitationCommands;
  /** Opening a SWHID, and the Quick Pick menu. */
  readonly misc: MiscCommands;

  /**
   * Creates the commands.
   *
   * @param swh - The client that talks to Git and the archive.
   * @param reports - Where the visits and citation reports are shown.
   * @param onArchiveChange - Called when what the archive holds may have changed.
   */
  constructor(swh: Swh, reports: Reports, onArchiveChange: ArchiveChangeHandler) {
    this.context = new CommandContext(swh, reports, onArchiveChange);
    this.archive = new ArchiveCommands(this.context);
    this.swhid = new SwhidCommands(this.context, this.archive);
    this.citation = new CitationCommands(this.context, this.swhid);
    this.misc = new MiscCommands();
  }
}
