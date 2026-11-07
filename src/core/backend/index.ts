/**
 * The Software Heritage backend: everything the extension asks the archive
 * or Git, behind the single class {@link Swh}.
 *
 * @remarks
 * SWHIDs are computed with Git, and the archive is asked whether it holds
 * them.
 *
 * The backend talks to the archive through an interface, {@link ArchiveApi},
 * in its own terms; it never sees HTTP. {@link HttpArchiveApi} (in
 * `adapters/`) implements the interface over the archive's Web API
 * (`/api/1`).
 *
 * {@link Swh} is built in layers, each file's class extending the one
 * before: `known.ts` (Git, the archive, which SWHIDs it holds) →
 * `origins.ts` → `swhids.ts` → {@link Swh} here.
 *
 * Answers that may change are remembered for a while (see `MEMO_TTL`):
 * what the archive holds stays so for the session, what it does not hold
 * is asked again after ten minutes.
 *
 * This module must not import `vscode`: {@link Swh} receives Git and the
 * archive through {@link SwhDeps}, and {@link HttpArchiveApi} its settings
 * and callbacks through {@link HttpArchiveDeps}. This lets the unit tests run
 * it with Node alone, on a fake archive or a fake `fetch`.
 *
 * @packageDocumentation
 */

import { UserError } from '../errors';
import { relativePath } from '../git';
import { ancestors, core, isPublicOrigin, typeOf } from '../swhid';
import { forgetNegatives } from './memo';
import { SwhSwhids } from './swhids';
import type { TreeNode } from './types';
import type { Maybe } from '../types';

export { HttpArchiveApi, type HttpArchiveDeps, KNOWN_BATCH_SIZE } from './adapters/httpArchiveApi';
export { type ArchiveApi, type CitationTarget, type LatestVisit, RATE_LIMIT_MESSAGE, type RateLimit } from './archiveApi';
export { VISITS_SHOWN } from './origins';
export type { CitationAnswer, FileStatus, OriginInfo, OriginVisits, SaveRequest, SwhDeps, SwhidInfo, Token, TreeNode, Visit } from './types';

/**
 * The Software Heritage client: archival status, SWHIDs, visits, save
 * requests and scans.
 *
 * @remarks
 * One instance lives as long as the extension; it holds the memos of the
 * archive's answers. Its public methods throw a {@link UserError} with a
 * message for the user when something goes wrong (archive unreachable,
 * rate limit, no remote…).
 */
export class Swh extends SwhSwhids {
  // ---------------------------------------------------------------- trees

  /**
   * Every file and directory of the tracked working tree, with its archival
   * status, from Git and the archive's API.
   *
   * @remarks
   * The check is Merkle-pruned: directories are asked about first, and an
   * archived directory covers everything under it, which is then not asked
   * about. A submodule's commit is never covered: the directory holds a
   * reference to it, not the commit itself.
   *
   * @param root - The repository's root directory.
   * @returns The nodes, the root `.` first, then in `git ls-tree` order.
   * @throws {@link UserError} when Git or the archive fails.
   */
  async tree(root: string): Promise<TreeNode[]> {
    const tree = await this.worktreeTree(root);
    const lsTree = (await this.git.get(root, ['ls-tree', '-r', '-t', '-z', tree])) ?? '';
    const nodes: TreeNode[] = [{ path: '.', swhid: core('dir', tree), dir: true, archived: false }];
    for (const line of lsTree.split('\0').filter(Boolean)) {
      // "<mode> <type> <hash>\t<path>", the path may hold tabs
      const tab = line.indexOf('\t');
      const [, type, hash] = line.substring(0, tab).split(' ');
      nodes.push({
        path: line.substring(tab + 1),
        swhid: core(type === 'tree' ? 'dir' : type === 'blob' ? 'cnt' : 'rev', hash),
        dir: type === 'tree',
        archived: false,
      });
    }
    const swhids = new Map(nodes.map((n) => [n.path, n.swhid]));
    // a directory holds a submodule's commit, not the commit itself
    const covered = (n: TreeNode) =>
      typeOf(n.swhid) !== 'rev' && ancestors(n.path).some((d) => this.knownP(swhids.get(d)!));
    // directories first: an archived one covers everything under it
    await this.rememberKnown(nodes.filter((n) => n.dir && !covered(n)).map((n) => n.swhid));
    await this.rememberKnown(nodes.filter((n) => !n.dir && !covered(n)).map((n) => n.swhid));
    return nodes.map((n) => ({ ...n, archived: this.knownP(n.swhid) || covered(n) }));
  }

  // ---------------------------------------------------------------- refresh

  /**
   * Forget what may have changed in the archive.
   *
   * @remarks
   * Forgets the origins' status and every "not archived" answer; what the
   * archive holds stays remembered.
   */
  refresh(): void {
    this.memoEpoch++;
    this.originMemo.clear();
    forgetNegatives(this.knownMemo);
  }

  /**
   * Forget every answer of the archive, what it holds included.
   *
   * @remarks
   * For when the archive itself changes, e.g. the `swh.archiveUrl` setting:
   * the answers of the previous archive do not hold for the new one.
   */
  forgetAll(): void {
    this.memoEpoch++;
    this.originMemo.clear();
    this.knownMemo.clear();
  }

  // ---------------------------------------------------------------- why not archived

  /**
   * Why the archive cannot hold a file or directory as it is.
   *
   * @remarks
   * Checks, in order: a remote, a public origin, Git tracking the path,
   * uncommitted changes, and the commit that last changed it being pushed.
   * Only that commit matters, not HEAD: a later commit elsewhere in the
   * tree does not keep this content from being archived.
   *
   * @param p - The real path.
   * @returns The reason in words, e.g. `it has uncommitted changes`, or
   * `undefined` when nothing prevents it (it may simply not be archived
   * since the last push) or the path is outside a repository.
   */
  async unarchivedWhy(p: string): Promise<Maybe<string>> {
    const root = await this.git.root(p);
    if (!root) return undefined;
    const rel = relativePath(root, p);
    const origin = await this.originOf(root);
    if (!origin) return 'the repository has no remote';
    if (!isPublicOrigin(origin)) return `the origin ${origin} is not a public URL`;
    if (!(await this.git.get(root, ['--literal-pathspecs', 'ls-files', '--', rel]))) return 'Git does not track it';
    // 1: differences; any other failure (e.g. no commit yet) is not one
    if ((await this.git.run(root, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', rel])).status === 1) {
      return 'it has uncommitted changes';
    }
    // not HEAD: a later commit elsewhere in the tree does not keep this
    // content from being archived
    const last = await this.lastCommit(root, rel);
    if (!last || !(await this.git.get(root, ['for-each-ref', '--count=1', '--contains', last, 'refs/remotes/']))) {
      return 'the commit holding it is not pushed';
    }
    return undefined;
  }
}
