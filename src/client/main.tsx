import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { curveBumpX, line, pointer, select, zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3';
import './style.css';
import { isTerminalImportPhase, type ImportPreview, type TaskState } from '../shared/import';
import { CHANGE_SIZE_LIMITS, type ChangeSizeFilter, type IndexedCommit, type RepositoryIndex, type RepositoryRef, type RepositorySummary, type RepositoryTopology } from '../shared/history';
import { useHistoryStore, type SemanticZoom } from './history-store';
import { DiffInspector } from './diff-inspector';
import { CodeMap } from './code-map-view';
import { ContributorFlow } from './contributor-flow';
import type { Api } from './api';

type Session = { token: string; managedRoot: string };
type Directory = { name: string; path: string; isGitRepository: boolean };

function ImportPanel({ session, api, onImported, onRootChanged }: { session: Session; api: Api; onImported: () => void; onRootChanged: (managedRoot: string) => void }) {
  const [kind, setKind] = useState<'local' | 'remote'>('local');
  const [source, setSource] = useState('');
  const [currentPath, setCurrentPath] = useState('');
  const [directories, setDirectories] = useState<Directory[]>([]);
  const [preview, setPreview] = useState<ImportPreview>();
  const [task, setTask] = useState<TaskState>();
  const [error, setError] = useState('');
  const streamController = useRef<AbortController | undefined>(undefined);
  const browse = async (next?: string) => {
    try {
      const data = await api<{ path: string; directories: Directory[] }>(`/api/browse${next ? `?path=${encodeURIComponent(next)}` : ''}`);
      setCurrentPath(data.path); setDirectories(data.directories);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => { if (kind === 'local') void browse(); }, [kind]);
  useEffect(() => () => streamController.current?.abort(), []);
  const choose = (next: string) => { setSource(next); setPreview(undefined); setTask(undefined); };
  const inspect = async () => {
    try { setError(''); setPreview(await api('/api/imports/preview', { method: 'POST', body: JSON.stringify({ kind, source }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const stream = async (id: string) => {
    const controller = new AbortController(); streamController.current?.abort(); streamController.current = controller;
    const response = await fetch(`/api/imports/${id}/events`, { headers: { 'X-Session-Token': session.token }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error('无法读取导入进度');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
    while (true) {
      const { done, value } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find(part => part.startsWith('data: '));
        if (data) { const state = JSON.parse(data.slice(6)) as TaskState; setTask(state); if (state.phase === 'complete') onImported(); }
      }
      if (done) break;
    }
  };
  const start = async () => {
    if (!preview) return;
    try {
      setError(''); const created = await api<TaskState>('/api/imports', { method: 'POST', body: JSON.stringify({ kind: preview.kind, source: preview.source }) });
      setPreview(undefined); setTask(created); await stream(created.id);
    } catch (cause) { if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const cancel = async () => { if (task) setTask(await api(`/api/imports/${task.id}`, { method: 'DELETE' })); };
  const saveRoot = async () => {
    const managedRoot = window.prompt('后续导入使用的受管根目录', session.managedRoot);
    if (!managedRoot) return;
    try { const changed = await api<{ managedRoot: string }>('/api/settings', { method: 'PUT', body: JSON.stringify({ managedRoot }) }); onRootChanged(changed.managedRoot); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <section className="import-panel" aria-label="导入仓库">
    <div className="tabs"><button aria-pressed={kind === 'local'} onClick={() => { setKind('local'); choose(''); }}>本地仓库</button><button aria-pressed={kind === 'remote'} onClick={() => { setKind('remote'); choose(''); }}>远程仓库</button></div>
    {kind === 'local' ? <><div className="pathbar"><span>{currentPath}</span><button onClick={() => void browse(currentPath.split('/').slice(0, -1).join('/') || '/')}>上一级</button></div><ul className="directories">{directories.map(directory => <li key={directory.path}><button onClick={() => directory.isGitRepository ? choose(directory.path) : void browse(directory.path)}><span>{directory.name}</span><small>{directory.isGitRepository ? 'Git 仓库，选择' : '目录'}</small></button></li>)}</ul><label>已选仓库<input value={source} readOnly placeholder="选择 Git 仓库目录" /></label></> : <label>公开 HTTPS Git URL<input value={source} onChange={event => choose(event.target.value)} /></label>}
    <p className="muted">受管目录：<code>{session.managedRoot}</code></p><button onClick={() => void saveRoot()}>设置存储目录</button>
    {!preview && <button className="primary" disabled={!source || !!task && !isTerminalImportPhase(task.phase)} onClick={() => void inspect()}>检查仓库</button>}
    {preview && <div className="preview"><strong>确认导入对象</strong><p><code>{preview.source}</code></p><p>默认分支：{preview.defaultBranch ?? '无法确定'}，预计提交：{preview.estimatedCommitCount ?? '克隆后统计'}</p><div className="actions"><button className="primary" onClick={() => void start()}>确认并导入</button><button onClick={() => setPreview(undefined)}>返回修改</button></div></div>}
    {task && <div className={`status ${task.phase}`} role="status"><progress max="100" value={task.progress} /><strong>{task.progress.toFixed(0)}% · {task.message}</strong>{!isTerminalImportPhase(task.phase) && <button onClick={() => void cancel()}>取消导入</button>}</div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}

const zoomScale: Record<SemanticZoom, number> = { global: .62, intermediate: 1, detail: 1.5 };

function HistoryGraph() {
  const { commits, refs, topology, selectedOid, hoveredOid, highlightedOids, contributorHighlightOids, aOid, bOid, semanticZoom, boxedOids, select: selectCommit, hover, setSemanticZoom, setBoxedOids } = useHistoryStore();
  const svgRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | undefined>(undefined);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [boxStart, setBoxStart] = useState<[number, number]>();
  const [boxEnd, setBoxEnd] = useState<[number, number]>();
  const commitMap = useMemo(() => new Map(commits.map(commit => [commit.oid, commit])), [commits]);
  const nodes = useMemo(() => (topology?.nodes ?? []).filter(node => commitMap.has(node.oid)), [topology, commitMap]);
  const positions = useMemo(() => new Map(nodes.map(node => [node.oid, { x: 72 + node.order * 138, y: 74 + node.lane * 74 }])), [nodes]);
  const graphWidth = Math.max(960, 144 + Math.max(0, nodes.length - 1) * 138);
  const graphHeight = Math.max(320, 148 + Math.max(0, ...nodes.map(node => node.lane)) * 74);
  const relations = useMemo(() => {
    if (!hoveredOid) return new Set<string>();
    const related = new Set([hoveredOid]); const children = new Map<string, string[]>();
    commits.forEach(commit => commit.parents.forEach(parent => children.set(parent, [...(children.get(parent) ?? []), commit.oid])));
    const visit = (start: string, direction: 'parents' | 'children') => {
      const pending = [start];
      while (pending.length) { const oid = pending.pop()!; const next = direction === 'parents' ? commitMap.get(oid)?.parents ?? [] : children.get(oid) ?? []; next.forEach(item => { if (!related.has(item)) { related.add(item); pending.push(item); } }); }
    };
    visit(hoveredOid, 'parents'); visit(hoveredOid, 'children'); return related;
  }, [commits, commitMap, hoveredOid]);
  const refsByOid = useMemo(() => {
    const result = new Map<string, RepositoryRef[]>(); refs.forEach(ref => result.set(ref.oid, [...(result.get(ref.oid) ?? []), ref])); return result;
  }, [refs]);
  useEffect(() => {
    if (!svgRef.current) return;
    const behavior = zoom<SVGSVGElement, unknown>().filter(event => {
      const target = event.target;
      return !event.shiftKey && !(target instanceof Element && target.closest('.node-hit')) && (!event.ctrlKey || event.type === 'wheel') && !event.button;
    }).scaleExtent([.35, 2.4]).on('zoom', event => {
      setTransform(event.transform);
      setSemanticZoom(event.transform.k < .78 ? 'global' : event.transform.k < 1.28 ? 'intermediate' : 'detail');
    });
    zoomRef.current = behavior; select(svgRef.current).call(behavior);
    return () => { if (svgRef.current) select(svgRef.current).on('.zoom', null); };
  }, [setSemanticZoom]);
  const setLevel = (level: SemanticZoom) => {
    if (!svgRef.current || !zoomRef.current) return;
    const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
    select(svgRef.current).transition().duration(duration).call(zoomRef.current.transform, zoomIdentity.scale(zoomScale[level]));
  };
  const edgePath = line<[number, number]>().x(point => point[0]).y(point => point[1]).curve(curveBumpX);
  const finishBox = () => {
    if (!boxStart || !boxEnd) return;
    const [[left, top], [right, bottom]] = [[Math.min(boxStart[0], boxEnd[0]), Math.min(boxStart[1], boxEnd[1])], [Math.max(boxStart[0], boxEnd[0]), Math.max(boxStart[1], boxEnd[1])]];
    setBoxedOids(nodes.filter(node => { const position = positions.get(node.oid)!; const x = position.x * transform.k + transform.x; const y = position.y * transform.k + transform.y; return x >= left && x <= right && y >= top && y <= bottom; }).map(node => node.oid));
    setBoxStart(undefined); setBoxEnd(undefined);
  };
  return <section className="graph-panel" aria-label="提交拓扑">
    <div className="graph-toolbar"><strong>提交拓扑</strong><div className="zoom-levels" aria-label="语义缩放">{(['global', 'intermediate', 'detail'] as const).map(level => <button key={level} aria-pressed={semanticZoom === level} onClick={() => setLevel(level)}>{level === 'global' ? '全局' : level === 'intermediate' ? '中级' : '细节'}</button>)}</div></div>
    <svg ref={svgRef} className="dag" viewBox="0 0 1000 430" role="img" aria-labelledby="dag-title dag-description" onPointerDown={event => { if (event.shiftKey) { const point = pointer(event); setBoxStart(point); setBoxEnd(point); event.currentTarget.setPointerCapture(event.pointerId); } }} onPointerMove={event => { if (boxStart) setBoxEnd(pointer(event)); }} onPointerUp={finishBox}>
      <title id="dag-title">横向提交拓扑图</title><desc id="dag-description">{nodes.length} 个提交，主线 {topology?.mainlineRef ?? '未选择'}，已选 {commitMap.get(selectedOid)?.subject ?? '无'}</desc>
      <g transform={transform.toString()}>
        {(topology?.edges ?? []).filter(edge => commitMap.has(edge.from) && commitMap.has(edge.to)).map(edge => { const from = positions.get(edge.from); const to = positions.get(edge.to); return from && to ? <path key={`${edge.from}-${edge.to}`} className={`edge ${relations.has(edge.from) && relations.has(edge.to) ? 'related' : ''}`} d={edgePath([[from.x, from.y], [to.x, to.y]]) ?? ''} /> : null; })}
        {nodes.map(node => { const commit = commitMap.get(node.oid); const position = positions.get(node.oid)!; const labels = refsByOid.get(node.oid) ?? []; const active = node.oid === selectedOid; const related = relations.has(node.oid); const pathRelated = highlightedOids.includes(node.oid); const contributorRelated = contributorHighlightOids.includes(node.oid); const isA = node.oid === aOid; const isB = node.oid === bOid; const visibleLabel = semanticZoom !== 'global' || active || node.oid === hoveredOid; return <g key={node.oid} className={`commit-node ${active ? 'selected' : ''} ${related ? 'related' : ''} ${pathRelated ? 'path-related' : ''} ${contributorRelated ? 'contributor-related' : ''} ${isA || isB ? 'compared' : ''}`} transform={`translate(${position.x} ${position.y})`} onMouseEnter={() => hover(node.oid)} onMouseLeave={() => hover('')}>
          <circle r={active ? 11 : 8} className={node.isMainline ? 'mainline' : 'branch'} />{isA && <g className="ab-marker marker-a" transform="translate(-20 -20)"><rect x="-8" y="-8" width="16" height="16" /><text y="4">A</text></g>}{isB && <g className="ab-marker marker-b" transform="translate(20 -20)"><path d="M 0 -10 L 10 0 L 0 10 L -10 0 Z" /><text y="4">B</text></g>}<foreignObject x={-15} y={-15} width={30} height={30}><button className="node-hit" aria-label={`${commit?.subject}，${commit?.author}，${node.oid}${isA ? '，版本 A' : ''}${isB ? '，版本 B' : ''}`} onClick={() => selectCommit(node.oid)} /></foreignObject><text className="oid" y={-15}>{node.oid.slice(0, 8)}</text>{visibleLabel && <text className="subject" y={26}>{commit?.subject.slice(0, semanticZoom === 'detail' ? 42 : 24)}</text>}{semanticZoom === 'detail' && <text className="meta" y={43}>{commit?.author} · +{commit?.additions}/-{commit?.deletions}</text>}{labels.map((ref, index) => <text key={ref.name} className={`ref-label ${ref.kind}`} y={-31 - index * 15}>{ref.shortName}</text>)}</g>; })}
      </g>
      {boxStart && boxEnd && <rect className="selection-box" x={Math.min(boxStart[0], boxEnd[0])} y={Math.min(boxStart[1], boxEnd[1])} width={Math.abs(boxEnd[0] - boxStart[0])} height={Math.abs(boxEnd[1] - boxStart[1])} />}
    </svg>
    <p className="graph-caption">Shift 加拖动可框选。{boxedOids.length ? `已框选 ${boxedOids.length} 个提交，共 ${boxedOids.reduce((total, oid) => total + (commitMap.get(oid)?.additions ?? 0) + (commitMap.get(oid)?.deletions ?? 0), 0)} 行变更。` : `画布 ${graphWidth} × ${graphHeight}，滚轮或按钮缩放。`}</p>
    <details className="graph-summary"><summary>拓扑文本摘要</summary><ol>{nodes.map(node => <li key={node.oid}><button onClick={() => selectCommit(node.oid)} aria-current={node.oid === selectedOid ? 'true' : undefined}>{commitMap.get(node.oid)?.subject}，{commitMap.get(node.oid)?.author}，轨道 {node.lane}，{node.oid.slice(0, 12)}</button></li>)}</ol></details>
  </section>;
}

function Workspace({ api }: { api: Api }) {
  const store = useHistoryStore();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dockMode, setDockMode] = useState<'diff' | 'map' | 'contributors' | 'combined'>('diff');
  const selected = store.commits.find(commit => commit.oid === store.selectedOid);
  const hovered = store.commits.find(commit => commit.oid === store.hoveredOid);
  const authors = [...new Set(store.allCommits.map(commit => commit.author))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  useEffect(() => {
    if (!store.repositoryId) return;
    const controller = new AbortController(); setLoading(true); setError('');
    Promise.all([
      api<RepositoryIndex>(`/api/repositories/${encodeURIComponent(store.repositoryId)}`, { signal: controller.signal }),
      api<RepositoryTopology>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/topology`, { signal: controller.signal }),
    ]).then(([index, topology]) => store.setHistory(index.commits, index.refs, topology)).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [store.repositoryId]);
  useEffect(() => {
    if (!store.repositoryId) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const parameters = new URLSearchParams(); if (store.query) parameters.set('query', store.query); if (store.author) parameters.set('author', store.author); if (store.refFilter) parameters.set('ref', store.refFilter); if (store.changeSize) parameters.set('changeSize', store.changeSize);
      api<IndexedCommit[]>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/commits?${parameters}`, { signal: controller.signal }).then(store.setCommits).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [store.repositoryId, store.query, store.author, store.refFilter, store.changeSize]);
  useEffect(() => {
    if (!store.repositoryId) return;
    const parameters = new URLSearchParams(); parameters.set('repository', store.repositoryId);
    if (store.aOid) parameters.set('a', store.aOid); if (store.bOid) parameters.set('b', store.bOid); if (store.selectedOid) parameters.set('selected', store.selectedOid);
    window.history.replaceState(null, '', `${window.location.pathname}?${parameters}`);
  }, [store.repositoryId, store.aOid, store.bOid, store.selectedOid]);
  const switchMainline = async (mainlineRef: string) => {
    try { const topology = await api<RepositoryTopology>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/topology?mainlineRef=${encodeURIComponent(mainlineRef)}`); store.setTopology(topology); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <div className="workspace">
    <aside className="sidebar"><label>仓库<select value={store.repositoryId} onChange={event => store.openRepository(event.target.value)}>{store.repositories.map(repository => <option key={repository.id} value={repository.id}>{repository.name} ({repository.commitCount})</option>)}</select></label><label>主线<select value={store.mainlineRef} onChange={event => void switchMainline(event.target.value)}>{store.refs.map(ref => <option key={ref.name} value={ref.name}>{ref.shortName}</option>)}</select></label><label>搜索<input type="search" value={store.query} onChange={event => store.setQuery(event.target.value)} placeholder="消息、OID、作者或路径" /></label><label>作者<select value={store.author} onChange={event => store.setAuthor(event.target.value)}><option value="">全部作者</option>{authors.map(author => <option key={author}>{author}</option>)}</select></label><label>引用<select value={store.refFilter} onChange={event => store.setRefFilter(event.target.value)}><option value="">全部引用</option>{store.refs.map(ref => <option key={ref.name} value={ref.name}>{ref.shortName}</option>)}</select></label><label>变更规模<select value={store.changeSize} onChange={event => store.setChangeSize(event.target.value as ChangeSizeFilter)}><option value="">全部规模</option><option value="small">小，最多 {CHANGE_SIZE_LIMITS.small} 行</option><option value="medium">中，{CHANGE_SIZE_LIMITS.small + 1}–{CHANGE_SIZE_LIMITS.medium} 行</option><option value="large">大，超过 {CHANGE_SIZE_LIMITS.medium} 行</option></select></label><p className="muted">当前范围：全部可达提交</p></aside>
    <HistoryGraph />
    <aside className="inspector"><p className="eyebrow">提交检查器</p>{loading ? <p>正在索引…</p> : selected ? <><h2>{selected.subject}</h2><code className="full-oid">{selected.oid}</code><dl><div><dt>作者</dt><dd>{selected.author}</dd></div><div><dt>父提交</dt><dd>{selected.parents.length || '无'} 个</dd></div><div><dt>变更</dt><dd>{selected.filesChanged} 文件，+{selected.additions}/-{selected.deletions}</dd></div></dl><p>{selected.message}</p><h3>相关路径</h3><ul className="paths">{(hovered ?? selected).paths.map(path => <li key={path}><code>{path}</code></li>)}</ul></> : <p>当前筛选没有提交。</p>}{error && <p className="error" role="alert">{error}</p>}</aside>
    <section className="analysis-dock" aria-label="分析坞">
      <div className="dock-tabs" role="tablist" aria-label="分析视图">
        <button role="tab" aria-selected={dockMode === 'diff'} onClick={() => setDockMode('diff')}>差异</button>
        <button role="tab" aria-selected={dockMode === 'map'} onClick={() => setDockMode('map')}>代码地图</button>
        <button role="tab" aria-selected={dockMode === 'contributors'} onClick={() => setDockMode('contributors')}>贡献者</button>
        <button role="tab" aria-selected={dockMode === 'combined'} onClick={() => setDockMode('combined')}>并列分析</button>
      </div>
      {dockMode === 'diff' ? <DiffInspector api={api} /> : dockMode === 'map' ? <CodeMap api={api} /> : dockMode === 'contributors' ? <ContributorFlow api={api} /> : <div className="analysis-side-by-side"><CodeMap api={api} /><ContributorFlow api={api} /></div>}
    </section>
  </div>;
}

function App() {
  const [session, setSession] = useState<Session>();
  const [showImport, setShowImport] = useState(false);
  const { repositories, repositoryId, setRepositories, openRepository, restoreUrlState } = useHistoryStore();
  const api: Api = async <T,>(url: string, init: RequestInit = {}) => {
    const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', 'X-Session-Token': session?.token ?? '', ...init.headers } });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data as T;
  };
  const loadRepositories = async () => {
    const next = await api<RepositorySummary[]>('/api/repositories'); setRepositories(next);
    if (!repositoryId && next[0]) {
      const parameters = new URLSearchParams(window.location.search); const requested = parameters.get('repository');
      const repository = next.find(item => item.id === requested) ?? next[0];
      restoreUrlState({ repositoryId: repository.id, aOid: parameters.get('a') ?? '', bOid: parameters.get('b') ?? '', selectedOid: parameters.get('selected') ?? '' });
    }
    if (next.length) setShowImport(false);
  };
  useEffect(() => { fetch('/api/session').then(response => response.json()).then(setSession); }, []);
  useEffect(() => { if (session) void loadRepositories(); }, [session]);
  if (!session) return <main className="loading">正在启动本地工作台…</main>;
  return <main><header><div><p className="eyebrow">本地只读工作台</p><h1>{repositories.length && !showImport ? 'Git 历史可视化' : '导入 Git 仓库'}</h1></div><div className="actions">{repositories.length > 0 && <button onClick={() => setShowImport(value => !value)}>{showImport ? '返回历史' : '导入其他仓库'}</button>}</div></header>{showImport || repositories.length === 0 ? <ImportPanel session={session} api={api} onImported={() => void loadRepositories()} onRootChanged={managedRoot => setSession(current => current && ({ ...current, managedRoot }))} /> : <Workspace api={api} />}</main>;
}

createRoot(document.getElementById('root')!).render(<App />);
