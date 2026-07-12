import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { isTerminalImportPhase, type ImportPreview, type ImportRequest, type TaskState } from '../shared/import.js';
import { ConfigStore } from './config-store.js';

type ValidatedImport = { request: ImportRequest; remoteResolutions: string[] };
type ImportExecution = { controller: AbortController; destination: string; promise?: Promise<void> };

const nonPublicAddress = (address: string) => {
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return nonPublicAddress(normalized.slice(7));
    return !/^[23][0-9a-f]{3}:/.test(normalized) || /^2001:(?:2|1[0-9a-f]|2[0-9a-f]|db8):/.test(normalized) || normalized.startsWith('3fff:');
  }
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 100 && b >= 64 && b <= 127 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113;
};

async function validateRemote(source: string) {
  let url: URL;
  try { url = new URL(source); } catch { throw new Error('请输入有效的 HTTPS Git URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) throw new Error('远程导入只接受公开 HTTPS Git URL');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => nonPublicAddress(address))) throw new Error('远程地址必须解析到公开网络');
  const port = url.port || '443';
  return addresses.map(({ address, family }) => `${hostname}:${port}:${family === 6 ? `[${address}]` : address}`);
}

async function runGit(args: string[], env: NodeJS.ProcessEnv, onProgress?: (line: string) => void, signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('操作已取消', 'AbortError'));
    const child = spawn('git', args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { error += chunk; onProgress?.(chunk.trim()); });
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new DOMException('操作已取消', 'AbortError'));
      else if (code === 0) resolve(output.trim());
      else reject(new Error(error.trim() || `Git 退出，状态码 ${code}`));
    });
  });
}

export class ImportService {
  readonly events = new EventEmitter();
  readonly tasks = new Map<string, TaskState>();
  private managedRoot: string;
  private readonly browseRoot: string;
  private readonly config: ConfigStore;
  private readonly executions = new Map<string, ImportExecution>();
  constructor(managedRoot?: string, browseRoot = homedir(), config = new ConfigStore()) {
    this.config = config;
    this.managedRoot = path.resolve(managedRoot ?? config.value.managedRoot ?? path.join(homedir(), '.git-history-visualizer', 'repositories'));
    this.browseRoot = path.resolve(browseRoot);
  }
  get root() { return this.managedRoot; }
  async setRoot(next: string) {
    if (!path.isAbsolute(next)) throw new Error('受管根目录必须是绝对路径');
    await fs.mkdir(next, { recursive: true });
    const resolvedRoot = await fs.realpath(next);
    await this.config.update({ managedRoot: resolvedRoot });
    this.managedRoot = resolvedRoot;
  }
  async browse(input = this.browseRoot) {
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
  private async validateRequest(request: ImportRequest): Promise<ValidatedImport> {
    if (!request || !['local', 'remote'].includes(request.kind) || typeof request.source !== 'string' || !request.source) throw new Error('导入来源无效');
    if (request.kind === 'remote') return { request, remoteResolutions: await validateRemote(request.source) };
    const source = await fs.realpath(request.source);
    const root = await fs.realpath(this.browseRoot);
    if (source !== root && !source.startsWith(root + path.sep)) throw new Error('本地仓库超出允许浏览范围');
    await fs.access(path.join(source, '.git'));
    return { request: { kind: 'local', source }, remoteResolutions: [] };
  }
  async preview(request: ImportRequest): Promise<ImportPreview> {
    const validated = await this.validateRequest(request);
    if (validated.request.kind === 'remote') {
      const args = ['-c', 'http.followRedirects=false', 'ls-remote', '--symref', '--', validated.request.source, 'HEAD'];
      for (const resolution of validated.remoteResolutions) args.unshift('-c', `http.curloptResolve=${resolution}`);
      const output = await runGit(args, { GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https' });
      const defaultBranch = output.match(/^ref:\s+refs\/heads\/(.+)\s+HEAD$/m)?.[1] ?? null;
      return { ...validated.request, defaultBranch, estimatedCommitCount: null };
    }
    const source = validated.request.source;
    const defaultBranch = await runGit(['-C', source, 'symbolic-ref', '--short', 'HEAD'], { GIT_OPTIONAL_LOCKS: '0' }).catch(() => null);
    const count = await runGit(['-C', source, 'rev-list', '--all', '--count'], { GIT_OPTIONAL_LOCKS: '0' });
    return { kind: 'local', source, defaultBranch, estimatedCommitCount: Number(count) };
  }
  async create(request: ImportRequest) {
    const validated = await this.validateRequest(request);
    request = validated.request;
    await fs.mkdir(this.managedRoot, { recursive: true });
    const name = path.basename(request.source.replace(/\.git\/?$/, '')) || 'repository';
    const suffix = createHash('sha256').update(`${request.kind}:${request.source}`).digest('hex').slice(0, 10);
    const destination = path.join(this.managedRoot, `${name}-${suffix}`);
    try { await fs.mkdir(destination); } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('该仓库已导入，目标目录发生冲突');
      throw cause;
    }
    const task: TaskState = { id: randomUUID(), phase: 'queued', progress: 0, message: '等待克隆' };
    const controller = new AbortController();
    this.tasks.set(task.id, task); this.publish(task);
    const execution: ImportExecution = { controller, destination };
    this.executions.set(task.id, execution);
    setImmediate(() => {
      if (task.phase !== 'queued') return;
      execution.promise = this.execute(task, request, destination, validated.remoteResolutions, controller.signal);
      void execution.promise.then(() => this.executions.delete(task.id), () => this.executions.delete(task.id));
    });
    return task;
  }
  async cancel(id: string) {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    if (isTerminalImportPhase(task.phase)) return task;
    const execution = this.executions.get(id);
    execution?.controller.abort();
    if (execution?.promise) await execution.promise;
    else {
      if (execution) await fs.rm(execution.destination, { recursive: true, force: true });
      Object.assign(task, { phase: 'cancelled', message: '导入已取消', recoverable: true });
      this.publish(task);
      this.executions.delete(id);
    }
    return task;
  }
  private publish(task: TaskState) { this.events.emit(task.id, { ...task }); }
  private async execute(task: TaskState, request: ImportRequest, destination: string, remoteResolutions: string[], signal: AbortSignal) {
    try {
      Object.assign(task, { phase: 'cloning', progress: 5, message: '正在完整克隆仓库' }); this.publish(task);
      const args = ['-c', 'core.hooksPath=/dev/null', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false', '-c', 'http.followRedirects=false', 'clone', '--no-checkout', '--progress'];
      for (const resolution of remoteResolutions) args.unshift('-c', `http.curloptResolve=${resolution}`);
      if (request.kind === 'local') args.push('--no-hardlinks');
      args.push('--', request.source, destination);
      await runGit(args, { GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_ALLOW_PROTOCOL: request.kind === 'remote' ? 'https' : 'file' }, line => {
        const percentages = [...line.matchAll(/(\d+)%/g)].map(match => Number(match[1]));
        if (percentages.length) task.progress = Math.max(task.progress, Math.min(85, 5 + Math.max(...percentages) * .8));
        task.message = line.slice(-240) || task.message; this.publish(task);
      }, signal);
      Object.assign(task, { phase: 'indexing', progress: 90, message: '正在读取提交索引' }); this.publish(task);
      await runGit(['-C', destination, 'rev-list', '--all', '--count'], { GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', GIT_CONFIG_NOSYSTEM: '1' }, undefined, signal);
      Object.assign(task, { phase: 'complete', progress: 100, message: '导入完成', repositoryPath: destination }); this.publish(task);
    } catch (cause) {
      await fs.rm(destination, { recursive: true, force: true });
      if (signal.aborted) Object.assign(task, { phase: 'cancelled', message: '导入已取消', recoverable: true });
      else Object.assign(task, { phase: 'error', message: cause instanceof Error ? cause.message : '导入失败', recoverable: true });
      this.publish(task);
    }
  }
}
