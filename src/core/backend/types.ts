/**
 * The data {@link Swh} answers with, and what it needs from its host.
 *
 * @packageDocumentation
 */

import type { Git } from '../git';

/** The archival status of a repository's origin. */
export interface OriginInfo {
  /** The origin URL, normalized as the archive names it, e.g. `https://github.com/owner/repo`. */
  origin: string;
  /** Whether the archive holds the origin, i.e. has visited it with a snapshot. */
  archived: boolean;
  /** The date of the latest visit with a snapshot, ISO 8601; only when archived. */
  date?: string;
  /** The status of that visit, e.g. `full`; only when archived. */
  status?: string;
  /** The SHA-1 of that visit's snapshot; only when archived. */
  snapshot?: string;
  /** The revision SWHID of the commit the current branch's upstream points to, when asked for. */
  upstream?: string;
  /** Whether the archive holds {@link OriginInfo.upstream}. */
  'upstream-archived'?: boolean;
}

/** The SWHID of a file, directory or range of lines. */
export interface SwhidInfo {
  /** The qualified SWHID: the core SWHID with its context qualifiers (origin, visit, anchor, path, lines). */
  swhid: string;
  /** The core SWHID, without qualifiers, e.g. `swh:1:cnt:…`. */
  core: string;
  /** Whether the archive holds the core SWHID. */
  archived: boolean;
  /** The origin of the repository holding the file, public or not. */
  origin?: string;
  /** Whether the archive holds that origin. */
  'origin-archived'?: boolean;
  /**
   * The revision SWHID of the commit whose version is identified, when the
   * archived version was asked for and found.
   */
  version?: string;
  /** Why the archive was not asked: the SWHID then comes from Git alone. */
  unchecked?: string;
}

/** A file or directory of the tracked working tree, with its archival status. */
export interface TreeNode {
  /** The path relative to the repository root, with `/` separators; `.` for the root. */
  path: string;
  /** The core SWHID: `dir` for a directory, `cnt` for a file, `rev` for a submodule's commit. */
  swhid: string;
  /** Whether the node is a directory. */
  dir: boolean;
  /** Whether the archive holds it, itself or through an archived directory above it. */
  archived: boolean;
}

/**
 * What {@link Swh} needs from its host: settings and callbacks.
 *
 * @remarks
 * The extension passes functions that read VS Code's settings and secret
 * storage; the tests pass fixed values.
 */
export interface SwhDeps {
  /** The archive's web root, e.g. `https://archive.softwareheritage.org`; read at each request. */
  archiveUrl(): string;
  /** The API token, or `undefined` to make anonymous requests. */
  token(): Promise<string | undefined>;
  /** Show a warning to the user. */
  warn(message: string): void;
  /** Called whenever the tokenless rate limit is updated, see {@link Swh.rateLimit}. */
  onRateLimit?(): void;
  /** The Git runner to use. */
  git: Git;
}
