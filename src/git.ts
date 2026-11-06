// Running Git, without VS Code.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UserError } from './http';

export interface GitResult {
  status: number;
  out: string;
}

export interface GitOptions {
  /** Put the standard error into the output too. */
  stderr?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class Git {
  constructor(private program: () => string = () => 'git') {}

  /** Run git ARGS in DIR: its status and its output, trimmed. */
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
      child.on('error', () => resolve({ status: -1, out: out.trim() }));
      child.on('close', (code) => resolve({ status: code ?? -1, out: out.trim() }));
    });
  }

  /** Trimmed output of git ARGS in DIR; undefined when it fails or says nothing. */
  async get(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | undefined> {
    const r = await this.run(dir, args, { env });
    return r.status === 0 && r.out !== '' ? r.out : undefined;
  }

  /** Trimmed output of git ARGS in DIR; a UserError with its message on failure. */
  async check(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const r = await this.run(dir, args, { stderr: true, env });
    if (r.status !== 0) {
      throw new UserError(`Git ${args[0]} failed in ${dir}: ${r.out}`);
    }
    return r.out;
  }

  /** Root of the Git repository holding FILE, undefined outside one. */
  async root(file: string): Promise<string | undefined> {
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
   * Call FN with the environment that makes a copy of the index of the
   * repository at ROOT Git's index.
   */
  async withIndexCopy<T>(root: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const index = path.resolve(root, await this.check(root, ['rev-parse', '--git-path', 'index']));
    const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'swh-index-'));
    const tmp = path.join(tmpdir, 'index');
    try {
      // git rejects an empty index file: none at all is an empty index;
      // the copy keeps the index's date, against which git tells whether
      // a file's recorded stat can be trusted
      try {
        const st = await fs.stat(index);
        await fs.copyFile(index, tmp);
        await fs.utimes(tmp, st.atime, st.mtime);
      } catch {
        // no index
      }
      return await fn({ ...process.env, GIT_INDEX_FILE: tmp });
    } finally {
      await fs.rm(tmpdir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** FILE relative to ROOT, with slashes; "." for ROOT itself. */
export function relativePath(root: string, file: string): string {
  const rel = path.relative(root, file).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}
