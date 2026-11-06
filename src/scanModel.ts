// The scan report as a tree: pure functions over the backend's nodes.

import type { TreeNode } from './backend';
import { ancestors } from './swhid';

export type ScanStatus = 'archived' | 'partial' | 'not-archived';

export interface ScanItem {
  path: string;
  name: string;
  swhid: string;
  dir: boolean;
  status: ScanStatus;
  /** For a directory: [files, archived files] under it. */
  counts?: [number, number];
  parent?: ScanItem;
  children: ScanItem[];
}

export interface Scan {
  root: ScanItem;
  items: ScanItem[];
  files: number;
  archivedFiles: number;
  dirs: number;
  archivedDirs: number;
  partialDirs: number;
}

export const percent = (k: number, n: number) => (n === 0 ? 0 : Math.floor((100 * k) / n));

/** Compare paths component by component, "." first. */
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

/** The scan of NODES, as a tree whose root is ".". */
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

/** The scan's figures, in words. */
export function scanSummary(s: Scan): string {
  return (
    `Files: ${s.files}, archived ${s.archivedFiles} (${percent(s.archivedFiles, s.files)}%)   ` +
    `Directories: ${s.dirs}, archived ${s.archivedDirs} (${percent(s.archivedDirs, s.dirs)}%), ` +
    `partially ${s.partialDirs} (${percent(s.partialDirs, s.dirs)}%)`
  );
}
