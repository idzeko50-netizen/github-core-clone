// mcp.ts — the Model Context Protocol endpoint (Streamable HTTP, JSON-RPC 2.0),
// revision 2026-07-28: server/discover, initialize, tools/list, tools/call.
// The tools act on the same store as REST and GraphQL.

import {
  VIEWER,
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  squashMerge,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

export interface McpReply {
  status: number;
  body: string;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
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
    description: 'List issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
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
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}
function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}
function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Read an argument under its canonical name or a common synonym. */
function arg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined && args[name] !== null) return args[name];
  }
  return undefined;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = arg(args, 'owner', 'owner_login', 'login') as string | undefined;
  let name = arg(args, 'repo', 'repository', 'repository_name', 'repo_name') as string | undefined;
  const full = arg(args, 'full_name', 'repo_full_name') as string | undefined;
  if ((!owner || !name) && typeof full === 'string' && full.includes('/')) {
    const [o, n] = full.split('/', 2);
    owner = owner ?? o;
    name = name ?? n;
  }
  if (!owner || !name) return null;
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return null;
  return store.get(owner, name) ?? null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolErr(`unknown tool ${name}`);
  const missing = tool.inputSchema.required.filter((r) => arg(args, r) === undefined);
  if (missing.length) return toolErr(`missing required argument(s): ${missing.join(', ')}`);

  switch (name) {
    case 'create_repo': {
      const repoName = String(arg(args, 'name'));
      if (store.get(VIEWER.login, repoName)) return toolErr(`repository ${repoName} already exists`);
      const repo = store.create(VIEWER.login, repoName, {
        private: arg(args, 'private', 'is_private') === true,
        description: typeof arg(args, 'description') === 'string' ? String(arg(args, 'description')) : '',
      });
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      const created = storeCreateIssue(repo, {
        title: String(arg(args, 'title')),
        body: typeof arg(args, 'body') === 'string' ? String(arg(args, 'body')) : '',
      });
      if ('error' in created) return toolErr(created.error);
      return toolOk({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        labels: created.labels,
      });
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      const state = typeof arg(args, 'state') === 'string' ? String(arg(args, 'state')) : 'open';
      const list = repo.issues
        .filter((i) => state === 'all' || i.state === state)
        .map((i) => ({ id: i.id, number: i.number, title: i.title, body: i.body, state: i.state }));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      const created = storeCreatePull(null as unknown as Store, repo, {
        title: String(arg(args, 'title')),
        body: typeof arg(args, 'body') === 'string' ? String(arg(args, 'body')) : '',
        head: String(arg(args, 'head', 'head_ref', 'head_branch')),
        base: String(arg(args, 'base', 'base_ref', 'base_branch')),
      });
      if ('error' in created) return toolErr(created.error);
      return toolOk({
        id: created.id,
        number: created.number,
        title: created.title,
        body: created.body,
        state: created.state,
        head: { ref: created.headRef, sha: created.headSha },
        base: { ref: created.baseRef, sha: created.baseSha },
      });
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      const number = Number(arg(args, 'pull_number', 'pull_request_number', 'pr_number', 'number'));
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolErr(`pull request #${number} not found`);
      if (pull.merged || pull.state === 'closed') return toolErr(`pull request #${number} is already closed`);
      const sha = squashMerge(repo, pull);
      if (sha === null) return toolErr(`pull request #${number} has merge conflicts`);
      return toolOk({ number: pull.number, merged: true, sha, state: pull.state });
    }
    case 'get_issue': {
      const repo = findRepo(store, args);
      if (!repo) return toolErr('repository not found');
      const number = Number(arg(args, 'issue_number', 'number'));
      const issue = repo.issues.find((i) => i.number === number);
      if (!issue) return toolErr(`issue #${number} not found`);
      return toolOk({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state });
    }
    default:
      return toolErr(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // A body that is not JSON: HTTP 400 with JSON-RPC -32700, echoing the id if one is legible.
    const idMatch = /"id"\s*:\s*("[^"]*"|\d+)/.exec(bodyText);
    let id: unknown = null;
    if (idMatch) {
      const raw = idMatch[1]!;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return {
      status: 400,
      body: JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) };
  }
  const req = parsed as { id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id: acknowledge with 202 and no body.
  if (req.id === undefined) {
    return { status: 202, body: '' };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [REVISION],
      protocolVersion: REVISION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISION;
    const negotiated = wanted === REVISION ? REVISION : REVISION;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (!toolName) return rpcError(id, -32602, 'tools/call needs a tool name');
    if (!TOOLS.some((t) => t.name === toolName)) {
      return rpcError(id, -32602, `unknown tool ${toolName}`);
    }
    const result = callTool(store, toolName, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}
