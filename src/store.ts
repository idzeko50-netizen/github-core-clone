// store.ts — the forge's own in-memory store: repositories, git objects and refs,
// issues, labels, pull requests and comments. Deterministic by construction: every
// timestamp is a fixed constant, every id is a counter or a hash of its content.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type GitObjectType,
} from './git-core.ts';

/** The token owner's identity: the competition's published scenario (fixed seed). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** One fixed timestamp for every API date and every commit the forge itself writes. */
export const FIXED_EPOCH = 1_700_000_000;
export const FIXED_ISO = '2025-01-01T00:00:00Z';

export function viewerIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${FIXED_EPOCH} +0000`;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface PullRequest {
  number: number;
  id: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  dbId: number;
  owner: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  commitSeq: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextDbId = 1;
  private repoSeq = 0;

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  get(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner.toLowerCase() === owner.toLowerCase()) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  create(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo {
    const repo: Repo = {
      dbId: this.nextDbId,
      owner,
      name,
      private: opts.private ?? false,
      description: opts.description ?? '',
      defaultBranch: 'main',
      seq: this.repoSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      commitSeq: 0,
    };
    this.nextDbId += 1;
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  delete(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }
}

// ---------------------------------------------------------------------------------------------
// global (Relay) ids: opaque, stable, never the plain database id or number
// ---------------------------------------------------------------------------------------------

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function repoGlobalId(repo: Repo): string {
  return `R_${b64url(`repo:${repo.owner}/${repo.name}`)}`;
}
export function issueGlobalId(repo: Repo, issue: Issue): string {
  return `I_${b64url(`issue:${repo.owner}/${repo.name}:${issue.number}`)}`;
}
export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return `PR_${b64url(`pr:${repo.owner}/${repo.name}:${pull.number}`)}`;
}
export function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return `IC_${b64url(`comment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`)}`;
}

/** Decode a global id back to its kind and coordinates, or null. */
export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number } | null {
  const match = /^(R|I|PR|IC)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  const kind = match[1] === 'R' ? 'repo' : match[1] === 'I' ? 'issue' : match[1] === 'PR' ? 'pull' : 'comment';
  let text: string;
  try {
    text = Buffer.from(match[2], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  const kindTag = parts[0] ?? '';
  const rest = parts[1] ?? '';
  const [owner, name] = rest.split('/');
  const number = parts.length > 2 ? Number(parts[2]) : 0;
  if (!owner || !name) return null;
  return { kind, owner, name, number };
}

// ---------------------------------------------------------------------------------------------
// git object helpers on a repo
// ---------------------------------------------------------------------------------------------

export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function lookupOf(repo: Repo): (oid: string) => GitObject | undefined {
  return (oid) => repo.objects.get(oid);
}

/** The files of a tree, flattened to path -> {oid, mode}, following nested trees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, pre: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = pre === '' ? entry.name : `${pre}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree object for `files` (path -> blob oid) from scratch. */
export function buildTreeForFiles(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/**
 * Commit one file change on `branch` (creating the branch at the default tip, or as the
 * root commit, when it does not exist yet). Returns the new commit sha.
 */
export function commitFile(
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  opts: { delete?: boolean } = {},
): string {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = tip ? parseCommit(repo.objects.get(tip)!.data).tree : null;
  const files = parentTree ? flattenTree(repo, parentTree) : new Map<string, { oid: string; mode: string }>();
  if (opts.delete === true) {
    files.delete(path);
  } else {
    const blobOid = putObject(repo, 'blob', content);
    files.set(path, { oid: blobOid, mode: '100644' });
  }
  const treeOid = buildTreeForFiles(repo, files);
  repo.commitSeq += 1;
  const stamp = `${FIXED_EPOCH + repo.commitSeq} +0000`;
  const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
  const commit = buildCommit({
    tree: treeOid,
    parents: tip ? [tip] : [],
    author: identity,
    committer: identity,
    message: message.endsWith('\n') ? message : `${message}\n`,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(ref, commitOid);
  return commitOid;
}

/** The commit history of a ref tip, newest first (first-parent walk). */
export function history(repo: Repo, tip: string | undefined): string[] {
  const out: string[] = [];
  let cur = tip;
  const seen = new Set<string>();
  while (cur && isOid(cur) && !seen.has(cur)) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    out.push(cur);
    cur = parseCommit(obj.data).parents[0];
  }
  return out;
}

/** Line counts of a blob, for pull-file additions/deletions. */
function lineCounts(data: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  const text = data.toString('utf8');
  const lines = text === '' ? [] : text.split('\n');
  // A trailing newline does not make an extra line.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Diff the trees of two commits (base -> head), as a pull request's files list. */
export function diffCommits(repo: Repo, baseOid: string, headOid: string): FileChange[] {
  const baseTree = parseCommit(repo.objects.get(baseOid)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headOid)!.data).tree;
  const baseFiles = flattenTree(repo, baseTree);
  const headFiles = flattenTree(repo, headTree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseFiles.get(path);
    const head = headFiles.get(path);
    if (base && !head) {
      const deletions = lineCounts(repo.objects.get(base.oid)!.data);
      let n = 0;
      for (const c of deletions.values()) n += c;
      changes.push({ filename: path, status: 'removed', additions: 0, deletions: n, changes: n });
    } else if (!base && head) {
      const additions = lineCounts(repo.objects.get(head.oid)!.data);
      let n = 0;
      for (const c of additions.values()) n += c;
      changes.push({ filename: path, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (base && head && base.oid !== head.oid) {
      const oldCounts = lineCounts(repo.objects.get(base.oid)!.data);
      const newCounts = lineCounts(repo.objects.get(head.oid)!.data);
      let additions = 0;
      let deletions = 0;
      for (const [line, n] of newCounts) additions += Math.max(0, n - (oldCounts.get(line) ?? 0));
      for (const [line, n] of oldCounts) deletions += Math.max(0, n - (newCounts.get(line) ?? 0));
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

/** Files changed between two commits (names only), for merge-conflict detection. */
export function changedPaths(repo: Repo, baseOid: string, headOid: string): Set<string> {
  return new Set(diffCommits(repo, baseOid, headOid).map((c) => c.filename));
}

/** Is `pull` conflicted against the base branch's current tip? */
export function pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!baseTip) return 'CONFLICTING';
  if (baseTip === pull.baseSha) return 'MERGEABLE';
  const baseChanged = changedPaths(repo, pull.baseSha, baseTip);
  const headChanged = changedPaths(repo, pull.baseSha, pull.headSha);
  for (const path of headChanged) if (baseChanged.has(path)) return 'CONFLICTING';
  return 'MERGEABLE';
}

/**
 * Squash-merge a pull request onto its base branch: the merged tree is the base tip's
 * tree with the head's changes (relative to the PR's base) applied. Returns the merge
 * commit sha, or null when the pull is conflicted.
 */
export function squashMerge(repo: Repo, pull: PullRequest): string | null {
  if (pullMergeable(repo, pull) !== 'MERGEABLE') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const files = flattenTree(repo, baseTree);
  const prBaseTree = parseCommit(repo.objects.get(pull.baseSha)!.data).tree;
  const prBaseFiles = flattenTree(repo, prBaseTree);
  const headTree = parseCommit(repo.objects.get(pull.headSha)!.data).tree;
  const headFiles = flattenTree(repo, headTree);
  const changed = new Set([...prBaseFiles.keys(), ...headFiles.keys()]);
  for (const path of changed) {
    const from = prBaseFiles.get(path);
    const to = headFiles.get(path);
    if (from?.oid === to?.oid) continue;
    if (to) files.set(path, to);
    else files.delete(path);
  }
  const treeOid = buildTreeForFiles(repo, files);
  repo.commitSeq += 1;
  const stamp = `${FIXED_EPOCH + repo.commitSeq} +0000`;
  const identity = `${VIEWER.name} <${VIEWER.email}> ${stamp}`;
  const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
  const commit = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    author: identity,
    committer: identity,
    message,
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = commitOid;
  return commitOid;
}

/** Create a pull request record (head and base must already exist as refs). */
export function createPull(
  store: Store,
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): PullRequest | { error: string } {
  const headTip = repo.refs.get(`refs/heads/${input.head}`);
  const baseTip = repo.refs.get(`refs/heads/${input.base}`);
  if (!headTip) return { error: `head branch ${input.head} does not exist` };
  if (!baseTip) return { error: `base branch ${input.base} does not exist` };
  const existing = repo.pulls.find((p) => p.headRef === input.head && p.baseRef === input.base && p.state === 'open');
  if (existing) return { error: `a pull request is already open for ${input.head}` };
  const pull: PullRequest = {
    number: repo.nextPull,
    id: '',
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    headSha: headTip,
    baseSha: baseTip,
    seq: repo.pulls.length,
  };
  pull.id = pullGlobalId(repo, pull);
  repo.nextPull += 1;
  repo.pulls.push(pull);
  void store;
  return pull;
}

/** Create an issue record (labels must already exist). */
export function createIssue(
  repo: Repo,
  input: { title: string; body: string; labels?: readonly (string | { name: string })[] },
): Issue | { error: string } {
  const labels: Label[] = [];
  for (const raw of input.labels ?? []) {
    const name = typeof raw === 'string' ? raw : raw.name;
    const label = repo.labels.get(name);
    if (!label) return { error: `label ${name} does not exist` };
    labels.push(label);
  }
  const issue: Issue = {
    number: repo.nextIssue,
    id: '',
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    seq: repo.issues.length,
    comments: [],
  };
  issue.id = issueGlobalId(repo, issue);
  repo.nextIssue += 1;
  repo.issues.push(issue);
  return issue;
}

export { ZERO_OID, collectReachable, isAncestor, peelToCommit };
