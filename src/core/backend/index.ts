/**
 * The Software Heritage backend: everything the extension asks the archive
 * or Git, behind the single class {@link Swh}.
 *
 * @remarks
 * Every request goes one of two ways:
 *
 * - through the local swhd daemon, when it answers at the configured URL
 *   (see {@link Swh.daemonAvailable}); it keeps a persistent cache of
 *   SWHIDs, which spares the archive's rate limit;
 * - otherwise directly: SWHIDs are computed with Git, and the archive's Web
 *   API (`/api/1`) is asked whether it holds them.
 *
 * Answers that may change are remembered for a while (see `MEMO_TTL`):
 * what the archive holds stays so for the session, what it does not hold
 * is asked again after ten minutes.
 *
 * This module must not import `vscode`: it receives its settings and
 * callbacks through {@link SwhDeps}, which lets the unit tests run it with
 * Node alone.
 *
 * @packageDocumentation
 */

import { UserError } from '../http';
import { relativePath } from '../git';
import { ancestors, core, isPublicOrigin, typeOf, versionAtLeast } from '../swhid';
import { forgetNegatives } from './memo';
import { SwhSwhids } from './swhids';
import type { TreeNode } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export { DAEMON_MIN_VERSION, RATE_LIMIT_MESSAGE } from './client';
export type { OriginInfo, SwhDeps, SwhidInfo, TreeNode } from './types';

/** Seconds to wait for swhd's `/tree`: a large repository takes many calls. */
export const TREE_TIMEOUT = 600;

/**
 * The Software Heritage client: archival status, SWHIDs, visits, save
 * requests and scans, through swhd or directly.
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
  private async directTree(root: string): Promise<TreeNode[]> {
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

  /**
   * Every file and directory of the tracked working tree, with its archival status.
   *
   * @remarks
   * Through swhd's `/tree` when it runs, waiting up to {@link TREE_TIMEOUT}
   * seconds; directly otherwise, see {@link Swh.directTree}.
   *
   * @param root - The repository's root directory.
   * @returns The nodes, unsorted but for the direct backend's root first.
   * @throws {@link UserError} when Git, the daemon or the archive fails.
   */
  async tree(root: string): Promise<TreeNode[]> {
    if (!(await this.daemonAvailable())) return this.directTree(root);
    const answer = await this.daemon('GET', '/tree', { path: root, timeout: TREE_TIMEOUT });
    return Object.entries(answer ?? {}).map(([p, e]: [string, any]) => {
      return { path: p, swhid: e.swhid, dir: !!e['dir?'], archived: !!e.archived };
    });
  }

  // ---------------------------------------------------------------- refresh

  /**
   * Forget what may have changed in the archive, here and in swhd.
   *
   * @remarks
   * Forgets the origins' status and every "not archived" answer; what the
   * archive holds stays remembered. The daemon is pinged again, as it may
   * have started or stopped, and asked to forget too (swhd 0.10.0 or later).
   *
   * @returns Why swhd did not forget, in words, or `undefined` when it did
   * or is not running.
   */
  async refresh(): Promise<string | undefined> {
    this.originMemo.clear();
    forgetNegatives(this.knownMemo);
    // swhd may have started, or stopped
    this.daemonChecked = undefined;
    const pong = await this.daemonPong();
    if (!pong) return undefined;
    if (!versionAtLeast(pong.version, '0.10.0')) return `it needs 0.10.0, not ${pong.version}`;
    try {
      await this.daemon('POST', '/forget', { timeout: 60 });
      return undefined;
    } catch (e) {
      if (e instanceof UserError) return e.message;
      throw e;
    }
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
  async unarchivedWhy(p: string): Promise<string | undefined> {
    const root = await this.git.root(p);
    if (!root) return undefined;
    const rel = relativePath(root, p);
    const origin = await this.originOf(root);
    if (!origin) return 'the repository has no remote';
    if (!isPublicOrigin(origin)) return `the origin ${origin} is not a public URL`;
    if (!(await this.git.get(root, ['--literal-pathspecs', 'ls-files', '--', rel]))) return 'Git does not track it';
    if ((await this.git.run(root, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', rel])).status !== 0) {
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
