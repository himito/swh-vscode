/**
 * The second layer of {@link Swh}: repositories' origins, their visits, and
 * save requests.
 *
 * @packageDocumentation
 */

import { UserError } from '../errors';
import { core, isPublicOrigin, normalizeOrigin, originCandidates } from '../swhid';
import { forgetNegatives, fresh, Memo, MEMO_TTL, memoPut } from './memo';
import { SwhKnown } from './known';
import type { OriginInfo, OriginVisits, SaveRequest, Visit } from './types';
import type { Maybe } from '../types';

/** How many of an origin's latest visits {@link Swh.visits} gives. */
export const VISITS_SHOWN = 10;

/** Origins, visits and save requests; see {@link Swh}. */
export class SwhOrigins extends SwhKnown {
  /** Remote URL → origin info, trusted for `MEMO_TTL` seconds. */
  protected originMemo: Memo<OriginInfo | null> = new Map();

  // ---------------------------------------------------------------- origins

  /**
   * The URL of a repository's remote.
   *
   * @remarks
   * The remote the current branch tracks, else `origin`, else the only
   * remote. A branch tracking a local branch, or a remote that is not
   * configured, counts as none.
   *
   * @param root - The repository's root directory.
   * @returns The remote's URL as Git has it, or `undefined` without a remote.
   */
  async remoteUrl(root: string): Promise<Maybe<string>> {
    const url = await this.git.get(root, ['ls-remote', '--get-url']);
    if (url && /[:/]/.test(url)) return url;
    const remotes = (await this.git.get(root, ['remote']))?.split('\n').filter(Boolean) ?? [];
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
    return remote ? this.git.get(root, ['remote', 'get-url', remote]) : undefined;
  }

  /**
   * A repository's origin, as the archive names it.
   *
   * @param root - The repository's root directory.
   * @returns The normalized remote URL (see {@link normalizeOrigin}), or
   * `undefined` without a remote. It may be a local path, not public.
   */
  async originOf(root: string): Promise<Maybe<string>> {
    const remote = await this.remoteUrl(root);
    return remote ? normalizeOrigin(remote) : undefined;
  }

  /**
   * The latest visit with a snapshot of the first URL the archive holds.
   *
   * @param urls - Candidate origin URLs, tried in order.
   * @returns `[url, visit]` for the first archived URL, or `null` when the
   * archive holds none of them; `visit` is `undefined` when the archive's
   * description of it is unusable.
   * @throws {@link UserError} as {@link ArchiveApi.latestVisit} does.
   */
  private async latestVisit(urls: string[]): Promise<[string, Maybe<Visit>] | null> {
    for (const url of urls) {
      const latest = await this.archive.latestVisit(url);
      if (latest.archived) return [url, latest.visit];
    }
    return null;
  }

  /**
   * The archival status of the first of several candidate origins the archive holds.
   *
   * @param candidates - Origin URLs, e.g. with and without `.git`; see {@link originCandidates}.
   * @returns The status of the first archived candidate, or of the first
   * candidate, not archived, when none is. A non-public origin is never
   * looked up: the archive holds only public ones.
   * @throws {@link UserError} when the archive cannot be reached or answers
   * an error other than 404.
   */
  private async findOrigin(candidates: string[]): Promise<OriginInfo> {
    // the archive holds only public origins: look up none otherwise
    const found = await this.latestVisit(isPublicOrigin(candidates[0]) ? candidates : []);
    if (!found) return { origin: candidates[0], archived: false };
    const [origin, visit] = found;
    return { origin, archived: true, ...visit };
  }

  /**
   * The archival status of a public repository, by URL.
   *
   * @param origin - The repository's public URL.
   * @returns Its status.
   * @throws {@link UserError} when `origin` is not a public URL, or the
   * archive cannot answer.
   */
  async originStatus(origin: string): Promise<OriginInfo> {
    if (!isPublicOrigin(origin)) throw new UserError(`Not a public repository URL: ${origin}`);
    return this.findOrigin(originCandidates(origin));
  }

  /**
   * The archival status of a repository's origin, asked of the archive directly.
   *
   * @remarks
   * Remembered by remote URL for `MEMO_TTL` seconds, unless the memo forgot
   * answers while the archive was asked.
   *
   * @param root - The repository's root directory.
   * @returns Its status, or `null` without a remote.
   * @throws {@link UserError} when the archive cannot answer.
   */
  protected async directOrigin(root: string): Promise<OriginInfo | null> {
    const remote = await this.remoteUrl(root);
    if (!remote) return null;
    const e = this.originMemo.get(remote);
    if (e && fresh(e.time, MEMO_TTL)) return e.value;
    const epoch = this.memoEpoch;
    const info = await this.findOrigin(originCandidates(remote));
    // forgotten meanwhile: the answer may be from before the change
    return epoch === this.memoEpoch ? memoPut(this.originMemo, remote, info) : info;
  }

  /**
   * The last {@link VISITS_SHOWN} visits of an origin.
   *
   * @param info - The origin's status; a non-archived origin has no visits, and the archive is not asked.
   * @returns The origin URL and its visits, most recent first.
   * @throws {@link UserError} as {@link ArchiveApi.visits} does.
   */
  private async originVisits(info: OriginInfo): Promise<OriginVisits> {
    if (!info.archived) return { origin: info.origin, visits: [] };
    return { origin: info.origin, visits: await this.archive.visits(info.origin, VISITS_SHOWN) };
  }

  /**
   * Whether the archive holds the commit the current branch's upstream points to.
   *
   * @param root - The repository's root directory.
   * @param info - The origin's status; nothing is asked when it is not archived.
   * @returns `upstream` and `upstream-archived`, or an empty object when the
   * branch has no remote upstream.
   * @throws {@link UserError} when the archive cannot answer.
   */
  private async directUpstream(root: string, info: OriginInfo): Promise<Partial<OriginInfo>> {
    if (!info.archived) return {};
    const upstream = await this.git.get(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
    if (!upstream?.startsWith('refs/remotes/')) return {};
    const commit = await this.git.get(root, ['rev-parse', '--verify', '-q', '@{upstream}^{commit}']);
    if (!commit) return {};
    const rev = core('rev', commit);
    return { upstream: rev, 'upstream-archived': await this.archivedP(rev) };
  }

  /**
   * The archival status of a repository's origin.
   *
   * @param root - The repository's root directory.
   * @param upstream - Whether to tell, too, if the branch's upstream commit is archived.
   * @returns The origin's status.
   * @throws {@link UserError} when the repository has no remote (`No remote`),
   * or the archive cannot answer.
   */
  async origin(root: string, upstream = false): Promise<OriginInfo> {
    const info = await this.directOrigin(root);
    if (!info) throw new UserError('No remote');
    return { ...info, ...(upstream ? await this.directUpstream(root, info) : {}) };
  }

  /**
   * Like {@link Swh.origin}, but `null` rather than an error without a
   * remote; for the status bar's background checks.
   *
   * @param root - The repository's root directory.
   * @returns The origin's status, or `null` without a remote.
   * @throws {@link UserError} when the archive cannot answer.
   */
  async originQuiet(root: string): Promise<OriginInfo | null> {
    return this.directOrigin(root);
  }

  /**
   * The last ten archival visits of a repository's origin, or of a public origin.
   *
   * @param root - The repository's root directory; ignored when `origin` is given.
   * @param origin - A public repository URL to ask about instead.
   * @returns The origin URL and its visits, most recent first; none when it
   * is not archived.
   * @throws {@link UserError} when there is no remote, `origin` is not
   * public, or the archive cannot answer.
   */
  async visits(root: Maybe<string>, origin?: string): Promise<OriginVisits> {
    if (origin) return this.originVisits(await this.originStatus(origin));
    return this.originVisits(await this.origin(root!));
  }

  /**
   * Forget what a save request is about to change: the origin's status, and
   * every "not archived" answer.
   *
   * @param origin - The origin about to be saved.
   */
  private forgetBeforeSave(origin: string) {
    this.memoEpoch++;
    const candidates = originCandidates(origin);
    for (const [remote, e] of this.originMemo) {
      if (e.value && candidates.includes(e.value.origin)) this.originMemo.delete(remote);
    }
    // a SWHID tells not which origin holds it: forget every "not archived"
    forgetNegatives(this.knownMemo);
  }

  /**
   * Ask the archive to save a public repository now ("Save Code Now").
   *
   * @param origin - The repository's public URL.
   * @returns The save request, as the archive answered it.
   * @throws {@link UserError} when `origin` is not public, or as
   * {@link ArchiveApi.save} does.
   */
  async saveOrigin(origin: string): Promise<SaveRequest> {
    if (!isPublicOrigin(origin)) throw new UserError('The origin is not a public URL');
    try {
      return await this.archive.save(origin);
    } finally {
      // the request may have reached the archive even when its answer is an error
      this.forgetBeforeSave(origin);
    }
  }

  /**
   * Ask the archive to save a repository's origin now.
   *
   * @param root - The repository's root directory.
   * @returns The save request, see {@link Swh.saveOrigin}.
   * @throws {@link UserError} when there is no remote, the origin is not
   * public, or the archive refuses or cannot answer.
   */
  async save(root: string): Promise<SaveRequest> {
    // a non-public origin is not looked up in the archive, and saveOrigin rejects it
    const info = await this.directOrigin(root);
    if (!info) throw new UserError('No remote');
    return this.saveOrigin(info.origin);
  }
}
