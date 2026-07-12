import { describe, expect, it } from 'vitest';
import { analyzePhases } from '../src/server/phase-analysis';
import type { IndexedCommit, RepositoryIndex } from '../src/shared/history';

const oid = (index: number) => index.toString(16).padStart(40, '0');
const commit = (index: number, authorId: string, paths: string[], changes = 12): IndexedCommit => ({
  oid: oid(index), parents: index ? [oid(index - 1)] : [], author: authorId, authorId, authoredAt: `20${index.toString().padStart(2, '0')}-01-01T00:00:00Z`, subject: `commit ${index}`, message: `commit ${index}`, additions: changes, deletions: 0, filesChanged: paths.length, paths,
});

function fixture(): RepositoryIndex {
  const chronological = Array.from({ length: 24 }, (_, index) => {
    if (index === 8) return commit(index, 'bob', ['packages/core/index.ts', 'package.json'], 220);
    if (index >= 8) return commit(index, 'bob', ['packages/core/index.ts']);
    return commit(index, 'alice', ['src/index.ts']);
  });
  return {
    version: 2, id: 'fixture', name: 'fixture', revisionFingerprint: 'revision', defaultRef: 'refs/heads/main',
    refs: [
      { name: 'refs/heads/main', shortName: 'main', kind: 'head', oid: oid(23) },
      { name: 'refs/tags/v2', shortName: 'v2', kind: 'tag', oid: oid(8) },
      { name: 'refs/tags/v3', shortName: 'v3', kind: 'tag', oid: oid(17) },
    ],
    commits: chronological.reverse(),
  };
}

describe('阶段分析算法', () => {
  it('确定性评分全部结构信号，且相邻边界至少间隔 8 个提交', () => {
    const index = fixture();
    const first = analyzePhases(index);
    expect(first).toEqual(analyzePhases(index));
    expect(first).toMatchObject({ version: 1, revisionFingerprint: 'revision' });
    expect(first.boundaries.length).toBeGreaterThanOrEqual(2);
    expect(first.boundaries.every((boundary, position, all) => position === 0 || Math.abs(boundary.order - all[position - 1].order) >= 8)).toBe(true);
    const reasons = first.boundaries.flatMap(boundary => boundary.reasons).join(' ');
    expect(reasons).toMatch(/tag/);
    expect(reasons).toMatch(/顶层目录/);
    expect(reasons).toMatch(/配置/);
    expect(reasons).toMatch(/大规模变更/);
    expect(reasons).toMatch(/主要贡献者结构变化/);
  });

  it('真实时间变化不影响结果', () => {
    const index = fixture();
    const changedDates = { ...index, commits: index.commits.map((entry, position) => ({ ...entry, authoredAt: `1999-01-${String(position + 1).padStart(2, '0')}T00:00:00Z` })) };
    expect(analyzePhases(changedDates)).toEqual(analyzePhases(index));
  });

  it.each(['pom.xml', 'build.gradle', 'go.mod', 'pytest.ini', 'CMakeLists.txt'])('识别依赖、构建或测试配置首次出现：%s', configuration => {
    const chronological = Array.from({ length: 10 }, (_, index) => commit(index, 'alice', index === 5 ? [configuration] : ['src/index.ts']));
    const index: RepositoryIndex = { version: 2, id: 'config', name: 'config', revisionFingerprint: 'config-revision', defaultRef: 'refs/heads/main', refs: [{ name: 'refs/heads/main', shortName: 'main', kind: 'head', oid: oid(9) }], commits: chronological.reverse() };
    expect(analyzePhases(index).boundaries.flatMap(boundary => boundary.reasons)).toContain(`配置首次出现 ${configuration}`);
  });
});
