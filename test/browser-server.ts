import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createApp } from '../src/server/app.js';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'git-history-browser-'));
const managedRoot = path.join(root, 'managed');
const repository = path.join(managedRoot, 'fixture');
await mkdir(repository, { recursive: true });
await exec('git', ['init', '-b', 'main'], { cwd: repository });

async function commit(message: string, name: string) {
  await exec('git', ['add', '.'], { cwd: repository });
  await exec('git', ['-c', `user.name=${name}`, '-c', `user.email=${name.toLowerCase()}@example.com`, 'commit', '-m', message], { cwd: repository });
  return (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
}

await writeFile(path.join(repository, 'README.md'), 'initial\n');
const initial = await commit('initial', 'Alice');
await exec('git', ['checkout', '-b', 'feature'], { cwd: repository });
await writeFile(path.join(repository, '含 空格.md'), Array.from({ length: 12 }, (_, index) => `内容 ${index + 1}`).join('\n') + '\n');
await writeFile(path.join(repository, '.mailmap'), 'Bob <bob@example.com> Robert <robert@example.com>\n');
const feature = await commit('add unicode guide', 'Robert');
await exec('git', ['tag', 'v1-feature', feature], { cwd: repository });
await exec('git', ['checkout', 'main'], { cwd: repository });
await writeFile(path.join(repository, 'README.md'), 'initial\nmain\n');
await commit('update main', 'Alice');
await exec('git', ['-c', 'user.name=Merge Bot', '-c', 'user.email=merge@example.com', 'merge', '--no-ff', 'feature', '-m', 'merge feature'], { cwd: repository });
const merge = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repository })).stdout.trim();
await exec('git', ['update-ref', 'refs/remotes/origin/feature', feature], { cwd: repository });
await exec('git', ['update-ref', 'refs/remotes/origin/main', merge], { cwd: repository });
await exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: repository });
await exec('git', ['update-ref', 'refs/bisect/good', initial], { cwd: repository });

const { server } = createApp({ managedRoot, browseRoot: root, configPath: path.join(root, 'config.json') });
server.listen(4193, '127.0.0.1');

const close = () => {
  server.close(() => { void rm(root, { recursive: true, force: true }).finally(() => process.exit(0)); });
};
process.once('SIGINT', close);
process.once('SIGTERM', close);
