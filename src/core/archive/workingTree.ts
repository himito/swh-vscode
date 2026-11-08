/**
 * The SWHIDs of the files and directories of a working tree, computed with
 * Git and anchored on archived commits, as the {@link WorkingTree} service:
 * one of the parts {@link Swh} is made of.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { type Git, relativePath } from '#core/git';
import { type Maybe, uniq, UserError } from '#core/shared';
import { isPublicOrigin } from '#core/origin';
import { type LineRange, Swhid } from '#core/swhid';
import type { Holdings } from './holdings';
import type { Origins } from './origins';
import type { FileStatus, SwhidInfo } from './types';

/**
 * The SWHID of a commit.
 *
 * @param commit - The commit's hash.
 * @returns Its revision SWHID, `swh:1:rev:<commit>`.
 */
const revisionSwhid = (commit: string) => Swhid.of('rev', commit);

/** Where a file or directory is in its repository. */
type RepoPath = {
  /** The repository's root directory. */
  root: string;
  /** The path relative to the root, with `/` separators; `.` for the root. */
  rel: string;
};

/**
 * The version of a file or directory a SWHID is computed for, and what the
 * archive holds of it: the archived version, or the working tree's.
 */
type SwhidTarget = {
  /** Its core SWHID. */
  core: Swhid;
  /** The commit to anchor the SWHID on, if any. */
  anchor: Maybe<string>;
  /** The revision SWHID of the commit whose version it is: only for the archived version. */
  version: Maybe<Swhid>;
  /** Whether the archive holds it. */
  archived: boolean;
};

/** A path's version in an archived commit. */
type ArchivedVersion = {
  /** The archived commit, which holds the path. */
  commit: string;
  /** The hash of the path's object in it: a blob for a file, a tree for a directory. */
  hash: string;
};

/** The types of Git objects a path can name: `blob` a file, `tree` a directory. */
type GitObjectType = 'blob' | 'tree';

/** A Git command: the directory to run it in, and its arguments. */
type GitCommand = {
  /** The directory to run it in. */
  dir: string;
  /** Its arguments, e.g. `['hash-object', '--', file]`. */
  args: string[];
};

/** Number of the most recent commits that are considered as a SWHID's anchor. */
export const ANCHOR_CANDIDATES_MAX = 100;

/**
 * The value of a SWHID's `path` qualifier for a path relative to the
 * repository root, from the anchor commit's root directory.
 *
 * @param rel - The relative path, with `/` separators; `"."` for the root.
 * @returns The path starting with `/`; `"/"` for the root.
 */
const anchorPath = (rel: string) => (rel === '.' ? '/' : `/${rel}`);

/**
 * The SWHIDs of files and directories, as they are in the working tree or
 * as the archive holds them, and whether it holds them.
 */
export class WorkingTree {
  /**
   * Creates the service.
   *
   * @param git - The Git runner, which hashes the files and trees.
   * @param holdings - What the archive holds: which commits can anchor a SWHID.
   * @param origins - The repositories' origins, which qualify the SWHIDs.
   */
  constructor(
    private readonly git: Git,
    private readonly holdings: Holdings,
    private readonly origins: Origins,
  ) { }

  // ---------------------------------------------------------------- SWHIDs

  /**
   * The core content SWHID of a file.
   *
   * @remarks
   * In a repository, the file is hashed as Git would store it at its path,
   * with its attributes and filters (e.g. line endings); outside one, as
   * it is on disk.
   *
   * @param file - The file's real path.
   * @param root - The root of the repository holding it, if any.
   * @returns The SWHID, e.g. `swh:1:cnt:94a9ed02…`.
   * @throws {@link UserError} when Git cannot hash the file, or the
   * repository uses SHA-256.
   */
  async contentSwhid(file: string, root: Maybe<string>): Promise<Swhid> {
    const { dir, args } = WorkingTree.hashCommand(file, root);
    const hash = await this.git.get(dir, args);
    if (!hash) throw new UserError(`Cannot hash ${file} with git`);
    return Swhid.of('cnt', hash);
  }

  /**
   * The Git command that hashes a file's content: where to run it, and its arguments.
   *
   * @param file - The file's real path.
   * @param root - The root of the repository holding it, if any.
   * @returns In a repository, `git hash-object --path`: the content as Git
   * would store it at its path, its attributes and filters applied (e.g. line
   * endings). Outside one, `git hash-object --no-filters`: the bytes as they
   * are on disk.
   */
  private static hashCommand(file: string, root: Maybe<string>): GitCommand {
    if (root) return { dir: root, args: ['hash-object', '--path', relativePath(root, file), '--', file] };
    return { dir: path.dirname(file), args: ['hash-object', '--no-filters', '--', file] };
  }

  /**
   * The most recent commits `git rev-list` lists.
   *
   * @param root - The repository's root directory.
   * @param args - The arguments of `git rev-list`, e.g. `HEAD`.
   * @returns At most `ANCHOR_CANDIDATES_MAX` commit hashes, most recent first.
   */
  private async revList(root: string, ...args: string[]): Promise<string[]> {
    const out = await this.git.get(root, ['rev-list', `--max-count=${ANCHOR_CANDIDATES_MAX}`, ...args]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  /**
   * The hash of the object at a path in a commit or tree.
   *
   * @param root - The repository's root directory.
   * @param commit - A commit or tree hash, or a revision such as `HEAD`.
   * @param rel - The path relative to the root; `.` for the root's tree.
   * @param type - Only an object of that type: `blob` for a file, `tree` for a directory.
   * @returns The object's hash, or `undefined` when there is none (of that type).
   */
  private async objectAt(root: string, commit: string, rel: string, type?: GitObjectType): Promise<Maybe<string>> {
    const hash = await this.git.get(root, ['rev-parse', '--verify', '-q', WorkingTree.objectName(commit, rel)]);
    if (hash === undefined || type === undefined) return hash;
    return (await this.objectType(root, hash)) === type ? hash : undefined;
  }

  /**
   * The type of an object of the repository.
   *
   * @param root - The repository's root directory.
   * @param hash - The object's hash.
   * @returns Its type, e.g. `blob` or `tree`, as `git cat-file -t` gives it.
   */
  private objectType(root: string, hash: string): Promise<Maybe<string>> {
    return this.git.get(root, ['cat-file', '-t', hash]);
  }

  /**
   * How Git names the object at a path in a commit or tree.
   *
   * @param commit - A commit or tree hash, or a revision such as `HEAD`.
   * @param rel - The path relative to the root; `.` for the root's tree.
   * @returns `<commit>:<path>`, or `<commit>^{tree}` for the root.
   */
  private static objectName(commit: string, rel: string): string {
    return rel === '.' ? `${commit}^{tree}` : `${commit}:${rel}`;
  }

  /**
   * The commits the archive holds, among some.
   *
   * @param commits - Commit hashes.
   * @returns Those the archive holds, in the same order.
   * @throws {@link UserError} as {@link Holdings.rememberKnown} does.
   */
  private async archivedCommits(commits: readonly string[]): Promise<string[]> {
    const revisions = commits.map((commit) => ({ commit, swhid: revisionSwhid(commit) }));

    // one request for all of them, then each answer read from the memo
    await this.holdings.rememberKnown(revisions.map(({ swhid }) => swhid));
    return revisions.filter(({ swhid }) => this.holdings.isKnownArchived(swhid)).map(({ commit }) => commit);
  }

  /**
   * A path's version in the most recent archived commit.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param dir - Whether the path is a directory.
   * @returns The most recent of HEAD's last `ANCHOR_CANDIDATES_MAX`
   * commits that is archived and holds the path, and the path's object in
   * it; `undefined` when none does.
   * @throws {@link UserError} as {@link Holdings.rememberKnown} does.
   */
  private async archivedVersion(root: string, rel: string, dir: boolean): Promise<Maybe<ArchivedVersion>> {
    const recent = await this.revList(root, 'HEAD');

    // a file's version is a blob, a directory's a tree: not one of the other kind
    const type = dir ? 'tree' : 'blob';
    for (const commit of await this.archivedCommits(recent)) {
      const hash = await this.objectAt(root, commit, rel, type);
      if (hash) return { commit, hash };
    }
    return undefined;
  }

  /**
   * The commit of HEAD's history that last changed a path.
   *
   * @remarks
   * Uses the plumbing `git rev-list`, not `git log`, whose output settings
   * such as `log.showSignature` could get in the way.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root, taken literally.
   * @returns The commit's hash, or `undefined` when no commit changed it.
   */
  lastCommit(root: string, rel: string): Promise<Maybe<string>> {
    return this.git.get(root, ['--literal-pathspecs', 'rev-list', '-1', 'HEAD', '--', rel]);
  }

  /**
   * The commits of HEAD's history that may hold an object at a path.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param hash - The object's hash.
   * @remarks
   * Those are the commits since the one that last changed the path: they
   * all hold the same object there, HEAD's. An older version of the path is
   * not this object, so the candidates are none unless HEAD holds it.
   *
   * @returns The commits from HEAD back to the one that last changed the
   * path, most recent first, at most `ANCHOR_CANDIDATES_MAX` plus that
   * one; none when HEAD does not hold `hash` at `rel`.
   */
  private async anchorCandidates(root: string, rel: string, hash: string): Promise<string[]> {
    if ((await this.objectAt(root, 'HEAD', rel)) !== hash) return [];

    const lastChange = await this.lastCommit(root, rel);
    if (!lastChange) return [];

    // what HEAD reaches but the last change's parents do not: that change, and every commit since
    const since = await this.revList(root, 'HEAD', '--not', `${lastChange}^@`);
    // the list stops at ANCHOR_CANDIDATES_MAX commits: the last change, the surest anchor, may be cut off
    return uniq([...since, lastChange]);
  }

  /**
   * The commit to anchor a SWHID on: the most recent archived commit that
   * holds the object at its path.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param coreSwhid - The object's core SWHID.
   * @returns The commit's hash, or `undefined` when no archived commit holds it.
   * @throws {@link UserError} as {@link Holdings.rememberKnown} does.
   */
  private async anchor(root: string, rel: string, coreSwhid: Swhid): Promise<Maybe<string>> {
    const commits = await this.anchorCandidates(root, rel, coreSwhid.hash);
    // one request for the object and its candidates: the commits are then all
    // remembered for archivedCommits, and the object's own status for the caller
    await this.holdings.rememberKnown([coreSwhid, ...commits.map(revisionSwhid)]);

    for (const commit of await this.archivedCommits(commits)) {
      // a commit of a branch merged since the last change may hold another version
      if ((await this.objectAt(root, commit, rel)) === coreSwhid.hash) return commit;
    }
    return undefined;
  }

  /**
   * The tree hash of the tracked working tree, as it is on disk.
   *
   * @remarks
   * The tracked files, modified or not, are staged in a copy of the index,
   * so the user's index is left alone. Untracked files are left out;
   * skip-worktree and assume-unchanged files count as indexed.
   *
   * @param root - The repository's root directory.
   * @returns The tree's hash.
   * @throws {@link UserError} when Git fails, e.g. on a file it cannot read.
   */
  async worktreeTree(root: string): Promise<string> {
    // staged in a copy of the index, which writes the blobs and trees as
    // git stash would
    return this.git.withIndexCopy(root, async (env) => {
      await this.git.check(root, ['add', '-u'], env);
      return this.git.check(root, ['write-tree'], env);
    });
  }

  /**
   * The core SWHID of a directory of the tracked working tree.
   *
   * @param dir - The directory's real path.
   * @param root - The repository's root directory.
   * @returns The SWHID, e.g. `swh:1:dir:…`, or `undefined` when nothing in
   * the directory is tracked.
   * @throws {@link UserError} as {@link WorkingTree.worktreeTree} does.
   */
  private async dirSwhid(dir: string, root: string): Promise<Maybe<Swhid>> {
    const hash = await this.objectAt(root, await this.worktreeTree(root), relativePath(root, dir));
    return hash ? Swhid.of('dir', hash) : undefined;
  }

  /**
   * The core SWHID of a file or directory, as it is in the working tree.
   *
   * @param file - The real path of a file or directory.
   * @param root - The root of the repository holding it, if any.
   * @returns The `cnt` SWHID of a file, or the `dir` SWHID of a directory.
   * @throws {@link UserError} for a directory outside a repository or with
   * nothing tracked, or when Git fails.
   */
  async worktreeSwhid(file: string, root: Maybe<string>): Promise<Swhid> {
    if ((await fs.stat(file)).isDirectory()) {
      if (!root) throw new UserError('Not inside a Git repository');

      const swhid = await this.dirSwhid(file, root);
      if (!swhid) throw new UserError(`Nothing is tracked in ${file}`);
      return swhid;
    }
    return this.contentSwhid(file, root);
  }

  /**
   * The version of a path the archive holds.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param dir - Whether the path is a directory.
   * @returns Its core SWHID, the commit holding it (its anchor), that
   * commit's SWHID, and `archived: true`; `undefined` when none of the
   * recent commits holding it is archived.
   * @throws {@link UserError} as {@link Holdings.rememberKnown} does.
   */
  private async archivedTarget(root: string, rel: string, dir: boolean): Promise<Maybe<SwhidTarget>> {
    const version = await this.archivedVersion(root, rel, dir);
    if (!version) return undefined;

    const versionSwhid = Swhid.of(dir ? 'dir' : 'cnt', version.hash);
    // the commit of the archived version holds it, hence its content
    this.holdings.rememberArchived(versionSwhid);
    return { core: versionSwhid, anchor: version.commit, version: revisionSwhid(version.commit), archived: true };
  }

  /**
   * A file or directory as it is in the working tree.
   *
   * @remarks
   * The archive is asked about it only with a public origin, or outside a
   * repository, as its content may have been archived from elsewhere: a
   * repository without a public origin cannot be archived. It is anchored
   * only in a repository with a public origin.
   *
   * @param place - Where it is in its repository, if it is in one.
   * @param pub - Whether the repository has a public origin.
   * @param worktree - Gives its core SWHID, see {@link WorkingTree.worktreeSwhid}.
   * @returns Its core SWHID, its anchor commit if any, and whether it is archived.
   * @throws {@link UserError} when Git or the archive fails.
   */
  private async worktreeTarget(place: Maybe<RepoPath>, pub: boolean, worktree: () => Promise<Swhid>): Promise<SwhidTarget> {
    const core = await worktree();
    // first: anchoring asks the archive about the SWHID too, in the same request
    const anchor = pub && place ? await this.anchor(place.root, place.rel, core) : undefined;
    const askable = pub || !place;
    const archived = askable ? await this.holdings.isArchived(core) : false;
    return { core, anchor, archived, version: undefined };
  }

  /**
   * The qualified SWHID of a file or directory, checked against the archive:
   * from Git and the archive's API.
   *
   * @remarks
   * {@link WorkingTree.qualifiedSwhid} falls back to the SWHID from Git alone,
   * `unchecked`, when this fails.
   *
   * @param file - The real path.
   * @param root - The root of the repository holding it, if any.
   * @param lines - The line range, if any; dropped for an archived
   * version that differs from the working tree's.
   * @param archivedVersion - Whether to identify the version the archive
   * holds rather than the working tree's; falls back to the working tree's
   * when none is archived.
   * @param worktree - Gives its core SWHID as it is in the working tree.
   * @returns The SWHID's details.
   * @throws {@link UserError} when Git or the archive fails.
   */
  private async checkedSwhid(
    file: string,
    root: Maybe<string>,
    lines: Maybe<LineRange>,
    archivedVersion: boolean,
    worktree: () => Promise<Swhid>,
  ): Promise<SwhidInfo> {
    const place: Maybe<RepoPath> = root ? { root, rel: relativePath(root, file) } : undefined;
    const info = place ? await this.origins.originQuiet(place.root) : null;
    const pub = isPublicOrigin(info?.origin);
    const dir = (await fs.stat(file)).isDirectory();

    // the archived version when asked for and found, else the working tree's
    const archived = archivedVersion && pub && place ? await this.archivedTarget(place.root, place.rel, dir) : undefined;
    const target = archived ?? (await this.worktreeTarget(place, pub, worktree));

    const swhid = target.core.qualify({
      origin: info?.origin,
      visit: info?.snapshot ? Swhid.of('snp', info.snapshot) : undefined,
      anchor: target.anchor ? revisionSwhid(target.anchor) : undefined,
      path: place && anchorPath(place.rel),
      lines: await WorkingTree.keptLines(target, lines, dir, worktree),
    });

    return {
      swhid,
      core: target.core,
      archived: target.archived,
      ...(info && { origin: info.origin, 'origin-archived': info.archived }),
      ...(target.version && { version: target.version }),
    };
  }

  /**
   * The selected lines that still hold for a target.
   *
   * @remarks
   * The lines were selected in the working tree. They hold for its version,
   * and for an archived version of the same content; another content's line
   * numbers would name other lines.
   *
   * @param target - What the SWHID is computed for.
   * @param lines - The lines selected, if any.
   * @param dir - Whether the target is a directory, which has no lines.
   * @param worktree - Gives the working tree's core SWHID; only called when
   * an archived version may have the same content.
   * @returns `lines`, or `undefined` when they no longer hold.
   */
  private static async keptLines(target: SwhidTarget, lines: Maybe<LineRange>, dir: boolean, worktree: () => Promise<Swhid>): Promise<Maybe<LineRange>> {
    if (lines === undefined || target.version === undefined) return lines;
    return !dir && target.core.equals(await worktree()) ? lines : undefined;
  }

  /**
   * The qualified SWHID of a file, a range of its lines, or a directory.
   *
   * @remarks
   * When the archive cannot be asked (unreachable, rate limit…), the SWHID
   * comes from Git alone, unqualified but for its lines, and
   * {@link SwhidInfo.unchecked} says why.
   *
   * @param file - The real path of a file or directory.
   * @param lines - The line range, if any.
   * @param archivedVersion - Whether to identify the version the archive holds.
   * @returns The SWHID's details.
   * @throws {@link UserError} when even Git cannot tell the SWHID.
   *
   * @example
   * ```ts
   * const info = await swh.qualifiedSwhid('/repo/src/a.ts', LineRange.of(3, 5));
   * info.swhid; // 'swh:1:cnt:…;origin=https://github.com/o/r;visit=…;anchor=…;path=/src/a.ts;lines=3-5'
   * ```
   */
  async qualifiedSwhid(file: string, lines?: LineRange, archivedVersion = false): Promise<SwhidInfo> {
    const root = await this.git.root(file);
    // computed once, whether the archive answers or not
    let swhid: Promise<Swhid> | undefined;
    const worktree = () => (swhid ??= this.worktreeSwhid(file, root));
    try {
      return await this.checkedSwhid(file, root, lines, archivedVersion, worktree);
    } catch (error) {
      if (!(error instanceof UserError)) throw error;

      // the SWHID from Git alone
      const worktreeSwhid = await worktree();
      const gitSwhid = worktreeSwhid.qualify({ lines });
      return { swhid: gitSwhid, core: worktreeSwhid, archived: false, unchecked: error.message };
    }
  }

  /**
   * Whether the archive holds a file or directory.
   *
   * @param file - The real path.
   * @param coreSwhid - Its core SWHID when already known, which spares hashing it.
   * @returns Its core SWHID and whether it is archived.
   * @throws {@link UserError} when Git or the archive fails.
   */
  async fileStatus(file: string, coreSwhid?: Swhid): Promise<FileStatus> {
    const swhid = coreSwhid ?? (await this.contentSwhid(file, await this.git.root(file)));
    return { swhid, archived: await this.holdings.isArchived(swhid) };
  }

  /**
   * The tree hash of a directory in HEAD, when its tracked files are unchanged.
   *
   * @remarks
   * Refreshing the files' recorded dates writes the index, so the check
   * runs on a copy of it: the user's index is never locked or changed. A
   * file whose date alone changed counts as unchanged.
   *
   * @param dir - The directory's real path.
   * @param root - The repository's root directory.
   * @returns The tree's hash, or `undefined` when there is no HEAD commit,
   * or a tracked file in the directory differs from HEAD, in the working tree
   * or in the index.
   * @throws {@link UserError} when Git cannot tell where the index is.
   */
  async headTree(dir: string, root: string): Promise<Maybe<string>> {
    // in a copy: refreshing the dates writes the index
    return this.git.withIndexCopy(root, async (env) => {
      // a file whose date alone changed is then no difference
      await this.git.run(root, ['update-index', '-q', '--refresh'], { env });
      if (!(await this.isAsInHead(dir, env))) return undefined;
      return this.git.get(dir, ['rev-parse', '--verify', '-q', 'HEAD:./'], env);
    });
  }

  /**
   * Whether the tracked files of a directory are as HEAD has them.
   *
   * @param dir - The directory.
   * @param env - The environment of the Git commands, with the index to use.
   * @returns `true` when no file differs: neither modified in the working
   * tree, compared with the index, nor staged, compared with HEAD; `false`
   * too when Git cannot tell, e.g. without a HEAD commit.
   */
  private async isAsInHead(dir: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    const unmodified = await this.findsNoDifference(dir, ['diff-files'], env);
    return unmodified && (await this.findsNoDifference(dir, ['diff-index', '--cached', 'HEAD'], env));
  }

  /**
   * Runs a Git diff of a directory, quietly.
   *
   * @param dir - The directory.
   * @param diff - The diff command and what it compares, e.g. `['diff-files']`.
   * @param env - The environment of the Git command.
   * @returns `true` when the diff finds no difference: its exit status is 0,
   * which a difference makes 1 and a failure more.
   */
  private async findsNoDifference(dir: string, diff: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
    const result = await this.git.run(dir, [...diff, '--quiet', '--', '.'], { env });
    return result.status === 0;
  }

  /**
   * Whether a directory holds untracked files that Git does not ignore.
   *
   * @param dir - The directory's path.
   * @returns `true` when it holds at least one; `false` when Git lists none,
   * or cannot list them.
   */
  async untracked(dir: string): Promise<boolean> {
    const listUntracked = [
      'ls-files',
      // the files Git does not track…
      '--others',
      // …and does not ignore, by .gitignore and the like
      '--exclude-standard',
      // an untracked directory as one entry, rather than each file in it
      '--directory',
      // but not an empty one: Git cannot track it
      '--no-empty-directory',
      // the names as they are, separated by NUL bytes
      '-z',
      '--',
      '.',
    ];
    const listed = await this.git.get(dir, listUntracked);
    // Git lists nothing when there are none, which `get` gives as `undefined`
    return listed !== undefined;
  }
}
