// The Software Heritage backend, without VS Code: through the local swhd
// daemon when it answers, else Git and the archive's Web API.

import { promises as fs } from 'fs';
import * as path from 'path';
import { Git, relativePath } from './git';
import { NOT_JSON, Resp, UserError, is2xx, headerNumber, retrieve } from './http';
import {
  baseUrl,
  core,
  hashOf,
  isPublicOrigin,
  normalizeOrigin,
  originCandidates,
  pathOrigin,
  qualify,
  queryString,
  typeOf,
  ancestors,
  versionAtLeast,
} from './swhid';

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DAEMON_MIN_VERSION = '0.8.0';
/** Three calls of 60 s to the archive. */
const DAEMON_TIMEOUT = 190;
/** A large repository takes many calls. */
export const TREE_TIMEOUT = 600;
/** Seconds during which an answer of the archive that may change holds. */
const MEMO_TTL = 600;
/** Number of the most recent commits that may anchor a SWHID. */
const ANCHOR_CANDIDATES_MAX = 100;
export const RATE_LIMIT_MESSAGE = 'Software Heritage API rate limit reached';

const UNKNOWN = Symbol('unknown');
type Entry<T> = { time: number; value: T };
type Memo<T> = Map<string, Entry<T>>;

export interface OriginInfo {
  origin: string;
  archived: boolean;
  date?: string;
  status?: string;
  snapshot?: string;
  upstream?: string;
  'upstream-archived'?: boolean;
}

export interface SwhidInfo {
  swhid: string;
  core: string;
  archived: boolean;
  origin?: string;
  'origin-archived'?: boolean;
  version?: string;
  /** Why the archive was not asked. */
  unchecked?: string;
}

/** A file or directory of the tracked working tree. */
export interface TreeNode {
  path: string;
  swhid: string;
  dir: boolean;
  archived: boolean;
}

export interface SwhDeps {
  archiveUrl(): string;
  daemonUrl(): string;
  token(): Promise<string | undefined>;
  warn(message: string): void;
  onRateLimit?(): void;
  git: Git;
}

const now = () => Date.now() / 1000;
const fresh = (time: number | undefined, ttl: number) => time !== undefined && now() - time < ttl;
const uniq = <T>(xs: T[]) => [...new Set(xs)];
function partition<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export class Swh {
  /** The API's tokenless rate limit, RESET in epoch seconds. */
  rateLimit?: { used: number; limit: number; reset: number };
  private daemonChecked?: { time: number; pong: Promise<any | null> };
  private daemonOutdatedWarned = false;
  private originMemo: Memo<OriginInfo | null> = new Map();
  private knownMemo: Memo<boolean> = new Map();
  readonly git: Git;

  constructor(private deps: SwhDeps) {
    this.git = deps.git;
  }

  // ---------------------------------------------------------------- HTTP

  apiUrl(p: string) {
    return baseUrl(this.deps.archiveUrl()) + '/api/1' + p;
  }

  private async retrieve(method: string, url: string, body: string | undefined, headers: Record<string, string>, timeout = 60) {
    const tracked = url.startsWith(this.apiUrl('')) && !headers.Authorization;
    const resp = await retrieve(method, url, body, headers, timeout);
    if (resp && tracked) {
      const limit = headerNumber(resp.headers, 'X-RateLimit-Limit');
      const remaining = headerNumber(resp.headers, 'X-RateLimit-Remaining');
      if (limit !== undefined && remaining !== undefined) {
        this.rateLimit = {
          used: limit - remaining,
          limit,
          reset: headerNumber(resp.headers, 'X-RateLimit-Reset') ?? now() + 3600,
        };
        this.deps.onRateLimit?.();
      }
    }
    return resp;
  }

  /** "USED/LIMIT" of the API's tokenless rate limit, undefined when not known. */
  rateLimitText(): string | undefined {
    const r = this.rateLimit;
    return r && now() < r.reset ? `${r.used}/${r.limit}` : undefined;
  }

  private async apiHeaders(body?: string): Promise<Record<string, string>> {
    const token = await this.deps.token();
    const h: Record<string, string> = { Accept: 'application/json' };
    if (body) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  private rateLimited(retryAfter: unknown): never {
    throw new UserError(`${RATE_LIMIT_MESSAGE}; retry in ${retryAfter ?? 'a few'} seconds`);
  }

  private archiveAnswered(status: unknown, about: unknown): never {
    throw new UserError(`The Software Heritage archive answered HTTP ${status} (${about})`);
  }

  /** The archive's response to METHOD PATH with the JSON string BODY. */
  async api(method: string, p: string, body?: string): Promise<Resp> {
    const resp = await this.retrieve(method, this.apiUrl(p), body, await this.apiHeaders(body));
    if (!resp) throw new UserError(`Cannot reach the Software Heritage archive at ${this.deps.archiveUrl()}`);
    if (resp.status === 429) this.rateLimited(resp.retryAfter);
    return resp;
  }

  /** The parsed body of the 2xx response RESP; a UserError about WHAT otherwise. */
  apiBody(resp: Resp, what: string): any {
    if (!is2xx(resp)) {
      const reason = resp.body && typeof resp.body === 'object' ? resp.body.reason : undefined;
      this.archiveAnswered(resp.status, typeof reason === 'string' ? `${what}: ${reason}` : what);
    }
    if (resp.body === NOT_JSON) throw new UserError(`The Software Heritage archive answered no JSON (${what})`);
    return resp.body;
  }

  // ---------------------------------------------------------------- daemon

  private daemonBase() {
    return baseUrl(this.deps.daemonUrl().trim());
  }

  private async daemonPing(): Promise<any | null> {
    if (!this.daemonBase()) return null;
    const resp = await this.retrieve('GET', this.daemonBase() + '/ping', undefined, {}, 2);
    if (!resp || resp.status !== 200) return null;
    const pong = resp.body;
    if (versionAtLeast(pong?.version, DAEMON_MIN_VERSION)) return pong;
    if (!this.daemonOutdatedWarned) {
      this.daemonOutdatedWarned = true;
      this.deps.warn(
        `swhd ${typeof pong?.version === 'string' ? pong.version : '< 0.2.0'} is older than ${DAEMON_MIN_VERSION}; going without it`,
      );
    }
    return null;
  }

  /** The daemon's answer to /ping, remembered for half a minute. */
  daemonPong(): Promise<any | null> {
    if (!this.daemonChecked || !fresh(this.daemonChecked.time, 30)) {
      this.daemonChecked = { time: now(), pong: this.daemonPing() };
    }
    return this.daemonChecked.pong;
  }

  async daemonAvailable(): Promise<boolean> {
    return !!(await this.daemonPong());
  }

  /** Send METHOD ROUTE to the daemon; its answer's body, when 2xx. */
  async daemon(
    method: string,
    route: string,
    opts: { path?: string; params?: Array<[string, string?]>; body?: string; timeout?: number } = {},
  ): Promise<any> {
    const params: Array<[string, string?]> = [...(opts.path ? [['path', opts.path] as [string, string]] : []), ...(opts.params ?? [])];
    const q = queryString(params);
    const url = this.daemonBase() + route + (q ? '?' + q : '');
    const resp = await this.retrieve(method, url, opts.body, await this.apiHeaders(opts.body), opts.timeout ?? DAEMON_TIMEOUT);
    return this.daemonAnswer(method, route, resp);
  }

  private async daemonAnswer(method: string, route: string, resp: Resp | null): Promise<any> {
    if (!resp) {
      // gone: ping it again next time
      this.daemonChecked = undefined;
      throw new UserError(`Cannot reach swhd at ${this.deps.daemonUrl()}, or it is too slow (is it still running?)`);
    }
    const body = resp.body;
    const upstream = body && typeof body === 'object' ? body['upstream-status'] : undefined;
    if (body === NOT_JSON) throw new UserError(`Invalid response from swhd (HTTP ${resp.status}, not JSON)`);
    if (is2xx(resp)) return body;
    if (resp.status === 429) this.rateLimited(body?.['retry-after']);
    if (resp.status === 404) throw new UserError(`Unknown to swhd, ${method} ${route} (needs swhd ${DAEMON_MIN_VERSION})`);
    if (upstream) this.archiveAnswered(upstream, body?.error);
    if (body?.error) throw new UserError(String(body.error));
    throw new UserError(`Unexpected response from swhd: ${resp.status}`);
  }

  // ---------------------------------------------------------------- memos

  private memoGet<T>(memo: Memo<T>, key: string): T | null | typeof UNKNOWN {
    // a SWHID is immutable, but the archive may get the artifact later
    const e = memo.get(key);
    if (!e) return UNKNOWN;
    if (e.value) return e.value;
    return fresh(e.time, MEMO_TTL) ? null : UNKNOWN;
  }

  private memoPut<T>(memo: Memo<T>, key: string, value: T): T {
    memo.set(key, { time: now(), value });
    return value;
  }

  /** Forget the negative answers MEMO holds: what the archive holds stays so. */
  private forgetNegatives<T>(memo: Memo<T>) {
    for (const [k, e] of memo) if (!e.value) memo.delete(k);
  }

  knownP(swhid: string): boolean {
    return this.memoGet(this.knownMemo, swhid) === true;
  }

  /** Ask the archive about those of SWHIDS not known yet. */
  async rememberKnown(swhids: string[]): Promise<void> {
    const unknown = uniq(swhids).filter((s) => this.memoGet(this.knownMemo, s) === UNKNOWN);
    for (const batch of partition(unknown, 1000)) {
      const body = this.apiBody(await this.api('POST', '/known/', JSON.stringify(batch)), 'the SWHID lookup');
      for (const [swhid, answer] of Object.entries(body ?? {})) {
        this.memoPut(this.knownMemo, swhid, (answer as any)?.known === true);
      }
    }
  }

  async archivedP(swhid: string): Promise<boolean> {
    await this.rememberKnown([swhid]);
    return this.knownP(swhid);
  }

  // ---------------------------------------------------------------- origins

  /** URL of the remote of the repository at ROOT: the one the branch tracks, else origin, else the only one. */
  async remoteUrl(root: string): Promise<string | undefined> {
    const url = await this.git.get(root, ['ls-remote', '--get-url']);
    if (url && /[:/]/.test(url)) return url;
    const remotes = (await this.git.get(root, ['remote']))?.split('\n').filter(Boolean) ?? [];
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined;
    return remote ? this.git.get(root, ['remote', 'get-url', remote]) : undefined;
  }

  /** Origin of the repository at ROOT as the archive names it. */
  async originOf(root: string): Promise<string | undefined> {
    const remote = await this.remoteUrl(root);
    return remote ? normalizeOrigin(remote) : undefined;
  }

  /** [URL, VISIT] for the first of URLS the archive holds, VISIT its latest with a snapshot. */
  private async latestVisit(urls: string[]): Promise<[string, any] | null> {
    for (const url of urls) {
      const resp = await this.api('GET', `/origin/${pathOrigin(url)}/visit/latest/?require_snapshot=true`);
      if (resp.status !== 404) return [url, this.apiBody(resp, "the origin's visits")];
    }
    return null;
  }

  /** The origin info for the first of CANDIDATES the archive holds. */
  private async findOrigin(candidates: string[]): Promise<OriginInfo> {
    // the archive holds only public origins: look up none otherwise
    const found = await this.latestVisit(isPublicOrigin(candidates[0]) ? candidates : []);
    if (!found) return { origin: candidates[0], archived: false };
    const [origin, visit] = found;
    const info: OriginInfo = { origin, archived: true };
    for (const k of ['date', 'status', 'snapshot'] as const) if (visit?.[k] != null) info[k] = visit[k];
    return info;
  }

  /** Archival status of the public repository URL ORIGIN. */
  async originStatus(origin: string): Promise<OriginInfo> {
    if (!isPublicOrigin(origin)) throw new UserError(`Not a public repository URL: ${origin}`);
    return this.findOrigin(originCandidates(origin));
  }

  /** The origin of the repository at ROOT, null without a remote; remembered. */
  private async directOrigin(root: string): Promise<OriginInfo | null> {
    const remote = await this.remoteUrl(root);
    if (!remote) return null;
    const e = this.originMemo.get(remote);
    if (e && fresh(e.time, MEMO_TTL)) return e.value;
    return this.memoPut(this.originMemo, remote, await this.findOrigin(originCandidates(remote)));
  }

  private async originVisits(info: OriginInfo): Promise<{ origin: string; visits: any[] }> {
    return {
      origin: info.origin,
      visits: info.archived
        ? this.apiBody(await this.api('GET', `/origin/${pathOrigin(info.origin)}/visits/?per_page=10`), "the origin's visits")
        : [],
    };
  }

  private async directUpstream(root: string, info: OriginInfo): Promise<Partial<OriginInfo>> {
    if (!info.archived) return {};
    const upstream = await this.git.get(root, ['rev-parse', '--symbolic-full-name', '@{upstream}']);
    if (!upstream?.startsWith('refs/remotes/')) return {};
    const commit = await this.git.get(root, ['rev-parse', '--verify', '-q', '@{upstream}^{commit}']);
    if (!commit) return {};
    const rev = core('rev', commit);
    return { upstream: rev, 'upstream-archived': await this.archivedP(rev) };
  }

  /** Archival status of ROOT's origin, with UPSTREAM its branch's upstream's. */
  async origin(root: string, upstream = false): Promise<OriginInfo> {
    if (await this.daemonAvailable()) {
      return this.daemon('GET', '/origin', { path: root, params: upstream ? [['upstream']] : [], timeout: 60 });
    }
    const info = await this.directOrigin(root);
    if (!info) throw new UserError('No remote');
    return { ...info, ...(upstream ? await this.directUpstream(root, info) : {}) };
  }

  /** Like origin(), null without a remote: for the status bar. */
  async originQuiet(root: string): Promise<OriginInfo | null> {
    if ((await this.daemonAvailable()) && (await this.remoteUrl(root))) {
      return this.daemon('GET', '/origin', { path: root });
    }
    return this.directOrigin(root);
  }

  /** The last ten visits of ROOT's origin, or of the public ORIGIN. */
  async visits(root: string | undefined, origin?: string): Promise<{ origin: string; visits: any[] }> {
    if (origin) return this.originVisits(await this.originStatus(origin));
    if (await this.daemonAvailable()) return this.daemon('GET', '/visits', { path: root, timeout: 60 });
    return this.originVisits(await this.origin(root!));
  }

  /** Forget what a save request of ORIGIN is about to change. */
  private forgetBeforeSave(origin: string) {
    const candidates = originCandidates(origin);
    for (const [remote, e] of this.originMemo) {
      if (e.value && candidates.includes(e.value.origin)) this.originMemo.delete(remote);
    }
    // a SWHID tells not which origin holds it: forget every "not archived"
    this.forgetNegatives(this.knownMemo);
  }

  /** Ask the archive to save the public ORIGIN now: the save request. */
  async saveOrigin(origin: string): Promise<any> {
    if (!isPublicOrigin(origin)) throw new UserError('The origin is not a public URL');
    const request = this.apiBody(await this.api('POST', `/origin/save/git/url/${pathOrigin(origin)}/`), 'the save request');
    this.forgetBeforeSave(origin);
    return { origin, ...request };
  }

  /** Ask to save the repository at ROOT: the save request. */
  async save(root: string): Promise<any> {
    if (await this.daemonAvailable()) return this.daemon('POST', '/save', { path: root });
    const origin = await this.originOf(root);
    if (!origin) throw new UserError('No remote');
    if (!isPublicOrigin(origin)) throw new UserError('The origin is not a public URL');
    const info = await this.directOrigin(root);
    return this.saveOrigin(info!.origin);
  }

  // ---------------------------------------------------------------- SWHIDs

  /** Core content SWHID of FILE, as Git stores it in ROOT, or as is without ROOT. */
  async contentSwhid(file: string, root: string | undefined): Promise<string> {
    const hash = root
      ? await this.git.get(root, ['hash-object', '--path', relativePath(root, file), '--', file])
      : await this.git.get(path.dirname(file), ['hash-object', '--no-filters', '--', file]);
    if (!hash) throw new UserError(`Cannot hash ${file} with git`);
    return core('cnt', hash);
  }

  private async revList(root: string, ...args: string[]): Promise<string[]> {
    const out = await this.git.get(root, ['rev-list', `--max-count=${ANCHOR_CANDIDATES_MAX}`, ...args]);
    return out ? out.split('\n').filter(Boolean) : [];
  }

  /** Hash of the object at REL ("." for the root) in COMMIT, of TYPE if given. */
  private async objectAt(root: string, commit: string, rel: string, type?: 'blob' | 'tree'): Promise<string | undefined> {
    const object = rel === '.' ? `${commit}^{tree}` : `${commit}:${rel}`;
    const hash = await this.git.get(root, ['rev-parse', '--verify', '-q', object]);
    if (!hash) return undefined;
    if (type && type !== (await this.git.get(root, ['cat-file', '-t', hash]))) return undefined;
    return hash;
  }

  /** Those of the hashes COMMITS the archive holds, in order. */
  private async archivedCommits(commits: string[]): Promise<string[]> {
    await this.rememberKnown(commits.map((c) => core('rev', c)));
    return commits.filter((c) => this.knownP(core('rev', c)));
  }

  /** [COMMIT, HASH] of REL in the latest archived commit of HEAD's last ones. */
  private async archivedVersion(root: string, rel: string, dir: boolean): Promise<[string, string] | undefined> {
    for (const commit of await this.archivedCommits(await this.revList(root, 'HEAD'))) {
      const hash = await this.objectAt(root, commit, rel, dir ? 'tree' : 'blob');
      if (hash) return [commit, hash];
    }
    return undefined;
  }

  /** The commit of HEAD's history that last changed REL. */
  private lastCommit(root: string, rel: string) {
    return this.git.get(root, ['--literal-pathspecs', 'rev-list', '-1', 'HEAD', '--', rel]);
  }

  /** Commits of HEAD's history that may hold the object HASH at REL, most recent first. */
  private async anchorCandidates(root: string, rel: string, hash: string): Promise<string[]> {
    if (hash !== (await this.objectAt(root, 'HEAD', rel))) return [];
    const last = await this.lastCommit(root, rel);
    if (!last) return [];
    return uniq([...(await this.revList(root, 'HEAD', '--not', `${last}^@`)), last]);
  }

  /** Most recent archived commit at ROOT that holds CORE at REL. */
  private async anchor(root: string, rel: string, coreSwhid: string): Promise<string | undefined> {
    const hash = hashOf(coreSwhid);
    const commits = await this.anchorCandidates(root, rel, hash);
    await this.rememberKnown([coreSwhid, ...commits.map((c) => core('rev', c))]);
    for (const commit of await this.archivedCommits(commits)) {
      if (hash === (await this.objectAt(root, commit, rel))) return commit;
    }
    return undefined;
  }

  /** Hash of the tree of the tracked working tree of the repository at ROOT. */
  async worktreeTree(root: string): Promise<string> {
    // staged in a copy of the index, which writes the blobs and trees as
    // git stash would
    return this.git.withIndexCopy(root, async (env) => {
      await this.git.check(root, ['add', '-u'], env);
      return this.git.check(root, ['write-tree'], env);
    });
  }

  /** Core SWHID of DIR in the tracked working tree at ROOT; undefined when nothing in it is tracked. */
  private async dirSwhid(dir: string, root: string): Promise<string | undefined> {
    const hash = await this.objectAt(root, await this.worktreeTree(root), relativePath(root, dir));
    return hash ? core('dir', hash) : undefined;
  }

  /** Core SWHID of FILE, or of a tracked directory, in the working tree at ROOT. */
  async worktreeSwhid(file: string, root: string | undefined): Promise<string> {
    if ((await fs.stat(file)).isDirectory()) {
      if (!root) throw new UserError('Not inside a Git repository');
      const swhid = await this.dirSwhid(file, root);
      if (!swhid) throw new UserError(`Nothing is tracked in ${file}`);
      return swhid;
    }
    return this.contentSwhid(file, root);
  }

  private async archivedTarget(root: string, rel: string, dir: boolean) {
    const version = await this.archivedVersion(root, rel, dir);
    if (!version) return undefined;
    const c = core(dir ? 'dir' : 'cnt', version[1]);
    // the commit of the archived version holds it, hence its content
    this.memoPut(this.knownMemo, c, true);
    return { core: c, anchor: version[0], version: core('rev', version[0]), archived: true };
  }

  private async worktreeTarget(file: string, root: string | undefined, rel: string | undefined, pub: boolean) {
    const c = await this.worktreeSwhid(file, root);
    return {
      core: c,
      anchor: pub && root ? await this.anchor(root, rel!, c) : undefined,
      archived: pub || !root ? await this.archivedP(c) : false,
      version: undefined as string | undefined,
    };
  }

  private async directSwhid(file: string, lines: string | undefined, archivedVersion: boolean): Promise<SwhidInfo> {
    const root = await this.git.root(file);
    const rel = root ? relativePath(root, file) : undefined;
    const info = root ? await this.directOrigin(root) : null;
    const origin = info?.origin;
    const pub = isPublicOrigin(origin);
    const dir = (await fs.stat(file)).isDirectory();
    const t = (archivedVersion && pub && root ? await this.archivedTarget(root, rel!, dir) : undefined) ??
      (await this.worktreeTarget(file, root, rel, pub));
    const result: SwhidInfo = {
      swhid: qualify(t.core, origin, info?.snapshot, t.anchor ? core('rev', t.anchor) : undefined, rel, t.version ? undefined : lines),
      core: t.core,
      archived: t.archived,
    };
    if (origin) {
      result.origin = origin;
      result['origin-archived'] = info!.archived;
    }
    if (t.version) result.version = t.version;
    return result;
  }

  /**
   * Qualified SWHID of FILE, or a directory, or its LINES ("A-B", "A").
   * With ARCHIVED_VERSION, of the version the archive holds.
   */
  async qualifiedSwhid(file: string, lines?: string, archivedVersion = false): Promise<SwhidInfo> {
    const root = await this.git.root(file);
    const origin = root ? await this.originOf(root) : undefined;
    if ((await this.daemonAvailable()) && (!root || isPublicOrigin(origin))) {
      const params: Array<[string, string?]> = [];
      if (archivedVersion) params.push(['archived']);
      if (lines) params.push(['lines', lines]);
      return this.daemon('GET', '/swhid', { path: file, params, timeout: 60 });
    }
    try {
      return await this.directSwhid(file, lines, archivedVersion);
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      // the SWHID from Git alone
      const c = await this.worktreeSwhid(file, root);
      return { swhid: qualify(c, null, null, null, null, lines), core: c, archived: false, unchecked: e.message };
    }
  }

  /** {swhid, archived} of FILE; CORE, its SWHID when known, spares hashing it. */
  async fileStatus(file: string, coreSwhid?: string): Promise<{ swhid: string; archived: boolean }> {
    if (await this.daemonAvailable()) return this.daemon('GET', '/file', { path: file });
    const c = coreSwhid ?? (await this.contentSwhid(file, await this.git.root(file)));
    return { swhid: c, archived: await this.archivedP(c) };
  }

  /** Hash of the tree of DIR in HEAD, undefined when its tracked files differ. */
  async headTree(dir: string, root: string): Promise<string | undefined> {
    // in a copy: refreshing the dates writes the index
    return this.git.withIndexCopy(root, async (env) => {
      await this.git.run(root, ['update-index', '-q', '--refresh'], { env });
      if ((await this.git.run(dir, ['diff-files', '--quiet', '--', '.'], { env })).status !== 0) return undefined;
      if ((await this.git.run(dir, ['diff-index', '--cached', '--quiet', 'HEAD', '--', '.'], { env })).status !== 0) return undefined;
      return this.git.get(dir, ['rev-parse', '--verify', '-q', 'HEAD:./'], env);
    });
  }

  /** Whether DIR holds untracked files that Git does not ignore. */
  async untracked(dir: string): Promise<boolean> {
    return !!(await this.git.get(dir, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z', '--', '.']));
  }

  // ---------------------------------------------------------------- trees

  /** The nodes of the tracked working tree at ROOT, "." first; Merkle-pruned. */
  private async directTree(root: string): Promise<TreeNode[]> {
    const tree = await this.worktreeTree(root);
    const lsTree = (await this.git.get(root, ['ls-tree', '-r', '-t', '-z', tree])) ?? '';
    const nodes: TreeNode[] = [{ path: '.', swhid: core('dir', tree), dir: true, archived: false }];
    for (const line of lsTree.split('\0').filter(Boolean)) {
      // "<mode> <type> <hash>\t<path>", the path may hold tabs
      const tab = line.indexOf('\t');
      const [, type, hash] = line.substring(0, tab).split(' ');
      nodes.push({
        path: line.substring(tab + 1),
        swhid: core(type === 'tree' ? 'dir' : type === 'blob' ? 'cnt' : 'rev', hash),
        dir: type === 'tree',
        archived: false,
      });
    }
    const swhids = new Map(nodes.map((n) => [n.path, n.swhid]));
    // a directory holds a submodule's commit, not the commit itself
    const covered = (n: TreeNode) =>
      typeOf(n.swhid) !== 'rev' && ancestors(n.path).some((d) => this.knownP(swhids.get(d)!));
    // directories first: an archived one covers everything under it
    await this.rememberKnown(nodes.filter((n) => n.dir && !covered(n)).map((n) => n.swhid));
    await this.rememberKnown(nodes.filter((n) => !n.dir && !covered(n)).map((n) => n.swhid));
    return nodes.map((n) => ({ ...n, archived: this.knownP(n.swhid) || covered(n) }));
  }

  /** The nodes of ROOT, through the daemon when it runs. */
  async tree(root: string): Promise<TreeNode[]> {
    if (!(await this.daemonAvailable())) return this.directTree(root);
    const answer = await this.daemon('GET', '/tree', { path: root, timeout: TREE_TIMEOUT });
    return Object.entries(answer ?? {}).map(([p, e]: [string, any]) => {
      return { path: p, swhid: e.swhid, dir: !!e['dir?'], archived: !!e.archived };
    });
  }

  // ---------------------------------------------------------------- refresh

  /** Forget what may have changed in the archive; why swhd did not, if it did not. */
  async refresh(): Promise<string | undefined> {
    this.originMemo.clear();
    this.forgetNegatives(this.knownMemo);
    // swhd may have started, or stopped
    this.daemonChecked = undefined;
    const pong = await this.daemonPong();
    if (!pong) return undefined;
    if (!versionAtLeast(pong.version, '0.10.0')) return `it needs 0.10.0, not ${pong.version}`;
    try {
      await this.daemon('POST', '/forget', { timeout: 60 });
      return undefined;
    } catch (e) {
      if (e instanceof UserError) return e.message;
      throw e;
    }
  }

  // ---------------------------------------------------------------- why not archived

  /** Why the archive cannot hold PATH as it is, in words, or undefined. */
  async unarchivedWhy(p: string): Promise<string | undefined> {
    const root = await this.git.root(p);
    if (!root) return undefined;
    const rel = relativePath(root, p);
    const origin = await this.originOf(root);
    if (!origin) return 'the repository has no remote';
    if (!isPublicOrigin(origin)) return `the origin ${origin} is not a public URL`;
    if (!(await this.git.get(root, ['--literal-pathspecs', 'ls-files', '--', rel]))) return 'Git does not track it';
    if ((await this.git.run(root, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', rel])).status !== 0) {
      return 'it has uncommitted changes';
    }
    // not HEAD: a later commit elsewhere in the tree does not keep this
    // content from being archived
    const last = await this.lastCommit(root, rel);
    if (!last || !(await this.git.get(root, ['for-each-ref', '--count=1', '--contains', last, 'refs/remotes/']))) {
      return 'the commit holding it is not pushed';
    }
    return undefined;
  }
}
