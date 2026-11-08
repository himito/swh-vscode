/**
 * The extension's core: the backend (Git and the Software Heritage archive),
 * the {@link Swhid} value object, origins and their encodings, citations,
 * scans, and the error types.
 *
 * @remarks
 * Nothing here imports `vscode`, which lets the unit tests run it with Node
 * alone; keep it so.
 *
 * @packageDocumentation
 */

export * from './backend';
export * from './citation';
export * from './encoding';
export * from './errors';
export * from './git';
export * from './http';
export * from './origin';
export * from './scan';
export * from './swhid';
export * from './types';
export * from './util';
