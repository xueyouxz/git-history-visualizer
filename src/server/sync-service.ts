import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { isTerminalSyncPhase, type SyncPhase, type SyncTask } from '../shared/sync.js';
import type { HistoryService } from './history-service.js';

type Execution = { controller: AbortController; promise?: Promise<void> };

export class SyncService {
  readonly tasks = new Map<string, SyncTask>();
  readonly events = new EventEmitter();
  private readonly executions = new Map<string, Execution>();

  constructor(private readonly history: HistoryService) {}

  async create(repositoryId: string) {
    if ([...this.tasks.values()].some(task => task.repositoryId === repositoryId && !isTerminalSyncPhase(task.phase))) throw new Error('该仓库已有同步任务');
    await this.history.index(repositoryId);
    const task: SyncTask = { id: randomUUID(), repositoryId, phase: 'queued', progress: 0, message: '等待同步' };
    const execution: Execution = { controller: new AbortController() };
    this.tasks.set(task.id, task); this.executions.set(task.id, execution); this.publish(task);
    setImmediate(() => {
      if (task.phase !== 'queued') return;
      execution.promise = this.execute(task, execution.controller.signal);
      void execution.promise.finally(() => this.executions.delete(task.id));
    });
    return task;
  }

  async cancel(id: string) {
    const task = this.tasks.get(id); if (!task) return undefined; if (isTerminalSyncPhase(task.phase)) return task;
    const execution = this.executions.get(id); execution?.controller.abort();
    if (execution?.promise) await execution.promise;
    else { Object.assign(task, { phase: 'cancelled', message: '同步已取消', recoverable: true }); this.publish(task); this.executions.delete(id); }
    return task;
  }

  private publish(task: SyncTask) { this.events.emit(task.id, { ...task }); }
  private async execute(task: SyncTask, signal: AbortSignal) {
    try {
      const result = await this.history.synchronize(task.repositoryId, signal, (phase, progress, message) => { Object.assign(task, { phase, progress, message }); this.publish(task); });
      Object.assign(task, { phase: 'complete', progress: 100, message: '同步完成', ...result }); this.publish(task);
    } catch (cause) {
      if (signal.aborted) Object.assign(task, { phase: 'cancelled', message: '同步已取消', recoverable: true });
      else Object.assign(task, { phase: 'error', message: cause instanceof Error ? cause.message : '同步失败', recoverable: true });
      this.publish(task);
    }
  }
}
