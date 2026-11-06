/**
 * The fourth layer of {@link Swh}: the SWHIDs of files and directories,
 * computed with Git and anchored on archived commits.
 *
 * @packageDocumentation
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { relativePath } from '../git';
import { UserError } from '../http';
import { core, hashOf, isPublicOrigin, qualify } from '../swhid';
import { memoPut, uniq } from './memo';
import { SwhOrigins } from './origins';
import type { SwhidInfo } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Number of the most recent commits that are considered as a SWHID's anchor. */
const ANCHOR_CANDIDATES_MAX = 100;

/** SWHIDs of files and directories; see {@link Swh}. */
export class SwhSwhids extends SwhOrigins {
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
  async contentSwhid(file: string, root: string | undefined): Promise<string> {
    const hash = root
      ? await this.git.get(root, ['hash-object', '--path', relativePath(root, file), '--', file])
      : await this.git.get(path.dirname(file), ['hash-object', '--no-filters', '--', file]);
    if (!hash) throw new UserError(`Cannot hash ${file} with git`);
    return core('cnt', hash);
  }

  /**
   * The most recent commits `git rev-list` lists.
   *
   * @param root - The repository's root directory.
   * @param args - The arguments of `git rev-list`, e.g. `HEAD`.
   * @returns At most {@link ANCHOR_CANDIDATES_MAX} commit hashes, most recent first.
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
  private async objectAt(root: string, commit: string, rel: string, type?: 'blob' | 'tree'): Promise<string | undefined> {
    const object = rel === '.' ? `${commit}^{tree}` : `${commit}:${rel}`;
    const hash = await this.git.get(root, ['rev-parse', '--verify', '-q', object]);
    if (!hash) return undefined;
    if (type && type !== (await this.git.get(root, ['cat-file', '-t', hash]))) return undefined;
    return hash;
  }

  /**
   * The commits the archive holds, among some.
   *
   * @param commits - Commit hashes.
   * @returns Those the archive holds, in the same order.
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  private async archivedCommits(commits: string[]): Promise<string[]> {
    await this.rememberKnown(commits.map((c) => core('rev', c)));
    return commits.filter((c) => this.knownP(core('rev', c)));
  }

  /**
   * A path's version in the most recent archived commit.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param dir - Whether the path is a directory.
   * @returns `[commit, hash]` for the most recent of HEAD's last
   * {@link ANCHOR_CANDIDATES_MAX} commits that is archived and holds the
   * path, or `undefined` when none does.
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  private async archivedVersion(root: string, rel: string, dir: boolean): Promise<[string, string] | undefined> {
    for (const commit of await this.archivedCommits(await this.revList(root, 'HEAD'))) {
      const hash = await this.objectAt(root, commit, rel, dir ? 'tree' : 'blob');
      if (hash) return [commit, hash];
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
  protected lastCommit(root: string, rel: string) {
    return this.git.get(root, ['--literal-pathspecs', 'rev-list', '-1', 'HEAD', '--', rel]);
  }

  /**
   * The commits of HEAD's history that may hold an object at a path.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param hash - The object's hash.
   * @returns The commits from HEAD back to the one that last changed the
   * path, most recent first, at most {@link ANCHOR_CANDIDATES_MAX} plus that
   * one; none when HEAD does not hold `hash` at `rel`.
   */
  private async anchorCandidates(root: string, rel: string, hash: string): Promise<string[]> {
    if (hash !== (await this.objectAt(root, 'HEAD', rel))) return [];
    const last = await this.lastCommit(root, rel);
    if (!last) return [];
    return uniq([...(await this.revList(root, 'HEAD', '--not', `${last}^@`)), last]);
  }

  /**
   * The commit to anchor a SWHID on: the most recent archived commit that
   * holds the object at its path.
   *
   * @param root - The repository's root directory.
   * @param rel - The path relative to the root.
   * @param coreSwhid - The object's core SWHID.
   * @returns The commit's hash, or `undefined` when no archived commit holds it.
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  private async anchor(root: string, rel: string, coreSwhid: string): Promise<string | undefined> {
    const hash = hashOf(coreSwhid);
    const commits = await this.anchorCandidates(root, rel, hash);
    await this.rememberKnown([coreSwhid, ...commits.map((c) => core('rev', c))]);
    for (const commit of await this.archivedCommits(commits)) {
      if (hash === (await this.objectAt(root, commit, rel))) return commit;
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
   * @throws {@link UserError} as {@link Swh.worktreeTree} does.
   */
  private async dirSwhid(dir: string, root: string): Promise<string | undefined> {
    const hash = await this.objectAt(root, await this.worktreeTree(root), relativePath(root, dir));
    return hash ? core('dir', hash) : undefined;
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
  async worktreeSwhid(file: string, root: string | undefined): Promise<string> {
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
   * @throws {@link UserError} as {@link Swh.rememberKnown} does.
   */
  private async archivedTarget(root: string, rel: string, dir: boolean) {
    const version = await this.archivedVersion(root, rel, dir);
    if (!version) return undefined;
    const c = core(dir ? 'dir' : 'cnt', version[1]);
    // the commit of the archived version holds it, hence its content
    memoPut(this.knownMemo, c, true);
    return { core: c, anchor: version[0], version: core('rev', version[0]), archived: true };
  }

  /**
   * A file or directory as it is in the working tree.
   *
   * @remarks
   * The archive is asked about it only with a public origin, or outside a
   * repository: a repository without a public origin cannot be archived.
   *
   * @param file - The real path.
   * @param root - The root of the repository holding it, if any.
   * @param rel - The path relative to `root`.
   * @param pub - Whether the repository has a public origin.
   * @returns Its core SWHID, its anchor commit if any, and whether it is archived.
   * @throws {@link UserError} when Git or the archive fails.
   */
  private async worktreeTarget(file: string, root: string | undefined, rel: string | undefined, pub: boolean) {
    const c = await this.worktreeSwhid(file, root);
    return {
      core: c,
      anchor: pub && root ? await this.anchor(root, rel!, c) : undefined,
      archived: pub || !root ? await this.archivedP(c) : false,
      version: undefined as string | undefined,
    };
  }

  /**
   * The qualified SWHID of a file or directory, from Git and the archive's API.
   *
   * @param file - The real path.
   * @param lines - The line range, `A-B` or `A`; dropped for an archived version.
   * @param archivedVersion - Whether to identify the version the archive
   * holds rather than the working tree's; falls back to the working tree's
   * when none is archived.
   * @returns The SWHID's details.
   * @throws {@link UserError} when Git or the archive fails.
   */
  private async directSwhid(file: string, lines: string | undefined, archivedVersion: boolean): Promise<SwhidInfo> {
    const root = await this.git.root(file);
    const rel = root ? relativePath(root, file) : undefined;
    const info = root ? await this.directOrigin(root) : null;
    const origin = info?.origin;
    const pub = isPublicOrigin(origin);
    const dir = (await fs.stat(file)).isDirectory();
    const t = (archivedVersion && pub && root ? await this.archivedTarget(root, rel!, dir) : undefined) ??
      (await this.worktreeTarget(file, root, rel, pub));
    const result: SwhidInfo = {
      swhid: qualify(t.core, origin, info?.snapshot, t.anchor ? core('rev', t.anchor) : undefined, rel, t.version ? undefined : lines),
      core: t.core,
      archived: t.archived,
    };
    if (origin) {
      result.origin = origin;
      result['origin-archived'] = info!.archived;
    }
    if (t.version) result.version = t.version;
    return result;
  }

  /**
   * The qualified SWHID of a file, a range of its lines, or a directory.
   *
   * @remarks
   * Through swhd when it runs and the file is outside a repository or in
   * one with a public origin; directly otherwise. When the archive cannot
   * be asked (unreachable, rate limit…), the SWHID comes from Git alone,
   * unqualified but for its lines, and {@link SwhidInfo.unchecked} says why.
   *
   * @param file - The real path of a file or directory.
   * @param lines - The line range, `A-B` or `A`.
   * @param archivedVersion - Whether to identify the version the archive holds.
   * @returns The SWHID's details.
   * @throws {@link UserError} when even Git cannot tell the SWHID, or the
   * daemon fails.
   *
   * @example
   * ```ts
   * const info = await swh.qualifiedSwhid('/repo/src/a.ts', '3-5');
   * info.swhid; // 'swh:1:cnt:…;origin=https://github.com/o/r;visit=…;anchor=…;path=/src/a.ts;lines=3-5'
   * ```
   */
  async qualifiedSwhid(file: string, lines?: string, archivedVersion = false): Promise<SwhidInfo> {
    const root = await this.git.root(file);
    const origin = root ? await this.originOf(root) : undefined;
    if ((await this.daemonAvailable()) && (!root || isPublicOrigin(origin))) {
      const params: Array<[string, string?]> = [];
      if (archivedVersion) params.push(['archived']);
      if (lines) params.push(['lines', lines]);
      return this.daemon('GET', '/swhid', { path: file, params, timeout: 60 });
    }
    try {
      return await this.directSwhid(file, lines, archivedVersion);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      // the SWHID from Git alone
      const c = await this.worktreeSwhid(file, root);
      return { swhid: qualify(c, null, null, null, null, lines), core: c, archived: false, unchecked: e.message };
    }
  }

  /**
   * Whether the archive holds a file or directory, as swhd's `/file` tells.
   *
   * @param file - The real path.
   * @param coreSwhid - Its core SWHID when already known, which spares hashing it.
   * @returns Its core SWHID and whether it is archived.
   * @throws {@link UserError} when Git, the daemon or the archive fails.
   */
  async fileStatus(file: string, coreSwhid?: string): Promise<{ swhid: string; archived: boolean }> {
    if (await this.daemonAvailable()) return this.daemon('GET', '/file', { path: file });
    const c = coreSwhid ?? (await this.contentSwhid(file, await this.git.root(file)));
    return { swhid: c, archived: await this.archivedP(c) };
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
   * @returns The tree's hash, or `undefined` when a tracked file in the
   * directory differs from HEAD, in the working tree or in the index.
   */
  async headTree(dir: string, root: string): Promise<string | undefined> {
    // in a copy: refreshing the dates writes the index
    return this.git.withIndexCopy(root, async (env) => {
      await this.git.run(root, ['update-index', '-q', '--refresh'], { env });
      if ((await this.git.run(dir, ['diff-files', '--quiet', '--', '.'], { env })).status !== 0) return undefined;
      if ((await this.git.run(dir, ['diff-index', '--cached', '--quiet', 'HEAD', '--', '.'], { env })).status !== 0) return undefined;
      return this.git.get(dir, ['rev-parse', '--verify', '-q', 'HEAD:./'], env);
    });
  }

  /**
   * Whether a directory holds untracked files that Git does not ignore.
   *
   * @param dir - The directory's path.
   * @returns `true` when it holds at least one.
   */
  async untracked(dir: string): Promise<boolean> {
    return !!(await this.git.get(dir, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z', '--', '.']));
  }
}
