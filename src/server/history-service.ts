import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  REPOSITORY_INDEX_VERSION,
  COMMIT_CLASSIFICATION_VERSION,
  PHASE_ANALYSIS_VERSION,
  COMMIT_TYPES,
  CHANGE_SIZE_LIMITS,
  DIFF_LIMITS,
  type DiffFile,
  type IndexedCommit,
  type RepositoryIndex,
  type RepositoryRef,
  type RepositorySummary,
  type RepositoryTopology,
  type RepositoryComparison,
  type RepositoryTree,
  type RepositoryClassifications,
  type RepositoryPhases,
} from '../shared/history.js';
import { analyzeContributors } from './contributor-analysis.js';
import { classifyCommit } from './commit-classification.js';
import { analyzePhases } from './phase-analysis.js';

const gitEnvironment = {
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_EXTERNAL_DIFF: '',
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
};

function runGitBuffer(repository: string, args: string[], signal?: AbortSignal, maxBytes = 4 * 1024 * 1024) {
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('操作已取消', 'AbortError'));
    const child = spawn('git', ['-C', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'diff.external=', '-c', 'mailmap.blob=HEAD:.mailmap', ...args], {
      env: { ...process.env, ...gitEnvironment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let limitExceeded = false;
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > maxBytes) { limitExceeded = true; child.kill('SIGTERM'); return; }
      output.push(chunk);
    });
    child.stderr.on('data', chunk => errors.push(chunk));
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new DOMException('操作已取消', 'AbortError'));
      else if (limitExceeded) reject(new Error('Git 输出超过数据量上限'));
      else if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `Git 退出，状态码 ${code}`));
    });
  });
}

async function runGit(repository: string, args: string[], signal?: AbortSignal, maxBytes?: number) {
  return (await runGitBuffer(repository, args, signal, maxBytes)).toString('utf8');
}

async function readJson<T>(file: string) {
  return fs.readFile(file, 'utf8').then(value => JSON.parse(value) as T).catch(() => undefined);
}

async function writeJsonAtomically(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(value)); await fs.rename(temporary, file);
}

type RawDiff = Pick<DiffFile, 'path' | 'oldPath' | 'status' | 'similarity' | 'inferred'>;

function parseRawDiff(output: Buffer): RawDiff[] {
  const fields = output.toString('utf8').split('\0');
  const files: RawDiff[] = [];
  for (let index = 0; index < fields.length - 1;) {
    const header = fields[index++];
    if (!header.startsWith(':')) continue;
    const statusCode = header.trim().split(/\s+/).at(-1) ?? 'M';
    const firstPath = fields[index++] ?? '';
    if (statusCode.startsWith('R')) {
      const nextPath = fields[index++] ?? '';
      files.push({ path: nextPath, oldPath: firstPath, status: 'renamed', similarity: Number(statusCode.slice(1)), inferred: true });
    } else {
      files.push({
        path: firstPath,
        status: statusCode.startsWith('A') ? 'added' : statusCode.startsWith('D') ? 'deleted' : 'modified',
        inferred: false,
      });
    }
  }
  return files;
}

function decodeUtf8(buffer: Buffer, allowReplacement = false) {
  if (allowReplacement) return { text: buffer.toString('utf8'), unknownEncoding: false };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), unknownEncoding: false }; }
  catch { return { text: '', unknownEncoding: true }; }
}

function parseNumstat(output: string) {
  const fields = output.split('\0'); const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < fields.length - 1;) {
    const record = fields[index++]; const [added = '0', deleted = '0', inlinePath = ''] = record.split('\t');
    const path = inlinePath || (index++, fields[index++] ?? '');
    result.set(path, { additions: Number(added) || 0, deletions: Number(deleted) || 0, binary: added === '-' || deleted === '-' });
  }
  return result;
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
  const metadata = await runGit(repository, ['show', '-s', '--format=%aN%x00%aE%x00%aI%x00%s%x00%B', oid], signal);
  const [author, authorEmail, authoredAt, subject, message = ''] = metadata.split('\0');
  const identity = `${author.normalize('NFKC').trim().toLocaleLowerCase('en-US')}\0${authorEmail.normalize('NFKC').trim().toLocaleLowerCase('en-US')}`;
  const authorId = createHash('sha256').update(identity).digest('hex');
  const numstat = await runGit(repository, ['show', '--format=', '--numstat', '-z', '--no-renames', oid], signal);
  const changes = numstat.split('\0').filter(Boolean).map(entry => {
    const [added, deleted, ...pathParts] = entry.split('\t');
    return { additions: added === '-' ? 0 : Number(added), deletions: deleted === '-' ? 0 : Number(deleted), path: pathParts.join('\t') };
  });
  return {
    oid,
    parents,
    author,
    authorId,
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
    const repository = await this.repositoryPath(id);
    const refs = await readRefs(repository, signal);
    if (!refs.length) throw new Error('仓库没有可索引的公开引用');
    const revisionFingerprint = createHash('sha256').update(refs.map(ref => `${ref.name}\0${ref.oid}`).join('\n')).digest('hex');
    const cacheKey = `${id}:${revisionFingerprint}:${REPOSITORY_INDEX_VERSION}`;
    const cached = this.indexes.get(cacheKey);
    if (cached) return cached;
    const cacheDirectory = path.join(path.resolve(this.managedRoot()), '.ghv-cache', id, revisionFingerprint);
    const cacheFile = path.join(cacheDirectory, `index-v${REPOSITORY_INDEX_VERSION}.json`);
    const stored = await readJson<RepositoryIndex>(cacheFile);
    if (stored?.version === REPOSITORY_INDEX_VERSION && stored.id === id && stored.revisionFingerprint === revisionFingerprint) {
      this.indexes.set(cacheKey, stored);
      return stored;
    }
    const index = await this.buildIndex(id, repository, refs, revisionFingerprint, signal);
    await writeJsonAtomically(cacheFile, index);
    this.indexes.set(cacheKey, index);
    return index;
  }

  private async buildIndex(id: string, repository: string, refs: RepositoryRef[], revisionFingerprint: string, signal?: AbortSignal): Promise<RepositoryIndex> {
    const roots = [...new Set(refs.map(ref => ref.oid))];
    const graph = await runGit(repository, ['rev-list', '--topo-order', '--parents', ...roots], signal);
    const rows = graph.trim().split('\n').filter(Boolean).map(row => row.split(' '));
    const commits: IndexedCommit[] = [];
    for (const [oid, ...parents] of rows) commits.push(await readCommit(repository, oid, parents, signal));
    const symbolicHead = (await runGit(repository, ['symbolic-ref', '-q', 'HEAD'], signal).catch(() => '')).trim();
    const defaultRef = refs.some(ref => ref.name === symbolicHead)
      ? symbolicHead
      : refs.find(ref => ref.kind === 'head')?.name ?? refs[0].name;
    return { version: REPOSITORY_INDEX_VERSION, id, name: path.basename(repository), revisionFingerprint, defaultRef, refs, commits };
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
    const requestedTypes = [...new Set(parameters.getAll('classification').flatMap(value => value.split(',')).filter(Boolean))];
    if (requestedTypes.length) {
      if (requestedTypes.some(type => !COMMIT_TYPES.includes(type as typeof COMMIT_TYPES[number]))) throw new Error('提交分类筛选无效');
      const classifications = await this.classifications(id, signal); const typeByOid = new Map(classifications.results.map(result => [result.oid, result.type]));
      commits = commits.filter(commit => requestedTypes.includes(typeByOid.get(commit.oid) ?? ''));
    }
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

  async tree(id: string, oid: string, requestedPath = '', signal?: AbortSignal): Promise<RepositoryTree> {
    const index = await this.index(id, signal);
    if (!index.commits.some(commit => commit.oid === oid)) throw new Error('树提交不存在或不可达');
    if (requestedPath.length > 4_096 || requestedPath.includes('\0') || path.posix.isAbsolute(requestedPath)) throw new Error('树路径无效');
    const normalizedPath = requestedPath ? path.posix.normalize(requestedPath) : '';
    if (normalizedPath === '.' || normalizedPath === '..' || normalizedPath.startsWith('../') || normalizedPath !== requestedPath.replace(/\/$/, '')) throw new Error('树路径无效');
    const repository = await this.repositoryPath(id);
    const args = ['ls-tree', '-r', '-t', '-z', '-l', oid];
    if (normalizedPath) args.push('--', normalizedPath);
    const output = await runGitBuffer(repository, args, signal, 16 * 1024 * 1024);
    const entries = output.toString('utf8').split('\0').filter(Boolean).map(record => {
      const separator = record.indexOf('\t');
      if (separator < 0) throw new Error('无法解析 Git tree');
      const [mode, type, objectOid, size] = record.slice(0, separator).trim().split(/\s+/);
      const entryPath = record.slice(separator + 1);
      if (!mode || !objectOid || (type !== 'tree' && type !== 'blob')) throw new Error('无法解析 Git tree');
      return { path: entryPath, type: type as 'tree' | 'blob', oid: objectOid, ...(type === 'blob' ? { bytes: Number(size) } : {}) };
    }).filter(entry => entry.path !== normalizedPath)
      .sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return { oid, path: normalizedPath, entries };
  }

  async contributors(id: string, parameters: URLSearchParams, windowSize = 12, signal?: AbortSignal) {
    const index = await this.index(id, signal);
    const commits = await this.search(id, parameters, signal);
    return analyzeContributors(commits, index.revisionFingerprint, windowSize, 6);
  }

  async classifications(id: string, signal?: AbortSignal): Promise<RepositoryClassifications> {
    const index = await this.index(id, signal);
    const cacheDirectory = path.join(path.resolve(this.managedRoot()), '.ghv-cache', id, index.revisionFingerprint);
    const cacheFile = path.join(cacheDirectory, `classifications-v${COMMIT_CLASSIFICATION_VERSION}.json`);
    const cached = await readJson<RepositoryClassifications>(cacheFile);
    if (cached?.version === COMMIT_CLASSIFICATION_VERSION && cached.revisionFingerprint === index.revisionFingerprint && cached.results.length === index.commits.length) return cached;
    const classifications: RepositoryClassifications = { version: COMMIT_CLASSIFICATION_VERSION, revisionFingerprint: index.revisionFingerprint, results: index.commits.map(classifyCommit) };
    await writeJsonAtomically(cacheFile, classifications);
    return classifications;
  }

  async phases(id: string, signal?: AbortSignal): Promise<RepositoryPhases> {
    const index = await this.index(id, signal);
    const cacheDirectory = path.join(path.resolve(this.managedRoot()), '.ghv-cache', id, index.revisionFingerprint);
    const cacheFile = path.join(cacheDirectory, `phases-v${PHASE_ANALYSIS_VERSION}.json`);
    const cached = await readJson<RepositoryPhases>(cacheFile);
    if (cached?.version === PHASE_ANALYSIS_VERSION && cached.revisionFingerprint === index.revisionFingerprint) return cached;
    const phases = analyzePhases(index); await writeJsonAtomically(cacheFile, phases);
    return phases;
  }

  async compare(id: string, options: { a: string; b: string; parentIndex?: number; ignoreWhitespace?: boolean; contextLines?: number; requestedPath?: string; allowReplacement?: boolean }, signal?: AbortSignal): Promise<RepositoryComparison> {
    const index = await this.index(id, signal);
    const byOid = new Map(index.commits.map(commit => [commit.oid, commit]));
    if (!byOid.has(options.a) || !byOid.has(options.b)) throw new Error('比较提交不存在或不可达');
    const parentIndex = options.parentIndex;
    const selectedParent = parentIndex === undefined ? undefined : byOid.get(options.b)?.parents[parentIndex];
    if (parentIndex !== undefined && !selectedParent) throw new Error('父提交序号无效');
    const effectiveA = selectedParent ?? options.a;
    const repository = await this.repositoryPath(id);

    const ancestors = (start: string) => {
      const result = new Set<string>(); const pending = [start];
      while (pending.length) { const oid = pending.pop()!; if (result.has(oid)) continue; result.add(oid); pending.push(...(byOid.get(oid)?.parents ?? [])); }
      return result;
    };
    const aAncestors = ancestors(options.a); const bAncestors = ancestors(options.b);
    const relation = options.a === options.b ? 'same'
      : bAncestors.has(options.a) ? 'a-ancestor-of-b'
        : aAncestors.has(options.b) ? 'b-ancestor-of-a' : 'diverged';
    const commonAncestor = (await runGit(repository, ['merge-base', options.a, options.b], signal, 256)).trim();
    const pathFrom = async (base: string, tip: string) => base === tip ? [] : (await runGit(repository, ['rev-list', '--reverse', '--ancestry-path', `${base}..${tip}`], signal))
      .trim().split('\n').filter(Boolean);
    const [pathA, pathB] = await Promise.all([pathFrom(commonAncestor, options.a), pathFrom(commonAncestor, options.b)]);

    const whitespaceArgs = options.ignoreWhitespace ? ['--ignore-all-space', '--ignore-blank-lines'] : [];
    const diffArguments = ['--no-ext-diff', '--no-textconv', '-M50%', ...whitespaceArgs, effectiveA, options.b, '--'];
    const raw = await runGitBuffer(repository, ['diff', '--raw', '-z', ...diffArguments], signal);
    let changed = parseRawDiff(raw);
    if (options.requestedPath) {
      changed = changed.filter(file => file.path === options.requestedPath || file.oldPath === options.requestedPath);
      if (!changed.length) throw new Error('请求的差异文件不存在');
    }
    const statistics = parseNumstat(await runGit(repository, ['diff', '--numstat', '-z', ...diffArguments], signal));
    let totalPatchBytes = 0;
    let totalTruncated = false;
    const files: DiffFile[] = [];
    for (const change of changed) {
      const paths = [...new Set([change.oldPath, change.path].filter((value): value is string => Boolean(value)))];
      const statistic = statistics.get(change.path) ?? { additions: 0, deletions: 0, binary: false };
      const binary = statistic.binary;
      let patch = ''; let unknownEncoding = false; let truncated = false;
      if (!binary) {
        const remaining = Math.max(0, DIFF_LIMITS.totalBytes - totalPatchBytes);
        if (!remaining) { truncated = true; totalTruncated = true; }
        else {
          try {
            const patchArguments = diffArguments.concat(paths);
            const fileLimit = options.requestedPath ? DIFF_LIMITS.recoveryFileBytes : DIFF_LIMITS.fileBytes;
            const patchBuffer = await runGitBuffer(repository, ['diff', '--patch', '--no-color', `--unified=${options.contextLines ?? 3}`, ...patchArguments], signal, Math.min(fileLimit, remaining));
            totalPatchBytes += patchBuffer.length;
            const decoded = decodeUtf8(patchBuffer, options.allowReplacement); patch = decoded.text; unknownEncoding = decoded.unknownEncoding;
          } catch (cause) {
            if ((cause as Error).message === 'Git 输出超过数据量上限') { truncated = true; totalTruncated = true; }
            else throw cause;
          }
        }
      }
      if (options.ignoreWhitespace && !binary && !unknownEncoding && !truncated && !patch.includes('\n@@')) continue;
      files.push({ ...change, additions: statistic.additions, deletions: statistic.deletions, binary, unknownEncoding, truncated, patch });
    }
    return { a: options.a, b: options.b, effectiveA, parentIndex, relation, commonAncestor, pathA, pathB, files, truncated: totalTruncated, totalPatchBytes };
  }
}
