/**
 * The third layer of {@link Swh}: repositories' origins, their visits, and
 * save requests.
 *
 * @packageDocumentation
 */

import { UserError } from '../http';
import { core, isPublicOrigin, normalizeOrigin, originCandidates, pathOrigin } from '../swhid';
import { forgetNegatives, fresh, Memo, MEMO_TTL, memoPut } from './memo';
import { SwhKnown } from './known';
import type { OriginInfo } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

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
  async remoteUrl(root: string): Promise<string | undefined> {
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
  async originOf(root: string): Promise<string | undefined> {
    const remote = await this.remoteUrl(root);
    return remote ? normalizeOrigin(remote) : undefined;
  }

  /**
   * The latest visit with a snapshot of the first URL the archive holds.
   *
   * @param urls - Candidate origin URLs, tried in order.
   * @returns `[url, visit]` for the first archived URL, or `null` when the
   * archive holds none of them.
   * @throws {@link UserError} when the archive cannot be reached or answers
   * an error other than 404.
   */
  private async latestVisit(urls: string[]): Promise<[string, any] | null> {
    for (const url of urls) {
      const resp = await this.api('GET', `/origin/${pathOrigin(url)}/visit/latest/?require_snapshot=true`);
      if (resp.status !== 404) return [url, this.apiBody(resp, "the origin's visits")];
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
   * @throws {@link UserError} as {@link Swh.latestVisit} does.
   */
  private async findOrigin(candidates: string[]): Promise<OriginInfo> {
    // the archive holds only public origins: look up none otherwise
    const found = await this.latestVisit(isPublicOrigin(candidates[0]) ? candidates : []);
    if (!found) return { origin: candidates[0], archived: false };
    const [origin, visit] = found;
    const info: OriginInfo = { origin, archived: true };
    for (const k of ['date', 'status', 'snapshot'] as const) if (visit?.[k] != null) info[k] = visit[k];
    return info;
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
   * Remembered by remote URL for `MEMO_TTL` seconds.
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
    return memoPut(this.originMemo, remote, await this.findOrigin(originCandidates(remote)));
  }

  /**
   * The last ten visits of an origin, as swhd's `/visits` gives them.
   *
   * @param info - The origin's status; a non-archived origin has no visits, and the archive is not asked.
   * @returns The origin URL and its visits, most recent first.
   * @throws {@link UserError} when the archive cannot answer.
   */
  private async originVisits(info: OriginInfo): Promise<{ origin: string; visits: any[] }> {
    return {
      origin: info.origin,
      visits: info.archived
        ? this.apiBody(await this.api('GET', `/origin/${pathOrigin(info.origin)}/visits/?per_page=10`), "the origin's visits")
        : [],
    };
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
   * or the daemon or the archive cannot answer.
   */
  async origin(root: string, upstream = false): Promise<OriginInfo> {
    if (await this.daemonAvailable()) {
      return this.daemon('GET', '/origin', { path: root, params: upstream ? [['upstream']] : [], timeout: 60 });
    }
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
   * @throws {@link UserError} when the daemon or the archive cannot answer.
   */
  async originQuiet(root: string): Promise<OriginInfo | null> {
    if ((await this.daemonAvailable()) && (await this.remoteUrl(root))) {
      return this.daemon('GET', '/origin', { path: root });
    }
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
   * public, or the daemon or the archive cannot answer.
   */
  async visits(root: string | undefined, origin?: string): Promise<{ origin: string; visits: any[] }> {
    if (origin) return this.originVisits(await this.originStatus(origin));
    if (await this.daemonAvailable()) return this.daemon('GET', '/visits', { path: root, timeout: 60 });
    return this.originVisits(await this.origin(root!));
  }

  /**
   * Forget what a save request is about to change: the origin's status, and
   * every "not archived" answer.
   *
   * @param origin - The origin about to be saved.
   */
  private forgetBeforeSave(origin: string) {
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
   * @returns The archive's save request, with `origin` added; its
   * `save_request_status` is e.g. `accepted` or `pending` (awaiting review).
   * @throws {@link UserError} when `origin` is not public, or the archive
   * refuses or cannot answer.
   */
  async saveOrigin(origin: string): Promise<any> {
    if (!isPublicOrigin(origin)) throw new UserError('The origin is not a public URL');
    const request = this.apiBody(await this.api('POST', `/origin/save/git/url/${pathOrigin(origin)}/`), 'the save request');
    this.forgetBeforeSave(origin);
    return { origin, ...request };
  }

  /**
   * Ask the archive to save a repository's origin now.
   *
   * @param root - The repository's root directory.
   * @returns The save request, see {@link Swh.saveOrigin}.
   * @throws {@link UserError} when there is no remote, the origin is not
   * public, or the daemon or the archive refuses or cannot answer.
   */
  async save(root: string): Promise<any> {
    if (await this.daemonAvailable()) return this.daemon('POST', '/save', { path: root });
    const origin = await this.originOf(root);
    if (!origin) throw new UserError('No remote');
    if (!isPublicOrigin(origin)) throw new UserError('The origin is not a public URL');
    const info = await this.directOrigin(root);
    return this.saveOrigin(info!.origin);
  }
}
