import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/server/app.js';

const exec = promisify(execFile);
const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('完整本地应用导入', () => {
  it('通过公开 API 完整克隆临时真实 Git 仓库且不 checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const source = path.join(root, 'source'); const managed = path.join(root, 'managed'); await mkdir(source);
    await exec('git', ['init', '-b', 'main'], { cwd: source }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: source }); await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(path.join(source, 'README.md'), 'fixture'); await exec('git', ['add', '.'], { cwd: source }); await exec('git', ['commit', '-m', 'initial'], { cwd: source }); await exec('git', ['tag', 'v1'], { cwd: source });
    const app = createApp({ managedRoot: managed }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('服务启动失败');
    const base = `http://127.0.0.1:${address.port}`; const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'local', source }) }); expect(response.status).toBe(202);
    let task = await response.json(); for (let i = 0; i < 100 && !['complete', 'error'].includes(task.phase); i++) { await new Promise(r => setTimeout(r, 25)); task = await fetch(`${base}/api/imports/${task.id}`, { headers }).then(r => r.json()); }
    expect(task).toMatchObject({ phase: 'complete', progress: 100 });
    expect(await exec('git', ['-C', task.repositoryPath, 'rev-parse', 'refs/tags/v1'])).toBeTruthy();
    await expect(stat(path.join(task.repositoryPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });

  it('拒绝无令牌、恶意 Host、路径越界和非 HTTPS 远程来源', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const app = createApp({ managedRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error(); const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/browse`)).status).toBe(401);
    const hostStatus = await new Promise<number>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/session', headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode ?? 0); }); req.on('error', reject); req.end(); });
    expect(hostStatus).toBe(403);
    const headers = { 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/api/browse?path=${encodeURIComponent(tmpdir())}`, { headers })).status).toBe(400);
    const rejected = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'remote', source: 'ssh://example.com/repo.git' }) });
    expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ error: '远程导入只接受公开 HTTPS Git URL' });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
});
