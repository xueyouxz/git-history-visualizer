import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
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
  it('在导入前返回规范化来源、默认分支和提交数量', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const source = path.join(root, 'source'); await mkdir(source);
    await exec('git', ['init', '-b', 'main'], { cwd: source });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(path.join(source, 'README.md'), 'fixture');
    await exec('git', ['add', '.'], { cwd: source });
    await exec('git', ['commit', '-m', 'initial'], { cwd: source });
    const app = createApp({ managedRoot: path.join(root, 'managed'), browseRoot: root });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${base}/api/imports/preview`, {
      method: 'POST',
      headers: { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'local', source }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ kind: 'local', source: await realpath(source), defaultBranch: 'main', estimatedCommitCount: 1 });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });

  it('重启应用后保留后续导入使用的受管根目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const configPath = path.join(root, 'config.json');
    const initialRoot = path.join(root, 'initial');
    const nextRoot = path.join(root, 'next');
    const first = createApp({ managedRoot: initialRoot, browseRoot: root, configPath });
    await new Promise<void>(resolve => first.server.listen(0, '127.0.0.1', resolve));
    const firstAddress = first.server.address(); if (!firstAddress || typeof firstAddress === 'string') throw new Error();
    const firstBase = `http://127.0.0.1:${firstAddress.port}`;
    const changed = await fetch(`${firstBase}/api/settings`, {
      method: 'PUT',
      headers: { Origin: firstBase, 'X-Session-Token': first.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedRoot: nextRoot }),
    });
    expect(changed.status).toBe(200);
    await new Promise<void>(resolve => first.server.close(() => resolve()));

    const second = createApp({ browseRoot: root, configPath });
    await new Promise<void>(resolve => second.server.listen(0, '127.0.0.1', resolve));
    const secondAddress = second.server.address(); if (!secondAddress || typeof secondAddress === 'string') throw new Error();
    const session = await fetch(`http://127.0.0.1:${secondAddress.port}/api/session`).then(response => response.json());
    expect(session.managedRoot).toBe(await realpath(nextRoot));
    await new Promise<void>(resolve => second.server.close(() => resolve()));
  });

  it('可以取消排队中的导入并清理未完成目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const source = path.join(root, 'source'); const managed = path.join(root, 'managed'); await mkdir(source);
    await exec('git', ['init', '-b', 'main'], { cwd: source });
    await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: source });
    await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(path.join(source, 'README.md'), 'fixture'); await exec('git', ['add', '.'], { cwd: source }); await exec('git', ['commit', '-m', 'initial'], { cwd: source });
    const app = createApp({ managedRoot: managed, browseRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error();
    const base = `http://127.0.0.1:${address.port}`; const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    const created = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'local', source }) }).then(response => response.json());
    const cancelled = await fetch(`${base}/api/imports/${created.id}`, { method: 'DELETE', headers });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ id: created.id, phase: 'cancelled', recoverable: true });
    expect(await readdir(managed)).toEqual([]);
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });

  it('通过公开 API 完整克隆临时真实 Git 仓库且不 checkout', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const source = path.join(root, 'source'); const managed = path.join(root, 'managed'); await mkdir(source);
    await exec('git', ['init', '-b', 'main'], { cwd: source }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: source }); await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(path.join(source, 'README.md'), 'fixture'); await exec('git', ['add', '.'], { cwd: source }); await exec('git', ['commit', '-m', 'initial'], { cwd: source }); await exec('git', ['tag', 'v1'], { cwd: source });
    const app = createApp({ managedRoot: managed, browseRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('服务启动失败');
    const base = `http://127.0.0.1:${address.port}`; const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'local', source }) }); expect(response.status).toBe(202);
    const created = await response.json();
    const eventResponse = await fetch(`${base}/api/imports/${created.id}/events`, { headers });
    expect(eventResponse.headers.get('content-type')).toContain('text/event-stream');
    const states = (await eventResponse.text()).trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const task = states.at(-1);
    expect(task).toMatchObject({ phase: 'complete', progress: 100 });
    const replay = await fetch(`${base}/api/imports/${created.id}/events`, { headers, signal: AbortSignal.timeout(500) });
    expect(JSON.parse((await replay.text()).trim().replace(/^data: /, ''))).toMatchObject({ phase: 'complete', progress: 100 });
    expect(await exec('git', ['-C', task.repositoryPath, 'rev-parse', 'refs/tags/v1'])).toBeTruthy();
    await expect(stat(path.join(task.repositoryPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });

  it('拒绝无令牌、恶意 Host、路径越界和非 HTTPS 远程来源', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const app = createApp({ managedRoot: path.join(root, 'managed'), browseRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error(); const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/browse`)).status).toBe(401);
    const hostStatus = await new Promise<number>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/session', headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode ?? 0); }); req.on('error', reject); req.end(); });
    expect(hostStatus).toBe(403);
    const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    expect((await fetch(`${base}/api/browse?path=${encodeURIComponent(path.dirname(root))}`, { headers })).status).toBe(400);
    const rejected = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'remote', source: 'ssh://example.com/repo.git' }) });
    expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ error: '远程导入只接受公开 HTTPS Git URL' });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
});
