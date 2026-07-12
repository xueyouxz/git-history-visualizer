import { PHASE_ANALYSIS_VERSION, type IndexedCommit, type PhaseBoundary, type RepositoryIndex, type RepositoryPhases } from '../shared/history.js';

const configurationNames = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'go.mod', 'go.sum', 'cargo.toml', 'cargo.lock', 'requirements.txt', 'pyproject.toml', 'pytest.ini', 'tox.ini', 'cmakelists.txt', 'meson.build', 'makefile', 'dockerfile', 'gemfile', 'composer.json']);
const isConfigurationPath = (changedPath: string) => {
  const normalized = changedPath.toLocaleLowerCase('en-US'); const name = normalized.split('/').at(-1) ?? normalized;
  return configurationNames.has(name) || /(^|\/)\.github\/workflows\/[^/]+$|(^|\/)tsconfig[^/]*\.json$|(^|\/)[^/]*\.config\.[^/]+$|\.(?:ya?ml|toml)$/.test(normalized);
};
const topDirectory = (changedPath: string) => changedPath.includes('/') ? changedPath.split('/')[0] : undefined;

type Candidate = PhaseBoundary & { chronologicalOrder: number };

const leadingAuthors = (commits: IndexedCommit[]) => {
  const counts = new Map<string, number>(); commits.forEach(commit => counts.set(commit.authorId, (counts.get(commit.authorId) ?? 0) + 1));
  return new Set([...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'en')).slice(0, 2).map(([authorId]) => authorId));
};

export function analyzePhases(index: RepositoryIndex): RepositoryPhases {
  const chronological = [...index.commits].reverse();
  const originalOrder = new Map(index.commits.map((commit, order) => [commit.oid, order]));
  const tags = new Map<string, string[]>();
  index.refs.filter(ref => ref.kind === 'tag').forEach(ref => tags.set(ref.oid, [...(tags.get(ref.oid) ?? []), ref.shortName]));
  const seenTopDirectories = new Set<string>(); const seenConfigurations = new Set<string>(); const candidates: Candidate[] = [];
  chronological.forEach((commit, chronologicalOrder) => {
    const reasons: string[] = []; let score = 0;
    const commitTags = tags.get(commit.oid) ?? [];
    if (commitTags.length) { score += 4; reasons.push(`tag ${commitTags.sort((a, b) => a.localeCompare(b, 'en')).join('、')} 指向此提交`); }
    const directories = [...new Set(commit.paths.map(topDirectory).filter((value): value is string => Boolean(value)))];
    const newDirectories = chronologicalOrder ? directories.filter(directory => !seenTopDirectories.has(directory)) : [];
    if (newDirectories.length) { score += 3; reasons.push(`新增顶层目录 ${newDirectories.sort((a, b) => a.localeCompare(b, 'en')).join('、')}`); }
    directories.forEach(directory => seenTopDirectories.add(directory));
    const configurations = commit.paths.filter(isConfigurationPath);
    const newConfigurations = configurations.filter(changedPath => !seenConfigurations.has(changedPath));
    if (newConfigurations.length) { score += 3; reasons.push(`配置首次出现 ${newConfigurations.sort((a, b) => a.localeCompare(b, 'en')).join('、')}`); }
    configurations.forEach(changedPath => seenConfigurations.add(changedPath));
    const changes = commit.additions + commit.deletions;
    if (changes > 100) { score += 2; reasons.push(`大规模变更 ${changes} 行`); }
    if (commit.paths.length >= 3 && directories.some(directory => commit.paths.filter(changedPath => topDirectory(changedPath) === directory).length / commit.paths.length >= .6)) {
      score += 2; reasons.push('顶层目录变更占本次文件变更多数');
    }
    if (chronologicalOrder >= 4 && chronologicalOrder + 4 <= chronological.length) {
      const before = leadingAuthors(chronological.slice(chronologicalOrder - 4, chronologicalOrder));
      const after = leadingAuthors(chronological.slice(chronologicalOrder, chronologicalOrder + 4));
      if (![...before].some(authorId => after.has(authorId))) { score += 3; reasons.push('主要贡献者结构变化'); }
    }
    if (score >= 2 && chronologicalOrder > 0) candidates.push({ oid: commit.oid, order: originalOrder.get(commit.oid)!, chronologicalOrder, score, reasons });
  });
  const selected: Candidate[] = [];
  [...candidates].sort((left, right) => right.score - left.score || left.chronologicalOrder - right.chronologicalOrder).forEach(candidate => {
    if (selected.every(boundary => Math.abs(boundary.chronologicalOrder - candidate.chronologicalOrder) >= 8)) selected.push(candidate);
  });
  const boundaries = selected.sort((left, right) => left.order - right.order).map(({ chronologicalOrder: _chronologicalOrder, ...boundary }) => boundary);
  return { version: PHASE_ANALYSIS_VERSION, revisionFingerprint: index.revisionFingerprint, boundaries };
}
