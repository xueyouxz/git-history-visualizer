import { describe, expect, it } from 'vitest';
import { buildCodeMapLayout, buildPlaybackSequence, listCodeMapDirectories } from '../src/client/code-map';
import type { RepositoryTree } from '../src/shared/history';

const snapshot = (oid: string, entries: RepositoryTree['entries']): RepositoryTree => ({ oid, path: '', entries });

describe('代码地图算法', () => {
  it('对同一 A/B 目录并集生成稳定布局，并保留非颜色状态', () => {
    const a = snapshot('a'.repeat(40), [
      { path: 'README.md', type: 'blob', oid: '1'.repeat(40), bytes: 10 },
      { path: 'src', type: 'tree', oid: '2'.repeat(40) },
      { path: 'src/old.ts', type: 'blob', oid: '3'.repeat(40), bytes: 30 },
    ]);
    const b = snapshot('b'.repeat(40), [
      { path: 'README.md', type: 'blob', oid: '4'.repeat(40), bytes: 20 },
      { path: 'src', type: 'tree', oid: '5'.repeat(40) },
      { path: 'src/new.ts', type: 'blob', oid: '3'.repeat(40), bytes: 30 },
    ]);
    const first = buildCodeMapLayout(a, b, '', [{ oldPath: 'src/old.ts', path: 'src/new.ts' }], 800, 320);
    const second = buildCodeMapLayout(a, b, '', [{ oldPath: 'src/old.ts', path: 'src/new.ts' }], 800, 320);

    expect(second).toEqual(first);
    expect(first.map(item => item.path)).toEqual(['README.md', 'src/new.ts', 'src/old.ts']);
    expect(first.find(item => item.path === 'README.md')).toMatchObject({ status: 'modified' });
    expect(first.find(item => item.path === 'src/new.ts')).toMatchObject({ status: 'renamed', renamedFrom: 'src/old.ts' });
    expect(first.find(item => item.path === 'src/old.ts')).toMatchObject({ status: 'renamed', renamedTo: 'src/new.ts' });
    expect(first.every(item => item.width > 0 && item.height > 0)).toBe(true);
    expect(listCodeMapDirectories(first, '').map(directory => directory.path)).toEqual(['src']);
  });

  it('普通快照标记为未变，A 中独有目录仍可下钻', () => {
    const current = snapshot('b'.repeat(40), [{ path: 'src/current.ts', type: 'blob', oid: '1'.repeat(40), bytes: 5 }]);
    expect(buildCodeMapLayout(undefined, current, '').map(item => item.status)).toEqual(['unchanged']);
    const before = snapshot('a'.repeat(40), [{ path: 'removed/old.ts', type: 'blob', oid: '2'.repeat(40), bytes: 7 }]);
    const comparison = buildCodeMapLayout(before, current, '');
    expect(listCodeMapDirectories(comparison, '').map(directory => directory.path)).toEqual(['removed', 'src']);
    expect(buildCodeMapLayout(before, current, 'removed')).toMatchObject([{ path: 'removed/old.ts', status: 'deleted' }]);
  });

  it('重复构建主线与选定路径播放序列得到相同提交顺序', () => {
    const commits = [
      { oid: 'merge', parents: ['main', 'feature'] },
      { oid: 'main', parents: ['initial'] },
      { oid: 'feature', parents: ['initial'] },
      { oid: 'initial', parents: [] },
    ];
    expect(buildPlaybackSequence(commits, new Set(['merge', 'main', 'initial']))).toEqual(['initial', 'main', 'merge']);
    expect(buildPlaybackSequence(commits, undefined, 'feature')).toEqual(['initial', 'feature']);
    expect(buildPlaybackSequence(commits, undefined, 'feature')).toEqual(['initial', 'feature']);
    expect(buildPlaybackSequence(commits, undefined, 'merge', ['merge', 'feature', 'initial'])).toEqual(['initial', 'feature', 'merge']);
    expect(buildPlaybackSequence(commits, undefined, 'merge', ['merge', 'feature', 'main', 'initial'])).toEqual([]);
  });
});
