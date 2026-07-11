import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../src/server/app.js';

const exec = promisify(execFile);
const cleanup: string[] = [];

async function commit(repository: string, message: string, name: string) {
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['-c', `user.name=${name}`, '-c', `user.email=${name.toLowerCase()}@example.com`, 'commit', '-m', message], { cwd: repository });
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
}

async function createHistoryFixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'git-history-'));
  cleanup.push(root);
  const managedRoot = path.join(root, 'managed');
  const repository = path.join(managedRoot, 'fixture');
  await mkdir(repository, { recursive: true });
  await exec('git', ['init', '-b', 'main'], { cwd: repository });

  await writeFile(path.join(repository, 'README.md'), 'initial\n');
  await writeFile(path.join(repository, 'old name.txt'), 'rename me\n');
  await writeFile(path.join(repository, 'delete-me.txt'), 'delete me\n');
  await writeFile(path.join(repository, 'whitespace.txt'), 'value\n');
  const initial = await commit(repository, 'initial', 'Alice');
  await exec('git', ['checkout', '-b', 'feature'], { cwd: repository });
  await mkdir(path.join(repository, 'docs'));
  await writeFile(path.join(repository, 'docs', '含 空格.md'), Array.from({ length: 12 }, (_, index) => `内容 ${index + 1}`).join('\n') + '\n');
  await rename(path.join(repository, 'old name.txt'), path.join(repository, 'renamed.txt'));
  await unlink(path.join(repository, 'delete-me.txt'));
  await writeFile(path.join(repository, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(repository, 'unknown.txt'), Buffer.from([0x66, 0x6f, 0x80, 0x0a]));
  await writeFile(path.join(repository, 'whitespace.txt'), 'value    \n\n');
  await writeFile(path.join(repository, '.mailmap'), 'Bob <bob@example.com> Robert <robert@example.com>\n');
  const feature = await commit(repository, 'add unicode guide', 'Robert');
  await exec('git', ['tag', 'v1-feature', feature], { cwd: repository });

  await exec('git', ['checkout', 'main'], { cwd: repository });
  await writeFile(path.join(repository, 'README.md'), 'initial\nmain line\n');
  const main = await commit(repository, 'update main line', 'Alice');
  await exec('git', ['-c', 'user.name=Merge Bot', '-c', 'user.email=merge@example.com', 'merge', '--no-ff', 'feature', '-m', 'merge feature'], { cwd: repository });
  const merge = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();

  await exec('git', ['update-ref', 'refs/remotes/origin/feature', feature], { cwd: repository });
  await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repository });
  await exec('git', ['update-ref', 'refs/remotes/origin/main', merge], { cwd: repository });
  await exec('git', ['update-ref', 'refs/stash', feature], { cwd: repository });
  await exec('git', ['update-ref', 'refs/bisect/good', initial], { cwd: repository });

  return { managedRoot, repository, oids: { initial, feature, main, merge } };
}

async function startApp(managedRoot: string) {
  const app = createApp({ managedRoot, browseRoot: managedRoot });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('服务启动失败');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-Session-Token': app.token };
  return { app, base, headers };
}

let sharedFixture: Awaited<ReturnType<typeof createHistoryFixture>>;
let sharedApp: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => { sharedFixture = await createHistoryFixture(); sharedApp = await startApp(sharedFixture.managedRoot); });
afterAll(async () => {
  await new Promise<void>(resolve => sharedApp.app.server.close(() => resolve()));
  await Promise.all(cleanup.splice(0).map(target => rm(target, { recursive: true, force: true })));
});

describe('提交历史 REST 接口', () => {
  it('索引真实可达提交、公开 refs、作者、路径和变更统计', async () => {
    const fixture = sharedFixture;
    const { base, headers } = sharedApp;

    const repositoriesResponse = await fetch(`${base}/api/repositories`, { headers });
    expect(repositoriesResponse.status).toBe(200);
    const repositories = await repositoriesResponse.json();
    expect(repositories).toEqual([{ id: 'fixture', name: 'fixture', defaultRef: 'refs/heads/main', commitCount: 4 }]);

    const refsResponse = await fetch(`${base}/api/repositories/fixture/refs`, { headers });
    expect(refsResponse.status).toBe(200);
    const refs = await refsResponse.json();
    expect(refs.map((ref: { name: string }) => ref.name)).toEqual([
      'refs/heads/feature',
      'refs/heads/main',
      'refs/remotes/origin/feature',
      'refs/remotes/origin/main',
      'refs/tags/v1-feature',
    ]);
    expect(refs.some((ref: { name: string }) => ref.name.includes('/HEAD') || ref.name.startsWith('refs/stash') || ref.name.startsWith('refs/bisect/'))).toBe(false);

    const commitsResponse = await fetch(`${base}/api/repositories/fixture/commits`, { headers });
    expect(commitsResponse.status).toBe(200);
    const commits = await commitsResponse.json();
    expect(commits).toHaveLength(4);
    expect(commits.every((entry: { oid: string }) => /^[0-9a-f]{40,64}$/.test(entry.oid))).toBe(true);
    expect(commits.find((entry: { oid: string }) => entry.oid === fixture.oids.merge).parents).toEqual([fixture.oids.main, fixture.oids.feature]);
    expect(commits.find((entry: { oid: string }) => entry.oid === fixture.oids.feature)).toMatchObject({
      author: 'Bob',
      subject: 'add unicode guide',
      additions: 17,
      deletions: 3,
      filesChanged: 8,
    });
    expect(commits.find((entry: { oid: string }) => entry.oid === fixture.oids.feature).paths).toEqual([
      '.mailmap',
      'binary.dat',
      'delete-me.txt',
      'docs/含 空格.md',
      'old name.txt',
      'renamed.txt',
      'unknown.txt',
      'whitespace.txt',
    ]);

  }, 15_000);

  it('比较同祖先链和分叉历史，并解析重命名、删除、二进制与未知编码', async () => {
    const fixture = sharedFixture;
    const { base, headers } = sharedApp;
    const compare = async (a: string, b: string, suffix = '') => {
      const response = await fetch(`${base}/api/repositories/fixture/diff?a=${a}&b=${b}${suffix}`, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };

    const linear = await compare(fixture.oids.initial, fixture.oids.feature);
    expect(linear).toMatchObject({ relation: 'a-ancestor-of-b', commonAncestor: fixture.oids.initial });
    expect(linear.pathA).toEqual([]);
    expect(linear.pathB).toEqual([fixture.oids.feature]);
    expect(linear.files.find((file: { path: string }) => file.path === 'renamed.txt')).toMatchObject({
      status: 'renamed', oldPath: 'old name.txt', similarity: 100, inferred: true,
    });
    expect(linear.files.find((file: { path: string }) => file.path === 'delete-me.txt')).toMatchObject({ status: 'deleted' });
    expect(linear.files.find((file: { path: string }) => file.path === 'binary.dat')).toMatchObject({ binary: true, patch: '' });
    expect(linear.files.find((file: { path: string }) => file.path === 'unknown.txt')).toMatchObject({ unknownEncoding: true, patch: '' });

    const diverged = await compare(fixture.oids.main, fixture.oids.feature);
    expect(diverged).toMatchObject({ relation: 'diverged', commonAncestor: fixture.oids.initial });
    expect(diverged.pathA).toEqual([fixture.oids.main]);
    expect(diverged.pathB).toEqual([fixture.oids.feature]);

    const mergeDefault = await compare(fixture.oids.initial, fixture.oids.merge, '&parent=0');
    expect(mergeDefault.effectiveA).toBe(fixture.oids.main);
    const mergeOtherParent = await compare(fixture.oids.initial, fixture.oids.merge, '&parent=1');
    expect(mergeOtherParent.effectiveA).toBe(fixture.oids.feature);
  }, 15_000);

  it('忽略空白时排除仅空白差异', async () => {
    const fixture = sharedFixture;
    const { base, headers } = sharedApp;
    const normal = await fetch(`${base}/api/repositories/fixture/diff?a=${fixture.oids.initial}&b=${fixture.oids.feature}`, { headers }).then(response => response.json());
    const ignored = await fetch(`${base}/api/repositories/fixture/diff?a=${fixture.oids.initial}&b=${fixture.oids.feature}&ignoreWhitespace=true`, { headers }).then(response => response.json());
    expect(normal.files.some((file: { path: string }) => file.path === 'whitespace.txt')).toBe(true);
    expect(ignored.files.some((file: { path: string }) => file.path === 'whitespace.txt')).toBe(false);
  }, 15_000);

  it('搜索提交并按作者和 ref 筛选', async () => {
    const fixture = sharedFixture;
    const { base, headers } = sharedApp;

    const search = async (parameters: string) => {
      const response = await fetch(`${base}/api/repositories/fixture/commits?${parameters}`, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    expect((await search('query=unicode')).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.feature]);
    expect((await search(`query=${fixture.oids.main.slice(0, 12)}`)).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.main]);
    expect((await search(`query=${encodeURIComponent('含 空格.md')}`)).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.merge, fixture.oids.feature]);
    expect((await search('author=Alice')).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.main, fixture.oids.initial]);
    expect((await search(`ref=${encodeURIComponent('refs/heads/feature')}`)).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.feature, fixture.oids.initial]);
    expect((await search('changeSize=medium')).map((commit: { oid: string }) => commit.oid)).toEqual([fixture.oids.merge, fixture.oids.feature]);

    const detailResponse = await fetch(`${base}/api/repositories/fixture/commits/${fixture.oids.merge}`, { headers });
    expect(detailResponse.status).toBe(200);
    expect(await detailResponse.json()).toMatchObject({ oid: fixture.oids.merge, parents: [fixture.oids.main, fixture.oids.feature], subject: 'merge feature' });

  }, 15_000);

  it('返回确定性拓扑，并将所选 ref 的 first-parent 放在主线轨道', async () => {
    const fixture = sharedFixture;
    const { base, headers } = sharedApp;

    const readTopology = async (mainlineRef = '') => {
      const suffix = mainlineRef ? `?mainlineRef=${encodeURIComponent(mainlineRef)}` : '';
      const response = await fetch(`${base}/api/repositories/fixture/topology${suffix}`, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await readTopology();
    expect(await readTopology()).toEqual(first);
    expect(first.mainlineRef).toBe('refs/heads/main');
    expect(first.nodes.filter((node: { lane: number }) => node.lane === 0).map((node: { oid: string }) => node.oid)).toEqual([
      fixture.oids.merge,
      fixture.oids.main,
      fixture.oids.initial,
    ]);
    expect(first.nodes.map((node: { oid: string }) => node.oid)).toHaveLength(4);

    const featureMainline = await readTopology('refs/tags/v1-feature');
    expect(featureMainline.nodes.filter((node: { lane: number }) => node.lane === 0).map((node: { oid: string }) => node.oid)).toEqual([
      fixture.oids.feature,
      fixture.oids.initial,
    ]);

  }, 15_000);
});
