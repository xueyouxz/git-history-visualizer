import { useEffect, useRef, useState } from 'react';
import { isTerminalSyncPhase, type SyncTask } from '../shared/sync';
import type { Api } from './api';
import { consumeSse } from './sse';

export function SyncControl({ api, token, repositoryId, onComplete }: { api: Api; token: string; repositoryId: string; onComplete: () => void }) {
  const [task, setTask] = useState<SyncTask>(); const [error, setError] = useState(''); const [streamFailed, setStreamFailed] = useState(false); const streamController = useRef<AbortController | undefined>(undefined);
  useEffect(() => { streamController.current?.abort(); setTask(undefined); setError(''); setStreamFailed(false); return () => streamController.current?.abort(); }, [repositoryId]);
  const stream = async (id: string) => {
    const controller = new AbortController(); streamController.current?.abort(); streamController.current = controller;
    await consumeSse<SyncTask>(`/api/repositories/${encodeURIComponent(repositoryId)}/syncs/${id}/events`, token, controller.signal, state => { setTask(state); setStreamFailed(false); if (state.phase === 'complete') onComplete(); });
  };
  const start = async () => {
    let activeTask = task;
    try {
      setError(''); setStreamFailed(false);
      if (!streamFailed || !activeTask) { activeTask = await api<SyncTask>(`/api/repositories/${encodeURIComponent(repositoryId)}/syncs`, { method: 'POST' }); setTask(activeTask); }
      await stream(activeTask.id);
    } catch (cause) { if ((cause as Error).name !== 'AbortError') { setError(cause instanceof Error ? cause.message : String(cause)); if (activeTask) setStreamFailed(true); } }
  };
  const cancel = async () => { if (task) { try { setError(''); setTask(await api(`/api/repositories/${encodeURIComponent(repositoryId)}/syncs/${task.id}`, { method: 'DELETE' })); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } } };
  return <section className="sync-control" aria-label="仓库同步">
    <button disabled={Boolean(task && !isTerminalSyncPhase(task.phase) && !streamFailed)} onClick={() => void start()}>{streamFailed ? '重新连接同步' : task?.phase === 'error' || task?.phase === 'cancelled' ? '重试同步' : task?.phase === 'complete' ? '再次同步' : '手动同步'}</button>
    {task && <div className={`sync-status ${task.phase}`} role="status"><progress max="100" value={task.progress} /><span>{task.message}{task.phase === 'complete' && task.newCommits !== undefined ? `，新增 ${task.newCommits} 个提交` : ''}</span>{!isTerminalSyncPhase(task.phase) && <button onClick={() => void cancel()}>取消同步</button>}</div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
