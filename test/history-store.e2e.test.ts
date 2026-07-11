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
