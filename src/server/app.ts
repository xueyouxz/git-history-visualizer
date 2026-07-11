import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ImportService } from './import-service.js';

const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
const contentType = (file: string) => file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream';
const body = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) { chunks.push(chunk); if (chunks.reduce((n, b) => n + b.length, 0) > 16_384) throw new Error('请求内容过大'); } return JSON.parse(Buffer.concat(chunks).toString('utf8')); };

export function createApp(options: { managedRoot?: string; browseRoot?: string; devMiddleware?: (req: IncomingMessage, res: ServerResponse, next: () => void) => void } = {}) {
  const token = randomBytes(24).toString('base64url');
  const imports = new ImportService(options.managedRoot, options.browseRoot);
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) return json(res, 403, { error: 'Host 被拒绝' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'Origin 被拒绝' });
    if (!['GET', 'HEAD'].includes(req.method ?? '') && origin !== `http://${host}`) return json(res, 403, { error: '写请求必须来自当前应用' });
    const url = new URL(req.url ?? '/', `http://${host}`);
    try {
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { token, managedRoot: imports.root });
      if (url.pathname.startsWith('/api/')) {
        if (req.headers['x-session-token'] !== token) return json(res, 401, { error: '会话令牌无效' });
        if (url.pathname === '/api/browse' && req.method === 'GET') return json(res, 200, await imports.browse(url.searchParams.get('path') ?? undefined));
        if (url.pathname === '/api/settings' && req.method === 'PUT') { const data = await body(req); await imports.setRoot(data.managedRoot); return json(res, 200, { managedRoot: imports.root }); }
        if (url.pathname === '/api/imports' && req.method === 'POST') return json(res, 202, await imports.create(await body(req)));
        const match = url.pathname.match(/^\/api\/imports\/([\w-]+)$/);
        if (match && req.method === 'GET') { const task = imports.tasks.get(match[1]); return task ? json(res, 200, task) : json(res, 404, { error: '任务不存在' }); }
        const stream = url.pathname.match(/^\/api\/imports\/([\w-]+)\/events$/);
        if (stream && req.method === 'GET') {
          const task = imports.tasks.get(stream[1]); if (!task) return json(res, 404, { error: '任务不存在' });
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
          const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`); send(task);
          const listener = (state: { phase: string }) => { send(state); if (state.phase === 'complete' || state.phase === 'error') res.end(); };
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
  return { server, imports, token };
}
