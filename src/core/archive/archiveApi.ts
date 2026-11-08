/**
 * What the client asks the Software Heritage archive: the {@link ArchiveApi} interface.
 *
 * @remarks
 * {@link Swh} asks the archive only through {@link ArchiveApi}, in its own
 * terms (SWHIDs, origins, visits, save requests, citations), and never sees
 * HTTP, URLs, status codes or JSON. Those belong to the implementation:
 * `HttpArchiveApi` (in `adapters/`) implements the interface over the archive's
 * Web API. Another implementation, e.g. a fake archive in memory for the
 * tests, can be given to {@link Swh} instead (see {@link SwhDeps}).
 *
 * @packageDocumentation
 */

import type { Maybe } from '#core/shared';
import type { CitationAnswer, SaveRequest, Visit } from './types';

/**
 * The start of the {@link UserError} message an {@link ArchiveApi} raises
 * when the archive's rate limit is reached; callers test for it to tell that
 * failure apart.
 */
export const RATE_LIMIT_MESSAGE = 'Software Heritage API rate limit reached';

/**
 * The latest visit of an origin that took a snapshot, or that there is none.
 *
 * @remarks
 * - `{ archived: false }`: the archive holds no such visit: it has not archived the origin.
 * - `{ archived: true, visit }`: it has.
 */
export type LatestVisit =
  | {
    /** The archive has not archived the origin. */
    archived: false;
  }
  | {
    /** The archive has archived the origin. */
    archived: true;
    /** The visit; `undefined` when the archive's description of it is unusable. */
    visit: Maybe<Visit>;
  };

/** What a citation is asked for: a SWHID, or an origin's latest snapshot. */
export type CitationTarget =
  | {
    /** The SWHID to cite, qualified or not, as its canonical text. */
    swhid: string;
  }
  | {
    /** The public URL of the origin whose latest snapshot to cite. */
    origin: string;
  };

/** The archive's rate limit of requests without a token. */
export type RateLimit = {
  /** Requests made in the current window. */
  used: number;
  /** Requests allowed per window. */
  limit: number;
  /** When the window ends, in epoch seconds. */
  reset: number;
};

/**
 * What the client asks the Software Heritage archive.
 *
 * @remarks
 * Every method that asks the archive throws a {@link UserError} when the
 * archive cannot be reached, when its rate limit is reached (the message then
 * starts with {@link RATE_LIMIT_MESSAGE}), or when it answers an error or an
 * answer that cannot be understood; the message says what went wrong, for
 * the user.
 */
export interface ArchiveApi {
  /**
   * Which SWHIDs the archive holds.
   *
   * @param swhids - Core SWHIDs as their canonical text (see `Swhid.toString`),
   * as many as needed.
   * @returns Whether the archive holds each SWHID it answered about, by the
   * same text; a SWHID it did not answer about is missing.
   */
  known(swhids: readonly string[]): Promise<Map<string, boolean>>;

  /**
   * The latest visit of an origin that took a snapshot.
   *
   * @param origin - The origin URL, as the archive names it.
   * @returns The visit, or that the archive has not archived the origin.
   */
  latestVisit(origin: string): Promise<LatestVisit>;

  /**
   * The latest visits of an origin.
   *
   * @param origin - The origin URL, as the archive names it.
   * @param count - How many visits to give, at most.
   * @returns The visits, most recent first; unusable ones are left out.
   */
  visits(origin: string, count: number): Promise<Visit[]>;

  /**
   * Asks the archive to save a public repository now ("Save Code Now").
   *
   * @param origin - The repository's public URL.
   * @returns The save request, as the archive answered it; a refused
   * request is an error.
   */
  save(origin: string): Promise<SaveRequest>;

  /**
   * A BibTeX entry citing a SWHID or an origin, made by the archive from the
   * repository's `codemeta.json` or `CITATION.cff`.
   *
   * @param target - What to cite.
   * @returns The entry, or why there is none: `'no-metadata'` or `'failed'`.
   * Only an unreachable archive or the rate limit are errors.
   */
  citation(target: CitationTarget): Promise<CitationAnswer>;

  /**
   * The rate limit of requests without a token, as last seen; asks nothing.
   *
   * @returns The rate limit, or `undefined` when not known, e.g. with a token.
   */
  rateLimit(): Maybe<RateLimit>;
}
