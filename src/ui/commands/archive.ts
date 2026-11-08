/**
 * The commands about the archive: archival status, visits, save requests, refresh.
 *
 * @packageDocumentation
 */

import { formatDate, type Maybe, type OriginInfo, type OriginVisits, type SaveRequest, Swhid, type Visit } from '#core';
import { ask, busy, info } from '#ui/helpers';
import type { CommandContext } from './context';

/** An origin's archival status in words, from {@link ArchiveCommands.statusText}. */
type StatusText = {
  /** The description, e.g. `https://github.com/owner/repo is archived (last visit …)`. */
  text: string;
  /** Whether a save request would help: the origin is not archived, or its upstream commit is not yet. */
  saveWouldHelp: boolean;
};

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
  const snapshot = visit.snapshot ? Swhid.of('snp', visit.snapshot).toString() : '';
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

/** Implements the commands about the archive. */
export class ArchiveCommands {
  /**
   * Creates the commands.
   *
   * @param ctx - The client, and what the commands are about.
   */
  constructor(private readonly ctx: CommandContext) { }

  /**
   * Describes an origin's archival status in words.
   *
   * @param origin - The origin's archival status.
   * @returns The description, and whether a save request would help.
   */
  private statusText(origin: OriginInfo): StatusText {
    const url = origin.origin;
    if (!origin.archived) return { text: `${url} is not archived`, saveWouldHelp: true };

    const { upstream } = origin;
    const lastVisit = `last visit ${origin.date ? formatDate(origin.date) : 'unknown'}`;

    if (upstream && !origin['upstream-archived']) {
      return { text: `${url} is archived (${lastVisit}), upstream ${upstream.shortHash} not yet`, saveWouldHelp: true };
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
   * @throws {@link core!UserError} as {@link ArchiveCommands.doSave} does, when the
   * user accepts the save request.
   */
  private async reportStatus(origin: OriginInfo, asked?: string): Promise<void> {
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
   * @param askOrigin - Whether to ask for another repository's URL; `false` by default.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async status(askOrigin = false): Promise<void> {
    const origin = await this.ctx.originArg('check', askOrigin);
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
    if (origin) return this.ctx.swh.originStatus(origin);
    const withUpstream = true;
    return this.ctx.swh.origin(await this.ctx.repoRoot(), withUpstream);
  }

  /**
   * The visits report's text: one line per visit, with its date, status and snapshot.
   *
   * @param origin - The origin visited.
   * @param visits - Its visits, most recent first, as the archive lists them.
   * @returns The report, its snapshots as full SWHIDs so that they become links.
   */
  private visitsText(origin: string, visits: Visit[]): string {
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
   * @param askOrigin - Whether to ask for another repository's URL; `false` by default.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} when there is no repository or remote, or the
   * archive cannot be reached or refuses the request.
   */
  async visits(askOrigin = false): Promise<void> {
    const origin = await this.ctx.originArg('list the visits of', askOrigin);
    const originVisits = await busy('Software Heritage: listing the visits…', () => this.fetchVisits(origin));

    if (!originVisits.visits.length) {
      info(`${originVisits.origin} is not archived`);
      return;
    }
    await this.ctx.reports.show('swh visits.txt', this.visitsText(originVisits.origin, originVisits.visits));
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
    if (origin) return this.ctx.swh.visitsOf(origin);
    return this.ctx.swh.visits(await this.ctx.repoRoot());
  }

  /**
   * Asks Software Heritage to archive the repository now.
   *
   * @remarks
   * Implements `swh.save` and, with `askOrigin`, `swh.saveOther`.
   *
   * @param askOrigin - Whether to ask for another repository's URL; `false` by default.
   * @throws {@link core!Cancelled} when the user dismisses the prompt.
   * @throws {@link core!UserError} as {@link ArchiveCommands.doSave} does.
   */
  async save(askOrigin = false): Promise<void> {
    await this.doSave(await this.ctx.originArg('save', askOrigin));
  }

  /**
   * Sends a save request and tells its answer.
   *
   * @remarks
   * A request is accepted at once, or waits for review by Software Heritage;
   * a refused request is an HTTP error. Once the archive has answered, what it
   * holds may change, so {@link CommandContext.onArchiveChange} is called.
   *
   * @param origin - The public origin to save, or `undefined` for the current repository.
   * @throws {@link core!UserError} when there is no repository or remote, the
   * origin is not a public URL, or the archive cannot be reached or refuses
   * the request.
   */
  async doSave(origin?: string): Promise<void> {
    const what = origin ?? 'this repository';
    const request = await busy(`Software Heritage: sending the save request for ${what}…`, () => this.sendSaveRequest(origin));
    this.ctx.onArchiveChange();
    info(saveRequestText(request));
  }

  /**
   * Sends a save request to the archive.
   *
   * @param origin - The public origin to save, or `undefined` for the current repository.
   * @returns The save request, as the archive answered it.
   * @throws {@link core!UserError} as {@link ArchiveCommands.doSave} does.
   */
  private async sendSaveRequest(origin: Maybe<string>): Promise<SaveRequest> {
    if (origin) return this.ctx.swh.saveOrigin(origin);
    return this.ctx.swh.save(await this.ctx.repoRoot());
  }

  /**
   * Forgets what may have changed in the archive, and checks the status bar again.
   *
   * @remarks
   * Implements `swh.refresh`. What the archive holds stays remembered; the
   * negative answers and the origins' statuses are forgotten.
   */
  async refresh(): Promise<void> {
    this.ctx.swh.refresh();
    this.ctx.onArchiveChange();
    info('Forgot what may have changed in the Software Heritage archive');
  }
}
