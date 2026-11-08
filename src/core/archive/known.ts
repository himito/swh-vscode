/**
 * The first layer of {@link Swh}: Git and the archive, and which SWHIDs the archive holds.
 *
 * @packageDocumentation
 */

import type { Git } from '#core/git';
import type { Swhid } from '#core/swhid';
import { type Maybe, now, uniq } from '#core/shared';
import { Memo, MEMO_TTL } from './memo';
import type { ArchiveApi } from './archiveApi';
import type { SwhDeps } from './types';

/** Which SWHIDs the archive holds, remembered; see {@link Swh}. */
export class SwhKnown {
  /** The Git runner, shared with the rest of the extension. */
  readonly git: Git;
  /** The Software Heritage archive, see {@link ArchiveApi}. */
  readonly archive: ArchiveApi;
  /**
   * SWHID, as its canonical text → whether the archive holds it. What the
   * archive holds stays there, for the session; what it does not hold may be
   * archived later, so that is asked again after `MEMO_TTL` seconds.
   */
  protected readonly knownMemo = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });

  /**
   * Creates the client.
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
    const rateLimit = this.archive.rateLimit();
    return rateLimit && now() < rateLimit.reset ? `${rateLimit.used}/${rateLimit.limit}` : undefined;
  }

  /**
   * Whether the archive is known to hold a SWHID, without asking it.
   *
   * @param swhid - A core SWHID.
   * @returns `true` only when a remembered answer says so.
   */
  knownP(swhid: Swhid): boolean {
    return this.knownMemo.get(swhid.toString()) === true;
  }

  /**
   * Ask the archive which SWHIDs it holds, for those not remembered yet.
   *
   * @remarks
   * The answers go to the memo, where {@link Swh.knownP} reads them. Answers
   * that arrive after the memo forgot answers (see {@link Swh.refresh}) are
   * not stored. The archive is asked about the SWHIDs' canonical texts.
   *
   * @param swhids - Core SWHIDs; duplicates are asked once.
   * @throws {@link UserError} as {@link ArchiveApi.known} does.
   */
  async rememberKnown(swhids: readonly Swhid[]): Promise<void> {
    const texts = uniq(swhids.map((swhid) => swhid.toString()));
    const unknown = texts.filter((text) => !this.knownMemo.has(text));
    if (!unknown.length) return;
    const asOf = this.knownMemo.generation;
    const answers = await this.archive.known(unknown);
    for (const [text, known] of answers) this.knownMemo.put(text, known, asOf);
  }

  /**
   * Remember that the archive holds a SWHID, without asking it.
   *
   * @remarks
   * For what follows from another answer: e.g. an archived commit holds
   * its files.
   *
   * @param swhid - A core SWHID.
   */
  protected rememberArchived(swhid: Swhid): void {
    this.knownMemo.put(swhid.toString(), true);
  }

  /**
   * Whether the archive holds a SWHID, asking it when the memo cannot tell.
   *
   * @param swhid - A core SWHID.
   * @returns `true` when the archive holds it.
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  async archivedP(swhid: Swhid): Promise<boolean> {
    await this.rememberKnown([swhid]);
    return this.knownP(swhid);
  }
}
