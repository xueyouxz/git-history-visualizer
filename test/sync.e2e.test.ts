import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/server/app.js';

const exec = promisify(execFile);
let root: string; let seed: string; let remote: string; let repository: string;
let application: ReturnType<typeof createApp>; let base: string; let headers: Record<string, string>;

async function commit(message: string) {
  await exec('git', ['add', '.'], { cwd: seed });
  await exec('git', ['-c', 'user.name=Sync Tester', '-c', 'user.email=sync@example.com', 'commit', '-m', message], { cwd: seed });
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: seed })).stdout.trim();
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'git-sync-')); remote = path.join(root, 'remote.git'); seed = path.join(root, 'seed');
  const managedRoot = path.join(root, 'managed'); repository = path.join(managedRoot, 'sync-fixture');
  await exec('git', ['init', '--bare', remote]); await mkdir(seed); await exec('git', ['init', '-b', 'main'], { cwd: seed });
  await writeFile(path.join(seed, 'README.md'), 'initial\n'); const initial = await commit('initial');
  await exec('git', ['branch', 'obsolete', initial], { cwd: seed }); await exec('git', ['tag', 'old-tag', initial], { cwd: seed });
  await exec('git', ['remote', 'add', 'origin', remote], { cwd: seed }); await exec('git', ['push', '--all', 'origin'], { cwd: seed }); await exec('git', ['push', '--tags', 'origin'], { cwd: seed });
  await mkdir(managedRoot); await exec('git', ['clone', '--no-checkout', remote, repository]);
  application = createApp({ managedRoot, browseRoot: root }); await new Promise<void>(resolve => application.server.listen(0, '127.0.0.1', resolve));
  const address = application.server.address(); if (!address || typeof address === 'string') throw new Error('服务启动失败');
  base = `http://127.0.0.1:${address.port}`; headers = { 'X-Session-Token': application.token, Origin: base };
}, 15_000);

afterAll(async () => { await new Promise<void>(resolve => application.server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });

describe('仓库同步 REST 与 SSE', () => {
  it('显式同步新增对象和 tags，清理远程 refs，并支持重复同步', async () => {
    const before = await fetch(`${base}/api/repositories/sync-fixture`, { headers }).then(response => response.json());
    expect(before.commits).toHaveLength(1);
    expect(before.refs.map((ref: { name: string }) => ref.name)).toContain('refs/remotes/origin/obsolete');
    expect(before.refs.map((ref: { name: string }) => ref.name)).toContain('refs/tags/old-tag');

    await writeFile(path.join(seed, 'README.md'), 'initial\nnext\n'); const next = await commit('next'); await exec('git', ['tag', 'new-tag', next], { cwd: seed });
    await exec('git', ['push', 'origin', 'main'], { cwd: seed }); await exec('git', ['push', 'origin', 'new-tag'], { cwd: seed });
    await exec('git', ['push', 'origin', '--delete', 'obsolete'], { cwd: seed }); await exec('git', ['push', 'origin', '--delete', 'old-tag'], { cwd: seed });

    const create = await fetch(`${base}/api/repositories/sync-fixture/syncs`, { method: 'POST', headers });
    expect(create.status).toBe(202); const task = await create.json();
    const stream = await fetch(`${base}/api/repositories/sync-fixture/syncs/${task.id}/events`, { headers });
    expect(stream.status).toBe(200); const events = await stream.text();
    expect(events).toContain('"phase":"fetching"'); expect(events).toContain('"phase":"indexing"'); expect(events).toContain('"phase":"complete"');

    const after = await fetch(`${base}/api/repositories/sync-fixture`, { headers }).then(response => response.json());
    expect(after.commits.map((entry: { oid: string }) => entry.oid)).toContain(next);
    expect(after.refs.map((ref: { name: string }) => ref.name)).toContain('refs/tags/new-tag');
    expect(after.refs.map((ref: { name: string }) => ref.name)).not.toContain('refs/tags/old-tag');
    expect(after.refs.map((ref: { name: string }) => ref.name)).not.toContain('refs/remotes/origin/obsolete');
    expect(task.id).toBeTruthy();

    const repeated = await fetch(`${base}/api/repositories/sync-fixture/syncs`, { method: 'POST', headers }).then(response => response.json());
    const repeatedState = await fetch(`${base}/api/repositories/sync-fixture/syncs/${repeated.id}/events`, { headers }).then(response => response.text());
    expect(repeatedState).toContain('"phase":"complete"');
    const finalTask = await fetch(`${base}/api/repositories/sync-fixture/syncs/${repeated.id}`, { headers }).then(response => response.json());
    expect(finalTask).toMatchObject({ phase: 'complete', newCommits: 0 });
  }, 15_000);
});
