import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/server/app.js';

const exec = promisify(execFile);
let root: string; let managedRoot: string; let repository: string; let first: string; let second: string;
let smudgeMarker: string; let hookMarker: string;
let app: ReturnType<typeof createApp>; let base: string; let headers: Record<string, string>; const launches: Array<{ executable: string; args: string[] }> = []; let launchError = false;

async function commit(message: string) {
  await exec('git', ['add', '.'], { cwd: repository }); await exec('git', ['-c', 'user.name=Worktree Tester', '-c', 'user.email=worktree@example.com', 'commit', '-m', message], { cwd: repository });
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-worktree-')); managedRoot = path.join(root, 'managed'); repository = path.join(managedRoot, 'fixture'); await mkdir(repository, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: repository }); await writeFile(path.join(repository, '.gitignore'), 'ignored.tmp\n'); await writeFile(path.join(repository, '.gitattributes'), 'filtered.txt filter=evil\n'); await writeFile(path.join(repository, 'filtered.txt'), 'raw\n'); await writeFile(path.join(repository, 'README.md'), 'first\n'); first = await commit('first');
  await writeFile(path.join(repository, 'README.md'), 'second\n'); second = await commit('second');
  smudgeMarker = path.join(root, 'smudge-ran'); hookMarker = path.join(root, 'hook-ran'); await exec('git', ['config', 'filter.evil.smudge', `/bin/sh -c 'touch ${smudgeMarker}; cat'`], { cwd: repository }); await exec('git', ['config', 'filter.evil.required', 'true'], { cwd: repository });
  const hook = path.join(repository, '.git', 'hooks', 'post-checkout'); await writeFile(hook, `#!/bin/sh\ntouch ${hookMarker}\n`); await chmod(hook, 0o755);
  app = createApp({ managedRoot, browseRoot: root, configPath: path.join(root, 'config.json'), launchExternal: async (executable, args) => { if (launchError) throw new Error('启动失败'); launches.push({ executable, args }); } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('服务启动失败');
  base = `http://127.0.0.1:${address.port}`; headers = { Origin: base, 'X-Session-Token': app.token, 'Content-Type': 'application/json' };
}, 15_000);
afterAll(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

describe('历史版本工作区 REST', () => {
  it('显式创建 detached worktree，重复打开复用且只列出工具清单', async () => {
    expect(await fetch(`${base}/api/repositories/fixture/worktrees`, { headers }).then(response => response.json())).toEqual([]);
    const opened = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: first, target: 'terminal' }) });
    expect(opened.status, JSON.stringify(await opened.clone().json())).toBe(201); const workspace = await opened.json();
    expect(workspace).toMatchObject({ repositoryId: 'fixture', oid: first, reused: false, dirty: false });
    expect(workspace.path).toBe(path.join(managedRoot, '.worktrees', 'fixture', first));
    await expect(exec('git', ['-C', workspace.path, 'symbolic-ref', '-q', 'HEAD'])).rejects.toMatchObject({ code: 1 });
    expect((await exec('git', ['-C', workspace.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(first);
    await expect(stat(smudgeMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(hookMarker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fetch(`${base}/.worktrees/fixture/${first}/README.md`).then(response => response.text())).not.toBe('first\n');
    expect(launches.at(-1)).toEqual({ executable: '/usr/bin/open', args: ['-a', 'Terminal', workspace.path] });

    const repeated = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: first, target: 'terminal' }) }).then(response => response.json());
    expect(repeated).toMatchObject({ path: workspace.path, reused: true });
    expect(await fetch(`${base}/api/repositories/fixture/worktrees`, { headers }).then(response => response.json())).toHaveLength(1);

    const external = path.join(root, 'external-worktree'); await exec('git', ['worktree', 'add', '--detach', external, second], { cwd: repository });
    expect(await fetch(`${base}/api/repositories/fixture/worktrees`, { headers }).then(response => response.json())).toHaveLength(1);
    await exec('git', ['worktree', 'remove', '--force', external], { cwd: repository });
  }, 15_000);

  it('拒绝路径冲突和无效对象，不覆盖已有目录', async () => {
    const conflict = path.join(managedRoot, '.worktrees', 'fixture', second); await mkdir(conflict, { recursive: true }); await writeFile(path.join(conflict, 'keep.txt'), 'keep');
    const response = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: second, target: 'terminal' }) });
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ error: '版本工作区路径已存在且不在工具清单中' }); await stat(path.join(conflict, 'keep.txt'));
    const escaped = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: '../../escape', target: 'terminal' }) });
    expect(escaped.status).toBe(400); await rm(conflict, { recursive: true, force: true });
  });

  it('tracked、untracked 或 ignored 变化均阻止删除，清理后允许删除', async () => {
    const [workspace] = await fetch(`${base}/api/repositories/fixture/worktrees`, { headers }).then(response => response.json());
    const removeWorkspace = () => fetch(`${base}/api/repositories/fixture/worktrees/${first}`, { method: 'DELETE', headers });
    await writeFile(path.join(workspace.path, 'README.md'), 'modified\n'); expect((await removeWorkspace()).status).toBe(400); await exec('git', ['restore', 'README.md'], { cwd: workspace.path });
    await exec('git', ['rm', '--cached', 'README.md'], { cwd: workspace.path }); expect((await removeWorkspace()).status).toBe(400); await exec('git', ['read-tree', first], { cwd: workspace.path });
    await writeFile(path.join(workspace.path, 'untracked.txt'), 'new\n'); expect((await removeWorkspace()).status).toBe(400); await unlink(path.join(workspace.path, 'untracked.txt'));
    await writeFile(path.join(workspace.path, 'ignored.tmp'), 'ignored\n'); const ignored = await removeWorkspace(); expect(ignored.status).toBe(400); expect(await ignored.json()).toMatchObject({ error: expect.stringContaining(workspace.path) }); await unlink(path.join(workspace.path, 'ignored.tmp'));
    const removed = await removeWorkspace(); expect(removed.status).toBe(200); await expect(stat(workspace.path)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('编辑器配置使用绝对可执行文件和参数数组中的 path 占位符', async () => {
    const configured = await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ editor: { executable: '/usr/bin/code', args: ['--reuse-window', '{path}'] } }) });
    expect(configured.status).toBe(200);
    const opened = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: first, target: 'editor' }) }).then(response => response.json());
    expect(launches.at(-1)).toEqual({ executable: '/usr/bin/code', args: ['--reuse-window', opened.path] });
    const rejected = await fetch(`${base}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ editor: { executable: 'code', args: ['{path}'] } }) });
    expect(rejected.status).toBe(400);
  }, 15_000);

  it('外部程序启动失败时回滚新建工作区', async () => {
    const workspacePath = path.join(managedRoot, '.worktrees', 'fixture', second); launchError = true;
    const response = await fetch(`${base}/api/repositories/fixture/worktrees`, { method: 'POST', headers, body: JSON.stringify({ oid: second, target: 'terminal' }) });
    launchError = false; expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: '启动失败' });
    expect(await fetch(`${base}/api/repositories/fixture/worktrees`, { headers }).then(result => result.json())).not.toEqual(expect.arrayContaining([expect.objectContaining({ oid: second })]));
    await expect(stat(workspacePath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
});
