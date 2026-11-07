/**
 * The scan of a repository as a tree, and its figures.
 *
 * @remarks
 * The backend's scan gives a flat list of {@link TreeNode}s; this module
 * turns it into the tree the Scan view shows, and counts what is archived.
 * Its functions are pure, and it must not import `vscode`.
 *
 * @packageDocumentation
 */

import type { TreeNode } from './backend';
import { ancestors } from './swhid';

/**
 * The archival status of a scanned item.
 *
 * @remarks
 * `'partial'` applies to directories only: not archived as a whole, but
 * some files under them are.
 */
export type ScanStatus = 'archived' | 'partial' | 'not-archived';

/** A file or directory of the scanned tree. */
export type ScanItem = {
  /** The path relative to the repository root, with `/` separators; `"."` for the root. */
  path: string;
  /** The name to show: the last path segment, with a trailing `/` for a directory; `"./"` for the root. */
  name: string;
  /** The core SWHID of the item as it is in the working tree. */
  swhid: string;
  /** Whether the item is a directory. */
  dir: boolean;
  /** The item's archival status. */
  status: ScanStatus;
  /** For a directory: `[files, archived files]` under it, at any depth. */
  counts?: [number, number];
  /** The directory holding the item; none for the root. */
  parent?: ScanItem;
  /** The items in the directory, in path order; empty for a file. */
  children: ScanItem[];
};

/** A scanned repository: its tree and its figures. */
export type Scan = {
  /** The root directory, `"."`. */
  root: ScanItem;
  /** Every item, the root first, in path order. */
  items: ScanItem[];
  /** The number of files. */
  files: number;
  /** The number of archived files. */
  archivedFiles: number;
  /** The number of directories, the root included. */
  dirs: number;
  /** The number of directories archived as a whole. */
  archivedDirs: number;
  /** The number of directories partially archived. */
  partialDirs: number;
};

/**
 * Gives a proportion in percent, rounded down.
 *
 * @param k - The part.
 * @param n - The whole.
 * @returns `k` out of `n`, in percent; 0 when `n` is 0.
 */
export const percent = (k: number, n: number) => (n === 0 ? 0 : Math.floor((100 * k) / n));

/**
 * Compares two relative paths component by component, for sorting.
 *
 * @remarks
 * Comparing whole strings would put `a-b` between `a` and `a/c`; comparing
 * components keeps every directory's content right after it.
 *
 * @param a - A relative path, `"."` for the root.
 * @param b - Another one.
 * @returns A negative number when `a` comes first, positive when `b` does,
 * 0 when they are equal; the root `"."` comes first.
 */
function comparePaths(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '.') return -1;
  if (b === '.') return 1;
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return x.length - y.length;
}

/**
 * Builds the tree of a scan, with its figures.
 *
 * @remarks
 * A directory that is not archived as a whole is `'partial'` when at least
 * one file under it is archived.
 *
 * @param nodes - The nodes of the tracked working tree, in any order, as
 * {@link Swh.tree} gives them.
 * @returns The scan, whose root is `"."`.
 */
export function buildScan(nodes: TreeNode[]): Scan {
  const sorted = [...nodes].sort((a, b) => comparePaths(a.path, b.path));
  // directory path -> [files, archived] of the files under it
  const counts = new Map<string, [number, number]>();
  for (const n of sorted) {
    if (n.dir) continue;
    for (const d of ancestors(n.path)) {
      const c = counts.get(d) ?? [0, 0];
      counts.set(d, [c[0] + 1, c[1] + (n.archived ? 1 : 0)]);
    }
  }
  const byPath = new Map<string, ScanItem>();
  const items: ScanItem[] = [];
  for (const n of sorted) {
    const c = counts.get(n.path) ?? [0, 0];
    const status: ScanStatus = n.archived ? 'archived' : n.dir && c[1] > 0 ? 'partial' : 'not-archived';
    const item: ScanItem = {
      path: n.path,
      name: n.path === '.' ? './' : n.path.split('/').pop()! + (n.dir ? '/' : ''),
      swhid: n.swhid,
      dir: n.dir,
      status,
      counts: n.dir ? c : undefined,
      children: [],
    };
    const anc = ancestors(n.path);
    item.parent = anc.length ? byPath.get(anc[anc.length - 1]) : undefined;
    item.parent?.children.push(item);
    byPath.set(n.path, item);
    items.push(item);
  }
  const root = byPath.get('.') ?? { path: '.', name: './', swhid: '', dir: true, status: 'not-archived', children: [] };
  const dirs = items.filter((i) => i.dir);
  const all = counts.get('.') ?? [0, 0];
  return {
    root,
    items,
    files: all[0],
    archivedFiles: all[1],
    dirs: dirs.length,
    archivedDirs: dirs.filter((d) => d.status === 'archived').length,
    partialDirs: dirs.filter((d) => d.status === 'partial').length,
  };
}

/**
 * Describes the figures of a scan in words, for the Scan view's header.
 *
 * @param s - The scan.
 * @returns E.g. `"Files: 3, archived 1 (33%)   Directories: 3, archived 1 (33%), partially 1 (33%)"`.
 */
export function scanSummary(s: Scan): string {
  return (
    `Files: ${s.files}, archived ${s.archivedFiles} (${percent(s.archivedFiles, s.files)}%)   ` +
    `Directories: ${s.dirs}, archived ${s.archivedDirs} (${percent(s.archivedDirs, s.dirs)}%), ` +
    `partially ${s.partialDirs} (${percent(s.partialDirs, s.dirs)}%)`
  );
}
