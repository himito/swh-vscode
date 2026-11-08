/**
 * Repositories' origins, their visits, and save requests, as the
 * {@link Origins} service: one of the parts {@link Swh} is made of.
 *
 * @packageDocumentation
 */

import type { Git } from '#core/git';
import { isPublicOrigin, normalizeOrigin, originCandidates } from '#core/origin';
import { type Maybe, UserError } from '#core/shared';
import { Swhid } from '#core/swhid';
import type { ArchiveApi } from './archiveApi';
import type { Holdings } from './holdings';
import { Memo, MEMO_TTL } from './memo';
import type { OriginInfo, OriginVisits, SaveRequest, Visit } from './types';

/** The name Git gives the remote a repository was cloned from. */
const DEFAULT_REMOTE = 'origin';

/** Where Git keeps the remote branches: an upstream elsewhere is a local branch. */
const REMOTE_BRANCHES = 'refs/remotes/';

/** The upstream fields of an {@link OriginInfo}: the branch's upstream commit, and whether it is archived. */
type UpstreamStatus = Pick<OriginInfo, 'upstream' | 'upstream-archived'>;

/** What a remote's URL or path holds, and a remote's bare name does not: a `:` or a `/`. */
const URL_OR_PATH = /[:/]/;

/** A candidate origin the archive holds, and its latest visit with a snapshot. */
type ArchivedOrigin = {
  /** The candidate, as the archive holds it: e.g. with a `.git` suffix. */
  origin: string;
  /** Its latest visit; `undefined` when the archive's description of it is unusable. */
  visit: Maybe<Visit>;
};

/** How many of an origin's latest visits {@link Origins.visits} gives. */
export const VISITS_SHOWN = 10;

/**
 * Origins, visits and save requests: what the archive knows of repositories.
 *
 * @remarks
 * The origins' statuses are remembered for a while; a save request forgets
 * those it may change, and the "not archived" answers of {@link Holdings}.
 */
export class Origins {
  /**
   * Remote URL → the origin's status, trusted for `MEMO_TTL` seconds,
   * archived or not: a visit may come at any time.
   */
  private readonly memo = new Memo<OriginInfo>({ ttl: MEMO_TTL, keepPositives: false });

  /**
   * Creates the service, knowing nothing yet.
   *
   * @param git - The Git runner, to read the repositories' remotes.
   * @param archive - The archive to ask, see {@link ArchiveApi}.
   * @param holdings - What the archive holds: for the upstream commit, and
   * to forget the "not archived" answers before a save request.
   */
  constructor(
    private readonly git: Git,
    private readonly archive: ArchiveApi,
    private readonly holdings: Holdings,
  ) { }

  /** Forget every origin's status: what the archive holds of them may have changed. */
  forget(): void {
    this.memo.clear();
  }

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
    return (await this.fetchedRemoteUrl(root)) ?? (await this.defaultRemoteUrl(root));
  }

  /**
   * The URL of the remote Git would fetch from: the one the current branch
   * tracks, else `origin`.
   *
   * @remarks
   * Without such a remote, `git ls-remote --get-url` prints the name
   * `origin` itself, which is no URL: a URL or a path holds a `:` or a `/`.
   *
   * @param root - The repository's root directory.
   * @returns The remote's URL, or `undefined` when Git has none to fetch from.
   */
  private async fetchedRemoteUrl(root: string): Promise<Maybe<string>> {
    const url = await this.git.get(root, ['ls-remote', '--get-url']);
    return url !== undefined && URL_OR_PATH.test(url) ? url : undefined;
  }

  /**
   * The URL of the remote to use when Git would fetch from none: `origin`,
   * else the only remote.
   *
   * @param root - The repository's root directory.
   * @returns The remote's URL, or `undefined` without a remote, or with
   * several and none named `origin`.
   */
  private async defaultRemoteUrl(root: string): Promise<Maybe<string>> {
    const remote = Origins.defaultRemote(await this.remotes(root));
    return remote === undefined ? undefined : this.git.get(root, ['remote', 'get-url', remote]);
  }

  /**
   * The names of a repository's remotes.
   *
   * @param root - The repository's root directory.
   * @returns The names, as `git remote` lists them; none without a remote.
   */
  private async remotes(root: string): Promise<string[]> {
    const names = await this.git.get(root, ['remote']);
    return names ? names.split('\n').filter(Boolean) : [];
  }

  /**
   * The remote to use among several: `origin`, else the only one.
   *
   * @param remotes - The remotes' names.
   * @returns The remote's name, or `undefined` when there is none, or several
   * and none named `origin`: which one would be a guess.
   */
  private static defaultRemote(remotes: readonly string[]): Maybe<string> {
    if (remotes.includes(DEFAULT_REMOTE)) return DEFAULT_REMOTE;
    return remotes.length === 1 ? remotes[0] : undefined;
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
   * The first of some candidate origins the archive holds, and its latest
   * visit with a snapshot.
   *
   * @param candidates - Candidate origin URLs, tried in order.
   * @returns The first candidate archived, and its latest visit; `undefined`
   * when the archive holds none of them.
   * @throws {@link UserError} as {@link ArchiveApi.latestVisit} does.
   */
  private async firstArchived(candidates: readonly string[]): Promise<Maybe<ArchivedOrigin>> {
    for (const origin of candidates) {
      const latest = await this.archive.latestVisit(origin);
      if (latest.archived) return { origin, visit: latest.visit };
    }
    return undefined;
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
    const found = await this.firstArchived(isPublicOrigin(candidates[0]) ? candidates : []);
    if (!found) return { origin: candidates[0], archived: false };
    return { origin: found.origin, archived: true, ...found.visit };
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
  private async directOrigin(root: string): Promise<OriginInfo | null> {
    const remote = await this.remoteUrl(root);
    if (!remote) return null;

    const remembered = this.memo.get(remote);
    if (remembered !== undefined) return remembered;

    const asOf = this.memo.generation;
    const info = await this.findOrigin(originCandidates(remote));
    // not remembered if the memo forgot meanwhile: it may be out of date
    this.memo.put(remote, info, asOf);

    return info;
  }

  /**
   * The last {@link VISITS_SHOWN} visits of an origin.
   *
   * @param info - The origin's status; a non-archived origin has no visits,
   * and the archive is not asked.
   * @returns The origin URL, whether it is archived, and its visits, most recent first.
   * @throws {@link UserError} as {@link ArchiveApi.visits} does.
   */
  private async originVisits({ origin, archived }: OriginInfo): Promise<OriginVisits> {
    // an origin the archive does not hold has no visits: it is not asked
    const visits = archived ? await this.archive.visits(origin, VISITS_SHOWN) : [];
    return { origin, archived, visits };
  }

  /**
   * Whether the archive holds the commit the current branch's upstream points to.
   *
   * @param root - The repository's root directory.
   * @param info - The origin's status; nothing is asked when it is not
   * archived, as the archive then holds none of its commits.
   * @returns `upstream` and `upstream-archived`; none when the origin is not
   * archived, or the branch has no remote upstream.
   * @throws {@link UserError} when the archive cannot answer.
   */
  private async upstreamStatus(root: string, info: OriginInfo): Promise<UpstreamStatus> {
    if (!info.archived) return {};

    const commit = await this.upstreamCommit(root);
    if (!commit) return {};

    const upstream = Swhid.of('rev', commit);
    return { upstream, 'upstream-archived': await this.holdings.isArchived(upstream) };
  }

  /**
   * The commit the current branch's upstream points to, when it is a remote branch.
   *
   * @remarks
   * A branch that tracks a local branch has nothing pushed: it has no
   * upstream here.
   *
   * @param root - The repository's root directory.
   * @returns The commit's hash; `undefined` without a remote upstream.
   */
  private async upstreamCommit(root: string): Promise<Maybe<string>> {
    const upstream = await this.git.get(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
    if (!upstream?.startsWith(REMOTE_BRANCHES)) return undefined;

    return this.git.get(root, ['rev-parse', '--verify', '-q', '@{upstream}^{commit}']);
  }

  /**
   * The archival status of a repository's origin.
   *
   * @param root - The repository's root directory.
   * @returns The origin's status.
   * @throws {@link UserError} when the repository has no remote (`No remote`),
   * or the archive cannot answer.
   */
  async origin(root: string): Promise<OriginInfo> {
    const info = await this.directOrigin(root);
    if (!info) throw new UserError('No remote');
    return info;
  }

  /**
   * The archival status of a repository's origin, and of the commit the
   * current branch's upstream points to.
   *
   * @param root - The repository's root directory.
   * @returns The origin's status, with `upstream` and `upstream-archived`
   * when the origin is archived and the branch has a remote upstream.
   * @throws {@link UserError} as {@link Origins.origin} does.
   */
  async originWithUpstream(root: string): Promise<OriginInfo> {
    const info = await this.origin(root);
    const upstream = await this.upstreamStatus(root, info);
    return { ...info, ...upstream };
  }

  /**
   * Like {@link Origins.origin}, but `null` rather than an error without a
   * remote: for callers to whom a repository without a remote is no error,
   * such as the status bar's background checks, or the SWHIDs of files,
   * which are then not qualified with an origin.
   *
   * @param root - The repository's root directory.
   * @returns The origin's status, or `null` without a remote.
   * @throws {@link UserError} when the archive cannot answer.
   */
  async originQuiet(root: string): Promise<OriginInfo | null> {
    return this.directOrigin(root);
  }

  /**
   * The last {@link VISITS_SHOWN} archival visits of a repository's origin.
   *
   * @param root - The repository's root directory.
   * @returns The origin URL, whether it is archived, and its visits, most
   * recent first; none when it is not archived.
   * @throws {@link UserError} when there is no remote, or the archive cannot answer.
   */
  async visits(root: string): Promise<OriginVisits> {
    return this.originVisits(await this.origin(root));
  }

  /**
   * The last {@link VISITS_SHOWN} archival visits of a public repository, by URL.
   *
   * @param origin - The repository's public URL.
   * @returns The origin URL, as the archive holds it, whether it is archived,
   * and its visits, most recent first; none when it is not archived.
   * @throws {@link UserError} when `origin` is not public, or the archive cannot answer.
   */
  async visitsOf(origin: string): Promise<OriginVisits> {
    return this.originVisits(await this.originStatus(origin));
  }

  /**
   * Forget what a save request will change once the archive visits the
   * origin: its status, and every "not archived" answer.
   *
   * @param origin - The origin asked to be saved.
   */
  private forgetWhatSaveChanges(origin: string): void {
    const candidates = originCandidates(origin);
    this.memo.forget((info) => candidates.includes(info.origin));
    // a SWHID tells not which origin holds it: forget every "not archived"
    this.holdings.forgetNegatives();
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
    if (!isPublicOrigin(origin)) throw new UserError(`The origin ${origin} is not a public URL`);
    try {
      return await this.archive.save(origin);
    } finally {
      // the request may have reached the archive even when its answer is an error
      this.forgetWhatSaveChanges(origin);
    }
  }

  /**
   * Ask the archive to save a repository's origin now.
   *
   * @param root - The repository's root directory.
   * @returns The save request, see {@link Origins.saveOrigin}.
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
