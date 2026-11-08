/**
 * What the archive holds, as the {@link Holdings} service.
 *
 * @packageDocumentation
 */

import type { Swhid } from '#core/swhid';
import { uniq } from '#core/shared';
import { Memo, MEMO_TTL } from './memo';
import type { ArchiveApi } from './archiveApi';

/**
 * Which SWHIDs the archive holds, asked of the archive and remembered.
 *
 * @remarks
 * What the archive holds stays there, for the session; what it does not
 * hold may be archived later, so that is asked again after `MEMO_TTL`
 * seconds (see `Memo`).
 */
export class Holdings {
  /** SWHID, as its canonical text → whether the archive holds it. */
  private readonly memo = new Memo<boolean>({ ttl: MEMO_TTL, keepPositives: true });

  /**
   * Creates the service, knowing nothing yet.
   *
   * @param archive - The archive to ask, see {@link ArchiveApi}.
   */
  constructor(private readonly archive: ArchiveApi) { }

  /**
   * Whether the archive is known to hold a SWHID, without asking it.
   *
   * @param swhid - A core SWHID.
   * @returns `true` only when a remembered answer says so.
   */
  isKnownArchived(swhid: Swhid): boolean {
    return this.memo.get(swhid.toString()) === true;
  }

  /**
   * Whether the archive holds a SWHID, asking it when the memo cannot tell.
   *
   * @param swhid - A core SWHID.
   * @returns `true` when the archive holds it.
   * @throws {@link UserError} as {@link Holdings.rememberKnown} does.
   */
  async isArchived(swhid: Swhid): Promise<boolean> {
    await this.rememberKnown([swhid]);
    return this.isKnownArchived(swhid);
  }

  /**
   * Ask the archive which SWHIDs it holds, for those not remembered yet.
   *
   * @remarks
   * The answers are remembered, where {@link Holdings.isKnownArchived}
   * reads them, unless the memo forgot them while the archive was asked:
   * a "not archived" after {@link Holdings.forgetNegatives}, any after
   * {@link Holdings.forgetAll}. The archive is asked about the
   * SWHIDs' canonical texts.
   *
   * @param swhids - Core SWHIDs; duplicates are asked once.
   * @throws {@link UserError} as {@link ArchiveApi.known} does.
   */
  async rememberKnown(swhids: readonly Swhid[]): Promise<void> {
    const texts = uniq(swhids.map((swhid) => swhid.toString()));
    const unknown = texts.filter((text) => !this.memo.has(text));
    if (!unknown.length) return;

    const asOf = this.memo.generation;
    const answers = await this.archive.known(unknown);
    for (const [text, known] of answers) this.memo.put(text, known, asOf);
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
  rememberArchived(swhid: Swhid): void {
    this.memo.put(swhid.toString(), true);
  }

  /**
   * Forget every "not archived" answer: the archive may hold the SWHID by
   * now, e.g. after a save request. What it holds stays remembered.
   */
  forgetNegatives(): void {
    this.memo.forget((known) => !known);
  }

  /** Forget every answer, what the archive holds included: e.g. for another archive. */
  forgetAll(): void {
    this.memo.clear();
  }
}
