import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import type { ImportRequest, TaskState } from '../shared/import.js';

const nonPublicAddress = (address: string) => {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return nonPublicAddress(normalized.slice(7));
    return !/^[23][0-9a-f]{3}:/.test(normalized);
  }
  const [a, b] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19);
};

async function validateRemote(source: string) {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('请输入有效的 HTTPS Git URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error('远程导入只接受公开 HTTPS Git URL');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => nonPublicAddress(address))) throw new Error('远程地址必须解析到公开网络');
  const port = url.port || '443';
  return addresses.map(({ address, family }) => `${url.hostname}:${port}:${family === 6 ? `[${address}]` : address}`);
}

async function runGit(args: string[], env: NodeJS.ProcessEnv, onProgress?: (line: string) => void) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { error += chunk; onProgress?.(chunk.trim()); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `Git 退出，状态码 ${code}`)));
  });
}

export class ImportService {
  readonly events = new EventEmitter();
  readonly tasks = new Map<string, TaskState>();
  private managedRoot: string;
  private readonly browseRoot: string;
  constructor(managedRoot = path.join(homedir(), '.git-history-visualizer', 'repositories'), browseRoot = homedir()) { this.managedRoot = path.resolve(managedRoot); this.browseRoot = path.resolve(browseRoot); }
  get root() { return this.managedRoot; }
  async setRoot(next: string) {
    if (!path.isAbsolute(next)) throw new Error('受管根目录必须是绝对路径');
    await fs.mkdir(next, { recursive: true });
    this.managedRoot = await fs.realpath(next);
  }
  async browse(input = homedir()) {
    const root = await fs.realpath(this.browseRoot);
    const target = await fs.realpath(path.resolve(input));
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('目录超出允许浏览范围');
    const entries = await fs.readdir(target, { withFileTypes: true });
    const directories = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(async entry => {
      const full = path.join(target, entry.name);
      return { name: entry.name, path: full, isGitRepository: await fs.stat(path.join(full, '.git')).then(s => s.isDirectory() || s.isFile()).catch(() => false) };
    }));
    return { path: target, root, directories };
  }
  async create(request: ImportRequest) {
    let remoteResolutions: string[] = [];
    if (request.kind === 'remote') remoteResolutions = await validateRemote(request.source);
    else {
      const source = await fs.realpath(request.source);
      const root = await fs.realpath(this.browseRoot);
      if (source !== root && !source.startsWith(root + path.sep)) throw new Error('本地仓库超出允许浏览范围');
      await fs.access(path.join(source, '.git'));
      request = { ...request, source };
    }
    await fs.mkdir(this.managedRoot, { recursive: true });
    const name = path.basename(request.source.replace(/\.git\/?$/, '')) || 'repository';
    const suffix = createHash('sha256').update(`${request.kind}:${request.source}`).digest('hex').slice(0, 10);
    const destination = path.join(this.managedRoot, `${name}-${suffix}`);
    try { await fs.mkdir(destination); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('该仓库已导入，目标目录发生冲突');
      throw cause;
    }
    const task: TaskState = { id: randomUUID(), phase: 'queued', progress: 0, message: '等待克隆' };
    this.tasks.set(task.id, task); this.publish(task);
    void this.execute(task, request, destination, remoteResolutions);
    return task;
  }
  private publish(task: TaskState) { this.events.emit(task.id, { ...task }); }
  private async execute(task: TaskState, request: ImportRequest, destination: string, remoteResolutions: string[]) {
    try {
      Object.assign(task, { phase: 'cloning', progress: 5, message: '正在完整克隆仓库' }); this.publish(task);
      const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-c', 'http.followRedirects=false', 'clone', '--no-checkout', '--progress'];
      for (const resolution of remoteResolutions) args.unshift('-c', `http.curloptResolve=${resolution}`);
      if (request.kind === 'local') args.push('--no-hardlinks');
      args.push('--', request.source, destination);
      await runGit(args, { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: request.kind === 'remote' ? 'https' : 'file' }, line => {
        const match = line.match(/(\d+)%/); if (match) task.progress = Math.min(85, 5 + Number(match[1]) * .8);
        task.message = line.slice(-240) || task.message; this.publish(task);
      });
      Object.assign(task, { phase: 'indexing', progress: 90, message: '正在读取提交索引' }); this.publish(task);
      await runGit(['-C', destination, 'rev-list', '--all', '--count'], { GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' });
      Object.assign(task, { phase: 'complete', progress: 100, message: '导入完成', repositoryPath: destination }); this.publish(task);
    } catch (cause) {
      await fs.rm(destination, { recursive: true, force: true });
      Object.assign(task, { phase: 'error', message: cause instanceof Error ? cause.message : '导入失败', recoverable: true }); this.publish(task);
    }
  }
}
