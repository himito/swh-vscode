/**
 * The extension's core: the archive client, Git, SWHIDs, citations and
 * scans.
 *
 * @remarks
 * Nothing here imports `vscode`, which lets the unit tests run it with Node
 * alone; keep it so.
 *
 * @packageDocumentation
 */

export * from './backend';
export * from './citation';
export * from './git';
export * from './http';
export * from './scan';
export * from './swhid';
export * from './types';
