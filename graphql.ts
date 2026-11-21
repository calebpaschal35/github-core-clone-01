// GraphQL v4: a small document parser and executor for the queries gh and github-mcp-server
// send (viewer, repository + fields, issues with cursor pagination, pull requests, the __type
// probes, node(id:), batched operations, and the create/close/merge/comment mutations).
// It shares the store with REST, so a mutation here is visible over REST and vice versa.

import {
  store,
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  nowIso,
  reachableCommits,
  parseCommit,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { createIssueIn, createPullIn, mergePullRequest, pullFiles, pullMergeable, issueJson, pullJson } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// A small GraphQL document parser (queries and mutations, variables, aliases, inline fragments)

export interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  children: GqlField[];
  fragmentType: string | null;
}

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():!=$[]@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*|^-?[0-9]+(?:\.[0-9]+)?/.exec(source.slice(i));
    if (match !== null) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private at = 0;
  private variables: Record<string, unknown>;

  constructor(source: string, variables: Record<string, unknown>) {
    this.tokens = tokenize(source);
    this.variables = variables;
  }

  peek(): string | undefined {
    return this.tokens[this.at];
  }

  next(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.at += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token} in GraphQL document, got ${got}`);
  }

  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first === 'query' || first === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName !== '{' && maybeName !== '(') {
      name = this.next();
    }
    if (this.peek() === '(') this.skipVariableDefinitions();
    const fields = this.parseSelectionSet();
    return { kind, name, fields };
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): GqlField {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const children = this.parseSelectionSet();
      return { name: '__fragment', alias: null, args: {}, children, fragmentType };
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, unknown> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    let children: GqlField[] = [];
    if (this.peek() === '{') children = this.parseSelectionSet();
    return { name, alias, args, children, fragmentType: null };
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token === '$') return this.variables[this.next() as string] ?? null;
    if (token === '[') {
      const list: unknown[] = [];
      while (this.peek() !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token === '{') {
      const object: Record<string, unknown> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    if (token.startsWith('"')) return JSON.parse(token) as string;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const num = Number(token);
    if (!Number.isNaN(num) && /^-?[0-9]/.test(token)) return num;
    return token;
  }
}

// ---------------------------------------------------------------------------------------------
// Introspection schema

interface TypeInfo {
  kind: string;
  fields?: string[];
  values?: string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: { kind: 'OBJECT', fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'] },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'repository'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'id'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author', 'url'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  SearchType: { kind: 'ENUM', values: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'] },
  IssueState: { kind: 'ENUM', values: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', values: ['OPEN', 'CLOSED', 'MERGED'] },
  OrderDirection: { kind: 'ENUM', values: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', values: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  MergeableState: { kind: 'ENUM', values: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  MergeMethod: { kind: 'ENUM', values: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', values: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
};

function typeInfo(name: string): Record<string, unknown> | null {
  const info = SCHEMA[name];
  if (info === undefined) return null;
  return {
    name,
    kind: info.kind,
    description: null,
    fields: (info.fields ?? []).map((field) => ({ name: field, description: null })),
    enumValues: (info.values ?? []).map((value) => ({ name: value, description: null })),
  };
}

// ---------------------------------------------------------------------------------------------
// Execution

export interface GqlResult {
  data: Record<string, unknown> | null;
  errors: Array<{ message: string }>;
}

interface Ctx {
  errors: Array<{ message: string }>;
}

function fieldError(ctx: Ctx, typeName: string, field: string): void {
  ctx.errors.push({ message: `Cannot query field "${field}" on type "${typeName}".` });
}

function select(fields: GqlField[], parent: unknown, typeName: string, resolve: (field: GqlField) => unknown, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.name === '__fragment') {
      const nested = select(field.children, parent, typeName, resolve, ctx);
      Object.assign(out, nested);
      continue;
    }
    const key = field.alias ?? field.name;
    const value = resolve(field);
    if (value === undefined) {
      fieldError(ctx, typeName, field.name);
      out[key] = null;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function userFields(user: { login: string; id: number; name: string }, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  return select(fields, user, 'User', (field) => {
    if (field.name === 'login') return user.login;
    if (field.name === 'id') return store.globalId('User', user.login);
    if (field.name === 'name') return user.name;
    if (field.name === 'email') return `${user.login}@example.invalid`;
    if (field.name === 'url') return `https://example.invalid/${user.login}`;
    return undefined;
  }, ctx);
}

function issueFields(repo: Repo, issue: Issue, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  return select(fields, issue, 'Issue', (field) => {
    if (field.name === 'id') return store.globalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'body') return issue.body;
    if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'createdAt') return issue.createdAt;
    if (field.name === 'updatedAt') return issue.updatedAt;
    if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
    if (field.name === 'author') return userFields({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME }, field.children, ctx);
    if (field.name === 'labels') return { nodes: issue.labels.map((name) => ({ name })) };
    if (field.name === 'comments') return { nodes: issue.comments.map((comment) => ({ id: store.globalId('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`), body: comment.body })) };
    if (field.name === 'repository') return repositoryFields(repo, field.children, ctx);
    return undefined;
  }, ctx);
}

function pullRequestFields(repo: Repo, pull: Pull, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  return select(fields, pull, 'PullRequest', (field) => {
    if (field.name === 'id') return store.globalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (field.name === 'headRefName') return pull.head;
    if (field.name === 'baseRefName') return pull.base;
    if (field.name === 'mergeable') return pullMergeable(repo, pull);
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'createdAt') return pull.createdAt;
    if (field.name === 'updatedAt') return pull.updatedAt;
    if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
    if (field.name === 'author') return userFields({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME }, field.children, ctx);
    if (field.name === 'repository') return repositoryFields(repo, field.children, ctx);
    if (field.name === 'files') {
      const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 100;
      const files = pullFiles(repo, pull).slice(0, first);
      return { nodes: files.map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status })) };
    }
    return undefined;
  }, ctx);
}

/**
 * Resolve a connection field's children against its nodes and pageInfo. The query's `nodes`
 * selection belongs to the node type (its children are the node's fields); `pageInfo`'s children
 * belong to PageInfo. Passing the connection's children straight to the node fields function
 * (the earlier bug) made every node answer "Cannot query field nodes on type Issue".
 */
function connectionObject(
  children: GqlField[],
  nodes: unknown[],
  nodeFields: (node: never, fields: GqlField[]) => Record<string, unknown>,
  cursorFor: (node: never) => string | null,
  pageInfo: Record<string, unknown>,
  totalCount: number,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    if (child.name === 'nodes') {
      out['nodes'] = nodes.map((node) => nodeFields(node as never, child.children));
    } else if (child.name === 'pageInfo') {
      out['pageInfo'] = select(child.children, pageInfo, 'PageInfo', (f) => {
        const value = pageInfo[f.name];
        return value === undefined ? undefined : value;
      }, ctx);
    } else if (child.name === 'totalCount') {
      out['totalCount'] = totalCount;
    } else if (child.name === 'edges') {
      out['edges'] = nodes.map((node) => select(child.children, node, 'Edge', (f) => {
        if (f.name === 'node') return nodeFields(node as never, f.children);
        if (f.name === 'cursor') return cursorFor(node as never);
        return undefined;
      }, ctx));
    } else {
      fieldError(ctx, 'Connection', child.name);
      out[child.name] = null;
    }
  }
  return out;
}

function pageInfoFor(total: number, returned: number, afterCursor: string | null, endCursor: string | null): Record<string, unknown> {
  void afterCursor;
  return {
    hasNextPage: returned < total,
    hasPreviousPage: false,
    endCursor,
    startCursor: endCursor,
  };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const num = parseInt(text.slice('cursor:'.length), 10);
    return Number.isNaN(num) ? null : num;
  } catch {
    return null;
  }
}

function repositoryFields(repo: Repo, fields: GqlField[], ctx: Ctx): Record<string, unknown> {
  return select(fields, repo, 'Repository', (field) => {
    if (field.name === 'id') return store.globalId('Repository', `${repo.owner}/${repo.name}`);
    if (field.name === 'databaseId') return repo.id;
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (field.name === 'description') return repo.description;
    if (field.name === 'createdAt') return repo.createdAt;
    if (field.name === 'updatedAt') return repo.createdAt;
    if (field.name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
    if (field.name === 'owner') return userFields({ login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 2000 + repo.id, name: repo.owner }, field.children, ctx);
    if (field.name === 'defaultBranchRef') {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return select(field.children, null, 'Ref', (child) => {
        if (child.name === 'name') return repo.defaultBranch;
        if (child.name === 'id') return store.globalId('Ref', `${repo.owner}/${repo.name}:refs/heads/${repo.defaultBranch}`);
        return undefined;
      }, ctx);
    }
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const number = field.args['number'];
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      if (issue === undefined) return null;
      return issueFields(repo, issue, field.children, ctx);
    }
    if (field.name === 'issues') {
      const states = Array.isArray(field.args['states']) ? (field.args['states'] as string[]) : null;
      const orderBy = (field.args['orderBy'] ?? {}) as Record<string, unknown>;
      const direction = orderBy['direction'] === 'ASC' ? 'asc' : 'desc';
      const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 30;
      const after = decodeCursor(field.args['after']);
      let list = [...repo.issues.values()];
      if (states !== null) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state)));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => (a.seq - b.seq) || (a.number - b.number));
      if (direction === 'desc') list.reverse();
      if (after !== null) {
        list = direction === 'desc' ? list.filter((issue) => issue.number < after) : list.filter((issue) => issue.number > after);
      }
      const total = list.length;
      const page = list.slice(0, first);
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number as number) : null;
      return connectionObject(
        field.children,
        page,
        (issue, fields) => issueFields(repo, issue as Issue, fields, ctx),
        (issue) => encodeCursor((issue as Issue).number),
        pageInfoFor(total, page.length, field.args['after'] as string | null, endCursor),
        total,
        ctx,
      );
    }
    if (field.name === 'pullRequests') {
      const first = typeof field.args['first'] === 'number' ? (field.args['first'] as number) : 30;
      const list = [...repo.pulls.values()].sort((a, b) => (a.seq - b.seq) || (a.number - b.number));
      const page = list.slice(0, first);
      const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1]?.number as number) : null;
      return connectionObject(
        field.children,
        page,
        (pull, fields) => pullRequestFields(repo, pull as Pull, fields, ctx),
        (pull) => encodeCursor((pull as Pull).number),
        pageInfoFor(list.length, page.length, field.args['after'] as string | null, endCursor),
        list.length,
        ctx,
      );
    }
    if (field.name === 'pullRequest') {
      const number = field.args['number'];
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return null;
      return pullRequestFields(repo, pull, field.children, ctx);
    }
    return undefined;
  }, ctx);
}

function findByGlobalId(id: string): { repo: Repo; issue?: Issue; pull?: Pull } | null {
  const decoded = store.decodeGlobalId(id);
  if (decoded === null) return null;
  const [owner, rest] = decoded.ref.split('/', 2);
  if (owner === undefined || rest === undefined) return null;
  const repoName = decoded.kind === 'Repository' ? rest : rest.split(':')[0];
  const repo = store.getRepo(owner, repoName as string);
  if (repo === undefined) return null;
  if (decoded.kind === 'Repository') return { repo };
  const number = parseInt((rest.split(':')[1] ?? '').split(':')[0] as string, 10);
  if (Number.isNaN(number)) return null;
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.get(number);
    return issue === undefined ? null : { repo, issue };
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { repo, pull };
  }
  return null;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>): GqlResult {
  const ctx: Ctx = { errors: [] };
  let operation: GqlOperation;
  try {
    operation = new Parser(query, variables).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const data: Record<string, unknown> = {};
  if (operation.kind === 'query') {
    for (const field of operation.fields) {
      const key = field.alias ?? field.name;
      if (field.name === 'viewer') {
        data[key] = userFields({ login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME }, field.children, ctx);
      } else if (field.name === 'repository') {
        const owner = field.args['owner'];
        const name = field.args['name'];
        if (typeof owner !== 'string' || typeof name !== 'string') {
          data[key] = null;
        } else {
          const repo = store.getRepo(owner, name);
          data[key] = repo === undefined ? null : repositoryFields(repo, field.children, ctx);
        }
      } else if (field.name === 'node') {
        const id = field.args['id'];
        if (typeof id !== 'string') {
          data[key] = null;
        } else {
          const found = findByGlobalId(id);
          if (found === null) {
            data[key] = null;
          } else if (found.issue !== undefined) {
            data[key] = issueFields(found.repo, found.issue, field.children, ctx);
          } else if (found.pull !== undefined) {
            data[key] = pullRequestFields(found.repo, found.pull, field.children, ctx);
          } else {
            // A Repository node: inline fragments carry the requested fields.
            const out: Record<string, unknown> = {};
            for (const child of field.children) {
              if (child.name === '__fragment') {
                if (child.fragmentType === null || child.fragmentType === 'Repository') {
                  Object.assign(out, repositoryFields(found.repo, child.children, ctx));
                }
                continue;
              }
              const value = repositoryFields(found.repo, [child], ctx)[child.alias ?? child.name];
              if (value !== undefined) out[child.alias ?? child.name] = value;
            }
            data[key] = out;
          }
        }
      } else if (field.name === '__type') {
        const name = field.args['name'];
        data[key] = typeof name === 'string' ? typeInfo(name) : null;
      } else if (field.name === '__schema') {
        data[key] = { types: Object.keys(SCHEMA).map((name) => ({ name })) };
      } else {
        fieldError(ctx, 'Query', field.name);
        data[key] = null;
      }
    }
    return { data, errors: ctx.errors };
  }
  // Mutations.
  for (const field of operation.fields) {
    const key = field.alias ?? field.name;
    const input = (field.args['input'] ?? {}) as Record<string, unknown>;
    if (field.name === 'createIssue') {
      const repoId = input['repositoryId'];
      const found = typeof repoId === 'string' ? findByGlobalId(repoId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'createIssue: the repository id does not name a repository' });
        data[key] = null;
        continue;
      }
      const created = createIssueIn(found.repo, String(input['title'] ?? ''), String(input['body'] ?? ''), []);
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        data[key] = null;
        continue;
      }
      // The selection is on createIssue.issue; resolve it against the created issue.
      const issueSel = field.children.find((child) => child.name === 'issue');
      data[key] = { issue: issueSel !== undefined ? issueFields(found.repo, created, issueSel.children, ctx) : null };
    } else if (field.name === 'closeIssue') {
      const issueId = input['issueId'];
      const found = typeof issueId === 'string' ? findByGlobalId(issueId) : null;
      if (found === null || found.issue === undefined) {
        ctx.errors.push({ message: 'closeIssue: the issue id does not name an issue' });
        data[key] = null;
        continue;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = nowIso();
      const issueSel = field.children.find((child) => child.name === 'issue');
      data[key] = { issue: issueSel !== undefined ? issueFields(found.repo, found.issue, issueSel.children, ctx) : null };
    } else if (field.name === 'createPullRequest') {
      const repoId = input['repositoryId'];
      const found = typeof repoId === 'string' ? findByGlobalId(repoId) : null;
      if (found === null) {
        ctx.errors.push({ message: 'createPullRequest: the repository id does not name a repository' });
        data[key] = null;
        continue;
      }
      const created = createPullIn(found.repo, String(input['headRefName'] ?? ''), String(input['baseRefName'] ?? ''), String(input['title'] ?? ''), '');
      if ('error' in created) {
        ctx.errors.push({ message: created.error });
        data[key] = null;
        continue;
      }
      const prSel = field.children.find((child) => child.name === 'pullRequest');
      data[key] = { pullRequest: prSel !== undefined ? pullRequestFields(found.repo, created, prSel.children, ctx) : null };
    } else if (field.name === 'mergePullRequest') {
      const prId = input['pullRequestId'];
      const found = typeof prId === 'string' ? findByGlobalId(prId) : null;
      if (found === null || found.pull === undefined) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request id does not name a pull request' });
        data[key] = null;
        continue;
      }
      const merged = mergePullRequest(found.repo, found.pull);
      if (merged === null) {
        ctx.errors.push({ message: 'mergePullRequest: the pull request cannot be merged' });
        data[key] = null;
        continue;
      }
      const prSel = field.children.find((child) => child.name === 'pullRequest');
      data[key] = { pullRequest: prSel !== undefined ? pullRequestFields(found.repo, found.pull, prSel.children, ctx) : null };
    } else if (field.name === 'addComment') {
      const subjectId = input['subjectId'];
      const found = typeof subjectId === 'string' ? findByGlobalId(subjectId) : null;
      if (found === null || found.issue === undefined) {
        ctx.errors.push({ message: 'addComment: the subject id does not name an issue' });
        data[key] = null;
        continue;
      }
      const body = String(input['body'] ?? '');
      const comment = { id: found.repo.nextCommentId, body, createdAt: nowIso(), authorLogin: VIEWER_LOGIN };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const edgeSel = field.children.find((child) => child.name === 'commentEdge');
      const nodeSel = edgeSel?.children.find((child) => child.name === 'node');
      data[key] = {
        commentEdge: {
          node: nodeSel !== undefined
            ? select(nodeSel.children, comment, 'IssueComment', (child) => {
                if (child.name === 'id') return store.globalId('IssueComment', `${found.repo.owner}/${found.repo.name}:${found.issue?.number}:${comment.id}`);
                if (child.name === 'body') return comment.body;
                if (child.name === 'createdAt') return comment.createdAt;
                return undefined;
              }, ctx)
            : { id: store.globalId('IssueComment', `${found.repo.owner}/${found.repo.name}:${found.issue?.number}:${comment.id}`), body },
        },
      };
    } else {
      fieldError(ctx, 'Mutation', field.name);
      data[key] = null;
    }
  }
  return { data, errors: ctx.errors };
}

// Re-exported for the app's GraphQL route: run one document (or a batch of documents).
export function runGraphQL(body: unknown): { status: number; payload: unknown } {
  if (Array.isArray(body)) {
    const out = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'a batched operation must be an object' }] };
      const doc = entry as { query?: unknown; variables?: unknown };
      if (typeof doc.query !== 'string') return { data: null, errors: [{ message: 'a batched operation needs a query string' }] };
      const variables = (doc.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(doc.query, variables);
    });
    return { status: 200, payload: out };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 400, payload: { errors: [{ message: 'a GraphQL body must be an object' }] } };
  }
  const doc = body as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof doc.query !== 'string') {
    return { status: 400, payload: { errors: [{ message: 'a GraphQL request needs a query string' }] } };
  }
  const variables = (doc.variables ?? {}) as Record<string, unknown>;
  return { status: 200, payload: executeGraphQL(doc.query, variables) };
}

// Keep the imports the module's public surface uses referenced for the type checker.
void reachableCommits;
void parseCommit;
void issueJson;
void pullJson;
