/**
 * {@link Commands}: the extension's commands, by group, built on one shared
 * {@link CommandContext}.
 *
 * @remarks
 * The groups are made in the order they depend on each other: the archive
 * commands first, then the SWHID commands, which send save requests with
 * them, then the citations, which use the SWHID commands.
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
