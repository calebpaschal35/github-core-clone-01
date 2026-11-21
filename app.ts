// The HTTP shell: one Node server, no dependencies. It reads each request body, enforces the
// bearer token (every surface except /healthz), and routes to the git, REST, GraphQL and MCP
// handlers. Every REST reply is JSON with a non-empty X-GitHub-Request-Id.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  store,
  VIEWER_LOGIN,
  flattenTree,
  parseCommit,
  nowIso,
} from './store.ts';
import { infoRefs, uploadPack, receivePack } from './gitproto.ts';
import {
  ok,
  err,
  repoJson,
  issueJson,
  pullJson,
  pullFiles,
  pullMergeable,
  mergePullRequest,
  putContentFile,
  deleteContentFile,
  resolveRef,
  directoryEntries,
  createIssueIn,
  createPullIn,
  sortedIssues,
  commitListJson,
} from './rest.ts';
import { runGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import type { RestReply } from './rest.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const text = body === null || body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...(extraHeaders ?? {}),
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, extraHeaders?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), ...(extraHeaders ?? {}) });
  res.end(body);
}

function parseJsonBody(raw: Buffer): { value: unknown; error: string | null } {
  if (raw.length === 0) return { value: undefined, error: null };
  try {
    return { value: JSON.parse(raw.toString('utf8')) as unknown, error: null };
  } catch {
    return { value: undefined, error: 'the request body is not valid JSON' };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { perPage, page };
}

/** Slice a list into a page and build the Link header for the next page when there is one. */
function paginate<T>(items: readonly T[], perPage: number, page: number, req: IncomingMessage, query: URLSearchParams): { page: T[]; link: string | null } {
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const nextQuery = new URLSearchParams(query);
    nextQuery.set('page', String(page + 1));
    nextQuery.set('per_page', String(perPage));
    const url = new URL(req.url ?? '/', `http://${host}`);
    link = `<http://${host}${url.pathname}?${nextQuery.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function replyRest(res: ServerResponse, reply: RestReply): void {
  if (reply.status === 204) {
    res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...(reply.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.body, reply.headers);
}

// ---------------------------------------------------------------------------------------------
// REST handlers

function handleRest(req: IncomingMessage, res: ServerResponse, segments: string[], query: URLSearchParams, body: unknown): void {
  // GET /api/v3/
  if (segments.length === 0) {
    if (req.method !== 'GET') return replyRest(res, err(404, 'Not Found'));
    return replyRest(res, ok({
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://example.invalid/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: '/api/v3/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      notifications_url: '/api/v3/notifications',
      organization_repositories_url: '/api/v3/orgs/{org}/repos',
      organization_url: '/api/v3/orgs/{org}',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/users/{user}/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos',
      user_search_url: '/api/v3/search/users?q={query}',
    }, 200, { 'x-oauth-scopes': 'repo, admin:org, user' }));
  }
  if (segments[0] === 'meta') {
    if (req.method !== 'GET') return replyRest(res, err(404, 'Not Found'));
    return replyRest(res, ok({ installed_version: '1.0.0', verifiable_password_authentication: false, github_services_sha: 'github-core-clone' }));
  }
  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (req.method === 'GET') {
      const { perPage, page } = pageParams(query);
      const repos = store.viewerRepos().map((repo) => repoJson(repo));
      const { page: slice, link } = paginate(repos, perPage, page, req, query);
      return replyRest(res, ok(slice, 200, link === null ? undefined : { link }));
    }
    if (req.method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = typeof input['name'] === 'string' ? (input['name'] as string) : '';
      if (name === '') return replyRest(res, err(422, 'Validation Failed: name is required'));
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return replyRest(res, err(422, `Repository ${name} already exists`));
      }
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        input['private'] === true,
        typeof input['description'] === 'string' ? (input['description'] as string) : '',
      );
      return replyRest(res, ok(repoJson(repo), 201));
    }
    return replyRest(res, err(404, 'Not Found'));
  }
  if (segments[0] === 'repos') {
    const owner = segments[1] === undefined ? '' : decodeSegment(segments[1]);
    const name = segments[2] === undefined ? '' : decodeSegment(segments[2]);
    const repo = store.getRepo(owner, name);
    if (repo === undefined) return replyRest(res, err(404, 'Not Found'));
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (req.method === 'GET') return replyRest(res, ok(repoJson(repo)));
      if (req.method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input['description'] === 'string') repo.description = input['description'] as string;
        if (typeof input['private'] === 'boolean') repo.private = input['private'] as boolean;
        return replyRest(res, ok(repoJson(repo)));
      }
      if (req.method === 'DELETE') {
        store.deleteRepo(owner, name);
        return replyRest(res, { status: 204, body: null });
      }
      return replyRest(res, err(404, 'Not Found'));
    }
    if (rest[0] === 'branches' && req.method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
      return replyRest(res, ok(branches));
    }
    if (rest[0] === 'commits' && req.method === 'GET' && rest.length === 1) {
      const sha = query.get('sha') ?? undefined;
      if (sha !== undefined && repo.refs.get(`refs/heads/${sha}`) === undefined && repo.objects.get(sha) === undefined) {
        return replyRest(res, err(404, 'No commit found for SHA: ' + sha));
      }
      return replyRest(res, ok(commitListJson(repo, sha)));
    }
    if (rest[0] === 'git' && rest[1] === 'refs' && req.method === 'POST' && rest.length === 2) {
      const input = (body ?? {}) as Record<string, unknown>;
      const ref = typeof input['ref'] === 'string' ? (input['ref'] as string) : '';
      const sha = typeof input['sha'] === 'string' ? (input['sha'] as string) : '';
      if (!ref.startsWith('refs/heads/')) return replyRest(res, err(422, 'Validation Failed: ref must be a branch ref'));
      const object = repo.objects.get(sha);
      if (object === undefined || object.type !== 'commit') return replyRest(res, err(422, `Validation Failed: ${sha} is not a commit`));
      if (repo.refs.has(ref)) return replyRest(res, err(422, `Reference ${ref} already exists`));
      repo.refs.set(ref, sha);
      return replyRest(res, ok({ ref, object: { sha } }, 201));
    }
    if (rest[0] === 'labels') {
      if (req.method === 'GET' && rest.length === 1) {
        return replyRest(res, ok([...repo.labels.values()].map((label) => ({ name: label.name, color: label.color }))));
      }
      if (req.method === 'POST' && rest.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const labelName = typeof input['name'] === 'string' ? (input['name'] as string) : '';
        if (labelName === '') return replyRest(res, err(422, 'Validation Failed: name is required'));
        const color = typeof input['color'] === 'string' ? (input['color'] as string) : 'ededed';
        const existing = repo.labels.get(labelName);
        if (existing !== undefined) return replyRest(res, ok({ name: existing.name, color: existing.color }, 200));
        repo.labels.set(labelName, { name: labelName, color });
        return replyRest(res, ok({ name: labelName, color }, 201));
      }
      return replyRest(res, err(404, 'Not Found'));
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (req.method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          void sort;
          const { perPage, page } = pageParams(query);
          const list = sortedIssues(repo, state, direction === 'asc' ? 'asc' : 'desc').map((issue) => issueJson(repo, issue));
          const { page: slice, link } = paginate(list, perPage, page, req, query);
          return replyRest(res, ok(slice, 200, link === null ? undefined : { link }));
        }
        if (req.method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
          if (title === '') return replyRest(res, err(422, 'Validation Failed: title is required'));
          const labels = Array.isArray(input['labels']) ? (input['labels'] as unknown[]).map(String) : [];
          const created = createIssueIn(repo, title, typeof input['body'] === 'string' ? (input['body'] as string) : '', labels);
          if ('error' in created) return replyRest(res, err(422, `Validation Failed: ${created.error}`));
          return replyRest(res, ok(issueJson(repo, created), 201));
        }
        return replyRest(res, err(404, 'Not Found'));
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (Number.isNaN(number)) return replyRest(res, err(404, 'Not Found'));
      const issue = repo.issues.get(number);
      if (rest.length === 2) {
        if (issue === undefined) return replyRest(res, err(404, 'Not Found'));
        if (req.method === 'GET') return replyRest(res, ok(issueJson(repo, issue)));
        if (req.method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          if (typeof input['state'] === 'string' && (input['state'] === 'open' || input['state'] === 'closed')) issue.state = input['state'] as 'open' | 'closed';
          if (typeof input['title'] === 'string') issue.title = input['title'] as string;
          if (typeof input['body'] === 'string') issue.body = input['body'] as string;
          if (Array.isArray(input['labels'])) {
            const labels = (input['labels'] as unknown[]).map(String);
            for (const label of labels) {
              if (!repo.labels.has(label)) return replyRest(res, err(422, `Validation Failed: label "${label}" does not exist`));
            }
            issue.labels = labels;
          }
          issue.updatedAt = nowIso();
          return replyRest(res, ok(issueJson(repo, issue)));
        }
        return replyRest(res, err(404, 'Not Found'));
      }
      if (rest[2] === 'comments') {
        if (issue === undefined) return replyRest(res, err(404, 'Not Found'));
        if (req.method === 'GET') {
          return replyRest(res, ok(issue.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            created_at: comment.createdAt,
            user: { login: comment.authorLogin, id: VIEWER_LOGIN === comment.authorLogin ? 1000 : 0, type: 'User' },
          }))));
        }
        if (req.method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const commentBody = typeof input['body'] === 'string' ? (input['body'] as string) : '';
          const comment = { id: repo.nextCommentId, body: commentBody, createdAt: nowIso(), authorLogin: VIEWER_LOGIN };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return replyRest(res, ok({ id: comment.id, body: comment.body, created_at: comment.createdAt, user: { login: VIEWER_LOGIN, id: 1000, type: 'User' } }, 201));
        }
        return replyRest(res, err(404, 'Not Found'));
      }
      return replyRest(res, err(404, 'Not Found'));
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (req.method === 'GET') {
          const state = query.get('state') ?? 'open';
          const { perPage, page } = pageParams(query);
          const list = [...repo.pulls.values()]
            .filter((pull) => state === 'all' || pull.state === state)
            .sort((a, b) => (a.seq - b.seq) || (a.number - b.number))
            .map((pull) => pullJson(repo, pull));
          const { page: slice, link } = paginate(list, perPage, page, req, query);
          return replyRest(res, ok(slice, 200, link === null ? undefined : { link }));
        }
        if (req.method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const head = typeof input['head'] === 'string' ? (input['head'] as string) : '';
          const base = typeof input['base'] === 'string' ? (input['base'] as string) : '';
          const title = typeof input['title'] === 'string' ? (input['title'] as string) : '';
          if (head === '' || base === '' || title === '') return replyRest(res, err(422, 'Validation Failed: head, base and title are required'));
          const created = createPullIn(repo, head, base, title, typeof input['body'] === 'string' ? (input['body'] as string) : '');
          if ('error' in created) return replyRest(res, err(422, `Validation Failed: ${created.error}`));
          return replyRest(res, ok(pullJson(repo, created), 201));
        }
        return replyRest(res, err(404, 'Not Found'));
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (Number.isNaN(number)) return replyRest(res, err(404, 'Not Found'));
      const pull = repo.pulls.get(number);
      if (rest.length === 2) {
        if (pull === undefined) return replyRest(res, err(404, 'Not Found'));
        if (req.method === 'GET') return replyRest(res, ok(pullJson(repo, pull)));
        return replyRest(res, err(404, 'Not Found'));
      }
      if (rest[2] === 'files' && req.method === 'GET') {
        if (pull === undefined) return replyRest(res, err(404, 'Not Found'));
        return replyRest(res, ok(pullFiles(repo, pull)));
      }
      if (rest[2] === 'merge' && req.method === 'PUT') {
        if (pull === undefined) return replyRest(res, err(404, 'Not Found'));
        if (pull.state !== 'open') return replyRest(res, err(405, 'Pull request is already closed'));
        if (pullMergeable(repo, pull) !== 'MERGEABLE') return replyRest(res, err(405, 'Merge conflict: the head branch cannot be merged cleanly'));
        const sha = mergePullRequest(repo, pull);
        if (sha === null) return replyRest(res, err(405, 'Merge conflict'));
        return replyRest(res, ok({ merged: true, sha, message: `Pull request #${pull.number} was merged` }));
      }
      return replyRest(res, err(404, 'Not Found'));
    }
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).map(decodeSegment).join('/');
      if (req.method === 'GET') {
        const ref = query.get('ref') ?? undefined;
        const tip = resolveRef(repo, ref);
        if (tip === null) return replyRest(res, err(404, 'Not Found'));
        const object = repo.objects.get(tip);
        if (object === undefined || object.type !== 'commit') return replyRest(res, err(404, 'Not Found'));
        const treeOid = parseCommit(object.data).tree;
        const files = flattenTree(repo, treeOid);
        const entry = files.get(filePath);
        if (entry !== undefined) {
          const blob = repo.objects.get(entry.oid);
          const content = blob === undefined ? Buffer.alloc(0) : blob.data;
          return replyRest(res, ok({
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
            sha: entry.oid,
            size: content.length,
            name: filePath.split('/').pop() ?? filePath,
            path: filePath,
          }));
        }
        const entries = directoryEntries(repo, treeOid, filePath);
        if (entries.length === 0) return replyRest(res, err(404, 'Not Found'));
        return replyRest(res, ok(entries));
      }
      if (req.method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input['message'] === 'string' ? (input['message'] as string) : 'Update file';
        const contentB64 = typeof input['content'] === 'string' ? (input['content'] as string) : '';
        const branch = typeof input['branch'] === 'string' ? (input['branch'] as string) : repo.defaultBranch;
        const sha = typeof input['sha'] === 'string' ? (input['sha'] as string) : undefined;
        if (contentB64 === '') return replyRest(res, err(422, 'Validation Failed: content is required'));
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return replyRest(res, err(422, 'Validation Failed: content is not valid base64'));
        }
        const tipBefore = resolveRef(repo, branch);
        let existed = false;
        if (tipBefore !== null) {
          const tipObject = repo.objects.get(tipBefore);
          if (tipObject !== undefined && tipObject.type === 'commit') {
            existed = flattenTree(repo, parseCommit(tipObject.data).tree).has(filePath);
          }
        }
        const result = putContentFile(repo, branch, filePath, content, message, sha);
        if (result === null) return replyRest(res, err(404, `Branch ${branch} was not found`));
        if (result === 'conflict') return replyRest(res, err(409, 'Conflict: the file was changed since the given sha'));
        return replyRest(res, ok({ content: { sha: result.contentSha, encoding: 'base64' }, commit: { sha: result.commitSha } }, existed ? 200 : 201));
      }
      if (req.method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input['message'] === 'string' ? (input['message'] as string) : 'Delete file';
        const branch = typeof input['branch'] === 'string' ? (input['branch'] as string) : repo.defaultBranch;
        const result = deleteContentFile(repo, branch, filePath, message);
        if (result === null) return replyRest(res, err(404, 'Not Found'));
        return replyRest(res, ok({ commit: { sha: result.commitSha } }));
      }
      return replyRest(res, err(404, 'Not Found'));
    }
    return replyRest(res, err(404, 'Not Found'));
  }
  return replyRest(res, err(404, 'Not Found'));
}

// ---------------------------------------------------------------------------------------------
// The server

export function createApp(): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const pathname = url.pathname;
        const query = url.searchParams;
        if (pathname === '/healthz' && req.method === 'GET') {
          sendJson(res, 200, { status: 'ok' });
          return;
        }
        // Authorization: every surface except /healthz needs the trial token.
        const presented = req.headers.authorization ?? '';
        const authorized = EXPECTED_TOKEN === '' || presented === `Bearer ${EXPECTED_TOKEN}`;
        if (!authorized) {
          if (pathname === '/api/graphql') {
            sendJson(res, 401, { errors: [{ message: 'Requires authentication' }] });
            return;
          }
          if (pathname === '/mcp') {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Requires authentication' } });
            return;
          }
          if (pathname.startsWith('/api/v3')) {
            replyRest(res, err(401, 'Requires authentication'));
            return;
          }
          if (pathname.includes('.git/')) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          replyRest(res, err(401, 'Requires authentication'));
          return;
        }
        // git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const suffix = gitMatch[3] ?? '';
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const raw = await readBody(req);
          if (suffix === '/info/refs' && req.method === 'GET') {
            const service = query.get('service');
            if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
              sendJson(res, 400, { message: 'a service is required' });
              return;
            }
            const wantV2 = req.headers['git-protocol'] === 'version=2';
            const answer = infoRefs(repo, service, wantV2);
            sendRaw(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (suffix === '/git-upload-pack' && req.method === 'POST') {
            const wantV2 = req.headers['git-protocol'] === 'version=2';
            const answer = uploadPack(repo, raw, wantV2);
            sendRaw(res, answer.status, answer.contentType, answer.body);
            return;
          }
          if (suffix === '/git-receive-pack' && req.method === 'POST') {
            const answer = receivePack(repo, raw);
            sendRaw(res, answer.status, answer.contentType, answer.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (pathname === '/api/graphql' && req.method === 'POST') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (parsed.error !== null) {
            sendJson(res, 400, { errors: [{ message: parsed.error }] });
            return;
          }
          const answer = runGraphQL(parsed.value);
          sendJson(res, answer.status, answer.payload);
          return;
        }
        if (pathname === '/mcp' && req.method === 'POST') {
          const raw = await readBody(req);
          if (raw.length === 0) {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
            return;
          }
          const answer = handleMcp(parsed);
          if (answer.body === null) {
            res.writeHead(answer.status, { 'x-github-request-id': nextRequestId(), ...(answer.headers ?? {}) });
            res.end();
            return;
          }
          sendJson(res, answer.status, answer.body, answer.headers);
          return;
        }
        if (pathname.startsWith('/api/v3')) {
          const segments = pathname.split('/').filter((part) => part !== '').slice(2);
          const raw = await readBody(req);
          let body: unknown = undefined;
          if (raw.length > 0) {
            const parsed = parseJsonBody(raw);
            if (parsed.error !== null) {
              replyRest(res, err(400, parsed.error));
              return;
            }
            body = parsed.value;
          }
          handleRest(req, res, segments, query, body);
          return;
        }
        replyRest(res, err(404, 'Not Found'));
      } catch (err) {
        if (!res.headersSent) {
          try {
            sendJson(res, 400, { message: err instanceof Error ? err.message : String(err) });
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
      }
    })();
  });
  return server;
}
