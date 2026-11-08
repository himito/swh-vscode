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
 * some files under them are. A submodule is never a file here: a directory
 * holds a reference to the submodule's commit, not the commit itself.
 */
export type ScanStatus = 'archived' | 'partial' | 'not-archived';

/**
 * How many files a directory holds, at any depth, and how many of them are
 * archived; submodules are not files.
 */
export type FileCounts = {
  /** The files under the directory. */
  files: number;
  /** Those of them the archive holds. */
  archived: number;
};

/** The counts of a directory without files; frozen, as every such directory shares it. */
const NO_FILES: Readonly<FileCounts> = Object.freeze({ files: 0, archived: 0 });

/**
 * The counts of a directory, with one more file.
 *
 * @param counts - The counts so far.
 * @param archived - Whether the archive holds the file.
 * @returns New counts; `counts` is left as it is.
 */
const withFile = (counts: Readonly<FileCounts>, archived: boolean): FileCounts => ({
  files: counts.files + 1,
  archived: counts.archived + (archived ? 1 : 0),
});

/** A file or directory of the scanned tree. */
export type ScanItem = {
  /** The path relative to the repository root, with `/` separators; `"."` for the root. */
  path: string;
  /** The name to show: the last path segment, with a trailing `/` for a directory; `"./"` for the root. */
  name: string;
  /** The core SWHID of the item as it is in the working tree: a `rev` for a submodule's commit. */
  swhid: Swhid;
  /** Whether the item is a directory. */
  dir: boolean;
  /** The item's archival status. */
  status: ScanStatus;
  /** For a directory: the files under it, at any depth, and how many are archived; shared, do not change it. */
  counts?: Readonly<FileCounts>;
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
  /** The number of files; submodules are not files. */
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
 * The components of a relative path.
 *
 * @param path - A relative path with `/` separators, `"."` for the root.
 * @returns Its components, e.g. `['a', 'b.txt']`; none for the root.
 */
const components = (path: string): string[] => (path === '.' ? [] : path.split('/'));

/**
 * Compares two strings by their UTF-16 code units, as `<` does.
 *
 * @remarks
 * Not `localeCompare`: the order must not depend on the user's locale.
 *
 * @param left - A string.
 * @param right - Another one.
 * @returns -1, 0 or 1.
 */
const compareStrings = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Compares two relative paths component by component, for sorting.
 *
 * @remarks
 * Comparing whole strings would put `a-b` between `a` and `a/c`; comparing
 * components keeps every directory's content right after it. A path comes
 * right before the paths under it, so the root, with no components, comes
 * first.
 *
 * @param left - A relative path, `"."` for the root.
 * @param right - Another relative path.
 * @returns A negative number when `left` comes first, positive when `right` does,
 * 0 when they are equal.
 */
function comparePaths(left: string, right: string): number {
  const leftParts = components(left);
  const rightParts = components(right);
  const shared = Math.min(leftParts.length, rightParts.length);

  for (let index = 0; index < shared; index++) {
    const order = compareStrings(leftParts[index], rightParts[index]);
    if (order !== 0) return order;
  }

  // one is a prefix of the other: the shorter, the directory, comes first
  return leftParts.length - rightParts.length;
}

/** The figures of a scan: everything in {@link Scan} but its tree. */
type ScanFigures = Omit<Scan, 'root' | 'items'>;

/**
 * Tells whether a node is a file: neither a directory nor a submodule.
 *
 * @param node - The node.
 * @returns `true` for a file, whose SWHID is a content's.
 */
const isFile = (node: TreeNode) => !node.dir && node.swhid.type === 'cnt';

/**
 * Counts the files under each directory, at any depth.
 *
 * @remarks
 * Submodules are left out: a directory does not hold a submodule's
 * commit, so an archived one does not make the directory partially archived.
 *
 * @param nodes - The nodes of the tree.
 * @returns The counts of each directory with files under it, by path.
 */
function countFiles(nodes: readonly TreeNode[]): Map<string, Readonly<FileCounts>> {
  const counts = new Map<string, Readonly<FileCounts>>();
  for (const file of nodes.filter(isFile)) {
    // each directory above the file holds it
    for (const dir of ancestors(file.path)) {
      const before = counts.get(dir) ?? NO_FILES;
      counts.set(dir, withFile(before, file.archived));
    }
  }
  return counts;
}

/**
 * The archival status of a node.
 *
 * @param node - The node.
 * @param counts - The files under it, for a directory.
 * @returns `archived` when the archive holds it; for a directory that it does
 * not hold as a whole, `partial` when it holds a file under it; `not-archived`
 * otherwise.
 */
function itemStatus(node: TreeNode, counts: Readonly<FileCounts>): ScanStatus {
  if (node.archived) return 'archived';
  return node.dir && counts.archived > 0 ? 'partial' : 'not-archived';
}

/**
 * The name the Scan view shows for a node.
 *
 * @param node - The node.
 * @returns Its last path segment, with a trailing `/` for a directory; `"./"` for the root.
 */
function itemName({ path, dir }: TreeNode): string {
  if (path === '.') return './';

  const name = path.substring(path.lastIndexOf('/') + 1);
  return dir ? `${name}/` : name;
}

/**
 * The scan item of a node, not linked to its parent and children yet.
 *
 * @param node - The node.
 * @param counts - The files under each directory, by path.
 * @returns The item.
 */
function toItem(node: TreeNode, counts: ReadonlyMap<string, Readonly<FileCounts>>): ScanItem {
  const nodeCounts = counts.get(node.path) ?? NO_FILES;

  return {
    path: node.path,
    name: itemName(node),
    swhid: node.swhid,
    dir: node.dir,
    status: itemStatus(node, nodeCounts),
    counts: node.dir ? nodeCounts : undefined,
    children: [],
  };
}

/**
 * Links items into a tree: each to its parent, and its parent to it.
 *
 * @param items - The items, in path order: a directory before what it holds.
 * Each item's directory must be among them, as in a tree from `git ls-tree -t`:
 * an item without it is linked to no parent.
 * @returns The root.
 * @throws `Error` when the items hold no root.
 */
function linkTree(items: readonly ScanItem[]): ScanItem {
  const byPath = new Map<string, ScanItem>();
  for (const item of items) {
    const parentPath = ancestors(item.path).at(-1);
    item.parent = parentPath === undefined ? undefined : byPath.get(parentPath);
    item.parent?.children.push(item);
    byPath.set(item.path, item);
  }

  const root = byPath.get('.');
  if (!root) throw new Error('A scan needs the root directory, "."');
  return root;
}

/**
 * The figures of a scan.
 *
 * @param items - Every item of the scan.
 * @param all - The files of the whole tree.
 * @returns How many files and directories, and how many are archived.
 */
function scanFigures(items: readonly ScanItem[], all: Readonly<FileCounts>): ScanFigures {
  const dirs = items.filter((item) => item.dir);
  const dirsWith = (status: ScanStatus) => dirs.filter((dir) => dir.status === status).length;

  return {
    files: all.files,
    archivedFiles: all.archived,
    dirs: dirs.length,
    archivedDirs: dirsWith('archived'),
    partialDirs: dirsWith('partial'),
  };
}

/**
 * Builds the tree of a scan, with its figures.
 *
 * @remarks
 * The nodes are sorted (see `comparePaths`), counted, made into items, and
 * linked into a tree. A directory that is not archived as a whole is
 * `'partial'` when at least one file under it is archived; a submodule is
 * not a file.
 *
 * @param nodes - The nodes of the tracked working tree, in any order, as
 * {@link Swh.tree} gives them; the root `"."` among them.
 * @returns The scan, whose root is `"."`.
 * @throws `Error` when the nodes hold no root.
 */
export function buildScan(nodes: readonly TreeNode[]): Scan {
  const sorted = [...nodes].sort((left, right) => comparePaths(left.path, right.path));
  const counts = countFiles(sorted);
  const items = sorted.map((node) => toItem(node, counts));
  const root = linkTree(items);
  return { root, items, ...scanFigures(items, counts.get('.') ?? NO_FILES) };
}

/**
 * A part of a total, with its proportion, for messages.
 *
 * @param part - How many, out of `total`.
 * @param total - How many in all.
 * @returns E.g. `"1 (33%)"`; see {@link percent}.
 */
const share = (part: number, total: number) => `${part} (${percent(part, total)}%)`;

/**
 * Describes the figures of a scan in words, for the Scan view's header.
 *
 * @param scan - The scan to summarize.
 * @returns E.g. `"Files: 3, archived 1 (33%)   Directories: 3, archived 1 (33%), partially 1 (33%)"`.
 */
export function scanSummary(scan: Scan): string {
  const files = `Files: ${scan.files}, archived ${share(scan.archivedFiles, scan.files)}`;

  const archivedDirs = `archived ${share(scan.archivedDirs, scan.dirs)}`;
  const partialDirs = `partially ${share(scan.partialDirs, scan.dirs)}`;
  const dirs = `Directories: ${scan.dirs}, ${archivedDirs}, ${partialDirs}`;

  return `${files}   ${dirs}`;
}
