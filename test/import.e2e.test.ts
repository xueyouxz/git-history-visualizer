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

  it('配置写入失败时不改变当前受管根目录', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    const initialRoot = path.join(root, 'initial'); await mkdir(initialRoot);
    const blocked = path.join(root, 'blocked'); await writeFile(blocked, 'not a directory');
    const app = createApp({ managedRoot: initialRoot, browseRoot: root, configPath: path.join(blocked, 'config.json') });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error();
    const base = `http://127.0.0.1:${address.port}`;
    const before = await fetch(`${base}/api/session`).then(response => response.json());
    const changed = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ managedRoot: path.join(root, 'next') }),
    });
    expect(changed.status).toBe(400);
    const session = await fetch(`${base}/api/session`).then(response => response.json());
    expect(session.managedRoot).toBe(before.managedRoot);
    await new Promise<void>(resolve => app.server.close(() => resolve()));
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
    const source = path.join(root, 'source'); const submodule = path.join(root, 'submodule'); const managed = path.join(root, 'managed'); await mkdir(source); await mkdir(submodule);
    await exec('git', ['init', '-b', 'main'], { cwd: source }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: source }); await exec('git', ['config', 'user.name', 'Test'], { cwd: source });
    await writeFile(path.join(source, 'README.md'), 'fixture'); await exec('git', ['add', '.'], { cwd: source }); await exec('git', ['commit', '-m', 'initial'], { cwd: source }); await exec('git', ['tag', 'v1'], { cwd: source });
    await exec('git', ['init', '-b', 'main'], { cwd: submodule }); await exec('git', ['config', 'user.email', 'test@example.com'], { cwd: submodule }); await exec('git', ['config', 'user.name', 'Test'], { cwd: submodule });
    await writeFile(path.join(submodule, 'module.txt'), 'module'); await exec('git', ['add', '.'], { cwd: submodule }); await exec('git', ['commit', '-m', 'module'], { cwd: submodule });
    await exec('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', submodule, 'dependencies/module'], { cwd: source });
    await writeFile(path.join(source, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
    await writeFile(path.join(source, 'large.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsize 1024\n');
    const withoutLfs = ['-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false'];
    await exec('git', [...withoutLfs, 'add', '.'], { cwd: source }); await exec('git', [...withoutLfs, 'commit', '-m', 'add external data declarations'], { cwd: source });
    const app = createApp({ managedRoot: managed, browseRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('服务启动失败');
    const base = `http://127.0.0.1:${address.port}`; const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    const response = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'local', source }) }); expect(response.status).toBe(202);
    const created = await response.json();
    const eventResponse = await fetch(`${base}/api/imports/${created.id}/events`, { headers });
    expect(eventResponse.headers.get('content-type')).toContain('text/event-stream');
    const states = (await eventResponse.text()).trim().split('\n\n').map(frame => JSON.parse(frame.replace(/^data: /, '')));
    const task = states.at(-1);
    expect(states.every((state, index) => index === 0 || state.progress >= states[index - 1].progress)).toBe(true);
    expect(task).toMatchObject({ phase: 'complete', progress: 100 });
    const replay = await fetch(`${base}/api/imports/${created.id}/events`, { headers, signal: AbortSignal.timeout(500) });
    expect(JSON.parse((await replay.text()).trim().replace(/^data: /, ''))).toMatchObject({ phase: 'complete', progress: 100 });
    expect(await exec('git', ['-C', task.repositoryPath, 'rev-parse', 'refs/tags/v1'])).toBeTruthy();
    await expect(stat(path.join(task.repositoryPath, 'README.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(task.repositoryPath, 'dependencies', 'module'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(task.repositoryPath, 'large.bin'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(task.repositoryPath, '.git', 'lfs', 'objects'))).rejects.toMatchObject({ code: 'ENOENT' });
    const repeated = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'local', source }) });
    expect(repeated.status).toBe(400); expect(await repeated.json()).toMatchObject({ error: '该仓库已导入，目标目录发生冲突' });
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });

  it('拒绝无令牌、恶意 Host、路径越界和非 HTTPS 远程来源', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'git-visualizer-')); cleanup.push(root);
    await writeFile(path.join(root, 'secret.txt'), 'private');
    const app = createApp({ managedRoot: path.join(root, 'managed'), browseRoot: root }); await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error(); const base = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${base}/api/browse`)).status).toBe(401);
    const hostStatus = await new Promise<number>((resolve, reject) => { const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/session', headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode ?? 0); }); req.on('error', reject); req.end(); });
    expect(hostStatus).toBe(403);
    const headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
    const browse = await fetch(`${base}/api/browse`, { headers }); expect(browse.headers.get('access-control-allow-origin')).toBeNull(); expect(await browse.text()).not.toContain('secret.txt');
    expect((await fetch(`${base}/api/browse?path=${encodeURIComponent(path.dirname(root))}`, { headers })).status).toBe(400);
    for (const source of ['ssh://example.com/repo.git', 'ext::command', 'file:///tmp/repo.git', 'https://user:secret@example.com/repo.git']) {
      const rejected = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'remote', source }) });
      expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ error: '远程导入只接受公开 HTTPS Git URL' });
    }
    for (const source of ['https://192.0.0.1/repo.git', 'https://192.0.2.1/repo.git', 'https://198.51.100.1/repo.git', 'https://203.0.113.1/repo.git', 'https://[2001:db8::1]/repo.git', 'https://[3fff::1]/repo.git']) {
      const rejected = await fetch(`${base}/api/imports`, { method: 'POST', headers, body: JSON.stringify({ kind: 'remote', source }) });
      expect(rejected.status).toBe(400); expect(await rejected.json()).toMatchObject({ error: '远程地址必须解析到公开网络' });
    }
    await new Promise<void>(resolve => app.server.close(() => resolve()));
  });
});
