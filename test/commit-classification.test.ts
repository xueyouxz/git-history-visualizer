import { describe, expect, it } from 'vitest';
import { classifyCommit } from '../src/server/commit-classification';
import type { IndexedCommit } from '../src/shared/history';

const sample = (overrides: Partial<IndexedCommit>): IndexedCommit => ({
  oid: 'a'.repeat(40), parents: ['b'.repeat(40)], author: 'Alice', authorId: 'author', authoredAt: '', subject: 'change', message: 'change', additions: 10, deletions: 2, filesChanged: 1, paths: ['src/index.ts'], ...overrides,
});

describe('提交分类规则', () => {
  it.each([
    ['feature', sample({ subject: 'feat: introduce search', message: 'feat: introduce search' })],
    ['fix', sample({ subject: 'fix: resolve empty history', message: 'fix: resolve empty history' })],
    ['refactor', sample({ subject: 'refactor: restructure parser', message: 'refactor: restructure parser', additions: 8, deletions: 8 })],
    ['test', sample({ subject: 'cover parser edge cases', message: 'cover parser edge cases', paths: ['test/parser.test.ts'] })],
    ['docs', sample({ subject: 'update guide', message: 'update guide', paths: ['docs/guide.md'] })],
    ['build/config', sample({ subject: 'configure release', message: 'configure release', paths: ['.github/workflows/release.yml'] })],
    ['merge', sample({ subject: 'merge feature', message: 'merge feature', parents: ['b'.repeat(40), 'c'.repeat(40)] })],
    ['mixed', sample({ subject: 'feat: add parser tests', message: 'feat: add parser tests', paths: ['src/parser.ts', 'test/parser.test.ts'] })],
  ] as const)('确定性识别 %s', (type, commit) => {
    const first = classifyCommit(commit);
    expect(first).toEqual(classifyCommit(commit));
    expect(first).toMatchObject({ oid: commit.oid, type });
    expect(first.reasons.length).toBeGreaterThan(0);
    expect(first.confidence).toBeGreaterThanOrEqual(.4);
    expect(first.confidence).toBeLessThanOrEqual(1);
  });

  it('没有消息和路径信号时使用增删规模作为低置信度依据', () => {
    const result = classifyCommit(sample({ subject: 'change', message: 'change', paths: ['source.bin'], additions: 40, deletions: 2 }));
    expect(result).toMatchObject({ type: 'feature', confidence: .65 });
    expect(result.reasons).toEqual(['新增行多于删除行且无更强分类信号']);
  });
});
