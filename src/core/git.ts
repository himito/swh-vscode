/**
 * Running Git.
 *
 * @remarks
 * The extension computes SWHIDs with Git itself: a Git blob, tree or commit
 * hash is the hash of the matching SWHID. This module runs the `git`
 * executable as a child process. It must not import `vscode`, so that the
 * unit tests can run it with Node alone.
 *
 * @packageDocumentation
 */

import { type ChildProcess, spawn } from 'child_process';
import { promises as fs, type Stats } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type Maybe, UserError } from './shared';

/** The exit status of a Git command that could not be run at all, e.g. Git is not installed. */
export const GIT_NOT_RUN = -1;

/**
 * The output of a Git command, without its final newlines.
 *
 * @remarks
 * Only the newlines: a path Git prints may end with a space.
 *
 * @param out - The output.
 * @returns `out` without its trailing `\n` and `\r`.
 */
const withoutFinalNewlines = (out: string) => out.replace(/[\r\n]+$/, '');

/** The result of a Git command. */
export type GitResult = {
  /** The exit status: 0 on success, {@link GIT_NOT_RUN} when Git could not be run at all. */
  status: number;
  /** The standard output (and error, if asked for), without its final newlines. */
  out: string;
};

/** Options of {@link Git.run}. */
export type GitOptions = {
  /** Whether to put the standard error into the output too, e.g. for error messages. */
  stderr?: boolean;
  /** The environment of the Git process; the extension's own by default. */
  env?: NodeJS.ProcessEnv;
};

/** Runs Git commands. */
export class Git {
  /**
   * Creates the runner.
   *
   * @param program - Gives the Git executable to run; read on each command,
   * so that a change of the `swh.gitPath` setting applies at once.
   * @defaultValue `program` gives `"git"`.
   */
  constructor(private program: () => string = () => 'git') {}

  /**
   * Runs a Git command.
   *
   * @remarks
   * Never throws: when Git cannot be run, the status is {@link GIT_NOT_RUN}.
   * Git gets no standard input, so a command that would read it, e.g. to
   * prompt, ends instead of waiting. Its standard error is read only when
   * `opts.stderr` asks for it, and dropped otherwise.
   *
   * @param dir - The directory to run it in.
   * @param args - The command's arguments, e.g. `['rev-parse', 'HEAD']`.
   * @param opts - Whether to capture the standard error, and the environment.
   * @returns Its exit status and its output, without its final newlines.
   */
  run(dir: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
    return new Promise((resolve) => {
      const chunks: string[] = [];
      // a promise settles once: a `close` after an `error` changes nothing
      const finish = (status: number) => resolve({ status, out: withoutFinalNewlines(chunks.join('')) });

      let child: ChildProcess;
      try {
        child = spawn(this.program(), args, {
          cwd: dir,
          env: opts.env ?? process.env,
          stdio: ['ignore', 'pipe', opts.stderr ? 'pipe' : 'ignore'],
          windowsHide: true,
        });
      } catch {
        finish(GIT_NOT_RUN);
        return;
      }

      const collect = (chunk: string) => chunks.push(chunk);
      child.stdout?.setEncoding('utf8').on('data', collect);
      child.stderr?.setEncoding('utf8').on('data', collect);
      child.on('error', () => finish(GIT_NOT_RUN));
      child.on('close', (code) => finish(code ?? GIT_NOT_RUN));
    });
  }

  /**
   * Runs a Git command whose failure means "no answer".
   *
   * @param dir - The directory to run it in.
   * @param args - The command's arguments.
   * @param env - The environment of the Git process, if not the extension's own.
   * @returns The command's output, trimmed; `undefined` when it fails or
   * prints nothing.
   */
  async get(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<Maybe<string>> {
    const result = await this.run(dir, args, { env });
    return result.status === 0 && result.out !== '' ? result.out : undefined;
  }

  /**
   * Runs a Git command that must succeed.
   *
   * @remarks
   * For commands that print nothing on their standard error when they
   * succeed: the error is then Git's own message.
   *
   * @param dir - The directory to run it in.
   * @param args - The command's arguments.
   * @param env - The environment of the Git process, if not the extension's own.
   * @returns The command's output, trimmed, possibly empty.
   * @throws {@link UserError} when the command fails, with Git's message.
   */
  async check(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const result = await this.run(dir, args, { stderr: true, env });
    if (result.status !== 0) {
      throw new UserError(`Git ${args[0]} failed in ${dir}: ${result.out}`);
    }
    return result.out;
  }

  /**
   * Finds the root of the Git repository holding a file or directory.
   *
   * @param file - A file or directory; it does not need to exist.
   * @returns The absolute path of the repository's working tree, or
   * `undefined` outside a repository (or inside its `.git` directory).
   */
  async root(file: string): Promise<Maybe<string>> {
    let dir = file;
    try {
      if (!(await fs.stat(file)).isDirectory()) dir = path.dirname(file);
    } catch {
      dir = path.dirname(file);
    }
    const top = await this.get(dir, ['rev-parse', '--show-toplevel']);
    return top ? path.resolve(top) : undefined;
  }

  /**
   * Runs Git commands against a temporary copy of a repository's index.
   *
   * @remarks
   * Staging files or refreshing the index writes it, and the user's index
   * must never change under their feet: `fn` gets an environment whose
   * `GIT_INDEX_FILE` points to a copy, deleted afterwards. The copy keeps
   * the index's modification time, against which Git tells whether a file's
   * recorded stat can be trusted.
   *
   * @typeParam T - What `fn` gives.
   * @param root - The repository's root.
   * @param fn - Runs the Git commands, with the environment to pass to them.
   * @returns What `fn` gives.
   * @throws {@link UserError} when Git cannot tell where the index is; the
   * file system's error when the index exists but cannot be read or copied.
   */
  async withIndexCopy<T>(root: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const index = await this.indexPath(root);
    return withTempDir(INDEX_COPY_PREFIX, async (dir) => {
      const copy = path.join(dir, 'index');
      await copyIndex(index, copy);
      return fn({ ...process.env, GIT_INDEX_FILE: copy });
    });
  }

  /**
   * The path of a repository's index.
   *
   * @remarks
   * Git gives it relative to the root, or absolute, e.g. in a linked
   * worktree or when `GIT_INDEX_FILE` is set.
   *
   * @param root - The repository's root.
   * @returns The index's absolute path; the file may not exist yet.
   * @throws {@link UserError} when Git cannot tell where the index is.
   */
  private async indexPath(root: string): Promise<string> {
    return path.resolve(root, await this.check(root, ['rev-parse', '--git-path', 'index']));
  }
}

/** The prefix of the temporary directories that hold the copies of an index. */
const INDEX_COPY_PREFIX = 'swh-index-';

/**
 * Runs `fn` with a new temporary directory, deleted afterwards.
 *
 * @remarks
 * The directory is deleted whether `fn` succeeds or not; a failure to
 * delete it is ignored, as it is the system's temporary directory.
 *
 * @typeParam T - What `fn` gives.
 * @param prefix - The start of the directory's name.
 * @param fn - What to run, with the directory's path.
 * @returns What `fn` gives.
 */
async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Copies a repository's index, keeping its modification time.
 *
 * @remarks
 * Git tells from the index's date whether the file stats it records can be
 * trusted, so the copy keeps it. A repository may have no index yet, e.g.
 * before its first `git add`: then no copy is made, which Git reads as an
 * empty index. An empty file would not do: Git rejects it.
 *
 * @param index - The index's path.
 * @param copy - Where to copy it.
 * @throws The file system's error when the index exists but cannot be read
 * or copied: an empty index must not pass for it.
 */
async function copyIndex(index: string, copy: string): Promise<void> {
  const stats = await statIfExists(index);
  if (!stats) return;
  await fs.copyFile(index, copy);
  await fs.utimes(copy, stats.atime, stats.mtime);
}

/**
 * The stats of a file, if it exists.
 *
 * @param file - The file's path.
 * @returns Its stats, or `undefined` when there is no such file.
 * @throws The file system's error for any other failure, e.g. a permission denied.
 */
async function statIfExists(file: string): Promise<Maybe<Stats>> {
  try {
    return await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Gives the path of a file relative to a repository root, as Git and
 * SWHIDs write it.
 *
 * @param root - The repository's root.
 * @param file - A file or directory inside it.
 * @returns The relative path with `/` separators on every platform, or
 * `"."` for the root itself.
 */
export function relativePath(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}
