// Model Context Protocol: the 2026-07-28 `server/discover` era, with the legacy `initialize`
// handshake as a fallback, `tools/list`, and `tools/call` for the six tools the suite needs
// (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request),
// all backed by the same store as REST and GraphQL.

import { store, VIEWER_LOGIN } from './store.ts';
import { repoJson, issueJson, pullJson, createIssueIn, createPullIn, mergePullRequest } from './rest.ts';
import type { Repo } from './store.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SESSION_ID = 'github-core-clone-session-1';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login for the new repository.' },
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['owner', 'name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findRepo(args: Record<string, unknown>): Repo | { error: string } {
  const owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : VIEWER_LOGIN;
  const repoName = typeof args['repo'] === 'string' ? (args['repo'] as string) : typeof args['name'] === 'string' ? (args['name'] as string) : '';
  if (repoName === '') return { error: 'a repo name is required' };
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return { error: `repository ${owner}/${repoName} was not found` };
  return repo;
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) {
    return { __rpcError: { code: -32602, message: `unknown tool ${name}` } };
  }
  const schema = tool.inputSchema as { required?: string[] };
  const missing = (schema.required ?? []).filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
  if (missing.length > 0) {
    return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      const owner = String(args['owner'] ?? VIEWER_LOGIN);
      const repoName = String(args['name'] ?? '');
      if (store.getRepo(owner, repoName) !== undefined) {
        return toolError(`repository ${owner}/${repoName} already exists`);
      }
      const repo = store.createRepo(owner, repoName, args['private'] === true, typeof args['description'] === 'string' ? (args['description'] as string) : '');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const created = createIssueIn(repo, String(args['title'] ?? ''), typeof args['body'] === 'string' ? (args['body'] as string) : '', []);
      if ('error' in created) return toolError(created.error);
      return toolResult(issueJson(repo, created));
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
      const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
      return toolResult(list.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const created = createPullIn(repo, String(args['head'] ?? ''), String(args['base'] ?? ''), String(args['title'] ?? ''), typeof args['body'] === 'string' ? (args['body'] as string) : '');
      if ('error' in created) return toolError(created.error);
      return toolResult(pullJson(repo, created));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const number = Number(args['pull_number']);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError(`pull request #${number} was not found`);
      const merged = mergePullRequest(repo, pull);
      if (merged === null) return toolError(`pull request #${number} cannot be merged`);
      return toolResult(pullJson(repo, pull));
    }
    case 'get_issue': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const number = Number(args['issue_number']);
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError(`issue #${number} was not found`);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      const repo = findRepo(args);
      if ('error' in repo) return toolError(repo.error);
      const state = typeof args['state'] === 'string' ? (args['state'] as string) : 'open';
      const list = [...repo.pulls.values()].filter((pull) => state === 'all' || pull.state === state);
      return toolResult(list.map((pull) => pullJson(repo, pull)));
    }
    default:
      return { __rpcError: { code: -32602, message: `unknown tool ${name}` } };
  }
}

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** Handle one JSON-RPC request object. Notifications (no id) answer 202 with no body. */
export function handleMcp(body: unknown): McpReply {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const request = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = request.id === undefined;
  const respond = (result: unknown): McpReply => {
    if (isNotification) return { status: 202, body: null };
    return { status: 200, body: { jsonrpc: '2.0', id, result }, headers: { 'Mcp-Session-Id': MCP_SESSION_ID } };
  };
  const fail = (code: number, message: string, data?: unknown): McpReply => {
    if (isNotification) return { status: 202, body: null };
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    return { status: 200, body: { jsonrpc: '2.0', id, error }, headers: { 'Mcp-Session-Id': MCP_SESSION_ID } };
  };
  if (method === 'server/discover') {
    return respond({
      protocolVersion: '2026-07-28',
      supportedVersions: [...MCP_SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2026-07-28';
    const chosen = MCP_SUPPORTED_VERSIONS.includes(offered) ? offered : '2026-07-28';
    return respond({
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return respond({});
  }
  if (method === 'tools/list') {
    return respond({ tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
  }
  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;
    if (name === '') return fail(-32602, 'tools/call needs a tool name');
    const result = callTool(name, args);
    if ('__rpcError' in result) {
      const rpcError = result['__rpcError'] as { code: number; message: string };
      return fail(rpcError.code, rpcError.message);
    }
    return respond(result);
  }
  return fail(-32601, `Method not found: ${method}`);
}
