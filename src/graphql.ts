// graphql.ts — a small GraphQL executor for the documents gh and github-mcp-server
// send: viewer/repository/issue/pull-request reads, the __type probes, node(id:),
// the five mutations, and operation batching. No vendored GraphQL library: the
// parser and the resolvers below are authored in this session.

import {
  VIEWER,
  commentGlobalId,
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  decodeGlobalId,
  diffCommits,
  issueGlobalId,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// schema surface (for introspection and unknown-field detection)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id'],
  User: ['login', 'id'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// parser: a minimal recursive-descent parser for query documents
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; type: string | null; selection: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  parse(): OperationNode[] {
    const ops: OperationNode[] = [];
    this.skipWs();
    while (this.pos < this.text.length) {
      ops.push(this.parseOperation());
      this.skipWs();
    }
    return ops;
  }

  private skipWs(): void {
    for (;;) {
      while (this.pos < this.text.length && /[\s,]/.test(this.text[this.pos]!)) this.pos += 1;
      if (this.text[this.pos] === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
        continue;
      }
      break;
    }
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private expect(ch: string): void {
    this.skipWs();
    if (this.text[this.pos] !== ch) throw new Error(`expected ${ch} at ${this.pos}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWs();
    const start = this.pos;
    while (this.pos < this.text.length && /[_A-Za-z0-9]/.test(this.text[this.pos]!)) this.pos += 1;
    if (start === this.pos) throw new Error(`expected a name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private parseOperation(): OperationNode {
    this.skipWs();
    let type: 'query' | 'mutation' = 'query';
    if (this.peek() === '{') {
      return { type, name: null, selection: this.parseSelectionSet() };
    }
    const word = this.readName();
    if (word !== 'query' && word !== 'mutation') throw new Error(`expected query or mutation, got ${word}`);
    type = word;
    this.skipWs();
    let name: string | null = null;
    if (/[_A-Za-z]/.test(this.peek())) name = this.readName();
    this.skipWs();
    if (this.peek() === '(') this.skipVariableDefinitions();
    this.skipWs();
    return { type, name, selection: this.parseSelectionSet() };
  }

  private skipVariableDefinitions(): void {
    // ($name: Type = default, ...) — balanced parens; contents are not needed.
    let depth = 0;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) return;
        continue;
      }
      this.pos += 1;
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    for (;;) {
      this.skipWs();
      if (this.peek() === '}') {
        this.pos += 1;
        return out;
      }
      if (this.text.startsWith('...', this.pos)) {
        this.pos += 3;
        this.skipWs();
        let type: string | null = null;
        if (this.text.startsWith('on', this.pos) && !/[_A-Za-z0-9]/.test(this.text[this.pos + 2] ?? '')) {
          this.pos += 2;
          type = this.readName();
        }
        out.push({ kind: 'inlineFragment', type, selection: this.parseSelectionSet() });
        continue;
      }
      out.push({ kind: 'field', field: this.parseField() });
    }
  }

  private parseField(): FieldNode {
    const first = this.readName();
    this.skipWs();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.pos += 1;
      alias = first;
      name = this.readName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    this.skipWs();
    if (this.peek() === '(') {
      this.pos += 1;
      for (;;) {
        this.skipWs();
        if (this.peek() === ')') {
          this.pos += 1;
          break;
        }
        const argName = this.readName();
        this.skipWs();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    this.skipWs();
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    this.skipWs();
    const ch = this.peek();
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', name: this.readName() };
    }
    if (ch === '"') return { kind: 'string', value: this.parseString() };
    if (ch === '[') {
      this.pos += 1;
      const values: ValueNode[] = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === ']') {
          this.pos += 1;
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (ch === '{') {
      this.pos += 1;
      const fields: { name: string; value: ValueNode }[] = [];
      for (;;) {
        this.skipWs();
        if (this.peek() === '}') {
          this.pos += 1;
          return { kind: 'object', fields };
        }
        const name = this.readName();
        this.skipWs();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      while (this.pos < this.text.length && /[0-9.eE+-]/.test(this.text[this.pos]!)) this.pos += 1;
      const raw = this.text.slice(start, this.pos);
      if (/[.eE]/.test(raw)) return { kind: 'float', value: Number(raw) };
      return { kind: 'int', value: Number(raw) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        this.pos += 1;
        const esc = this.text[this.pos]!;
        if (esc === 'n') out += '\n';
        else if (esc === 't') out += '\t';
        else if (esc === 'r') out += '\r';
        else out += esc;
        this.pos += 1;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}
function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(text);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

interface Ctx {
  store: Store;
  variables: Variables;
  errors: { message: string }[];
}

function unknownField(type: string, name: string, ctx: Ctx): null {
  ctx.errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return null;
}

function isKnown(type: string, name: string): boolean {
  return (SCHEMA[type] ?? []).includes(name);
}

/** Execute a selection set against a value of a known GraphQL type. */
function executeSelection(
  type: string,
  value: unknown,
  selection: SelectionNode[] | null,
  ctx: Ctx,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (selection === null) return value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inlineFragment') {
      if (node.type !== null && node.type !== type && !(type === 'Node' && node.type === 'Repository')) {
        continue;
      }
      const fragment = executeSelection(node.type ?? type, value, node.selection, ctx);
      if (fragment) Object.assign(out, fragment);
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    if (!isKnown(type, field.name)) {
      unknownField(type, field.name, ctx);
      out[key] = null;
      continue;
    }
    out[key] = resolveField(type, value, field, ctx);
  }
  return out;
}

function resolveField(type: string, value: unknown, field: FieldNode, ctx: Ctx): unknown {
  const args = argsOf(field, ctx.variables);
  const sel = field.selection;
  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') {
        return executeSelection('User', { login: VIEWER.login }, sel, ctx);
      }
      if (field.name === 'repository') {
        const repo = findRepo(ctx.store, args.owner as string, args.name as string);
        if (!repo) return null;
        return executeSelection('Repository', repo, sel, ctx);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (!decoded || decoded.kind !== 'repo') return null;
        const repo = ctx.store.get(decoded.owner, decoded.name);
        if (!repo) return null;
        // node(id:) answers the Repository fragment on a Repository value.
        return executeSelection('Repository', repo, sel, ctx);
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        return executeSelection('__Type', { __typeName: name }, sel, ctx);
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(field, args, ctx);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = value as { issue: unknown };
      if (field.name === 'issue') return executeSelection('Issue', payload.issue, sel, ctx);
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = value as { pullRequest: unknown };
      if (field.name === 'pullRequest') return executeSelection('PullRequest', payload.pullRequest, sel, ctx);
      return null;
    }
    case 'AddCommentPayload': {
      const payload = value as { commentEdge: unknown };
      if (field.name === 'commentEdge') return executeSelection('IssueCommentEdge', payload.commentEdge, sel, ctx);
      return null;
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.dbId;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return executeSelection('User', { login: repo.owner }, sel, ctx);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (!tip) return null;
          return executeSelection('Ref', { name: repo.defaultBranch }, sel, ctx);
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.find((i) => i.number === (args.number as number));
          if (!issue) return null;
          return executeSelection('Issue', issue, sel, ctx);
        }
        case 'issues':
          return issueConnection(repo, args, sel, ctx);
        case 'pullRequests':
          return pullConnection(repo, args, sel, ctx);
        case 'pullRequest': {
          const pull = repo.pulls.find((p) => p.number === (args.number as number));
          if (!pull) return null;
          return executeSelection('PullRequest', pull, sel, ctx);
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const issue = value as Issue;
      switch (field.name) {
        case 'id':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const pull = value as PullRequest;
      switch (field.name) {
        case 'id':
          return pull.id;
        case 'number':
          return pull.number;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable':
          return mergeableOf(pull, ctx);
        case 'files': {
          const repo = findRepoOfPull(ctx.store, pull);
          const first = typeof args.first === 'number' ? args.first : 10;
          const files = repo ? diffCommits(repo, pull.baseSha, pull.headSha) : [];
          const nodes = files.slice(0, first).map((f) => ({ path: f.filename }));
          return executeSelection(
            'PullRequestChangedFileConnection',
            { nodes, pageInfo: { hasNextPage: files.length > first, endCursor: null } },
            sel,
            ctx,
          );
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      const conn = value as { nodes: unknown[]; pageInfo: Record<string, unknown> };
      if (field.name === 'nodes') {
        const itemType =
          type === 'IssueConnection' ? 'Issue' : type === 'PullRequestConnection' ? 'PullRequest' : 'PullRequestChangedFile';
        return conn.nodes.map((n) => executeSelection(itemType, n, sel, ctx));
      }
      if (field.name === 'pageInfo') return executeSelection('PageInfo', conn.pageInfo, sel, ctx);
      if (field.name === 'totalCount') return conn.nodes.length;
      return null;
    }
    case 'PullRequestChangedFile': {
      const file = value as { path: string };
      return field.name === 'path' ? file.path : null;
    }
    case 'PageInfo': {
      const info = value as Record<string, unknown>;
      if (field.name === 'hasNextPage') return info.hasNextPage ?? false;
      if (field.name === 'endCursor') return info.endCursor ?? null;
      if (field.name === 'hasPreviousPage') return false;
      if (field.name === 'startCursor') return info.startCursor ?? null;
      return null;
    }
    case 'User':
    case 'Viewer': {
      const user = value as { login: string };
      return field.name === 'login' ? user.login : null;
    }
    case 'Ref': {
      const ref = value as { name: string };
      return field.name === 'name' ? ref.name : null;
    }
    case '__Type': {
      const t = value as { __typeName: string };
      if (field.name === 'name') return t.__typeName;
      if (field.name === 'kind') return t.__typeName in ENUM_VALUES ? 'ENUM' : 'OBJECT';
      if (field.name === 'fields') {
        return (SCHEMA[t.__typeName] ?? []).map((name) => executeSelection('__Field', { name }, sel, ctx));
      }
      if (field.name === 'enumValues') {
        return (ENUM_VALUES[t.__typeName] ?? []).map((name) => executeSelection('__EnumValue', { name }, sel, ctx));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      const entry = value as { name: string };
      return field.name === 'name' ? entry.name : null;
    }
    case 'IssueCommentEdge': {
      const edge = value as { node: unknown };
      if (field.name === 'node') return executeSelection('IssueComment', edge.node, sel, ctx);
      return null;
    }
    case 'IssueComment': {
      const comment = value as { id: string; body: string };
      if (field.name === 'id') return comment.id;
      if (field.name === 'body') return comment.body;
      return null;
    }
    default:
      return null;
  }
}

function findRepo(store: Store, owner: unknown, name: unknown): Repo | undefined {
  if (typeof owner !== 'string' || typeof name !== 'string') return undefined;
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
  return store.get(owner, name);
}

function findRepoOfPull(store: Store, pull: PullRequest): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.pulls.includes(pull)) return repo;
  }
  return undefined;
}

function mergeableOf(pull: PullRequest, ctx: Ctx): string {
  const repo = findRepoOfPull(ctx.store, pull);
  if (!repo) return 'UNKNOWN';
  return pullMergeable(repo, pull);
}

function issueConnection(repo: Repo, args: Record<string, unknown>, sel: SelectionNode[] | null, ctx: Ctx): unknown {
  let list = [...repo.issues];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
  const after = numberFromCursor(args.after);
  if (after !== null) {
    list = direction > 0 ? list.filter((i) => i.number > after) : list.filter((i) => i.number < after);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
  return executeSelection(
    'IssueConnection',
    { nodes: page, pageInfo: { hasNextPage, endCursor } },
    sel,
    ctx,
  );
}

function pullConnection(repo: Repo, args: Record<string, unknown>, sel: SelectionNode[] | null, ctx: Ctx): unknown {
  const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length ? cursorFor(page[page.length - 1]!.number) : null;
  return executeSelection(
    'PullRequestConnection',
    { nodes: page, pageInfo: { hasNextPage, endCursor } },
    sel,
    ctx,
  );
}

function resolveMutation(field: FieldNode, args: Record<string, unknown>, ctx: Ctx): unknown {
  const sel = field.selection;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'repo' ? ctx.store.get(decoded.owner, decoded.name) : undefined;
      if (!repo) return executeSelection('CreateIssuePayload', { issue: null }, sel, ctx);
      const created = storeCreateIssue(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
      });
      if ('error' in created) return executeSelection('CreateIssuePayload', { issue: null }, sel, ctx);
      return executeSelection('CreateIssuePayload', { issue: created }, sel, ctx);
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      const repo = decoded ? ctx.store.get(decoded.owner, decoded.name) : undefined;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!issue) return executeSelection('CloseIssuePayload', { issue: null }, sel, ctx);
      issue.state = 'closed';
      return executeSelection('CloseIssuePayload', { issue }, sel, ctx);
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded && decoded.kind === 'repo' ? ctx.store.get(decoded.owner, decoded.name) : undefined;
      if (!repo) return executeSelection('CreatePullRequestPayload', { pullRequest: null }, sel, ctx);
      const created = storeCreatePull(null as unknown as Store, repo, {
        title: String(input.title ?? ''),
        body: '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in created) return executeSelection('CreatePullRequestPayload', { pullRequest: null }, sel, ctx);
      return executeSelection('CreatePullRequestPayload', { pullRequest: created }, sel, ctx);
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      const repo = decoded ? ctx.store.get(decoded.owner, decoded.name) : undefined;
      const pull = repo?.pulls.find((p) => p.number === decoded?.number);
      if (!pull || !repo) return executeSelection('MergePullRequestPayload', { pullRequest: null }, sel, ctx);
      squashMerge(repo, pull);
      return executeSelection('MergePullRequestPayload', { pullRequest: pull }, sel, ctx);
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      const repo = decoded ? ctx.store.get(decoded.owner, decoded.name) : undefined;
      const issue = repo?.issues.find((i) => i.number === decoded?.number);
      if (!issue || !repo) return executeSelection('AddCommentPayload', { commentEdge: null }, sel, ctx);
      const comment = { id: repo.nextComment, body: String(input.body ?? ''), seq: issue.comments.length };
      repo.nextComment += 1;
      issue.comments.push(comment);
      const node = { id: commentGlobalId(repo, issue, comment), body: comment.body };
      return executeSelection('AddCommentPayload', { commentEdge: { node } }, sel, ctx);
    }
    default:
      return null;
  }
}

/** Execute one operation document; returns the {data, errors} envelope. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Variables,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: { message: string }[] } {
  const ctx: Ctx = { store, variables, errors: [] };
  let operations: OperationNode[];
  try {
    operations = new Parser(query).parse();
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL syntax error: ${(err as Error).message}` }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'no operation in document' }] };
  let operation = operations[0]!;
  if (operationName) {
    const named = operations.find((o) => o.name === operationName);
    if (named) operation = named;
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, {}, operation.selection, ctx);
  if (ctx.errors.length) return { data: null, errors: ctx.errors };
  return { data: data ?? {}, errors: [] };
}

export { issueGlobalId, pullGlobalId };
