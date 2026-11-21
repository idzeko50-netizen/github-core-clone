// rest.ts — the GitHub REST v3 surface: repositories, branches, commits, contents,
// labels, issues, comments and pull requests, over the in-memory store.
// Every reply is JSON with an X-GitHub-Request-Id; errors carry a string message.

import { parseCommit, parseTree } from './git-core.ts';
import {
  FIXED_ISO,
  VIEWER,
  changedPaths,
  commitFile,
  createIssue,
  createPull,
  diffCommits,
  flattenTree,
  history,
  pullGlobalId,
  pullMergeable,
  squashMerge,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => json(status, { message });
const notFound = (what = 'Not Found'): RestReply => err(404, what);

function repoJson(repo: Repo, origin: string): Record<string, unknown> {
  return {
    id: repo.dbId,
    node_id: `R_${repo.dbId}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', avatar_url: '' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
  };
}

function issueJson(repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  return {
    id: repo.dbId * 1_000_000 + issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments: issue.comments.length,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
  };
}

function pullJson(repo: Repo, pull: PullRequest, origin: string): Record<string, unknown> {
  return {
    id: repo.dbId * 1_000_000 + pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? pullMergeable(repo, pull) : null,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: { login: VIEWER.login },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: { login: VIEWER.login },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, sha: string, origin: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: c.message.replace(/\n$/, ''),
      author: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
      committer: { name: VIEWER.name, email: VIEWER.email, date: FIXED_ISO },
      tree: { sha: c.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** A repo lookup that enforces ownership: any other owner is a 404, never a 403. */
function ownedRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (owner.toLowerCase() !== VIEWER.login.toLowerCase()) return undefined;
  return store.get(owner, name);
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: T[], perPage: number, page: number): { page: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasNext: start + perPage < items.length };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, page: number, hasNext: boolean): string {
  const q = new URLSearchParams(query);
  q.set('per_page', String(perPage));
  const parts: string[] = [];
  if (hasNext) {
    q.set('page', String(page + 1));
    parts.push(`<${origin}${path}?${q.toString()}>; rel="next"`);
  }
  if (page > 1) {
    q.set('page', String(page - 1));
    parts.push(`<${origin}${path}?${q.toString()}>; rel="prev"`);
    q.set('page', '1');
    parts.push(`<${origin}${path}?${q.toString()}>; rel="first"`);
  }
  return parts.join(', ');
}

/** Resolve a branch name (or ref) to a commit sha, or undefined. */
function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (repo.objects.has(ref)) return ref;
  return undefined;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
): RestReply {
  const b = (body ?? {}) as Record<string, unknown>;
  const seg = segments.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });

  // GET /api/v3/ and /api/v3/meta and /api/v3/user
  if (seg.length === 0) {
    if (method === 'GET') {
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return notFound();
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return json(200, { installed_version: '1.0.0' });
    return notFound();
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') {
      return json(200, {
        login: VIEWER.login,
        id: VIEWER.id,
        name: VIEWER.name,
        email: VIEWER.email,
        type: 'User',
        avatar_url: '',
        html_url: `${origin}/${VIEWER.login}`,
      });
    }
    return notFound();
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(query);
      const all = store.listByOwner(VIEWER.login);
      const { page: items, hasNext } = paginate(all, perPage, page);
      const headers: Record<string, string> = {};
      const link = linkHeader(origin, '/api/v3/user/repos', query, perPage, page, hasNext);
      if (link) headers.link = link;
      return json(200, items.map((r) => repoJson(r, origin)), headers);
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is invalid');
      if (store.get(VIEWER.login, name)) return err(422, `repository ${name} already exists`);
      const repo = store.create(VIEWER.login, name, {
        private: typeof b.private === 'boolean' ? b.private : false,
        description: typeof b.description === 'string' ? b.description : '',
      });
      return json(201, repoJson(repo, origin));
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1]!;
  const repoName = seg[2]!;
  const repo = ownedRepo(store, owner, repoName);
  const rest = seg.slice(3);

  // /repos/{o}/{r} itself
  if (rest.length === 0) {
    if (!repo) return notFound('Not Found');
    if (method === 'GET') return json(200, repoJson(repo, origin));
    if (method === 'PATCH') {
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.private = b.private;
      return json(200, repoJson(repo, origin));
    }
    if (method === 'DELETE') {
      store.delete(owner, repoName);
      return { status: 204, body: null };
    }
    return notFound();
  }
  if (!repo) return notFound('Not Found');

  // branches
  if (rest[0] === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const branches = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`)! },
          protected: false,
        }));
      return json(200, branches);
    }
    if (method === 'GET' && rest.length === 2) {
      const sha = repo.refs.get(`refs/heads/${rest[1]}`);
      if (!sha) return notFound('Branch not found');
      return json(200, { name: rest[1], commit: { sha }, protected: false });
    }
    return notFound();
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const tip = resolveRef(repo, query.get('sha'));
    const list = tip ? history(repo, tip) : [];
    const { perPage, page } = pageParams(query);
    const { page: items } = paginate(list, perPage, page);
    const out: Record<string, unknown>[] = [];
    for (const sha of items) {
      const c = commitJson(repo, sha, origin);
      if (c) out.push(c);
    }
    return json(200, out);
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = typeof b.ref === 'string' ? b.ref : '';
      const sha = typeof b.sha === 'string' ? b.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return err(422, 'ref or sha is invalid');
      if (repo.refs.has(ref)) return err(422, `ref ${ref} already exists`);
      repo.refs.set(ref, sha);
      return json(201, { ref, node_id: `R_${sha}`, object: { sha, type: 'commit', url: '' } });
    }
    if (method === 'GET') {
      const suffix = rest.slice(2).join('/');
      if (suffix === '') {
        const all = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        return json(200, all);
      }
      const full = `refs/${suffix}`;
      const sha = repo.refs.get(full);
      if (!sha) return notFound('Reference not found');
      return json(200, { ref: full, node_id: `R_${sha}`, object: { sha, type: 'commit', url: '' } });
    }
    return notFound();
  }

  // contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    return handleContents(repo, method, filePath, query, b, origin);
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET') {
      return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: l.description })));
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name : '';
      if (!name) return err(422, 'label name is required');
      const existing = repo.labels.get(name);
      if (existing) return json(201, { name: existing.name, color: existing.color, description: existing.description });
      const label = {
        name,
        color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed',
        description: typeof b.description === 'string' ? b.description : '',
      };
      repo.labels.set(name, label);
      return json(201, { name: label.name, color: label.color, description: label.description });
    }
    return notFound();
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof b.title === 'string' ? b.title : '';
        if (!title) return err(422, 'title is required');
        const labels = Array.isArray(b.labels)
          ? (b.labels as (string | { name: string })[])
          : [];
        const created = createIssue(repo, { title, body: typeof b.body === 'string' ? b.body : '', labels });
        if ('error' in created) return err(422, created.error);
        return json(201, issueJson(repo, created, origin));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        if (sort === 'created') {
          list.sort((a, c2) => (direction === 'asc' ? a.seq - c2.seq : c2.seq - a.seq));
        }
        const { perPage, page } = pageParams(query);
        const { page: items, hasNext } = paginate(list, perPage, page);
        const headers: Record<string, string> = {};
        const link = linkHeader(origin, `/api/v3/repos/${owner}/${repoName}/issues`, query, perPage, page, hasNext);
        if (link) headers.link = link;
        return json(200, items.map((i) => issueJson(repo, i, origin)), headers);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.find((i) => i.number === number);
    if (rest.length === 2) {
      if (!issue) return notFound('Issue not found');
      if (method === 'GET') return json(200, issueJson(repo, issue, origin));
      if (method === 'PATCH') {
        if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        return json(200, issueJson(repo, issue, origin));
      }
      return notFound();
    }
    if (rest[2] === 'comments') {
      if (!issue) return notFound('Issue not found');
      if (method === 'GET') {
        return json(
          200,
          issue.comments.map((c) => ({
            id: c.id,
            node_id: `IC_${c.id}`,
            body: c.body,
            user: { login: VIEWER.login, id: VIEWER.id },
            created_at: FIXED_ISO,
            updated_at: FIXED_ISO,
          })),
        );
      }
      if (method === 'POST') {
        const text = typeof b.body === 'string' ? b.body : '';
        if (!text) return err(422, 'body is required');
        const comment = { id: repo.nextComment, body: text, seq: issue.comments.length };
        repo.nextComment += 1;
        issue.comments.push(comment);
        return json(201, {
          id: comment.id,
          node_id: `IC_${comment.id}`,
          body: comment.body,
          user: { login: VIEWER.login, id: VIEWER.id },
          created_at: FIXED_ISO,
          updated_at: FIXED_ISO,
        });
      }
      return notFound();
    }
    return notFound();
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = typeof b.title === 'string' ? b.title : '';
        const head = typeof b.head === 'string' ? b.head : '';
        const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
        if (!title || !head) return err(422, 'title and head are required');
        const created = createPull(null as unknown as Store, repo, { title, body: typeof b.body === 'string' ? b.body : '', head, base });
        if ('error' in created) return err(422, created.error);
        return json(201, pullJson(repo, created, origin));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, c2) => c2.seq - a.seq);
        const { perPage, page } = pageParams(query);
        const { page: items, hasNext } = paginate(list, perPage, page);
        const headers: Record<string, string> = {};
        const link = linkHeader(origin, `/api/v3/repos/${owner}/${repoName}/pulls`, query, perPage, page, hasNext);
        if (link) headers.link = link;
        return json(200, items.map((p) => pullJson(repo, p, origin)), headers);
      }
      return notFound();
    }
    const number = Number(rest[1]);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.find((p) => p.number === number);
    if (rest.length === 2) {
      if (!pull) return notFound('Pull request not found');
      if (method === 'GET') return json(200, pullJson(repo, pull, origin));
      return notFound();
    }
    if (rest[2] === 'files' && method === 'GET') {
      if (!pull) return notFound('Pull request not found');
      const files = diffCommits(repo, pull.baseSha, pull.headSha);
      return json(200, files);
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (!pull) return notFound('Pull request not found');
      if (pull.merged || pull.state === 'closed') return err(405, 'pull request is already merged or closed');
      const sha = squashMerge(repo, pull);
      if (sha === null) return err(405, 'merge conflict');
      return json(200, { sha, merged: true, message: `Pull request #${pull.number} successfully merged` });
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function handleContents(
  repo: Repo,
  method: string,
  filePath: string,
  query: URLSearchParams,
  b: Record<string, unknown>,
  origin: string,
): RestReply {
  const branch = typeof b.branch === 'string' ? b.branch : (query.get('ref') ?? repo.defaultBranch);
  const ref = `refs/heads/${branch}`;

  if (method === 'GET') {
    const tip = repo.refs.get(ref);
    if (!tip) return notFound('Not Found');
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const files = flattenTree(repo, treeOid);
    if (filePath === '') {
      // Root listing.
      const entries = dirListing(repo, treeOid, '');
      return json(200, entries);
    }
    const file = files.get(filePath);
    if (file) {
      const blob = repo.objects.get(file.oid)!;
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: filePath.split('/').pop(),
        path: filePath,
        content: blob.data.toString('base64'),
        sha: file.oid,
        url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${filePath}`,
        html_url: `${origin}/${repo.owner}/${repo.name}/blob/${branch}/${filePath}`,
        git_url: '',
        download_url: '',
      });
    }
    // A directory? List the entries directly under it.
    const prefix = `${filePath}/`;
    const listed = [...files.keys()].filter((p) => p.startsWith(prefix));
    if (listed.length === 0) return notFound('Not Found');
    const tree = walkToTree(repo, treeOid, filePath);
    if (!tree) return notFound('Not Found');
    return json(200, dirListing(repo, tree, filePath));
  }

  if (method === 'PUT') {
    const message = typeof b.message === 'string' ? b.message : 'update';
    const contentB64 = typeof b.content === 'string' ? b.content : '';
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(422, 'content is not valid base64');
    }
    const sha = typeof b.sha === 'string' ? b.sha : undefined;
    // Create the branch on first use (from the default tip, or as a root commit).
    if (!repo.refs.has(ref)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) repo.refs.set(ref, defaultTip);
    }
    const tip = repo.refs.get(ref);
    if (tip) {
      const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
      const files = flattenTree(repo, treeOid);
      const existing = files.get(filePath);
      if (existing) {
        if (sha === undefined || sha.toLowerCase() !== existing.oid.toLowerCase()) {
          return err(409, 'sha does not match the current file');
        }
        const commitSha = commitFile(repo, branch, filePath, content, message);
        const blobOid = flattenTree(repo, parseCommit(repo.objects.get(commitSha)!.data).tree).get(filePath)!.oid;
        return json(200, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitSha, message },
        });
      }
      if (sha !== undefined) return err(422, 'file does not exist');
    } else if (sha !== undefined) {
      return err(422, 'file does not exist');
    }
    const commitSha = commitFile(repo, branch, filePath, content, message);
    const blobOid = flattenTree(repo, parseCommit(repo.objects.get(commitSha)!.data).tree).get(filePath)!.oid;
    return json(201, {
      content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const message = typeof b.message === 'string' ? b.message : 'delete';
    const sha = typeof b.sha === 'string' ? b.sha : undefined;
    const tip = repo.refs.get(ref);
    if (!tip) return notFound('Not Found');
    const treeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const files = flattenTree(repo, treeOid);
    const existing = files.get(filePath);
    if (!existing) return notFound('Not Found');
    if (sha !== undefined && sha.toLowerCase() !== existing.oid.toLowerCase()) {
      return err(409, 'sha does not match the current file');
    }
    const commitSha = commitFile(repo, branch, filePath, Buffer.alloc(0), message, { delete: true });
    return json(200, { commit: { sha: commitSha, message } });
  }

  return notFound();
}

/** The tree oid at `dirPath` below `treeOid`, or null. */
function walkToTree(repo: Repo, treeOid: string, dirPath: string): string | null {
  let cur = treeOid;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return null;
    cur = entry.oid;
  }
  return cur;
}

function dirListing(repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const entry of parseTree(obj.data)) {
    const path = dirPath === '' ? entry.name : `${dirPath}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
    out.push({
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size,
      url: '',
      html_url: '',
      git_url: '',
      download_url: '',
    });
  }
  return out;
}

export { changedPaths, pullGlobalId };
