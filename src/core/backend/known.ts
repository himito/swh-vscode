/**
 * The first layer of {@link Swh}: Git and the archive, and which SWHIDs the archive holds.
 *
 * @packageDocumentation
 */

import type { Git } from '../git';
import type { Maybe } from '../types';
import { Memo, memoGet, memoPut, now, uniq, UNKNOWN } from './memo';
import type { ArchiveApi } from './archiveApi';
import type { SwhDeps } from './types';

/** Which SWHIDs the archive holds, remembered; see {@link Swh}. */
export class SwhKnown {
  /** The Git runner, shared with the rest of the extension. */
  readonly git: Git;
  /** The Software Heritage archive, see {@link ArchiveApi}. */
  readonly archive: ArchiveApi;
  /** SWHID → whether the archive holds it; see `memoGet`. */
  protected knownMemo: Memo<boolean> = new Map();
  /**
   * Bumped whenever the memos forget answers: a request sent before then
   * may bring an answer from before the change, which is then not stored.
   */
  protected memoEpoch = 0;

  /**
   * Creates the backend.
   *
   * @param deps - Git, and the archive.
   */
  constructor(deps: SwhDeps) {
    this.git = deps.git;
    this.archive = deps.archive;
  }

  /**
   * The archive's tokenless rate limit, for display.
   *
   * @returns `used/limit`, e.g. `48/120`, or `undefined` when not known or
   * when its window has ended.
   */
  rateLimitText(): Maybe<string> {
    const r = this.archive.rateLimit();
    return r && now() < r.reset ? `${r.used}/${r.limit}` : undefined;
  }

  /**
   * Whether the archive is known to hold a SWHID, without asking it.
   *
   * @param swhid - A core SWHID.
   * @returns `true` only when a remembered answer says so.
   */
  knownP(swhid: string): boolean {
    return memoGet(this.knownMemo, swhid) === true;
  }

  /**
   * Ask the archive which SWHIDs it holds, for those not remembered yet.
   *
   * @remarks
   * The answers go to the memo, where {@link Swh.knownP} reads them. Answers
   * that arrive after the memo forgot answers (see {@link Swh.refresh}) are
   * not stored.
   *
   * @param swhids - Core SWHIDs; duplicates are asked once.
   * @throws {@link UserError} as {@link ArchiveApi.known} does.
   */
  async rememberKnown(swhids: string[]): Promise<void> {
    const unknown = uniq(swhids).filter((s) => memoGet(this.knownMemo, s) === UNKNOWN);
    if (!unknown.length) return;
    const epoch = this.memoEpoch;
    const answers = await this.archive.known(unknown);
    if (epoch !== this.memoEpoch) return;
    for (const [swhid, known] of answers) memoPut(this.knownMemo, swhid, known);
  }

  /**
   * Whether the archive holds a SWHID, asking it when the memo cannot tell.
   *
   * @param swhid - A core SWHID.
   * @returns `true` when the archive holds it.
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  async archivedP(swhid: string): Promise<boolean> {
    await this.rememberKnown([swhid]);
    return this.knownP(swhid);
  }
}
