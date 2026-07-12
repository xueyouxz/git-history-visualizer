import { describe, expect, it } from 'vitest';
import { analyzeContributors } from '../src/server/contributor-analysis';

describe('贡献者演化算法', () => {
  it('按 DAG 顺序计算固定窗口变更占比，并将非主要贡献者聚合为其他', () => {
    const result = analyzeContributors([
      { oid: 'one', authorId: 'alice', author: 'Alice', additions: 10, deletions: 0 },
      { oid: 'two', authorId: 'bob', author: 'Bob', additions: 30, deletions: 0 },
      { oid: 'three', authorId: 'alice', author: 'Alice', additions: 10, deletions: 0 },
    ], 'revision', 2, 1);

    expect(result).toMatchObject({ version: 1, revisionFingerprint: 'revision', windowSize: 2 });
    expect(result.contributors).toEqual([
      { authorId: 'bob', name: 'Bob', aggregate: false },
      { authorId: 'other', name: '其他', aggregate: true },
    ]);
    expect(result.points).toEqual([
      { oid: 'one', order: 0, shares: [{ authorId: 'bob', lines: 0, share: 0 }, { authorId: 'other', lines: 10, share: 1 }] },
      { oid: 'two', order: 1, shares: [{ authorId: 'bob', lines: 30, share: .75 }, { authorId: 'other', lines: 10, share: .25 }] },
      { oid: 'three', order: 2, shares: [{ authorId: 'bob', lines: 30, share: .75 }, { authorId: 'other', lines: 10, share: .25 }] },
    ]);
  });
});
