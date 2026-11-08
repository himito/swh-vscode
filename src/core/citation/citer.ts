/**
 * The citation of files, directories and repositories, as the {@link Citer} service.
 *
 * @remarks
 * {@link Citer} gathers what a citation needs, from the archive and from
 * Git, and makes it a {@link Citation}. This module must not import `vscode`.
 *
 * @packageDocumentation
 */

import * as path from 'path';
import type { CitationAnswer, OriginInfo, Swh, SwhidInfo } from '../archive';
import { Citation, type CitationMetadata } from './citation';
import { type Maybe, UserError } from '../shared';
import { isPublicOrigin, originName } from '../origin';
import { Swhid } from '../swhid';

/**
 * Cites archived code: a file, its lines, a directory, or a repository.
 *
 * @remarks
 * The archive makes the entry when it can, from the repository's
 * `codemeta.json` or `CITATION.cff`; otherwise a minimal one is made from
 * the repository (see {@link Citation.minimal}). One instance serves the
 * whole extension: it holds nothing but the client.
 */
export class Citer {
  /**
   * Creates the service.
   *
   * @param swh - The client, to ask the archive and Git.
   */
  constructor(private readonly swh: Swh) {}

  /**
   * Cites a file, its lines, or a directory.
   *
   * @remarks
   * The archive is asked only when it holds the SWHID. For a minimal entry,
   * the title is the origin's name (else the repository directory's), the URL
   * the origin when public, and the date that of the anchor, when it is a
   * commit the repository has.
   *
   * @param info - The SWHID to cite, see {@link Swh.qualifiedSwhid}; its
   * `lines` qualifier, if any, gives the cited lines.
   * @param root - The root of the repository holding it, if any.
   * @returns The citation.
   * @throws {@link UserError} when the archive cannot be reached, or its rate
   * limit is reached.
   */
  async cite(info: SwhidInfo, root: Maybe<string>): Promise<Citation> {
    const answer = await this.archiveAnswer(info);
    // the archive's own entry needs nothing from the repository
    if (typeof answer === 'object') return Citation.fromArchive(answer.entry);
    return Citation.minimal(info.swhid, answer, await this.repositoryMetadata(info, root));
  }

  /**
   * Cites the latest archived snapshot of a public repository.
   *
   * @remarks
   * The repository is cited as the archive holds it, e.g. with a `.git`
   * suffix when that is how it was saved: that origin is what the archive
   * makes its entry for, and what the minimal entry's URL and SWHID give.
   *
   * @param origin - The repository's public URL.
   * @returns The citation.
   * @throws {@link UserError} when `origin` is not a public URL, the archive
   * does not hold it or has no snapshot of it to cite, cannot be reached, or
   * its rate limit is reached.
   */
  async citeOrigin(origin: string): Promise<Citation> {
    const info = await this.swh.originStatus(origin);
    const snapshot = Citer.latestSnapshot(info);
    const answer = await this.swh.archive.citation({ origin: info.origin });
    return Citation.of(answer, snapshot, Citer.originMetadata(info));
  }

  /**
   * What the archive answers to a citation request for a SWHID.
   *
   * @param info - The SWHID to cite.
   * @returns The archive's answer; `'not-archived'`, without asking, when it
   * does not hold the SWHID, as it makes entries only for what it holds.
   * @throws {@link UserError} when the archive cannot be reached, or its rate
   * limit is reached.
   */
  private async archiveAnswer(info: SwhidInfo): Promise<CitationAnswer> {
    if (!info.archived) return 'not-archived';
    return this.swh.archive.citation({ swhid: info.swhid.toString() });
  }

  /**
   * What a minimal entry says of a file or directory, from its repository.
   *
   * @param info - The SWHID cited.
   * @param root - The root of the repository holding it, if any.
   * @returns Its title, the origin when public, and the date of the anchor commit.
   */
  private async repositoryMetadata(info: SwhidInfo, root: Maybe<string>): Promise<CitationMetadata> {
    const { origin } = info;
    return {
      title: Citer.title(origin, root),
      url: isPublicOrigin(origin) ? origin : undefined,
      date: root ? await this.commitDate(root, info.swhid.qualifiers.anchor) : undefined,
    };
  }

  /**
   * The date of a commit, as the repository has it.
   *
   * @remarks
   * Only a commit has a date: a SWHID's anchor may also be a directory, a
   * release or a snapshot, of which `git show` would print the content instead.
   *
   * @param root - The repository's root.
   * @param anchor - A SWHID's anchor, if any.
   * @returns The committer date, `YYYY-MM-DD`, of an anchor that is a commit
   * the repository has; `undefined` otherwise.
   */
  private async commitDate(root: string, anchor: Maybe<Swhid>): Promise<Maybe<string>> {
    if (anchor?.type !== 'rev') return undefined;
    return this.swh.git.get(root, ['show', '-s', '--no-show-signature', '--format=%cs', anchor.hash]);
  }

  /**
   * What a minimal entry says of a repository, from its archival status.
   *
   * @param info - The origin's archival status, as the archive holds it.
   * @returns Its name as the title, the origin as the URL, and the date of
   * its latest visit.
   */
  private static originMetadata(info: OriginInfo): CitationMetadata {
    return { title: originName(info.origin), url: info.origin, date: info.date };
  }

  /**
   * The title of a minimal entry: the repository's name.
   *
   * @param origin - The repository's origin, if any.
   * @param root - The repository's root, if any.
   * @returns The origin's name, else the root directory's; `undefined` without either.
   */
  private static title(origin: Maybe<string>, root: Maybe<string>): Maybe<string> {
    if (origin) return originName(origin);
    return root ? path.basename(root) : undefined;
  }

  /**
   * The SWHID of an origin's latest archived snapshot, qualified with the origin.
   *
   * @param info - The origin's archival status.
   * @returns The snapshot's SWHID, e.g. `swh:1:snp:…;origin=https://…`.
   * @throws {@link UserError} when the archive does not hold the origin, or its
   * latest visit gives no snapshot to cite.
   */
  private static latestSnapshot(info: OriginInfo): Swhid {
    if (!info.archived) throw new UserError(`Software Heritage has not archived ${info.origin}`);
    if (!info.snapshot) throw new UserError(`The latest archival visit of ${info.origin} has no snapshot to cite`);
    return Swhid.of('snp', info.snapshot).qualify({ origin: info.origin });
  }
}
