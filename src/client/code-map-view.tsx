import { useEffect, useMemo, useRef, useState } from 'react';
import type { RepositoryComparison, RepositoryTree } from '../shared/history';
import type { Api } from './api';
import { useHistoryStore } from './history-store';
import { buildCodeMapLayout, buildPlaybackSequence, listCodeMapDirectories, type RenamePair } from './code-map';

const statusLabel = { unchanged: '未变', added: '新增', modified: '修改', deleted: '删除', renamed: '推断重命名' } as const;

export function CodeMap({ api }: { api: Api }) {
  const store = useHistoryStore();
  const [currentPath, setCurrentPath] = useState('');
  const [before, setBefore] = useState<RepositoryTree>();
  const [after, setAfter] = useState<RepositoryTree>();
  const [renames, setRenames] = useState<RenamePair[]>([]);
  const [error, setError] = useState('');
  const [pathMode, setPathMode] = useState<'mainline' | 'selected'>('mainline');
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const playback = useRef({ run: 0, index: 0, sequence: [] as string[], timer: 0 });
  const targetOid = store.aOid && store.bOid ? store.bOid : store.selectedOid;
  const beforeOid = store.aOid && store.bOid ? store.aOid : '';

  useEffect(() => { setCurrentPath(''); }, [store.repositoryId, beforeOid, targetOid]);
  useEffect(() => {
    if (!store.repositoryId || !targetOid) return;
    const controller = new AbortController(); setError('');
    const tree = (oid: string) => api<RepositoryTree>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/tree?oid=${oid}&path=`, { signal: controller.signal });
    Promise.all([
      tree(targetOid),
      beforeOid ? tree(beforeOid) : Promise.resolve(undefined),
      beforeOid ? api<RepositoryComparison>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/diff?a=${beforeOid}&b=${targetOid}`, { signal: controller.signal }) : Promise.resolve(undefined),
    ]).then(([nextAfter, nextBefore, comparison]) => {
      setAfter(nextAfter); setBefore(nextBefore);
      setRenames(comparison?.files.filter(file => file.status === 'renamed' && file.oldPath).map(file => ({ oldPath: file.oldPath!, path: file.path })) ?? []);
    }).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [store.repositoryId, beforeOid, targetOid]);

  const rectangles = useMemo(() => after ? buildCodeMapLayout(before, after, currentPath, renames, 1000, 300) : [], [before, after, currentPath, renames]);
  const contributorPaths = new Set(store.contributorPaths);
  const directories = useMemo(() => listCodeMapDirectories(rectangles, currentPath), [currentPath, rectangles]);
  const crumbs = currentPath ? currentPath.split('/') : [];

  const clearTimer = () => window.clearTimeout(playback.current.timer);
  const schedule = (run: number) => {
    clearTimer();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    playback.current.timer = window.setTimeout(() => {
      if (playback.current.run !== run || pausedRef.current) return;
      playback.current.index += 1;
      const oid = playback.current.sequence[playback.current.index];
      if (!oid) { setPlaying(false); return; }
      store.select(oid);
      if (playback.current.index === playback.current.sequence.length - 1) setPlaying(false); else schedule(run);
    }, reduced ? 0 : 260);
  };
  const start = () => {
    const mainline = pathMode === 'mainline' ? new Set(store.topology?.nodes.filter(node => node.isMainline).map(node => node.oid)) : undefined;
    const sequence = buildPlaybackSequence(store.allCommits, mainline, store.selectedOid, pathMode === 'selected' ? store.boxedOids : undefined);
    if (!sequence.length) { setError(pathMode === 'selected' ? '框选提交不构成连续拓扑路径' : '当前路径没有可播放提交'); return; }
    setError('');
    const run = playback.current.run + 1; playback.current = { run, index: 0, sequence, timer: 0 };
    pausedRef.current = false; setPaused(false); setPlaying(sequence.length > 1); store.select(sequence[0]); if (sequence.length > 1) schedule(run);
  };
  const pause = () => { clearTimer(); pausedRef.current = true; setPaused(true); };
  const resume = () => { pausedRef.current = false; setPaused(false); schedule(playback.current.run); };
  const cancel = () => { playback.current.run += 1; clearTimer(); pausedRef.current = false; setPaused(false); setPlaying(false); };
  useEffect(() => () => clearTimer(), []);

  return <div className="code-map-panel">
    <div className="code-map-toolbar">
      <p><strong>代码地图</strong>，面积表示 Git blob 字节数</p>
      <label>播放路径<select value={pathMode} onChange={event => setPathMode(event.target.value as typeof pathMode)}><option value="mainline">主线 first-parent</option><option value="selected">当前框选拓扑路径</option></select></label>
      {!playing && !paused && <button onClick={start}>播放{pathMode === 'mainline' ? '主线' : '选定'}路径</button>}
      {playing && !paused && <button onClick={pause}>暂停播放</button>}
      {playing && paused && <button onClick={resume}>继续播放</button>}
      {(playing || paused) && <button onClick={cancel}>取消播放</button>}
    </div>
    <nav className="breadcrumbs" aria-label="代码地图路径"><button onClick={() => setCurrentPath('')}>根目录</button>{crumbs.map((crumb, index) => <span key={`${crumb}-${index}`}> / <button onClick={() => setCurrentPath(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button></span>)}</nav>
    <div className="code-map-legend" aria-label="代码地图图例">{Object.entries(statusLabel).map(([status, label]) => <span key={status} className={`legend-${status}`}>{label}</span>)}</div>
    <div className="code-map-canvas" role="img" aria-label={`${rectangles.length} 个文件的代码地图`}>
      {rectangles.map(rectangle => <button key={rectangle.path} className={`map-file ${rectangle.status} ${contributorPaths.has(rectangle.path) ? 'contributor-related' : ''}`} style={{ left: `${rectangle.x / 10}%`, top: `${rectangle.y / 3}%`, width: `${rectangle.width / 10}%`, height: `${rectangle.height / 3}%` }} aria-label={`${rectangle.name}，${rectangle.bytes} 字节，${statusLabel[rectangle.status]}`} title={`${rectangle.path} · ${rectangle.bytes} 字节 · ${statusLabel[rectangle.status]}`} onMouseEnter={() => store.highlightPath(rectangle.path)} onMouseLeave={() => store.highlightPath('')}><span>{rectangle.name}</span><small>{rectangle.bytes} B</small></button>)}
      {directories.map(directory => <div key={directory.path} className="map-directory" style={{ left: `${directory.x / 10}%`, top: `${directory.y / 3}%`, width: `${directory.width / 10}%`, height: `${directory.height / 3}%` }}><button aria-label={`目录 ${directory.path}`} onClick={() => setCurrentPath(directory.path)}>{directory.name}/</button></div>)}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
