// The forge's in-memory store and git object model.
//
// Everything lives in memory for the life of the process: the suite is the only client and a
// trial is one run, so there is nothing to persist. Objects are content-addressed by SHA-1 the
// way git addresses them; repositories, issues, pull requests and labels sit on top of the same
// object store so the git surface and the REST/GraphQL/MCP surfaces always agree about a repo.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';
export const AGENT_NAME = 'github-core-clone/1.0.0';

/** The fixed clock: a base instant plus a monotonic counter, so every created object sorts stably. */
const EPOCH_MS = Date.parse('2025-01-01T00:00:00.000Z');
let tick = 0;
export function nowIso(): string {
  tick += 1;
  return new Date(EPOCH_MS + tick * 1000).toISOString();
}
export function nowEpochSec(): number {
  return Math.floor(EPOCH_MS / 1000) + tick;
}

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data`: SHA-1 over `<type> <size>\0<data>`. */
export function hashObject(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** A pack entry's type+size varint, git's little-endian-ish packing. */
function encodeEntryHeader(type: ObjType, size: number): Buffer {
  const typeNum = TYPE_NUM[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (remaining & 0x0f) | (typeNum << 4);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/** Write a pack of plain (undeltified) objects, with the SHA-1 trailer git verifies. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    parts.push(encodeEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Inflate the zlib stream starting at `offset`, whose uncompressed size is `expectedSize`. */
function inflateAt(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; next: number } {
  const attempt = (end: number): Buffer | null => {
    try {
      return inflateSync(buf.subarray(offset, end));
    } catch {
      return null;
    }
  };
  // Grow the window exponentially until a whole stream inflates to the expected size, then
  // binary-search the smallest end that does: a zlib stream is self-terminating, so the smallest
  // end that yields exactly `expectedSize` bytes is the stream's true end.
  let hi = Math.min(buf.length, offset + Math.max(64, expectedSize + 32));
  for (;;) {
    const out = attempt(hi);
    if (out !== null && out.length === expectedSize) break;
    if (hi >= buf.length) throw new Error('pack entry is truncated');
    hi = Math.min(buf.length, hi * 2);
  }
  let lo = offset;
  let good = hi;
  while (lo + 1 < good) {
    const mid = (lo + good) >> 1;
    const out = attempt(mid);
    if (out !== null && out.length === expectedSize) good = mid;
    else lo = mid;
  }
  const data = attempt(good);
  if (data === null || data.length !== expectedSize) throw new Error('pack entry would not inflate');
  return { data, next: good };
}

/** Read one delta's base size / result size varint (7 bits per byte, big-endian groups). */
function readDeltaVarint(data: Buffer, at: number): { value: number; next: number } {
  let value = 0;
  let i = at;
  for (;;) {
    const byte = data[i] ?? 0;
    i += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: i };
}

/** Apply a git delta to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const baseSize = readDeltaVarint(delta, at);
  at = baseSize.next;
  const resultSize = readDeltaVarint(delta, at);
  at = resultSize.next;
  if (baseSize.value !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op === undefined) break;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          offset |= (delta[at] ?? 0) << (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          size |= (delta[at] ?? 0) << (bit * 8);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      out.push(delta.subarray(at, at + op));
      total += op;
      at += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  if (total !== resultSize.value) throw new Error('delta result size mismatch');
  return Buffer.concat(out);
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a pack. Plain objects resolve at once; deltas resolve against bases already read or
 * already in `known` (the repo's store, or the fetcher's have-objects for a thin pack).
 */
export function readPack(buf: Buffer, known?: ReadonlyMap<string, GitObject>): PackRead {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a pack');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const pending: Array<{ oid: string; type: ObjType; data: Buffer; baseOid: string | null; baseOffset: number | null }> = [];
  const byOffset = new Map<number, string>();
  let deltaCount = 0;
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const entryStart = at;
    let byte = buf[at];
    at += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = buf[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeNum === 6) {
      // ofs-delta: the base offset is git's biased variable-length encoding.
      byte = buf[at];
      at += 1;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        byte = buf[at];
        at += 1;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryStart - offset;
      deltaCount += 1;
    } else if (typeNum === 7) {
      baseOid = buf.subarray(at, at + 20).toString('hex');
      at += 20;
      deltaCount += 1;
    }
    const inflated = inflateAt(buf, at, size);
    at = inflated.next;
    if (typeNum === 6 || typeNum === 7) {
      pending.push({ oid: '', type: 'blob', data: inflated.data, baseOid, baseOffset });
    } else {
      const type = NUM_TYPE[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const oid = hashObject(type, inflated.data);
      objects.set(oid, { type, data: inflated.data });
      byOffset.set(entryStart, oid);
      pending.push({ oid, type, data: inflated.data, baseOid: null, baseOffset: null });
    }
  }
  // Resolve deltas: bases are entries already read, in this pack or in `known`.
  const resolveBase = (entry: { baseOid: string | null; baseOffset: number | null }): GitObject => {
    if (entry.baseOid !== null) {
      const found = objects.get(entry.baseOid) ?? known?.get(entry.baseOid);
      if (found === undefined) throw new Error(`delta base ${entry.baseOid} is missing`);
      return found;
    }
    if (entry.baseOffset !== null) {
      const baseOid = byOffset.get(entry.baseOffset);
      if (baseOid === undefined) throw new Error('delta base offset is missing');
      const found = objects.get(baseOid) ?? known?.get(baseOid);
      if (found === undefined) throw new Error(`delta base ${baseOid} is missing`);
      return found;
    }
    throw new Error('delta without a base');
  };
  for (const entry of pending) {
    if (entry.baseOid === null && entry.baseOffset === null) continue;
    const base = resolveBase(entry);
    const data = applyDelta(base.data, entry.data);
    const oid = hashObject(base.type, data);
    objects.set(oid, { type: base.type, data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// Trees and commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Git's tree sort: directory names compare as if they ended in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Build a tree object from entries, sorted git-style. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0,
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit object. */
export function buildCommit(parts: CommitParts): Buffer {
  const lines = [`tree ${parts.tree}`];
  for (const parent of parts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${parts.author}`);
  lines.push(`committer ${parts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${parts.message}`, 'utf8');
}

/** Parse a tag object: its target, type, tag name and message. */
export function parseTag(data: Buffer): { object: string; type: string; tag: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag, message };
}

// ---------------------------------------------------------------------------------------------
// The store

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  authorLogin: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  id: number;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextPullId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      owner,
      name,
      id: this.nextRepoId,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: nowIso(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Every repository the viewer created (POST /user/repos), in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  nextIssueDbId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  nextPullDbId(): number {
    const id = this.nextPullId;
    this.nextPullId += 1;
    return id;
  }

  /** The global (Relay) id for an object: opaque, stable, decodable by this server. */
  globalId(kind: string, ref: string): string {
    return Buffer.from(`${kind}:${ref}`, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; ref: string } | null {
    try {
      const text = Buffer.from(id, 'base64url').toString('utf8');
      const colon = text.indexOf(':');
      if (colon < 0) return null;
      return { kind: text.slice(0, colon), ref: text.slice(colon + 1) };
    } catch {
      return null;
    }
  }
}

export const store = new Store();

// ---------------------------------------------------------------------------------------------
// Object reachability

/** Walk a repo's object graph from `tips`, collecting every reachable object id. */
export function reachableObjects(repo: Repo, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** All commits reachable from `tips`, in newest-first traversal order (parents after children). */
export function reachableCommits(repo: Repo, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...tips].reverse();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const commit = parseCommit(object.data);
    for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
  }
  return out;
}

/** Flatten a tree into path -> {mode, oid} (files only; directories are implied). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build a tree from a flat path map, storing every intermediate tree object. */
export function buildTreeFromMap(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** Whether `ancestor` is an ancestor of (or equal to) `commit`. */
export function isAncestor(repo: Repo, ancestor: string, commit: string): boolean {
  if (ancestor === commit) return true;
  const seen = new Set<string>();
  const stack = [commit];
  let steps = 0;
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    steps += 1;
    if (steps > 200_000) return false;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parsed = parseCommit(object.data);
    if (parsed.parents.includes(ancestor)) return true;
    for (const parent of parsed.parents) stack.push(parent);
  }
  return false;
}

/** Peel a ref target to its commit: follow annotated tags to their target commit. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 10; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The identity string the forge signs its own commits with. */
export function forgeIdentity(): string {
  const epoch = nowEpochSec();
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}
