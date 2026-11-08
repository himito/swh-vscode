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
import { type LineRange, type ObjectType, Swhid } from '#core/swhid';
import type { ArchiveApi } from './archiveApi';
import { Holdings } from './holdings';
import { Origins } from './origins';
import { WorkingTree } from './workingTree';
import type { FileStatus, OriginInfo, OriginVisits, SaveRequest, SwhDeps, SwhidInfo, TreeNode } from './types';

/** The exit status of `git diff --quiet` when it finds differences; 0 is none, more a failure. */
const DIFFERENCES_FOUND = 1;

/** The types of the entries of a Git tree: a file, a directory, or a submodule's commit. */
type TreeEntryType = 'blob' | 'tree' | 'commit';

/** The object type of the SWHID of each type of tree entry. */
const OBJECT_TYPE_OF_ENTRY = {
  blob: 'cnt',
  tree: 'dir',
  commit: 'rev',
} as const satisfies Record<TreeEntryType, ObjectType>;

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
    const nodes = await this.treeNodes(root, tree);
    return this.withArchivalStatus(nodes);
  }

  /**
   * The files and directories of a tree, not checked against the archive yet.
   *
   * @param root - The repository's root directory.
   * @param tree - The tree's hash.
   * @returns The nodes, the tree's root `.` first, then in `git ls-tree` order.
   */
  private async treeNodes(root: string, tree: string): Promise<TreeNode[]> {
    const listing = (await this.git.get(root, ['ls-tree', '-r', '-t', '-z', tree])) ?? '';
    const entries = listing.split('\0').filter(Boolean);
    const entryNodes = entries.map(Swh.treeEntry);

    const rootSwhid = Swhid.of('dir', tree);
    const rootNode: TreeNode = { path: '.', swhid: rootSwhid, dir: true, archived: false };
    return [rootNode, ...entryNodes];
  }

  /**
   * Parses one entry of `git ls-tree -z`.
   *
   * @param entry - `<mode> <type> <hash>\t<path>`; the path may hold tabs.
   * @returns The node it names, not checked against the archive yet.
   */
  private static treeEntry(entry: string): TreeNode {
    const tab = entry.indexOf('\t');
    const [, type, hash] = entry.substring(0, tab).split(' ');
    const path = entry.substring(tab + 1);
    const swhid = Swhid.of(OBJECT_TYPE_OF_ENTRY[type as TreeEntryType], hash);
    return { path, swhid, dir: type === 'tree', archived: false };
  }

  /**
   * The nodes of a tree, with whether the archive holds each.
   *
   * @remarks
   * Merkle-pruned: the directories are asked about first, and an archived
   * one covers everything under it, which is then not asked about.
   *
   * @param nodes - The nodes, the root among them.
   * @returns The same nodes, each with its archival status.
   * @throws {@link UserError} when the archive fails.
   */
  private async withArchivalStatus(nodes: readonly TreeNode[]): Promise<TreeNode[]> {
    const swhidAt = new Map(nodes.map((node) => [node.path, node.swhid]));
    const covered = (node: TreeNode) => this.isCovered(node, swhidAt);

    // directories first: the files are then filtered by what they cover
    await this.askAboutUncovered(nodes.filter((node) => node.dir), covered);
    await this.askAboutUncovered(nodes.filter((node) => !node.dir), covered);

    return nodes.map((node) => {
      const archived = this.holdings.isKnownArchived(node.swhid) || covered(node);
      return { ...node, archived };
    });
  }

  /**
   * Asks the archive about the nodes no archived directory covers.
   *
   * @param nodes - The nodes.
   * @param covered - Tells whether an archived directory covers a node, as
   * far as the archive's answers so far tell.
   * @throws {@link UserError} when the archive fails.
   */
  private async askAboutUncovered(nodes: readonly TreeNode[], covered: (node: TreeNode) => boolean): Promise<void> {
    const uncovered = nodes.filter((node) => !covered(node));
    await this.holdings.rememberKnown(uncovered.map((node) => node.swhid));
  }

  /**
   * Whether an archived directory above a node covers it.
   *
   * @remarks
   * A submodule's commit is never covered: a directory holds a reference to
   * it, not the commit itself.
   *
   * @param node - The node.
   * @param swhidAt - The SWHID of each node of the tree, by path.
   * @returns `true` when the archive is known to hold a directory above the node.
   */
  private isCovered(node: TreeNode, swhidAt: ReadonlyMap<string, Swhid>): boolean {
    if (node.swhid.type === 'rev') return false;
    return ancestors(node.path).some((dir) => {
      const swhid = swhidAt.get(dir);
      return swhid !== undefined && this.holdings.isKnownArchived(swhid);
    });
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
    return (await this.originProblem(root)) ?? (await this.pathProblem(root, rel));
  }

  /**
   * Why the archive cannot hold anything of a repository: its origin.
   *
   * @param root - The repository's root directory.
   * @returns The reason in words, or `undefined` when its origin is public.
   */
  private async originProblem(root: string): Promise<Maybe<string>> {
    const origin = await this.origins.originOf(root);
    if (!origin) return 'the repository has no remote';
    if (!isPublicOrigin(origin)) return `the origin ${origin} is not a public URL`;
    return undefined;
  }

  /**
   * Why the archive cannot hold a path as it is, as Git tells it.
   *
   * @remarks
   * Only the commit that last changed the path must be pushed, not HEAD: a
   * later commit elsewhere in the tree does not keep this content from being
   * archived.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @returns The reason in words, or `undefined` when nothing prevents it.
   */
  private async pathProblem(root: string, rel: string): Promise<Maybe<string>> {
    if (!(await this.isTracked(root, rel))) return 'Git does not track it';
    if (await this.hasUncommittedChanges(root, rel)) return 'it has uncommitted changes';

    const lastChange = await this.workingTree.lastCommit(root, rel);
    if (!lastChange || !(await this.isPushed(root, lastChange))) return 'the commit holding it is not pushed';
    return undefined;
  }

  /**
   * Whether Git tracks a path, or files under it.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root, taken literally.
   * @returns `true` when `git ls-files` lists anything for it.
   */
  private async isTracked(root: string, rel: string): Promise<boolean> {
    const listed = await this.git.get(root, ['--literal-pathspecs', 'ls-files', '--', rel]);
    return listed !== undefined;
  }

  /**
   * Whether a path differs from HEAD, in the working tree or the index.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root, taken literally.
   * @returns `true` when `git diff` finds a difference; `false` too when it
   * fails, e.g. without a commit yet, which is no change.
   */
  private async hasUncommittedChanges(root: string, rel: string): Promise<boolean> {
    const diff = await this.git.run(root, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', rel]);
    return diff.status === DIFFERENCES_FOUND;
  }

  /**
   * Whether a commit is pushed: a remote branch holds it.
   *
   * @param root - The repository's root directory.
   * @param commit - The commit's hash.
   * @returns `true` when a branch of `refs/remotes/` contains it.
   */
  private async isPushed(root: string, commit: string): Promise<boolean> {
    const branch = await this.git.get(root, ['for-each-ref', '--count=1', '--contains', commit, 'refs/remotes/']);
    return branch !== undefined;
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
