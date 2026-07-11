import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile, RepositoryComparison } from '../shared/history';
import { useHistoryStore } from './history-store';
import type { Api } from './api';

type DiffView = 'split' | 'unified';

const directoryOf = (file: string) => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '根目录';
const extensionOf = (file: string) => {
  const name = file.slice(file.lastIndexOf('/') + 1); const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLocaleLowerCase() : '无扩展名';
};

function Patch({ file, view, expanded, onUnknownEncoding, onTruncated }: { file: DiffFile; view: DiffView; expanded: boolean; onUnknownEncoding: () => void; onTruncated: () => void }) {
  if (file.binary) return <p className="diff-notice">二进制文件，只显示元数据。+{file.additions}/-{file.deletions}</p>;
  if (file.unknownEncoding) return <p className="diff-notice error">无法按 UTF-8 解码，已保留元数据。 <button onClick={onUnknownEncoding}>替换无效字节后查看</button></p>;
  if (file.truncated) return <p className="diff-notice error">单文件或总差异超过数据量上限，正文未加载。 <button onClick={onTruncated}>单独加载此文件</button></p>;
  const allLines = file.patch.split('\n');
  const lines = expanded ? allLines : allLines.filter(line => /^(diff |index |--- |\+\+\+ |@@|\+|-)/.test(line));
  if (view === 'unified') return <pre className="unified-diff">{lines.join('\n')}</pre>;
  const oldLines: string[] = []; const newLines: string[] = []; let removed: string[] = []; let added: string[] = [];
  const flushChanges = () => {
    const rows = Math.max(removed.length, added.length);
    for (let index = 0; index < rows; index += 1) { oldLines.push(removed[index] ?? ''); newLines.push(added[index] ?? ''); }
    removed = []; added = [];
  };
  lines.forEach(line => {
    if (line.startsWith('-') && !line.startsWith('---')) { removed.push(line); return; }
    if (line.startsWith('+') && !line.startsWith('+++')) { added.push(line); return; }
    flushChanges(); oldLines.push(line); newLines.push(line);
  });
  flushChanges();
  return <div className="split-diff"><pre aria-label="旧版本">{oldLines.join('\n')}</pre><pre aria-label="新版本">{newLines.join('\n')}</pre></div>;
}

export function DiffInspector({ api }: { api: Api }) {
  const { repositoryId, allCommits, selectedOid, aOid, bOid, setA, setB, swapAB, clearAB } = useHistoryStore();
  const byOid = useMemo(() => new Map(allCommits.map(commit => [commit.oid, commit])), [allCommits]);
  const selected = byOid.get(selectedOid); const a = byOid.get(aOid); const b = byOid.get(bOid);
  const [comparison, setComparison] = useState<RepositoryComparison>();
  const [view, setView] = useState<DiffView>('split');
  const [expanded, setExpanded] = useState(false);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [fileType, setFileType] = useState('');
  const [parentIndex, setParentIndex] = useState<number | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [notice, setNotice] = useState('');
  const [recoveryPath, setRecoveryPath] = useState('');
  const [allowReplacement, setAllowReplacement] = useState(false);
  const requestController = useRef<AbortController | undefined>(undefined);
  const retryComparison = () => setRetry(value => value + 1);

  useEffect(() => setParentIndex(b && b.parents.length > 1 ? 0 : undefined), [bOid, b?.parents.length]);
  useEffect(() => { setRecoveryPath(''); setAllowReplacement(false); }, [aOid, bOid]);
  useEffect(() => {
    if (!repositoryId || !aOid || !bOid) { requestController.current?.abort(); setComparison(undefined); setError(''); setLoading(false); return; }
    const controller = new AbortController(); requestController.current = controller; setLoading(true); setError(''); setNotice('');
    const parameters = new URLSearchParams({ a: aOid, b: bOid });
    if (parentIndex !== undefined) parameters.set('parent', String(parentIndex));
    if (ignoreWhitespace) parameters.set('ignoreWhitespace', 'true');
    if (expanded) parameters.set('expanded', 'true');
    if (recoveryPath) parameters.set('path', recoveryPath);
    if (allowReplacement) parameters.set('allowReplacement', 'true');
    api<RepositoryComparison>(`/api/repositories/${encodeURIComponent(repositoryId)}/diff?${parameters}`, { signal: controller.signal })
      .then(result => { setComparison(result); setFileType(''); })
      .catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repositoryId, aOid, bOid, parentIndex, ignoreWhitespace, expanded, recoveryPath, allowReplacement, retry]);

  const cancel = () => { requestController.current?.abort(); setLoading(false); setNotice('差异计算已取消，已有结果与 A/B 保持不变。'); };

  const types = [...new Set((comparison?.files ?? []).map(file => extensionOf(file.path)))].sort();
  const visibleFiles = (comparison?.files ?? []).filter(file => !fileType || extensionOf(file.path) === fileType);
  const directories = visibleFiles.reduce<Map<string, DiffFile[]>>((result, file) => {
    const directory = directoryOf(file.path); result.set(directory, [...(result.get(directory) ?? []), file]); return result;
  }, new Map());
  const relationLabel = comparison?.relation === 'diverged' ? '分叉历史' : comparison?.relation === 'same' ? '同一提交' : '同祖先链';

  return <section className="diff-inspector" aria-label="A/B 版本比较">
    <p className="eyebrow">A/B 版本比较</p>
    <div className="ab-actions"><button disabled={!selected} onClick={() => selected && setA(selected.oid)}>设当前为 A</button><button disabled={!selected} onClick={() => selected && setB(selected.oid)}>设当前为 B</button><button disabled={!aOid && !bOid} onClick={swapAB}>交换 A/B</button><button disabled={!aOid && !bOid} onClick={clearAB}>清除</button></div>
    <dl className="ab-summary"><div><dt>A</dt><dd>{a ? `${a.subject} · ${a.oid.slice(0, 8)}` : '未设置'}</dd></div><div><dt>B</dt><dd>{b ? `${b.subject} · ${b.oid.slice(0, 8)}` : '未设置'}</dd></div></dl>
    {!a || !b ? <p className="muted">选择提交后显式设置 A 和 B。</p> : <>
      {b.parents.length > 1 && <label>合并比较基准<select value={parentIndex ?? 0} onChange={event => setParentIndex(Number(event.target.value))}>{b.parents.map((parent, index) => <option key={parent} value={index}>第 {index + 1} 父提交 · {parent.slice(0, 8)}</option>)}</select></label>}
      <div className="diff-toolbar"><div className="tabs"><button aria-pressed={view === 'split'} onClick={() => setView('split')}>左右对照</button><button aria-pressed={view === 'unified'} onClick={() => setView('unified')}>统一 diff</button></div><button aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? '折叠上下文' : '展开上下文'}</button><label className="inline-check"><input type="checkbox" checked={ignoreWhitespace} onChange={event => setIgnoreWhitespace(event.target.checked)} />忽略空白</label></div>
      {loading && <p role="status">正在计算差异，已有 A/B 和结果保持不变。 <button onClick={cancel}>取消计算</button></p>}
      {notice && <p role="status">{notice} <button onClick={retryComparison}>重新计算</button></p>}
      {error && <p className="error" role="alert">{error} <button onClick={retryComparison}>重试</button></p>}
      {comparison && <>
        <div className="comparison-path"><strong>快照差异：</strong>{comparison.effectiveA.slice(0, 8)} → {comparison.b.slice(0, 8)}。<strong>提交演化：</strong>{relationLabel}，共同祖先 {comparison.commonAncestor.slice(0, 8)}。<div className="evolution-paths"><span>A 路径</span><ol>{comparison.pathA.map(oid => <li key={oid}>{byOid.get(oid)?.subject ?? oid.slice(0, 8)}</li>)}</ol><span>B 路径</span><ol>{comparison.pathB.map(oid => <li key={oid}>{byOid.get(oid)?.subject ?? oid.slice(0, 8)}</li>)}</ol></div></div>
        {comparison.truncated && <p className="error">总差异超过上限，已保留已加载的文件和元数据。可在截断文件上选择单独加载。</p>}
        {recoveryPath && <p className="comparison-path">正在单独查看 <code>{recoveryPath}</code>。 <button onClick={() => setRecoveryPath('')}>返回全部文件</button></p>}
        <label>文件类型<select value={fileType} onChange={event => setFileType(event.target.value)}><option value="">全部类型</option>{types.map(type => <option key={type}>{type}</option>)}</select></label>
        <div className="diff-files">{[...directories].map(([directory, files]) => <details key={directory} open><summary>{directory}（{files.length}）</summary>{files.map(file => <article className="diff-file" key={`${file.oldPath ?? ''}-${file.path}`}><h3>{file.status === 'renamed' ? `${file.oldPath} → ${file.path}` : file.path}</h3><p className="file-meta">{file.status === 'renamed' ? `推断重命名，${file.similarity}% 相似` : file.status} · +{file.additions}/-{file.deletions}</p><Patch file={file} view={view} expanded={expanded} onUnknownEncoding={() => setAllowReplacement(true)} onTruncated={() => setRecoveryPath(file.path)} /></article>)}</details>)}</div>
      </>}
    </>}
  </section>;
}
