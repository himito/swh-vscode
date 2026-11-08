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
import type { Swhid } from './swhid';
import { ancestors } from './util';

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
  swhid: Swhid;
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
 * @param part - How many, out of `total`.
 * @param total - How many in all.
 * @returns `part` out of `total`, in percent; 0 when `total` is 0.
 */
export const percent = (part: number, total: number) => (total === 0 ? 0 : Math.floor((100 * part) / total));

/**
 * Compares two relative paths component by component, for sorting.
 *
 * @remarks
 * Comparing whole strings would put `a-b` between `a` and `a/c`; comparing
 * components keeps every directory's content right after it.
 *
 * @param left - A relative path, `"."` for the root.
 * @param right - Another relative path.
 * @returns A negative number when `left` comes first, positive when `right` does,
 * 0 when they are equal; the root `"."` comes first.
 */
function comparePaths(left: string, right: string): number {
  if (left === right) return 0;
  if (left === '.') return -1;
  if (right === '.') return 1;
  const leftParts = left.split('/');
  const rightParts = right.split('/');
  for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

/**
 * Builds the tree of a scan, with its figures.
 *
 * @remarks
 * A directory that is not archived as a whole is `'partial'` when at least
 * one file under it is archived.
 *
 * @param nodes - The nodes of the tracked working tree, in any order, as
 * {@link Swh.tree} gives them; the root `"."` among them.
 * @returns The scan, whose root is `"."`.
 * @throws `Error` when the nodes hold no root.
 */
export function buildScan(nodes: TreeNode[]): Scan {
  const sorted = [...nodes].sort((left, right) => comparePaths(left.path, right.path));
  // directory path -> [files, archived] of the files under it
  const counts = new Map<string, [number, number]>();
  for (const node of sorted) {
    if (node.dir) continue;
    for (const dir of ancestors(node.path)) {
      const dirCounts = counts.get(dir) ?? [0, 0];
      counts.set(dir, [dirCounts[0] + 1, dirCounts[1] + (node.archived ? 1 : 0)]);
    }
  }
  const byPath = new Map<string, ScanItem>();
  const items: ScanItem[] = [];
  for (const node of sorted) {
    const nodeCounts = counts.get(node.path) ?? [0, 0];
    const status: ScanStatus = node.archived ? 'archived' : node.dir && nodeCounts[1] > 0 ? 'partial' : 'not-archived';
    const item: ScanItem = {
      path: node.path,
      name: node.path === '.' ? './' : node.path.split('/').pop()! + (node.dir ? '/' : ''),
      swhid: node.swhid,
      dir: node.dir,
      status,
      counts: node.dir ? nodeCounts : undefined,
      children: [],
    };
    const anc = ancestors(node.path);
    item.parent = anc.length ? byPath.get(anc[anc.length - 1]) : undefined;
    item.parent?.children.push(item);
    byPath.set(node.path, item);
    items.push(item);
  }
  const root = byPath.get('.');
  if (!root) throw new Error('A scan needs the root directory, "."');
  const dirs = items.filter((item) => item.dir);
  const all = counts.get('.') ?? [0, 0];
  return {
    root,
    items,
    files: all[0],
    archivedFiles: all[1],
    dirs: dirs.length,
    archivedDirs: dirs.filter((dir) => dir.status === 'archived').length,
    partialDirs: dirs.filter((dir) => dir.status === 'partial').length,
  };
}

/**
 * Describes the figures of a scan in words, for the Scan view's header.
 *
 * @param scan - The scan to summarize.
 * @returns E.g. `"Files: 3, archived 1 (33%)   Directories: 3, archived 1 (33%), partially 1 (33%)"`.
 */
export function scanSummary(scan: Scan): string {
  return (
    `Files: ${scan.files}, archived ${scan.archivedFiles} (${percent(scan.archivedFiles, scan.files)}%)   ` +
    `Directories: ${scan.dirs}, archived ${scan.archivedDirs} (${percent(scan.archivedDirs, scan.dirs)}%), ` +
    `partially ${scan.partialDirs} (${percent(scan.partialDirs, scan.dirs)}%)`
  );
}
