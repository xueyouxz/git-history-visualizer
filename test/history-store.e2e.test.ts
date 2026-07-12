import { beforeEach, describe, expect, it } from 'vitest';
import { useHistoryStore } from '../src/client/history-store';

describe('A/B 比较状态', () => {
  beforeEach(() => useHistoryStore.setState({ repositoryId: 'fixture', selectedOid: 'selected', aOid: '', bOid: '' }));

  it('支持显式设置、交换和清除，且不改变当前提交', () => {
    useHistoryStore.getState().setA('a');
    useHistoryStore.getState().setB('b');
    useHistoryStore.getState().swapAB();
    expect(useHistoryStore.getState()).toMatchObject({ aOid: 'b', bOid: 'a', selectedOid: 'selected' });
    useHistoryStore.getState().clearAB();
    expect(useHistoryStore.getState()).toMatchObject({ aOid: '', bOid: '', selectedOid: 'selected' });
  });
});

describe('贡献者联动状态', () => {
  it('选择主要贡献者或其他时计算提交和路径高亮，清除后保留原分析状态', () => {
    const commits = [
      { oid: 'a', parents: [], author: 'Alice', authorId: 'alice', authoredAt: '', subject: '', message: '', additions: 1, deletions: 0, filesChanged: 1, paths: ['src/a.ts'] },
      { oid: 'b', parents: ['a'], author: 'Bob', authorId: 'bob', authoredAt: '', subject: '', message: '', additions: 1, deletions: 0, filesChanged: 1, paths: ['src/b.ts'] },
    ];
    useHistoryStore.setState({
      repositoryId: 'fixture', selectedOid: 'selected', aOid: 'a', bOid: 'b', query: 'keep', boxedOids: ['a', 'b'],
      allCommits: commits, commits,
    });
    useHistoryStore.getState().selectContributor('other', ['alice']);
    expect(useHistoryStore.getState()).toMatchObject({ selectedContributorId: 'other', contributorHighlightOids: ['b'], contributorPaths: ['src/b.ts'], aOid: 'a', bOid: 'b', query: 'keep', boxedOids: ['a', 'b'] });
    useHistoryStore.getState().selectContributor('other', ['bob']);
    expect(useHistoryStore.getState()).toMatchObject({ selectedContributorId: 'other', contributorHighlightOids: ['a'], contributorPaths: ['src/a.ts'] });
    useHistoryStore.getState().selectContributor('', ['alice']);
    expect(useHistoryStore.getState()).toMatchObject({ selectedContributorId: '', contributorHighlightOids: [], contributorPaths: [], aOid: 'a', bOid: 'b', query: 'keep', boxedOids: ['a', 'b'] });
  });
});
