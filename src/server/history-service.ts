import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  REPOSITORY_INDEX_VERSION,
  CHANGE_SIZE_LIMITS,
  type IndexedCommit,
  type RepositoryIndex,
  type RepositoryRef,
  type RepositorySummary,
  type RepositoryTopology,
} from '../shared/history.js';

const gitEnvironment = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

function runGit(repository: string, args: string[], signal?: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('操作已取消', 'AbortError'));
    const child = spawn('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'mailmap.blob=HEAD:.mailmap', ...args], {
      env: { ...process.env, ...gitEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new DOMException('操作已取消', 'AbortError'));
      else if (code === 0) resolve(Buffer.concat(output).toString('utf8'));
      else reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `Git 退出，状态码 ${code}`));
    });
  });
}

const refKind = (name: string): RepositoryRef['kind'] =>
  name.startsWith('refs/heads/') ? 'head' : name.startsWith('refs/remotes/') ? 'remote' : 'tag';

const shortRefName = (name: string) => name.replace(/^refs\/(?:heads|tags)\//, '').replace(/^refs\/remotes\//, '');

async function readRefs(repository: string, signal?: AbortSignal): Promise<RepositoryRef[]> {
  const output = await runGit(repository, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname)%00%(*objectname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ], signal);
  return output.split('\n').filter(Boolean).map(line => {
    const [name, objectOid, peeledOid] = line.split('\0');
    return { name, shortName: shortRefName(name), kind: refKind(name), oid: peeledOid || objectOid };
  }).filter(ref => !(ref.kind === 'remote' && ref.name.endsWith('/HEAD')))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'));
}

async function readCommit(repository: string, oid: string, parents: string[], signal?: AbortSignal): Promise<IndexedCommit> {
  const metadata = await runGit(repository, ['show', '-s', '--format=%aN%x00%aI%x00%s%x00%B', oid], signal);
  const [author, authoredAt, subject, message = ''] = metadata.split('\0');
  const numstat = await runGit(repository, ['show', '--format=', '--numstat', '-z', '--no-renames', oid], signal);
  const changes = numstat.split('\0').filter(Boolean).map(entry => {
    const [added, deleted, ...pathParts] = entry.split('\t');
    return { additions: added === '-' ? 0 : Number(added), deletions: deleted === '-' ? 0 : Number(deleted), path: pathParts.join('\t') };
  });
  return {
    oid,
    parents,
    author,
    authoredAt,
    subject,
    message: message.trim(),
    additions: changes.reduce((total, change) => total + change.additions, 0),
    deletions: changes.reduce((total, change) => total + change.deletions, 0),
    filesChanged: changes.length,
    paths: changes.map(change => change.path).sort((left, right) => left.localeCompare(right, 'en')),
  };
}

export class HistoryService {
  private readonly indexes = new Map<string, RepositoryIndex>();

  constructor(private readonly managedRoot: () => string) {}

  private async repositoryPath(id: string) {
    if (!/^[\p{L}\p{N}._-]+$/u.test(id) || id === '.' || id === '..') throw new Error('仓库标识无效');
    const root = await fs.realpath(this.managedRoot());
    const candidate = path.join(root, id);
    const repository = await fs.realpath(candidate);
    if (!repository.startsWith(root + path.sep)) throw new Error('仓库超出受管范围');
    const git = await fs.stat(path.join(repository, '.git'));
    if (!git.isDirectory() && !git.isFile()) throw new Error('受管目录不是 Git 仓库');
    return repository;
  }

  async list(signal?: AbortSignal): Promise<RepositorySummary[]> {
    const root = path.resolve(this.managedRoot());
    await fs.mkdir(root, { recursive: true });
    const entries = await fs.readdir(root, { withFileTypes: true });
    const repositories: RepositorySummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try {
        const index = await this.index(entry.name, signal);
        repositories.push({ id: index.id, name: index.name, defaultRef: index.defaultRef, commitCount: index.commits.length });
      } catch { /* Ignore incomplete and unrelated managed directories. */ }
    }
    return repositories;
  }

  async index(id: string, signal?: AbortSignal): Promise<RepositoryIndex> {
    const cached = this.indexes.get(id);
    if (cached) return cached;
    const index = await this.buildIndex(id, signal);
    this.indexes.set(id, index);
    return index;
  }

  private async buildIndex(id: string, signal?: AbortSignal): Promise<RepositoryIndex> {
    const repository = await this.repositoryPath(id);
    const refs = await readRefs(repository, signal);
    if (!refs.length) throw new Error('仓库没有可索引的公开引用');
    const roots = [...new Set(refs.map(ref => ref.oid))];
    const graph = await runGit(repository, ['rev-list', '--topo-order', '--parents', ...roots], signal);
    const rows = graph.trim().split('\n').filter(Boolean).map(row => row.split(' '));
    const commits: IndexedCommit[] = [];
    for (const [oid, ...parents] of rows) commits.push(await readCommit(repository, oid, parents, signal));
    const symbolicHead = (await runGit(repository, ['symbolic-ref', '-q', 'HEAD'], signal).catch(() => '')).trim();
    const defaultRef = refs.some(ref => ref.name === symbolicHead)
      ? symbolicHead
      : refs.find(ref => ref.kind === 'head')?.name ?? refs[0].name;
    return { version: REPOSITORY_INDEX_VERSION, id, name: path.basename(repository), defaultRef, refs, commits };
  }

  async commit(id: string, oid: string, signal?: AbortSignal) {
    const index = await this.index(id, signal);
    return index.commits.find(commit => commit.oid === oid);
  }

  async search(id: string, parameters: URLSearchParams, signal?: AbortSignal) {
    const index = await this.index(id, signal);
    let commits = index.commits;
    const refName = parameters.get('ref');
    if (refName) {
      const ref = index.refs.find(candidate => candidate.name === refName);
      if (!ref) throw new Error('筛选引用不存在');
      const byOid = new Map(index.commits.map(commit => [commit.oid, commit]));
      const reachable = new Set<string>();
      const pending = [ref.oid];
      while (pending.length) {
        const oid = pending.pop()!;
        if (reachable.has(oid)) continue;
        reachable.add(oid);
        pending.push(...(byOid.get(oid)?.parents ?? []));
      }
      commits = commits.filter(commit => reachable.has(commit.oid));
    }
    const author = parameters.get('author')?.trim().toLocaleLowerCase();
    if (author) commits = commits.filter(commit => commit.author.toLocaleLowerCase() === author);
    const query = parameters.get('query')?.trim().toLocaleLowerCase();
    if (query) commits = commits.filter(commit => [commit.oid, commit.author, commit.subject, commit.message, ...commit.paths]
      .some(value => value.toLocaleLowerCase().includes(query)));
    const changeSize = parameters.get('changeSize');
    if (changeSize) commits = commits.filter(commit => {
      const changes = commit.additions + commit.deletions;
      return changeSize === 'small'
        ? changes <= CHANGE_SIZE_LIMITS.small
        : changeSize === 'medium'
          ? changes > CHANGE_SIZE_LIMITS.small && changes <= CHANGE_SIZE_LIMITS.medium
          : changeSize === 'large' ? changes > CHANGE_SIZE_LIMITS.medium : false;
    });
    return commits;
  }

  async topology(id: string, requestedRef?: string | null, signal?: AbortSignal): Promise<RepositoryTopology> {
    const index = await this.index(id, signal);
    const mainlineRef = requestedRef || index.defaultRef;
    const ref = index.refs.find(candidate => candidate.name === mainlineRef);
    if (!ref) throw new Error('主线引用不存在');
    const byOid = new Map(index.commits.map(commit => [commit.oid, commit]));
    const mainline = new Set<string>();
    let cursor: string | undefined = ref.oid;
    while (cursor && !mainline.has(cursor)) {
      mainline.add(cursor);
      cursor = byOid.get(cursor)?.parents[0];
    }

    const activeLanes = new Map<string, number>();
    const availableLane = () => {
      const occupied = new Set(activeLanes.values());
      let lane = 1;
      while (occupied.has(lane)) lane += 1;
      return lane;
    };
    const nodes = index.commits.map((commit, order) => {
      const lane = mainline.has(commit.oid) ? 0 : activeLanes.get(commit.oid) ?? availableLane();
      activeLanes.delete(commit.oid);
      commit.parents.forEach((parent, parentIndex) => {
        if (mainline.has(parent) || activeLanes.has(parent)) return;
        activeLanes.set(parent, parentIndex === 0 && lane > 0 ? lane : availableLane());
      });
      return { oid: commit.oid, order, lane, isMainline: mainline.has(commit.oid) };
    });
    const edges = index.commits.flatMap(commit => commit.parents.map(parent => ({ from: commit.oid, to: parent })));
    return { mainlineRef, nodes, edges };
  }
}
