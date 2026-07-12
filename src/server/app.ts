import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportService } from './import-service.js';
import { HistoryService } from './history-service.js';
import { isTerminalImportPhase, type ImportPhase } from '../shared/import.js';

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const contentType = (file: string) => file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
const body = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(chunk); if (chunks.reduce((n, b) => n + b.length, 0) > 16_384) throw new Error('请求内容过大'); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

export function createApp(options: { managedRoot?: string; browseRoot?: string; configPath?: string; devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void } = {}) {
  const token = randomBytes(24).toString('base64url');
  const imports = new ImportService(options.managedRoot, options.browseRoot, options.configPath);
  const history = new HistoryService(() => imports.root);
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return json(res, 403, { error: 'Host 被拒绝' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'Origin 被拒绝' });
    if (!['GET', 'HEAD'].includes(req.method ?? '') && origin !== `http://${host}`) return json(res, 403, { error: '写请求必须来自当前应用' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    const requestController = new AbortController();
    req.once('aborted', () => requestController.abort());
    try {
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token, managedRoot: imports.root });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-session-token'] !== token) return json(res, 401, { error: '会话令牌无效' });
        if (url.pathname === '/api/repositories' && req.method === 'GET') return json(res, 200, await history.list(requestController.signal));
        const repositoryRoute = url.pathname.match(/^\/api\/repositories\/([^/]+)(?:\/(refs|commits))?$/);
        if (repositoryRoute && req.method === 'GET') {
          const id = decodeURIComponent(repositoryRoute[1]);
          const index = await history.index(id, requestController.signal);
          if (!repositoryRoute[2]) return json(res, 200, index);
          if (repositoryRoute[2] === 'refs') return json(res, 200, index.refs);
          return json(res, 200, await history.search(id, url.searchParams, requestController.signal));
        }
        const topologyRoute = url.pathname.match(/^\/api\/repositories\/([^/]+)\/topology$/);
        if (topologyRoute && req.method === 'GET') return json(res, 200, await history.topology(decodeURIComponent(topologyRoute[1]), url.searchParams.get('mainlineRef'), requestController.signal));
        const treeRoute = url.pathname.match(/^\/api\/repositories\/([^/]+)\/tree$/);
        if (treeRoute && req.method === 'GET') {
          const oid = url.searchParams.get('oid') ?? '';
          if (!/^[0-9a-f]{40,64}$/.test(oid)) return json(res, 400, { error: '树提交无效' });
          return json(res, 200, await history.tree(decodeURIComponent(treeRoute[1]), oid, url.searchParams.get('path') ?? '', requestController.signal));
        }
        const diffRoute = url.pathname.match(/^\/api\/repositories\/([^/]+)\/diff$/);
        if (diffRoute && req.method === 'GET') {
          const a = url.searchParams.get('a') ?? ''; const b = url.searchParams.get('b') ?? '';
          if (!/^[0-9a-f]{40,64}$/.test(a) || !/^[0-9a-f]{40,64}$/.test(b)) return json(res, 400, { error: '比较提交无效' });
          const parentValue = url.searchParams.get('parent');
          const parentIndex = parentValue === null ? undefined : Number(parentValue);
          if (parentIndex !== undefined && (!Number.isInteger(parentIndex) || parentIndex < 0 || parentIndex > 15)) return json(res, 400, { error: '父提交序号无效' });
          const requestedPath = url.searchParams.get('path') ?? undefined;
          if (requestedPath && (requestedPath.length > 4_096 || requestedPath.includes('\0'))) return json(res, 400, { error: '差异路径无效' });
          return json(res, 200, await history.compare(decodeURIComponent(diffRoute[1]), { a, b, parentIndex, ignoreWhitespace: url.searchParams.get('ignoreWhitespace') === 'true', contextLines: url.searchParams.get('expanded') === 'true' ? 50 : 3, requestedPath, allowReplacement: url.searchParams.get('allowReplacement') === 'true' }, requestController.signal));
        }
        const commitRoute = url.pathname.match(/^\/api\/repositories\/([^/]+)\/commits\/([0-9a-f]{40,64})$/);
        if (commitRoute && req.method === 'GET') {
          const commit = await history.commit(decodeURIComponent(commitRoute[1]), commitRoute[2], requestController.signal);
          return commit ? json(res, 200, commit) : json(res, 404, { error: '提交不存在' });
        }
        if (url.pathname === '/api/browse' && req.method === 'GET') return json(res, 200, await imports.browse(url.searchParams.get('path') ?? undefined));
        if (url.pathname === '/api/settings' && req.method === 'PUT') { const data = await body(req); await imports.setRoot(data.managedRoot); return json(res, 200, { managedRoot: imports.root }); }
        if (url.pathname === '/api/imports/preview' && req.method === 'POST') return json(res, 200, await imports.preview(await body(req)));
        if (url.pathname === '/api/imports' && req.method === 'POST') return json(res, 202, await imports.create(await body(req)));
        const match = url.pathname.match(/^\/api\/imports\/([\w-]+)$/);
        if (match && req.method === 'GET') { const task = imports.tasks.get(match[1]); return task ? json(res, 200, task) : json(res, 404, { error: '任务不存在' }); }
        if (match && req.method === 'DELETE') { const task = await imports.cancel(match[1]); return task ? json(res, 200, task) : json(res, 404, { error: '任务不存在' }); }
        const stream = url.pathname.match(/^\/api\/imports\/([\w-]+)\/events$/);
        if (stream && req.method === 'GET') {
          const task = imports.tasks.get(stream[1]); if (!task) return json(res, 404, { error: '任务不存在' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`); send(task);
          if (isTerminalImportPhase(task.phase)) { res.end(); return; }
          const listener = (state: { phase: ImportPhase }) => { send(state); if (isTerminalImportPhase(state.phase)) res.end(); };
          imports.events.on(task.id, listener); req.on('close', () => imports.events.off(task.id, listener)); return;
        }
        return json(res, 404, { error: '接口不存在' });
      }
      if (options.devMiddleware) return options.devMiddleware(req, res, () => json(res, 404, { error: '资源不存在' }));
      const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist/client');
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const asset = path.resolve(clientRoot, requested);
      if (asset !== clientRoot && !asset.startsWith(clientRoot + path.sep)) return json(res, 404, { error: '资源不存在' });
      const content = await fs.readFile(asset).catch(() => fs.readFile(path.join(clientRoot, 'index.html')));
      res.writeHead(200, { 'Content-Type': contentType(asset), 'X-Content-Type-Options': 'nosniff' }); res.end(content);
    } catch (cause) { json(res, 400, { error: cause instanceof Error ? cause.message : '请求失败' }); }
  });
  return { server, imports, history, token };
}
