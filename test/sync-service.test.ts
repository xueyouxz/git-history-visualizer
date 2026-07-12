import { describe, expect, it } from 'vitest';
import { SyncService } from '../src/server/sync-service';
import type { HistoryService } from '../src/server/history-service';

const tick = () => new Promise(resolve => setImmediate(resolve));
const index = { version: 2 as const, id: 'fixture', name: 'fixture', revisionFingerprint: 'revision', defaultRef: 'refs/heads/main', refs: [], commits: [] };

describe('同步任务状态', () => {
  it('可取消运行中的同步并保留可恢复状态', async () => {
    const history = {
      index: async () => index,
      synchronize: async (_id: string, signal: AbortSignal, progress: (phase: 'fetching', value: number, message: string) => void) => {
        progress('fetching', 15, '正在获取');
        await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('取消', 'AbortError')), { once: true }); });
        return { newCommits: 0, removedRefs: 0 };
      },
    } as unknown as HistoryService;
    const service = new SyncService(history); const task = await service.create('fixture'); await tick();
    expect(service.tasks.get(task.id)?.phase).toBe('fetching');
    expect(await service.cancel(task.id)).toMatchObject({ phase: 'cancelled', recoverable: true });
  });

  it('将同步错误标记为可恢复并允许新任务重试', async () => {
    const history = { index: async () => index, synchronize: async () => { throw new Error('远程不可用'); } } as unknown as HistoryService;
    const service = new SyncService(history); const failed = await service.create('fixture'); await tick();
    expect(service.tasks.get(failed.id)).toMatchObject({ phase: 'error', message: '远程不可用', recoverable: true });
    expect((await service.create('fixture')).id).not.toBe(failed.id);
  });
});
