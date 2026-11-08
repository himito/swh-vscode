/**
 * The Software Heritage client, {@link Swh}: everything the extension asks
 * the archive, or Git about what the archive holds.
 *
 * @remarks
 * SWHIDs are computed with Git, and the archive is asked whether it holds
 * them.
 *
 * {@link Swh} talks to the archive through an interface, {@link ArchiveApi},
 * in its own terms; it never sees HTTP. {@link HttpArchiveApi} (in
 * `adapters/`) implements the interface over the archive's Web API
 * (`/api/1`).
 *
 * {@link Swh} is made of parts, each a service of its own, given what it
 * needs when {@link Swh} builds it: {@link Holdings} (`holdings.ts`, which
 * SWHIDs the archive holds) ← {@link Origins} (`origins.ts`, origins,
 * visits, save requests) ← {@link WorkingTree} (`workingTree.ts`, the
 * SWHIDs of files and directories). Each uses those to its left, and only
 * through their public methods.
 *
 * Answers that may change are remembered for a while (see `MEMO_TTL`):
 * what the archive holds stays so for the session, what it does not hold
 * is asked again after ten minutes.
 *
 * This module must not import `vscode`: {@link Swh} receives Git and the
 * archive through {@link SwhDeps}, and {@link HttpArchiveApi} its settings
 * and callbacks through {@link HttpArchiveDeps}. This lets the unit tests run
 * it with Node alone, on a fake archive or a fake `fetch`.
 *
 * @packageDocumentation
 */

export { HttpArchiveApi, type HttpArchiveDeps, KNOWN_BATCH_SIZE } from './adapters/httpArchiveApi';
export { type ArchiveApi, type CitationTarget, type KnownAnswers, type LatestVisit, RATE_LIMIT_MESSAGE, type RateLimit } from './archiveApi';
export { Holdings } from './holdings';
export { Origins, VISITS_SHOWN } from './origins';
export { WorkingTree } from './workingTree';
export type { CitationAnswer, FileStatus, OriginInfo, OriginVisits, SaveRequest, SwhDeps, SwhidInfo, Token, TreeNode, Visit } from './types';
export { Swh } from './swh';
