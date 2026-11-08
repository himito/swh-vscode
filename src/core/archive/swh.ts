/**
 * The Software Heritage client, {@link Swh}: what the extension asks the
 * archive, and Git about what the archive holds.
 *
 * @remarks
 * {@link Swh} is made of parts, each a service of its own: {@link Holdings}
 * (what the archive holds), {@link Origins} (origins, visits, save
 * requests) and {@link WorkingTree} (the SWHIDs of files and directories).
 * It builds them on the same Git and archive, and gives the methods callers
 * need, most of them done by a part.
 *
 * @packageDocumentation
 */

import { type Git, relativePath } from '#core/git';
import { isPublicOrigin } from '#core/origin';
import { ancestors, type Maybe, now, UserError } from '#core/shared';
import { type LineRange, Swhid } from '#core/swhid';
import type { ArchiveApi } from './archiveApi';
import { Holdings } from './holdings';
import { Origins } from './origins';
import { WorkingTree } from './workingTree';
import type { FileStatus, OriginInfo, OriginVisits, SaveRequest, SwhDeps, SwhidInfo, TreeNode } from './types';

/**
 * The Software Heritage client: archival status, SWHIDs, visits, save
 * requests and scans.
 *
 * @remarks
 * One instance lives as long as the extension; its parts hold the memos of
 * the archive's answers. Its public methods throw a {@link UserError} with
 * a message for the user when something goes wrong (archive unreachable,
 * rate limit, no remote…).
 */
export class Swh {
  /** The Git runner, shared with the rest of the extension. */
  readonly git: Git;
  /** The Software Heritage archive, see {@link ArchiveApi}. */
  readonly archive: ArchiveApi;
  /** What the archive holds. */
  private readonly holdings: Holdings;
  /** Origins, visits and save requests. */
  private readonly origins: Origins;
  /** The SWHIDs of files and directories. */
  private readonly workingTree: WorkingTree;

  /**
   * Creates the client and its parts, knowing nothing yet.
   *
   * @param deps - Git, and the archive.
   */
  constructor(deps: SwhDeps) {
    this.git = deps.git;
    this.archive = deps.archive;
    this.holdings = new Holdings(this.archive);
    this.origins = new Origins(this.git, this.archive, this.holdings);
    this.workingTree = new WorkingTree(this.git, this.holdings, this.origins);
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
    const tree = await this.workingTree.worktreeTree(root);
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
      node.swhid.type !== 'rev' && ancestors(node.path).some((dir) => this.holdings.isKnownArchived(swhids.get(dir)!));
    // directories first: an archived one covers everything under it
    await this.holdings.rememberKnown(nodes.filter((node) => node.dir && !covered(node)).map((node) => node.swhid));
    await this.holdings.rememberKnown(nodes.filter((node) => !node.dir && !covered(node)).map((node) => node.swhid));
    return nodes.map((node) => ({ ...node, archived: this.holdings.isKnownArchived(node.swhid) || covered(node) }));
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
    this.origins.forget();
    this.holdings.forgetNegatives();
  }

  /**
   * Forget every answer of the archive, what it holds included.
   *
   * @remarks
   * For when the archive itself changes, e.g. the `swh.archiveUrl` setting:
   * the answers of the previous archive do not hold for the new one.
   */
  forgetAll(): void {
    this.origins.forget();
    this.holdings.forgetAll();
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
    const origin = await this.origins.originOf(root);
    if (!origin) return 'the repository has no remote';
    if (!isPublicOrigin(origin)) return `the origin ${origin} is not a public URL`;
    if (!(await this.git.get(root, ['--literal-pathspecs', 'ls-files', '--', rel]))) return 'Git does not track it';
    // 1: differences; any other failure (e.g. no commit yet) is not one
    if ((await this.git.run(root, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', rel])).status === 1) {
      return 'it has uncommitted changes';
    }
    // not HEAD: a later commit elsewhere in the tree does not keep this
    // content from being archived
    const last = await this.workingTree.lastCommit(root, rel);
    if (!last || !(await this.git.get(root, ['for-each-ref', '--count=1', '--contains', last, 'refs/remotes/']))) {
      return 'the commit holding it is not pushed';
    }
    return undefined;
  }

  // ---------------------------------------------------------------- what the archive holds

  /** {@inheritDoc Holdings.isKnownArchived} */
  isKnownArchived(swhid: Swhid): boolean {
    return this.holdings.isKnownArchived(swhid);
  }

  /** {@inheritDoc Holdings.isArchived} */
  isArchived(swhid: Swhid): Promise<boolean> {
    return this.holdings.isArchived(swhid);
  }

  /** {@inheritDoc Holdings.rememberKnown} */
  rememberKnown(swhids: readonly Swhid[]): Promise<void> {
    return this.holdings.rememberKnown(swhids);
  }

  // ---------------------------------------------------------------- origins, visits, save requests

  /** {@inheritDoc Origins.originOf} */
  originOf(root: string): Promise<Maybe<string>> {
    return this.origins.originOf(root);
  }

  /** {@inheritDoc Origins.originStatus} */
  originStatus(origin: string): Promise<OriginInfo> {
    return this.origins.originStatus(origin);
  }

  /** {@inheritDoc Origins.origin} */
  origin(root: string): Promise<OriginInfo> {
    return this.origins.origin(root);
  }

  /** {@inheritDoc Origins.originWithUpstream} */
  originWithUpstream(root: string): Promise<OriginInfo> {
    return this.origins.originWithUpstream(root);
  }

  /** {@inheritDoc Origins.originQuiet} */
  originQuiet(root: string): Promise<OriginInfo | null> {
    return this.origins.originQuiet(root);
  }

  /** {@inheritDoc Origins.visits} */
  visits(root: string): Promise<OriginVisits> {
    return this.origins.visits(root);
  }

  /** {@inheritDoc Origins.visitsOf} */
  visitsOf(origin: string): Promise<OriginVisits> {
    return this.origins.visitsOf(origin);
  }

  /** {@inheritDoc Origins.saveOrigin} */
  saveOrigin(origin: string): Promise<SaveRequest> {
    return this.origins.saveOrigin(origin);
  }

  /** {@inheritDoc Origins.save} */
  save(root: string): Promise<SaveRequest> {
    return this.origins.save(root);
  }

  // ---------------------------------------------------------------- SWHIDs of the working tree

  /** {@inheritDoc WorkingTree.contentSwhid} */
  contentSwhid(file: string, root: Maybe<string>): Promise<Swhid> {
    return this.workingTree.contentSwhid(file, root);
  }

  /** {@inheritDoc WorkingTree.worktreeTree} */
  worktreeTree(root: string): Promise<string> {
    return this.workingTree.worktreeTree(root);
  }

  /** {@inheritDoc WorkingTree.worktreeSwhid} */
  worktreeSwhid(file: string, root: Maybe<string>): Promise<Swhid> {
    return this.workingTree.worktreeSwhid(file, root);
  }

  /** {@inheritDoc WorkingTree.qualifiedSwhid} */
  qualifiedSwhid(file: string, lines?: LineRange, archivedVersion = false): Promise<SwhidInfo> {
    return this.workingTree.qualifiedSwhid(file, lines, archivedVersion);
  }

  /** {@inheritDoc WorkingTree.fileStatus} */
  fileStatus(file: string, coreSwhid?: Swhid): Promise<FileStatus> {
    return this.workingTree.fileStatus(file, coreSwhid);
  }

  /** {@inheritDoc WorkingTree.headTree} */
  headTree(dir: string, root: string): Promise<Maybe<string>> {
    return this.workingTree.headTree(dir, root);
  }

  /** {@inheritDoc WorkingTree.untracked} */
  untracked(dir: string): Promise<boolean> {
    return this.workingTree.untracked(dir);
  }
}
