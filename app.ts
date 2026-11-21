// app.ts — the forge's HTTP server: one process, one in-memory store, four surfaces
// (git smart HTTP, REST v3, GraphQL v4, MCP) plus the /healthz boot probe.
// Auth: every surface except /healthz requires Authorization: Bearer $MAKEFUN_SHOP_TOKEN.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack, type GitResponse } from './src/git-http.ts';
import { executeGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function tokenOf(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      requestCounter += 1;
      const requestId = `req-${requestCounter}`;
      const commonHeaders = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
        return;
      }
      const path = url.pathname;

      // The env's boot check calls this twice: 200 {"ok":true}, no token.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, commonHeaders);
        return;
      }

      // Auth on every other surface: a missing or wrong token is 401.
      const expected = tokenOf();
      const auth = req.headers.authorization ?? '';
      if (expected !== '' && auth !== `Bearer ${expected}`) {
        sendJson(res, 401, { message: 'Requires authentication' }, commonHeaders);
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const service = gitMatch[3]!;
        const repo = store.get(owner, repoName);
        const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        let answer: GitResponse;
        if (method === 'GET' && service === 'info/refs') {
          answer = infoRefs(repo, url.searchParams.get('service') ?? '', wantsV2);
        } else if (method === 'POST' && service === 'git-upload-pack') {
          answer = uploadPack(repo, await readBody(req), wantsV2);
        } else if (method === 'POST' && service === 'git-receive-pack') {
          answer = receivePack(repo, await readBody(req));
        } else {
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }
        sendRaw(res, answer.status, answer.contentType, answer.body, commonHeaders);
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'malformed JSON' }, commonHeaders);
          return;
        }
        if (Array.isArray(parsed)) {
          const out = parsed.map((entry) => {
            const op = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
            if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'query must be a string' }] };
            return executeGraphQL(
              store,
              op.query,
              (op.variables ?? {}) as Record<string, unknown>,
              typeof op.operationName === 'string' ? op.operationName : undefined,
            );
          });
          sendJson(res, 200, out, commonHeaders);
          return;
        }
        const op = (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
        if (typeof op.query !== 'string') {
          sendJson(res, 400, { message: 'query must be a string' }, commonHeaders);
          return;
        }
        sendJson(
          res,
          200,
          executeGraphQL(
            store,
            op.query,
            (op.variables ?? {}) as Record<string, unknown>,
            typeof op.operationName === 'string' ? op.operationName : undefined,
          ),
          commonHeaders,
        );
        return;
      }

      // MCP.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
          return;
        }
        const raw = await readBody(req);
        const reply = handleMcp(store, raw.toString('utf8'));
        if (reply.status === 202) {
          res.writeHead(202, { ...commonHeaders });
          res.end();
          return;
        }
        sendRaw(res, reply.status, JSON_TYPE, Buffer.from(reply.body, 'utf8'), commonHeaders);
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/');
        let parsedBody: unknown = undefined;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              parsedBody = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'malformed JSON' }, commonHeaders);
              return;
            }
          }
        }
        const origin = `http://${req.headers.host ?? 'entry'}`;
        const reply = handleRest(store, method, segments, url.searchParams, parsedBody, origin);
        const headers = { ...commonHeaders, ...(reply.headers ?? {}) };
        if (reply.status === 204) {
          res.writeHead(204, headers);
          res.end();
          return;
        }
        // The API root also carries the OAuth scopes header.
        if (method === 'GET' && segments.length === 0) headers['x-oauth-scopes'] = 'repo, read:org';
        sendJson(res, reply.status, reply.body, headers);
        return;
      }

      // Anything else: GitHub's JSON 404.
      sendJson(res, 404, { message: 'Not Found' }, commonHeaders);
    })().catch((err: unknown) => {
      try {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' }, {
          'x-github-request-id': `req-${requestCounter}`,
        });
      } catch {
        // The response is already gone; nothing left to do.
      }
    });
  });
}
