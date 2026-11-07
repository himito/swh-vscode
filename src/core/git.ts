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

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserError } from './http';
import type { Maybe } from './types';

/** The result of a Git command. */
export type GitResult = {
  /** The exit status: 0 on success, -1 when Git could not be run at all. */
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
   * Never throws: when Git cannot be run, the status is -1.
   *
   * @param dir - The directory to run it in.
   * @param args - The command's arguments, e.g. `['rev-parse', 'HEAD']`.
   * @param opts - Whether to capture the standard error, and the environment.
   * @returns Its exit status and its output, trimmed.
   */
  run(dir: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
    return new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn(this.program(), args, { cwd: dir, env: opts.env ?? process.env, windowsHide: true });
      } catch {
        resolve({ status: -1, out: '' });
        return;
      }
      child.stdout.setEncoding('utf8').on('data', (d: string) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d: string) => {
        if (opts.stderr) out += d;
      });
      // only the final newlines: a path may end with a space
      const output = () => out.replace(/[\r\n]+$/, '');
      child.on('error', () => resolve({ status: -1, out: output() }));
      child.on('close', (code) => resolve({ status: code ?? -1, out: output() }));
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
    const r = await this.run(dir, args, { env });
    return r.status === 0 && r.out !== '' ? r.out : undefined;
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
    const r = await this.run(dir, args, { stderr: true, env });
    if (r.status !== 0) {
      throw new UserError(`Git ${args[0]} failed in ${dir}: ${r.out}`);
    }
    return r.out;
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
   * @throws {@link UserError} when Git cannot tell where the index is.
   */
  async withIndexCopy<T>(root: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const index = path.resolve(root, await this.check(root, ['rev-parse', '--git-path', 'index']));
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'swh-index-'));
    const tmp = path.join(tmpdir, 'index');
    try {
      // git rejects an empty index file: none at all is an empty index;
      // the copy keeps the index's date, against which git tells whether
      // a file's recorded stat can be trusted
      const st = await fs.stat(index).catch(() => undefined);
      // no index: an empty one; a failed copy must not pass for one
      if (st) {
        await fs.copyFile(index, tmp);
        await fs.utimes(tmp, st.atime, st.mtime);
      }
      return await fn({ ...process.env, GIT_INDEX_FILE: tmp });
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => undefined);
    }
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
