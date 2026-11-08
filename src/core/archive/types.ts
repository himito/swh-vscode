/**
 * The data {@link Swh} answers with, and what it needs from its host.
 *
 * @packageDocumentation
 */

import type { Git } from '#core/git';
import type { Swhid } from '#core/swhid';
import type { Maybe } from '#core/shared';
import type { ArchiveApi } from './archiveApi';

/** An API token, or `undefined` to make anonymous requests. */
export type Token = Maybe<string>;

/** The archival status of a repository's origin. */
export type OriginInfo = {
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
  upstream?: Swhid;
  /** Whether the archive holds {@link OriginInfo.upstream}. */
  'upstream-archived'?: boolean;
};

/** An archival visit of an origin, as the archive lists it. */
export type Visit = {
  /** When the visit happened, ISO 8601. */
  date: string;
  /** How it ended, e.g. `full` or `partial`. */
  status: string;
  /** The SHA-1 of the snapshot it took, if any. */
  snapshot?: string;
};

/** An origin and its last archival visits. */
export type OriginVisits = {
  /** The origin URL, normalized as the archive names it. */
  origin: string;
  /** Its visits, most recent first; none when it is not archived. */
  visits: Visit[];
};

/** A save request, as the archive answered it. */
export type SaveRequest = {
  /** The origin URL the request is for. */
  origin: string;
  /** Where the request stands, e.g. `accepted`, or `pending` while it awaits review. */
  status: string;
};

/** The SWHID of a file, directory or range of lines. */
export type SwhidInfo = {
  /** The qualified SWHID: the core SWHID with its context qualifiers (origin, visit, anchor, path, lines). */
  swhid: Swhid;
  /** The core SWHID, without qualifiers, e.g. `swh:1:cnt:…`. */
  core: Swhid;
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
  version?: Swhid;
  /** Why the archive was not asked: the SWHID then comes from Git alone. */
  unchecked?: string;
};

/** Whether the archive holds a file or directory, see {@link Swh.fileStatus}. */
export type FileStatus = {
  /** Its core SWHID, e.g. `swh:1:cnt:…`. */
  swhid: Swhid;
  /** Whether the archive holds it. */
  archived: boolean;
};

/** A file or directory of the tracked working tree, with its archival status. */
export type TreeNode = {
  /** The path relative to the repository root, with `/` separators; `.` for the root. */
  path: string;
  /** The core SWHID: `dir` for a directory, `cnt` for a file, `rev` for a submodule's commit. */
  swhid: Swhid;
  /** Whether the node is a directory. */
  dir: boolean;
  /** Whether the archive holds it, itself or through an archived directory above it. */
  archived: boolean;
};

/**
 * What the archive answered to a citation request.
 *
 * @remarks
 * - `{ entry }`: the archive's BibTeX entry.
 * - `'no-metadata'`: the archive has no citation metadata for it.
 * - `'failed'`: the archive failed to make one.
 * - `'not-archived'`: the archive was not asked, as it does not hold the code.
 */
export type CitationAnswer =
  | {
      /** The archive's BibTeX entry. */
      entry: string;
    }
  | 'no-metadata'
  | 'failed'
  | 'not-archived';

/**
 * What {@link Swh} needs from its host: Git, and the archive.
 *
 * @remarks
 * The extension passes the HTTP implementation of the archive's Web API
 * (`HttpArchiveApi`) and a Git runner; the tests may pass a fake archive
 * instead.
 */
export type SwhDeps = {
  /** The Git runner to use. */
  git: Git;
  /** The Software Heritage archive, see {@link ArchiveApi}. */
  archive: ArchiveApi;
};
