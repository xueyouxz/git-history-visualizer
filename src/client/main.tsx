import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { ImportPreview, TaskState } from '../shared/import';

type Directory = { name: string; path: string; isGitRepository: boolean };

function App() {
  const [session, setSession] = useState<{ token: string; managedRoot: string }>();
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [source, setSource] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [preview, setPreview] = useState<ImportPreview>();
  const [task, setTask] = useState<TaskState>();
  const [error, setError] = useState('');
  const streamController = useRef<AbortController | undefined>(undefined);
  const api = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Session-Token': session?.token ?? '', ...init.headers } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  useEffect(() => { fetch('/api/session').then(r => r.json()).then(setSession); }, []);
  useEffect(() => () => streamController.current?.abort(), []);
  const browse = async (path?: string) => { try { const data = await api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`); setCurrentPath(data.path); setDirectories(data.directories); } catch (e) { setError(String(e)); } };
  useEffect(() => { if (session && kind === 'local') void browse(); }, [session, kind]);
  const selectSource = (next: string) => { setSource(next); setPreview(undefined); setTask(undefined); };
  const inspect = async () => { try { setError(''); setPreview(await api('/api/imports/preview', { method: 'POST', body: JSON.stringify({ kind, source }) })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const streamTask = async (id: string) => {
    const controller = new AbortController(); streamController.current?.abort(); streamController.current = controller;
    const response = await fetch(`/api/imports/${id}/events`, { headers: { 'X-Session-Token': session?.token ?? '' }, signal: controller.signal });
    if (!response.ok || !response.body) { const data = await response.json(); throw new Error(data.error ?? '无法读取任务进度'); }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const line = frame.split('\n').find(part => part.startsWith('data: '));
        if (line) setTask(JSON.parse(line.slice(6)) as TaskState);
      }
      if (done) break;
    }
  };
  const start = async () => { if (!preview) return; try { setError(''); const next: TaskState = await api('/api/imports', { method: 'POST', body: JSON.stringify({ kind: preview.kind, source: preview.source }) }); setPreview(undefined); setTask(next); await streamTask(next.id); } catch (e) { if ((e as Error).name !== 'AbortError') setError(e instanceof Error ? e.message : String(e)); } };
  const cancel = async () => { if (!task) return; try { setTask(await api(`/api/imports/${task.id}`, { method: 'DELETE' })); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const saveRoot = async () => { const managedRoot = prompt('后续导入使用的受管根目录', session?.managedRoot); if (!managedRoot) return; try { const next = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ managedRoot }) }); setSession(s => s && ({ ...s, managedRoot: next.managedRoot })); } catch (e) { setError(String(e)); } };
  return <main><header><div><p className="eyebrow">本地只读工作台</p><h1>导入 Git 仓库</h1></div><button className="secondary" onClick={saveRoot}>设置存储目录</button></header>
    <section className="panel"><div className="tabs"><button aria-pressed={kind === 'local'} onClick={() => { setKind('local'); selectSource(''); }}>本地仓库</button><button aria-pressed={kind === 'remote'} onClick={() => { setKind('remote'); selectSource(''); }}>远程仓库</button></div>
      {kind === 'local' ? <div><div className="pathbar"><span>{currentPath}</span><button onClick={() => browse(currentPath.split('/').slice(0,-1).join('/') || '/')}>上一级</button></div><ul>{directories.map(d => <li key={d.path}><button onClick={() => d.isGitRepository ? selectSource(d.path) : browse(d.path)}><span>{d.name}</span><small>{d.isGitRepository ? 'Git 仓库，选择' : '目录'}</small></button></li>)}</ul><label>已选仓库<input value={source} readOnly placeholder="选择上方标记为 Git 仓库的目录" /></label></div> : <label>公开 HTTPS Git URL<input value={source} onChange={e => selectSource(e.target.value)} placeholder="https://github.com/owner/repository.git" /></label>}
      <p className="root">受管目录：<code>{session?.managedRoot}</code></p>
      {!preview && <button className="primary" disabled={!source || !!task && !['complete','cancelled','error'].includes(task.phase)} onClick={inspect}>检查仓库</button>}
      {preview && <div className="preview" role="region" aria-label="导入确认"><strong>确认导入对象</strong><dl><div><dt>来源</dt><dd><code>{preview.source}</code></dd></div><div><dt>默认分支</dt><dd>{preview.defaultBranch ?? '无法确定'}</dd></div><div><dt>预计提交数</dt><dd>{preview.estimatedCommitCount ?? '远程仓库将在克隆后统计'}</dd></div></dl><div className="actions"><button className="primary" onClick={start}>确认并导入</button><button className="secondary" onClick={() => setPreview(undefined)}>返回修改</button></div></div>}
      {task && <div className={`status ${task.phase}`} role="status"><progress max="100" value={task.progress} /><strong>{task.progress.toFixed(0)}% · {task.message}</strong>{task.repositoryPath && <code>{task.repositoryPath}</code>}{!['complete','cancelled','error'].includes(task.phase) && <button onClick={cancel}>取消导入</button>}{task.recoverable && <button onClick={() => { setTask(undefined); setPreview(undefined); }}>修改来源后重试</button>}</div>}{error && <p className="error" role="alert">{error}</p>}
    </section></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
