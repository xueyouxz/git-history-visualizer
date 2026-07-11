import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import type { TaskState } from '../shared/import';

type Directory = { name: string; path: string; isGitRepository: boolean };

function App() {
  const [session, setSession] = useState<{ token: string; managedRoot: string }>();
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [source, setSource] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [task, setTask] = useState<TaskState>();
  const [error, setError] = useState('');
  const api = async (url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Session-Token': session?.token ?? '', ...init.headers } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  useEffect(() => { fetch('/api/session').then(r => r.json()).then(setSession); }, []);
  const browse = async (path?: string) => { try { const data = await api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`); setCurrentPath(data.path); setDirectories(data.directories); } catch (e) { setError(String(e)); } };
  useEffect(() => { if (session && kind === 'local') void browse(); }, [session, kind]);
  const start = async () => { try { setError(''); const next: TaskState = await api('/api/imports', { method: 'POST', body: JSON.stringify({ kind, source }) }); setTask(next); const timer = setInterval(async () => { const state: TaskState = await api(`/api/imports/${next.id}`); setTask(state); if (state.phase === 'complete' || state.phase === 'error') clearInterval(timer); }, 300); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  const saveRoot = async () => { const managedRoot = prompt('后续导入使用的受管根目录', session?.managedRoot); if (!managedRoot) return; try { const next = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ managedRoot }) }); setSession(s => s && ({ ...s, managedRoot: next.managedRoot })); } catch (e) { setError(String(e)); } };
  return <main><header><div><p className="eyebrow">本地只读工作台</p><h1>导入 Git 仓库</h1></div><button className="secondary" onClick={saveRoot}>设置存储目录</button></header>
    <section className="panel"><div className="tabs"><button aria-pressed={kind === 'local'} onClick={() => setKind('local')}>本地仓库</button><button aria-pressed={kind === 'remote'} onClick={() => setKind('remote')}>远程仓库</button></div>
      {kind === 'local' ? <div><div className="pathbar"><span>{currentPath}</span><button onClick={() => browse(currentPath.split('/').slice(0,-1).join('/') || '/')}>上一级</button></div><ul>{directories.map(d => <li key={d.path}><button onClick={() => d.isGitRepository ? setSource(d.path) : browse(d.path)}><span>{d.name}</span><small>{d.isGitRepository ? 'Git 仓库，选择' : '目录'}</small></button></li>)}</ul><label>已选仓库<input value={source} readOnly placeholder="选择上方标记为 Git 仓库的目录" /></label></div> : <label>公开 HTTPS Git URL<input value={source} onChange={e => setSource(e.target.value)} placeholder="https://github.com/owner/repository.git" /></label>}
      <p className="root">受管目录：<code>{session?.managedRoot}</code></p><button className="primary" disabled={!source || !!task && !['complete','error'].includes(task.phase)} onClick={start}>开始导入</button>
      {task && <div className={`status ${task.phase}`} role="status"><progress max="100" value={task.progress} /><strong>{task.progress.toFixed(0)}% · {task.message}</strong>{task.repositoryPath && <code>{task.repositoryPath}</code>}{task.recoverable && <button onClick={() => setTask(undefined)}>修改来源后重试</button>}</div>}{error && <p className="error" role="alert">{error}</p>}
    </section></main>;
}
createRoot(document.getElementById('root')!).render(<App />);
