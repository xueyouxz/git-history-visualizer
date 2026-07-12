import React, { useEffect, useState } from 'react';
import type { ManagedWorktree, WorktreeTarget } from '../shared/worktree';
import type { Api } from './api';

type Settings = { managedRoot: string; editor?: { executable: string; args: string[] } };

export function WorktreeControl({ api, repositoryId, oid }: { api: Api; repositoryId: string; oid: string }) {
  const [target, setTarget] = useState<WorktreeTarget>('terminal');
  const [worktrees, setWorktrees] = useState<ManagedWorktree[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [executable, setExecutable] = useState('');
  const [args, setArgs] = useState('["{path}"]');
  const endpoint = `/api/repositories/${encodeURIComponent(repositoryId)}/worktrees`;
  const refresh = async () => setWorktrees(await api<ManagedWorktree[]>(endpoint));

  useEffect(() => {
    const controller = new AbortController(); setError('');
    Promise.all([
      api<ManagedWorktree[]>(endpoint, { signal: controller.signal }).then(setWorktrees),
      api<Settings>('/api/settings', { signal: controller.signal }).then(settings => { if (settings.editor) { setExecutable(settings.editor.executable); setArgs(JSON.stringify(settings.editor.args)); } }),
    ]).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [repositoryId]);

  const open = async () => {
    try { setBusy(true); setError(''); await api(endpoint, { method: 'POST', body: JSON.stringify({ oid, target }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (worktree: ManagedWorktree) => {
    if (!window.confirm(`删除受管版本工作区？\n${worktree.path}`)) return;
    try { setBusy(true); setError(''); await api(`${endpoint}/${worktree.oid}`, { method: 'DELETE' }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const saveEditor = async () => {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (!Array.isArray(parsed) || parsed.some(argument => typeof argument !== 'string')) throw new Error('参数必须是 JSON 字符串数组');
      setBusy(true); setError(''); await api('/api/settings', { method: 'PUT', body: JSON.stringify({ editor: { executable, args: parsed } }) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return <section className="worktree-control" aria-label="历史版本工作区">
    <h3>历史版本工作区</h3>
    <label>打开位置<select value={target} onChange={event => setTarget(event.target.value as WorktreeTarget)}><option value="terminal">终端</option><option value="editor">外部编辑器</option></select></label>
    <button className="primary" disabled={busy} onClick={() => void open()}>打开此版本</button>
    <details><summary>外部编辑器配置</summary><label>可执行文件<input value={executable} onChange={event => setExecutable(event.target.value)} placeholder="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" /></label><label>参数 JSON<input value={args} onChange={event => setArgs(event.target.value)} /></label><button disabled={busy || !executable} onClick={() => void saveEditor()}>保存编辑器配置</button></details>
    {worktrees.length > 0 && <ul className="worktree-list">{worktrees.map(worktree => <li key={worktree.oid}><code>{worktree.oid.slice(0, 12)}</code><small>{worktree.dirty ? `有改动：${worktree.status}` : '干净'}</small><code>{worktree.path}</code><button disabled={busy} onClick={() => void remove(worktree)}>删除工作区</button></li>)}</ul>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
