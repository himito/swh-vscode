/**
 * The extension's core: one package per concern, all re-exported here.
 *
 * @remarks
 * - `shared/`: the error types, percent-encoding, small helpers;
 * - `origin.ts`: origins, the URLs the archive knows repositories by;
 * - `swhid/`: the {@link Swhid}, {@link Qualifiers} and {@link LineRange} value objects;
 * - `git.ts`: running Git;
 * - `archive/`: {@link Swh}, the Software Heritage client: what the archive holds, on Git and its Web API;
 * - `citation/`: {@link Citation}, {@link Citer} and {@link BibtexEntry};
 * - `scan.ts`: the scan of a repository as a tree.
 *
 * A package imports another only through its alias, `#core/<package>`,
 * and only one listed before it: there is no cycle between them. The files
 * of one package import each other with relative paths. Nothing here imports
 * `vscode`, which lets the unit tests run it with Node alone; keep it so.
 *
 * @packageDocumentation
 */

export * from '#core/archive';
export * from '#core/citation';
export * from '#core/git';
export * from '#core/origin';
export * from '#core/scan';
export * from '#core/shared';
export * from '#core/swhid';
