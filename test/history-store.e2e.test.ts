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

describe('提交分类筛选状态', () => {
  it('支持多个分类且不改变 A/B 和当前提交', () => {
    useHistoryStore.setState({ selectedOid: 'selected', aOid: 'a', bOid: 'b', boxedOids: ['a', 'b'], classificationFilters: [] });
    useHistoryStore.getState().toggleClassification('fix');
    useHistoryStore.getState().toggleClassification('docs');
    expect(useHistoryStore.getState()).toMatchObject({ classificationFilters: ['docs', 'fix'], selectedOid: 'selected', aOid: 'a', bOid: 'b' });
    useHistoryStore.getState().setCommits([]);
    expect(useHistoryStore.getState()).toMatchObject({ selectedOid: 'selected', aOid: 'a', bOid: 'b', boxedOids: ['a', 'b'] });
    useHistoryStore.getState().toggleClassification('fix');
    expect(useHistoryStore.getState()).toMatchObject({ classificationFilters: ['docs'], selectedOid: 'selected', aOid: 'a', bOid: 'b' });
  });
});

describe('阶段叠加状态', () => {
  it('调整、关闭或失败清除阶段结果不改变提交、拓扑、选择、A/B、框选和路径状态', () => {
    const analysis = { version: 1 as const, revisionFingerprint: 'revision', boundaries: [{ oid: 'b', order: 2, score: 4, reasons: ['tag v1'] }] };
    const commits = [{ oid: 'a', parents: [], author: 'Alice', authorId: 'alice', authoredAt: '', subject: 'initial', message: 'initial', additions: 1, deletions: 0, filesChanged: 1, paths: ['src/a.ts'] }];
    const topology = { mainlineRef: 'refs/heads/main', nodes: [{ oid: 'a', order: 0, lane: 0, isMainline: true }], edges: [] };
    useHistoryStore.setState({ allCommits: commits, commits, topology, selectedOid: 'selected', aOid: 'a', bOid: 'b', boxedOids: ['a', 'b'], highlightedPath: 'src/a.ts', phaseAnalysis: undefined, phaseOverrides: {} });
    useHistoryStore.getState().setPhaseAnalysis(analysis, {});
    useHistoryStore.getState().setPhaseBoundary('b', 1);
    expect(useHistoryStore.getState()).toMatchObject({ selectedOid: 'selected', aOid: 'a', bOid: 'b', boxedOids: ['a', 'b'], phaseOverrides: { b: 1 } });
    useHistoryStore.getState().clearPhaseAnalysis();
    expect(useHistoryStore.getState()).toMatchObject({ allCommits: commits, commits, topology, selectedOid: 'selected', aOid: 'a', bOid: 'b', boxedOids: ['a', 'b'], highlightedPath: 'src/a.ts', phaseAnalysis: undefined, phaseOverrides: {} });
  });
});

describe('同步后状态替换', () => {
  it('保留提交、A/B、范围和筛选，仅清除失效 ref 与旧修订分析', () => {
    const commit = (oid: string) => ({ oid, parents: [], author: 'Alice', authorId: 'alice', authoredAt: '', subject: oid, message: oid, additions: 1, deletions: 0, filesChanged: 1, paths: ['src/a.ts'] });
    const oldCommits = [commit('a'), commit('b')]; const nextCommits = [commit('c'), ...oldCommits];
    useHistoryStore.setState({ revisionFingerprint: 'old', allCommits: oldCommits, commits: oldCommits, selectedOid: 'b', aOid: 'a', bOid: 'b', range: 'all', query: 'keep', author: 'Alice', refFilter: 'refs/heads/obsolete', changeSize: 'small', classificationFilters: ['docs'], boxedOids: ['a', 'b'], classifications: { a: { oid: 'a', type: 'docs', reasons: ['文档'], confidence: .8 } }, phaseAnalysis: { version: 1, revisionFingerprint: 'old', boundaries: [] }, phaseOverrides: { a: 1 } });
    useHistoryStore.getState().setHistory(nextCommits, [{ name: 'refs/heads/main', shortName: 'main', kind: 'head', oid: 'c' }], { mainlineRef: 'refs/heads/main', nodes: [], edges: [] }, 'new');
    expect(useHistoryStore.getState()).toMatchObject({ revisionFingerprint: 'new', selectedOid: 'b', aOid: 'a', bOid: 'b', range: 'all', query: 'keep', author: 'Alice', refFilter: '', changeSize: 'small', classificationFilters: ['docs'], boxedOids: ['a', 'b'], classifications: {}, phaseAnalysis: undefined, phaseOverrides: {} });
  });
});
