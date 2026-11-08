/**
 * The last layer of {@link Swh}, the Software Heritage client: the trees of
 * the working tree, forgetting answers, and why a file is not archived.
 *
 * @remarks
 * Each layer's class extends the one before: `known.ts` → `origins.ts` →
 * `swhids.ts` → {@link Swh} here.
 *
 * @packageDocumentation
 */

import { ancestors, type Maybe, UserError } from '#core/shared';
import { relativePath } from '#core/git';
import { isPublicOrigin } from '#core/origin';
import { Swhid } from '#core/swhid';
import { SwhSwhids } from './swhids';
import type { TreeNode } from './types';

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
    const nodes: TreeNode[] = [{ path: '.', swhid: Swhid.of('dir', tree), dir: true, archived: false }];
    for (const line of lsTree.split('\0').filter(Boolean)) {
      // "<mode> <type> <hash>\t<path>", the path may hold tabs
      const tab = line.indexOf('\t');
      const [, type, hash] = line.substring(0, tab).split(' ');
      nodes.push({
        path: line.substring(tab + 1),
        swhid: Swhid.of(type === 'tree' ? 'dir' : type === 'blob' ? 'cnt' : 'rev', hash),
        dir: type === 'tree',
        archived: false,
      });
    }
    const swhids = new Map(nodes.map((node) => [node.path, node.swhid]));
    // a directory holds a submodule's commit, not the commit itself
    const covered = (node: TreeNode) =>
      node.swhid.type !== 'rev' && ancestors(node.path).some((dir) => this.knownP(swhids.get(dir)!));
    // directories first: an archived one covers everything under it
    await this.rememberKnown(nodes.filter((node) => node.dir && !covered(node)).map((node) => node.swhid));
    await this.rememberKnown(nodes.filter((node) => !node.dir && !covered(node)).map((node) => node.swhid));
    return nodes.map((node) => ({ ...node, archived: this.knownP(node.swhid) || covered(node) }));
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
    this.originMemo.clear();
    this.knownMemo.forget((known) => !known);
  }

  /**
   * Forget every answer of the archive, what it holds included.
   *
   * @remarks
   * For when the archive itself changes, e.g. the `swh.archiveUrl` setting:
   * the answers of the previous archive do not hold for the new one.
   */
  forgetAll(): void {
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
   * @param targetPath - The real path.
   * @returns The reason in words, e.g. `it has uncommitted changes`, or
   * `undefined` when nothing prevents it (it may simply not be archived
   * since the last push) or the path is outside a repository.
   */
  async unarchivedWhy(targetPath: string): Promise<Maybe<string>> {
    const root = await this.git.root(targetPath);
    if (!root) return undefined;
    const rel = relativePath(root, targetPath);
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
