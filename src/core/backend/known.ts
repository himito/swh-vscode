/**
 * The second layer of {@link Swh}: which SWHIDs the archive holds.
 *
 * @packageDocumentation
 */

import { Memo, memoGet, memoPut, partition, uniq, UNKNOWN } from './memo';
import { SwhClient } from './client';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Which SWHIDs the archive holds, remembered; see {@link Swh}. */
export class SwhKnown extends SwhClient {
  /** SWHID → whether the archive holds it; see {@link memoGet}. */
  protected knownMemo: Memo<boolean> = new Map();
  /**
   * Bumped whenever the memos forget answers: a request sent before then
   * may bring an answer from before the change, which is then not stored.
   */
  protected memoEpoch = 0;

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
   * Uses the `/known/` endpoint, 1000 SWHIDs per request; the answers go to
   * the memo, where {@link Swh.knownP} reads them. An answer that arrives
   * after the memo forgot answers (see {@link Swh.refresh}) is not stored.
   *
   * @param swhids - Core SWHIDs; duplicates are asked once.
   * @throws {@link UserError} when the archive cannot be reached, is
   * rate-limited, or answers an error.
   */
  async rememberKnown(swhids: string[]): Promise<void> {
    const unknown = uniq(swhids).filter((s) => memoGet(this.knownMemo, s) === UNKNOWN);
    for (const batch of partition(unknown, 1000)) {
      const epoch = this.memoEpoch;
      const body = this.apiBody(await this.api('POST', '/known/', JSON.stringify(batch)), 'the SWHID lookup');
      if (epoch !== this.memoEpoch) continue;
      for (const [swhid, answer] of Object.entries(body ?? {})) {
        memoPut(this.knownMemo, swhid, (answer as any)?.known === true);
      }
    }
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
