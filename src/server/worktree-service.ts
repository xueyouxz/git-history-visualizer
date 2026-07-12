import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ManagedWorktree, WorktreeTarget } from '../shared/worktree.js';
import type { HistoryService } from './history-service.js';
import type { ConfigStore } from './config-store.js';

type ManifestEntry = Omit<ManagedWorktree, 'dirty' | 'status' | 'reused'>;
type Launcher = (executable: string, args: string[]) => Promise<void>;
const defaultLauncher: Launcher = (executable, args) => new Promise((resolve, reject) => { const child = spawn(executable, args, { detached: true, stdio: 'ignore' }); child.once('spawn', () => { child.unref(); resolve(); }); child.once('error', reject); });
const gitEnvironment = { GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_EXTERNAL_DIFF: '', GIT_LFS_SKIP_SMUDGE: '1', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
const runGitBuffer = (repository: string, args: string[]) => new Promise<Buffer>((resolve, reject) => {
  const child = spawn('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'diff.external=', ...args], { env: { ...process.env, ...gitEnvironment }, stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = []; const errors: Buffer[] = []; child.stdout.on('data', chunk => output.push(chunk)); child.stderr.on('data', chunk => errors.push(chunk)); child.on('error', reject); child.on('close', code => code === 0 ? resolve(Buffer.concat(output)) : reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `Git 退出，状态码 ${code}`)));
});
const runGit = async (repository: string, args: string[]) => (await runGitBuffer(repository, args)).toString('utf8').trim();

type TreeEntry = { mode: string; oid: string; relativePath: string };

async function treeEntries(repository: string, oid: string) {
  const output = await runGitBuffer(repository, ['ls-tree', '-rz', '--full-tree', oid]);
  return output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const match = record.match(/^(\d+) (?:blob|commit) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error('无法解析 Git 树对象');
    return { mode: match[1], oid: match[2], relativePath: match[3] } satisfies TreeEntry;
  });
}

function targetPath(root: string, relativePath: string) {
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('Git 树包含越界路径');
  return target;
}

async function materialize(repository: string, oid: string, root: string) {
  for (const entry of await treeEntries(repository, oid)) {
    if (entry.mode === '160000') continue;
    const target = targetPath(root, entry.relativePath); const content = await runGitBuffer(repository, ['cat-file', 'blob', entry.oid]);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (entry.mode === '120000') await fs.symlink(content.toString('utf8'), target);
    else await fs.writeFile(target, content, { mode: entry.mode === '100755' ? 0o755 : 0o644 });
  }
}

async function workingPaths(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    if (current === root && entry.name === '.git') continue;
    const absolute = path.join(current, entry.name); const relative = path.relative(root, absolute);
    if (entry.isDirectory()) result.push(...await workingPaths(root, absolute)); else result.push(relative);
  }
  return result;
}

function blobOid(content: Buffer, oidLength: number) {
  return createHash(oidLength === 64 ? 'sha256' : 'sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

async function worktreeStatus(entry: ManifestEntry) {
  const repositoryEntries = await treeEntries(entry.path, entry.oid); const tracked = new Set(repositoryEntries.filter(item => item.mode !== '160000').map(item => item.relativePath)); const changes: string[] = [];
  const expectedIndex = new Map(repositoryEntries.map(item => [item.relativePath, `${item.mode} ${item.oid}`]));
  const actualIndex = new Map<string, string>();
  for (const record of (await runGitBuffer(entry.path, ['ls-files', '--stage', '-z'])).toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^(\d+) ([0-9a-f]+) ([0-3])\t([\s\S]+)$/); if (!match) throw new Error('无法解析 Git 暂存区');
    const value = `${match[1]} ${match[2]}`; actualIndex.set(match[4], match[3] === '0' ? value : `${actualIndex.get(match[4]) ?? ''} stage-${match[3]}:${value}`.trim());
  }
  for (const relativePath of new Set([...expectedIndex.keys(), ...actualIndex.keys()])) if (expectedIndex.get(relativePath) !== actualIndex.get(relativePath)) changes.push(`S ${relativePath}`);
  for (const item of repositoryEntries) {
    const target = targetPath(entry.path, item.relativePath); const state = await fs.lstat(target).catch(() => undefined);
    if (item.mode === '160000') { if (state) changes.push(`M ${item.relativePath}`); continue; }
    if (!state) { changes.push(`D ${item.relativePath}`); continue; }
    if (item.mode === '120000') {
      const content = state.isSymbolicLink() ? Buffer.from(await fs.readlink(target)) : Buffer.alloc(0);
      if (!state.isSymbolicLink() || blobOid(content, item.oid.length) !== item.oid) changes.push(`M ${item.relativePath}`);
    } else {
      const content = state.isFile() ? await fs.readFile(target) : Buffer.alloc(0);
      if (!state.isFile() || blobOid(content, item.oid.length) !== item.oid || (item.mode === '100755') !== Boolean(state.mode & 0o111)) changes.push(`M ${item.relativePath}`);
    }
  }
  for (const relativePath of await workingPaths(entry.path)) if (!tracked.has(relativePath)) changes.push(`?? ${relativePath}`);
  return changes.sort((left, right) => left.localeCompare(right, 'en')).join('\n');
}

export class WorktreeService {
  constructor(private readonly managedRoot: () => string, private readonly history: HistoryService, private readonly config: ConfigStore, private readonly launch: Launcher = defaultLauncher) {}
  private root() { return path.join(path.resolve(this.managedRoot()), '.worktrees'); }
  private manifestPath() { return path.join(this.root(), 'manifest.json'); }
  private expectedPath(repositoryId: string, oid: string) { return path.join(this.root(), repositoryId, oid); }
  private validate(repositoryId: string, oid: string) {
    if (!/^[\p{L}\p{N}._-]+$/u.test(repositoryId) || repositoryId === '.' || repositoryId === '..') throw new Error('仓库标识无效');
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('提交对象无效');
    return this.expectedPath(repositoryId, oid);
  }
  private async manifest() {
    const entries = await fs.readFile(this.manifestPath(), 'utf8').then(value => JSON.parse(value) as ManifestEntry[]).catch(() => []);
    return entries.filter(entry => entry.path === this.expectedPath(entry.repositoryId, entry.oid) && /^[0-9a-f]{40,64}$/.test(entry.oid));
  }
  private async save(entries: ManifestEntry[]) {
    await fs.mkdir(this.root(), { recursive: true }); const file = this.manifestPath(); const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 }); await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
  }
  private async status(entry: ManifestEntry): Promise<ManagedWorktree> {
    const status = await worktreeStatus(entry);
    return { ...entry, dirty: Boolean(status), status };
  }
  async list(repositoryId: string) {
    return Promise.all((await this.manifest()).filter(entry => entry.repositoryId === repositoryId).map(entry => this.status(entry)));
  }
  async open(repositoryId: string, oid: string, target: WorktreeTarget) {
    const workspacePath = this.validate(repositoryId, oid); if (target !== 'terminal' && target !== 'editor') throw new Error('打开目标无效');
    const launcher = target === 'terminal' ? { executable: '/usr/bin/open', args: ['-a', 'Terminal', '{path}'] } : this.config.value.editor;
    if (!launcher) throw new Error('尚未配置外部编辑器');
    const index = await this.history.index(repositoryId); if (!index.commits.some(commit => commit.oid === oid)) throw new Error('提交不存在或不可达');
    const entries = await this.manifest(); let entry = entries.find(candidate => candidate.repositoryId === repositoryId && candidate.oid === oid); let reused = Boolean(entry);
    if (entry) { await fs.stat(entry.path); if ((await runGit(entry.path, ['rev-parse', 'HEAD'])) !== oid) throw new Error('工具清单中的工作区版本不一致'); }
    else {
      if (await fs.lstat(workspacePath).then(() => true).catch(() => false)) throw new Error('版本工作区路径已存在且不在工具清单中');
      await fs.mkdir(path.dirname(workspacePath), { recursive: true }); const repository = await this.history.repositoryLocation(repositoryId);
      await runGit(repository, ['worktree', 'add', '--detach', '--no-checkout', workspacePath, oid]);
      try { await runGit(workspacePath, ['read-tree', oid]); await materialize(repository, oid, workspacePath); } catch (cause) { await runGit(repository, ['worktree', 'remove', '--force', workspacePath]).catch(() => undefined); throw cause; }
      entry = { repositoryId, oid, path: workspacePath, createdAt: new Date().toISOString() };
      try { await this.save([...entries, entry]); } catch (cause) { await runGit(repository, ['worktree', 'remove', '--force', workspacePath]).catch(() => undefined); throw cause; }
    }
    try { await this.launch(launcher.executable, launcher.args.map(argument => argument === '{path}' ? workspacePath : argument)); }
    catch (cause) {
      if (!reused) {
        const repository = await this.history.repositoryLocation(repositoryId);
        try { await runGit(repository, ['worktree', 'remove', '--force', workspacePath]); await this.save(entries); }
        catch (rollbackCause) { throw new Error(`外部程序启动失败，工作区回滚失败，人工处理路径：${workspacePath}；${rollbackCause instanceof Error ? rollbackCause.message : String(rollbackCause)}`, { cause }); }
      }
      throw cause;
    }
    return { ...await this.status(entry), reused };
  }
  async remove(repositoryId: string, oid: string) {
    const workspacePath = this.validate(repositoryId, oid); const entries = await this.manifest(); const entry = entries.find(candidate => candidate.repositoryId === repositoryId && candidate.oid === oid && candidate.path === workspacePath);
    if (!entry) throw new Error('版本工作区不在工具清单中'); const state = await this.status(entry);
    if (state.dirty) throw new Error(`工作区非干净，人工处理路径：${entry.path}；状态：${state.status.replace(/\n/g, ' | ')}`);
    const repository = await this.history.repositoryLocation(repositoryId); await runGit(repository, ['worktree', 'remove', '--force', workspacePath]); await this.save(entries.filter(candidate => candidate !== entry)); return { ...state, removed: true };
  }
}
