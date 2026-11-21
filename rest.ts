// REST v3: repositories, issues, pull requests, contents, branches, commits, labels, comments.
// Every handler works on the same store the git surface writes, so a commit pushed over git
// shows up in GET /commits and GET /contents, and a file PUT over REST is a real git commit
// a clone can fetch.

import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  DEFAULT_BRANCH,
  ZERO_OID,
  nowIso,
  hashObject,
  flattenTree,
  buildTreeFromMap,
  parseCommit,
  buildCommit,
  forgeIdentity,
  reachableCommits,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function ok(body: unknown, status = 200, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

export function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

export function repoUrl(owner: string, name: string): string {
  return `/repos/${owner}/${name}`;
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: store.globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 + repo.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3${repoUrl(repo.owner, repo.name)}`,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    clone_url: `https://example.invalid/${repo.owner}/${repo.name}.git`,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3${repoUrl(repo.owner, repo.name)}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: store.globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull) === 'MERGEABLE',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3${repoUrl(repo.owner, repo.name)}/pulls/${pull.number}`,
  };
}

/** The files a pull request changes, with line counts, from base tip to head tip. */
export function pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = pull.baseSha === ZERO_OID ? new Map() : flattenTree(repo, treeOfCommit(repo, pull.baseSha));
  const headFiles = pull.headSha === ZERO_OID ? new Map() : flattenTree(repo, treeOfCommit(repo, pull.headSha));
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base === undefined && head !== undefined) {
      const lines = blobLines(repo, head.oid);
      out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
    } else if (base !== undefined && head === undefined) {
      const lines = blobLines(repo, base.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
    } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
      const diff = lineDiff(blobText(repo, base.oid), blobText(repo, head.oid));
      out.push({ filename: path, status: 'modified', additions: diff.added, deletions: diff.removed, changes: diff.added + diff.removed });
    }
  }
  return out;
}

function treeOfCommit(repo: Repo, commitOid: string): string {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return '';
  return parseCommit(object.data).tree;
}

function blobText(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (object === undefined) return '';
  return object.data.toString('utf8');
}

function blobLines(repo: Repo, oid: string): number {
  const text = blobText(repo, oid);
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** A small LCS line diff: counts of added and removed lines. */
export function lineDiff(before: string, after: string): { added: number; removed: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const n = a.length;
  const m = b.length;
  // LCS on lines; contents are small, so the O(n*m) table is fine.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
    }
  }
  const common = dp[0]![0] as number;
  return { added: m - common, removed: n - common };
}

/** Whether a pull request's head applies cleanly onto its base's current tip. */
export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  const baseFiles = pull.baseSha === ZERO_OID ? new Map() : flattenTree(repo, treeOfCommit(repo, pull.baseSha));
  const headFiles = pull.headSha === ZERO_OID ? new Map() : flattenTree(repo, treeOfCommit(repo, pull.headSha));
  const currentBaseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (currentBaseTip === undefined) return 'CONFLICTING';
  const currentFiles = flattenTree(repo, treeOfCommit(repo, currentBaseTip));
  const changed = new Set<string>();
  for (const path of new Set([...baseFiles.keys(), ...headFiles.keys()])) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if ((b?.oid ?? null) !== (h?.oid ?? null)) changed.add(path);
  }
  for (const path of changed) {
    const baseOid = baseFiles.get(path)?.oid ?? null;
    const headOid = headFiles.get(path)?.oid ?? null;
    const currentOid = currentFiles.get(path)?.oid ?? null;
    if (currentOid !== baseOid && currentOid !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** Squash-merge a pull request onto its base branch; returns the merge commit oid or null. */
export function mergePullRequest(repo: Repo, pull: Pull): string | null {
  if (pull.state !== 'open' || pull.merged) return null;
  if (pullMergeable(repo, pull) !== 'MERGEABLE') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (baseTip === undefined) return null;
  const baseFiles = flattenTree(repo, treeOfCommit(repo, baseTip));
  const headFiles = flattenTree(repo, treeOfCommit(repo, pull.headSha));
  const prBaseFiles = flattenTree(repo, treeOfCommit(repo, pull.baseSha));
  const merged = new Map(baseFiles);
  for (const path of new Set([...prBaseFiles.keys(), ...headFiles.keys()])) {
    const before = prBaseFiles.get(path);
    const after = headFiles.get(path);
    if ((before?.oid ?? null) === (after?.oid ?? null)) continue;
    if (after === undefined) merged.delete(path);
    else merged.set(path, after);
  }
  const treeOid = buildTreeFromMap(repo, merged);
  const message = `${pull.title} (#${pull.number})\n`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: forgeIdentity(),
    committer: forgeIdentity(),
    message,
  });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(`refs/heads/${pull.base}`, commitOid);
  const at = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = at;
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = at;
  return commitOid;
}

// ---------------------------------------------------------------------------------------------
// Contents (files as git commits)

interface ContentResult {
  commitSha: string;
  contentSha: string;
}

/**
 * Write one file into a repo's branch as a git commit. `expectedSha` is the blob sha the caller
 * believes is current; a mismatch is a 409. Returns null when the branch does not exist.
 */
export function putContentFile(repo: Repo, branch: string, path: string, content: Buffer, message: string, expectedSha?: string): ContentResult | 'conflict' | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  let files = new Map<string, { mode: string; oid: string }>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const tree = treeOfCommit(repo, tip);
    if (tree !== '') files = flattenTree(repo, tree);
    parents.push(tip);
  } else if (branch !== repo.defaultBranch) {
    return null;
  }
  if (expectedSha !== undefined) {
    const current = files.get(path)?.oid ?? null;
    if (current !== expectedSha) return 'conflict';
  }
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  files.set(path, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromMap(repo, files);
  const commitData = buildCommit({ tree: treeOid, parents, author: forgeIdentity(), committer: forgeIdentity(), message: message.endsWith('\n') ? message : `${message}\n` });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitOid);
  return { commitSha: commitOid, contentSha: blobOid };
}

/** Delete one file from a branch as a git commit. */
export function deleteContentFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const tree = treeOfCommit(repo, tip);
  const files = flattenTree(repo, tree);
  if (!files.has(path)) return null;
  files.delete(path);
  const treeOid = buildTreeFromMap(repo, files);
  const commitData = buildCommit({ tree: treeOid, parents: [tip], author: forgeIdentity(), committer: forgeIdentity(), message: message.endsWith('\n') ? message : `${message}\n` });
  const commitOid = hashObject('commit', commitData);
  repo.objects.set(commitOid, { type: 'commit', data: commitData });
  repo.refs.set(ref, commitOid);
  return { commitSha: commitOid };
}

/** Resolve a `ref` query value (branch name, full ref, or commit oid) to a tip commit oid. */
export function resolveRef(repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(ref)) return repo.refs.get(ref) as string;
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const object = repo.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

/** The file entries under a directory path in a tree, for GET /contents/<dir>. */
export function directoryEntries(repo: Repo, treeOid: string, dir: string): Array<{ type: string; name: string; path: string; sha: string }> {
  const files = flattenTree(repo, treeOid);
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: string; sha: string }>();
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) children.set(rest, { type: 'file', sha: entry.oid });
    else children.set(rest.slice(0, slash), { type: 'dir', sha: '' });
  }
  // Directory shas are the subtree oids.
  const out: Array<{ type: string; name: string; path: string; sha: string }> = [];
  for (const [name, child] of [...children.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let sha = child.sha;
    if (child.type === 'dir') {
      const object = repo.objects.get(treeOid);
      if (object !== undefined && object.type === 'tree') {
        // Walk the tree to the subdirectory.
        let current = treeOid;
        for (const part of `${prefix}${name}`.split('/').filter(Boolean)) {
          const obj = repo.objects.get(current);
          if (obj === undefined || obj.type !== 'tree') break;
          const entry = parseTree(obj.data).find((item) => item.name === part);
          if (entry === undefined) break;
          current = entry.oid;
        }
        sha = current;
      }
    }
    out.push({ type: child.type, name, path: `${prefix}${name}`, sha });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Issues and pulls shared by REST, GraphQL and MCP

export function createIssueIn(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const label of labels) {
    if (!repo.labels.has(label)) return { error: `label "${label}" does not exist` };
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const at = nowIso();
  const issue: Issue = {
    number,
    id: store.nextIssueDbId(),
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: at,
    updatedAt: at,
    seq: repo.seq + 1,
  };
  repo.seq += 1;
  repo.issues.set(number, issue);
  return issue;
}

export function createPullIn(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (headTip === undefined) return { error: `head branch "${head}" does not exist` };
  if (baseTip === undefined) return { error: `base branch "${base}" does not exist` };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.head === head && pull.base === base) {
      return { error: `a pull request from ${head} to ${base} already exists` };
    }
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const at = nowIso();
  const pull: Pull = {
    number,
    id: store.nextPullDbId(),
    title,
    body,
    state: 'open',
    head,
    base,
    headSha: headTip,
    baseSha: baseTip,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: at,
    updatedAt: at,
    seq: repo.seq + 1,
  };
  repo.seq += 1;
  repo.pulls.set(number, pull);
  return pull;
}

/** Sort issues by creation: `direction` asc or desc; ties break by number. */
export function sortedIssues(repo: Repo, state: string | undefined, direction: 'asc' | 'desc'): Issue[] {
  const list = [...repo.issues.values()];
  const filtered = state === undefined || state === 'all' ? list : list.filter((issue) => issue.state === state);
  filtered.sort((a, b) => (a.seq - b.seq) || (a.number - b.number));
  if (direction === 'desc') filtered.reverse();
  return filtered;
}

/** The commit list for a branch (or the default branch): newest first, ancestry only. */
export function commitListJson(repo: Repo, branch: string | undefined): Array<Record<string, unknown>> {
  const tip = branch === undefined ? repo.refs.get(`refs/heads/${repo.defaultBranch}`) : repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return [];
  return reachableCommits(repo, [tip]).map((oid) => {
    const object = repo.objects.get(oid);
    const parsed = object !== undefined ? parseCommit(object.data) : null;
    // Git stores the message with a trailing newline; the API shows it without one — the
    // suite compares the message exactly against what the contents call passed in.
    const rawMessage = parsed?.message ?? '';
    const message = rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage;
    return {
      sha: oid,
      commit: {
        message,
        author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: nowIso() },
        committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: nowIso() },
      },
      parents: (parsed?.parents ?? []).map((parent) => ({ sha: parent })),
    };
  });
}
