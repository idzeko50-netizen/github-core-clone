// git-http.ts — git smart HTTP: info/refs advertisements (v0 + protocol v2),
// v2 ls-refs / fetch, v0 fetch, and v0 receive-pack with report-status.
// All framing is pkt-line; packs are plain (no deltas) on the way out and are
// delta-resolved on the way in (see git-core.ts).

import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  parsePktLines,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktTextLines,
  readPack,
  writePack,
  type GitObject,
  type ObjectLookup,
} from './git-core.ts';
import { lookupOf, type Repo } from './store.ts';

export const AGENT = 'github-core-clone/1.0';
const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResponse(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** Every ref of a repo, sorted by name, with peeled tag targets. */
export function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  const lookup = lookupOf(repo);
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = peelToCommit(oid, lookup);
      if (target !== oid) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

function headTarget(repo: Repo): string {
  return 'refs/heads/main';
}

/** v0 advertisement body: service preamble, flush, ref lines, flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS;
  const symref = ` symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}${symref}\n`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? refs[0]!.oid;
    parts.push(pktLine(`${headOid} HEAD\0${caps}${symref}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Protocol v2 capability advertisement: `version 2` then one capability per line. */
function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), pktFlush()]);
}

export function infoRefs(
  repo: Repo | undefined,
  service: string,
  wantsV2: boolean,
): GitResponse {
  if (!repo) return textResponse(404, 'Not Found');
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  return textResponse(404, 'Not Found');
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(lines: string[]): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const line of lines) {
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsV2(repo: Repo, body: Buffer): GitResponse {
  let lines: string[];
  try {
    lines = pktTextLines(parsePktLines(body));
  } catch (err) {
    return textResponse(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const args = parseLsRefsArgs(lines);
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const headOid = repo.refs.get(headTarget(repo));
  if (keep('HEAD')) {
    if (headOid) {
      parts.push(pktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD${args.symrefs ? ` symref-target:${headTarget(repo)}` : ''}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------------------------------------
// fetch: object selection
// ---------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  args.wants = [...new Set(args.wants)];
  return args;
}

/** A commit's own contents: the commit plus its tree and blobs, never its parents. */
function collectCommitContents(lookup: ObjectLookup, oid: string, out: Set<string>): void {
  const obj = lookup(oid);
  if (!obj || obj.type !== 'commit') return;
  out.add(oid);
  const stack = [parseCommit(obj.data).tree];
  while (stack.length) {
    const treeOid = stack.pop()!;
    if (out.has(treeOid)) continue;
    const treeObj = lookup(treeOid);
    if (!treeObj || treeObj.type !== 'tree') continue;
    out.add(treeOid);
    for (const e of parseTree(treeObj.data)) {
      if (e.mode === '40000') stack.push(e.oid);
      else out.add(e.oid);
    }
  }
}

/**
 * What the client already holds: the full closure of its haves, except that a have
 * named in the request's shallow boundary is held only to its own contents — its
 * parents are exactly what a shallow clone does not have.
 */
function collectHaveClosure(lookup: ObjectLookup, haves: string[], shallow: string[]): Set<string> {
  const shallowSet = new Set(shallow);
  const out = new Set<string>();
  const stack = [...haves];
  while (stack.length) {
    const oid = stack.pop()!;
    if (out.has(oid) || !isOid(oid)) continue;
    const obj = lookup(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      collectCommitContents(lookup, oid, out);
      if (!shallowSet.has(oid)) {
        for (const p of parseCommit(obj.data).parents) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      out.add(oid);
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      out.add(oid);
      stack.push(parseTag(obj.data).object);
    } else {
      out.add(oid);
    }
  }
  return out;
}

/** The objects a fetch must send, plus the shallow boundary it reports. */
function selectFetchObjects(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; oids: string[]; shallow: string[]; unshallow: string[] } {
  const lookup = lookupOf(repo);
  const haveClosure = collectHaveClosure(lookup, args.haves, args.shallow);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const wanted = new Set<string>();

  if (args.depth === null) {
    for (const oid of collectReachable(args.wants, lookup)) wanted.add(oid);
  } else {
    // Depth-limited walk: level 0 is the wanted commits; level depth-1 is the boundary.
    const depth = Math.max(1, Math.trunc(args.depth));
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: { oid: string; level: number }[] = [];
    const seenCommits = new Set<string>();
    for (const want of args.wants) {
      const obj = repo.objects.get(want);
      if (!obj) continue;
      if (obj.type === 'tag') {
        wanted.add(want);
        const target = peelToCommit(want, lookup);
        queue.push({ oid: target, level: 0 });
      } else if (obj.type === 'commit') {
        queue.push({ oid: want, level: 0 });
      } else {
        wanted.add(want);
      }
    }
    while (queue.length) {
      const { oid, level } = queue.shift()!;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      included.add(oid);
      const commit = parseCommit(obj.data);
      if (level === depth - 1) {
        if (commit.parents.length) boundary.add(oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
      }
    }
    // The included commits' own contents only: following parents here would
    // send the whole history a depth-limited fetch must not send.
    for (const oid of included) {
      collectCommitContents(lookup, oid, wanted);
    }
    for (const oid of boundary) shallow.push(oid);
    for (const prev of args.shallow) {
      if (included.has(prev)) {
        const obj = repo.objects.get(prev);
        const parents = obj?.type === 'commit' ? parseCommit(obj.data).parents : [];
        if (parents.every((p) => included.has(p))) unshallow.push(prev);
      }
    }
  }

  const objects: GitObject[] = [];
  const oids: string[] = [];
  for (const oid of [...wanted].sort()) {
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) {
      objects.push(obj);
      oids.push(oid);
    }
  }
  return { objects, oids, shallow: [...new Set(shallow)].sort(), unshallow: [...new Set(unshallow)].sort() };
}

/**
 * A pack is a pure function of its object set (same objects, same order, same
 * bytes), and the same tip is fetched over and over — fifty concurrent shallow
 * clones of one repo all want the same pack. Cache the built pack, keyed by the
 * SHA-1 of the sorted object ids, bounded so a forge that serves many distinct
 * tips cannot grow without limit.
 */
const PACK_CACHE_MAX = 64;
const packCache = new Map<string, Buffer>();

function packFor(oids: readonly string[], objects: GitObject[]): Buffer {
  const key = createHash('sha1').update(oids.join('|'), 'utf8').digest('hex');
  const hit = packCache.get(key);
  if (hit) return hit;
  const pack = writePack(objects);
  packCache.set(key, pack);
  if (packCache.size > PACK_CACHE_MAX) {
    const oldest = packCache.keys().next().value;
    if (oldest !== undefined) packCache.delete(oldest);
  }
  return pack;
}

/** Split bytes into sideband (band 1) pkt-lines of at most 65515 payload bytes. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.subarray(i, Math.min(data.length, i + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return out;
}

function fetchV2(repo: Repo, body: Buffer): GitResponse {
  let lines: string[];
  try {
    lines = pktTextLines(parsePktLines(body));
  } catch (err) {
    return textResponse(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const args = parseFetchArgs(lines);
  const { objects, oids, shallow, unshallow } = selectFetchObjects(repo, args);
  const pack = packFor(oids, objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (shallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(repo: Repo, body: Buffer): GitResponse {
  let lines: string[];
  try {
    lines = pktTextLines(parsePktLines(body));
  } catch (err) {
    return textResponse(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const args = parseFetchArgs(lines);
  const { objects, oids, shallow, unshallow } = selectFetchObjects(repo, args);
  const pack = packFor(oids, objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

export function uploadPack(repo: Repo | undefined, body: Buffer, wantsV2: boolean): GitResponse {
  if (!repo) return textResponse(404, 'Not Found');
  let packets;
  try {
    packets = parsePktLines(body);
  } catch (err) {
    return textResponse(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  const lines = pktTextLines(packets);
  if (wantsV2) {
    if (lines[0] === 'command=ls-refs') return lsRefsV2(repo, body);
    if (lines[0] === 'command=fetch') return fetchV2(repo, body);
    return textResponse(400, `unknown upload-pack command ${JSON.stringify(lines[0] ?? '')}`);
  }
  return fetchV0(repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (!repo) return textResponse(404, 'Not Found');
  // Commands run until the first flush; the pack follows it. Parse pkt-lines
  // incrementally: the pack bytes after the flush are not pkt-lines.
  const commands: PushCommand[] = [];
  let packStart = body.length;
  let cursor = 0;
  try {
    while (cursor + 4 <= body.length) {
      const head = body.subarray(cursor, cursor + 4).toString('ascii');
      if (head === '0000') {
        packStart = cursor + 4;
        cursor = packStart;
        break;
      }
      if (head === '0001' || head === '0002') {
        cursor += 4;
        continue;
      }
      const len = parseInt(head, 16);
      if (!Number.isFinite(len) || len < 4 || cursor + len > body.length) {
        throw new Error(`bad pkt-line length ${JSON.stringify(head)} at ${cursor}`);
      }
      let text = body.subarray(cursor + 4, cursor + len).toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      const parts = text.split(' ');
      if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
        commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
      }
      cursor += len;
    }
  } catch (err) {
    return textResponse(400, `malformed pkt-line: ${(err as Error).message}`);
  }
  let unpackError: string | null = null;
  if (commands.length === 0) {
    return textResponse(400, 'receive-pack needs at least one command');
  }
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes, lookupOf(repo));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = (err as Error).message;
    }
  }
  const lookup = lookupOf(repo);
  const reportLines: string[] = [];
  if (unpackError !== null) {
    reportLines.push(`unpack ${unpackError}\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      const fail = (reason: string): void => {
        reportLines.push(`ng ${cmd.ref} ${reason}\n`);
      };
      const ok = (): void => {
        reportLines.push(`ok ${cmd.ref}\n`);
      };
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) fail('ref does not exist');
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) fail('non-fast-forward');
        else {
          repo.refs.delete(cmd.ref);
          ok();
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        fail('object not found');
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) fail('already exists');
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          ok();
        }
        continue;
      }
      if (current === undefined) {
        fail('ref does not exist');
        continue;
      }
      if (cmd.oldOid !== current) {
        fail('non-fast-forward');
        continue;
      }
      if (!isAncestor(cmd.oldOid, cmd.newOid, lookup)) {
        fail('non-fast-forward');
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      ok();
    }
  }
  const reportBytes = Buffer.concat(reportLines.map((l) => pktLine(l)));
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < reportBytes.length; i += CHUNK) {
    const chunk = reportBytes.subarray(i, Math.min(reportBytes.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

export { hashObject, parseTree };
