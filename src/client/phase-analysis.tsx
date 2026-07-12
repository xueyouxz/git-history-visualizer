import { useEffect, useRef, useState } from 'react';
import { PHASE_ANALYSIS_VERSION, type RepositoryPhases } from '../shared/history';
import type { Api } from './api';
import { useHistoryStore } from './history-store';

type Status = 'idle' | 'loading' | 'ready' | 'closed' | 'cancelled' | 'error';

export function PhaseAnalysis({ api }: { api: Api }) {
  const store = useHistoryStore();
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const controller = useRef<AbortController | undefined>(undefined);
  const storageKey = store.repositoryId && store.revisionFingerprint ? `ghv:phases:v${PHASE_ANALYSIS_VERSION}:${store.repositoryId}:${store.revisionFingerprint}` : '';
  const load = () => {
    if (!store.repositoryId || !store.revisionFingerprint) return;
    controller.current?.abort(); const nextController = new AbortController(); controller.current = nextController;
    setStatus('loading'); setError('');
    api<RepositoryPhases>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/phases?version=${PHASE_ANALYSIS_VERSION}`, { signal: nextController.signal })
      .then(analysis => {
        if (analysis.revisionFingerprint !== store.revisionFingerprint) throw new Error('阶段结果与当前仓库修订不一致');
        let overrides: Record<string, number> = {};
        try { overrides = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, number>; } catch { localStorage.removeItem(storageKey); }
        const validOids = new Set(analysis.boundaries.map(boundary => boundary.oid));
        overrides = Object.fromEntries(Object.entries(overrides).filter(([oid, order]) => validOids.has(oid) && Number.isInteger(order) && order >= 0 && order < store.allCommits.length));
        store.setPhaseAnalysis(analysis, overrides); setStatus('ready');
      }).catch(cause => {
        if (cause.name === 'AbortError') return;
        store.clearPhaseAnalysis(); setError(cause.message); setStatus('error');
      });
  };
  useEffect(() => { if (store.repositoryId && store.revisionFingerprint) load(); return () => controller.current?.abort(); }, [store.repositoryId, store.revisionFingerprint]);
  const close = () => { controller.current?.abort(); store.clearPhaseAnalysis(); setStatus('closed'); };
  const cancel = () => { controller.current?.abort(); store.clearPhaseAnalysis(); setStatus('cancelled'); };
  const move = (oid: string, order: number) => {
    store.setPhaseBoundary(oid, order);
    localStorage.setItem(storageKey, JSON.stringify({ ...store.phaseOverrides, [oid]: order }));
  };
  if (status === 'closed') return <section className="phase-analysis"><button onClick={load}>启用阶段分析</button></section>;
  return <section className="phase-analysis" aria-label="阶段分析">
    <div className="phase-heading"><strong>阶段建议</strong><div>{status === 'ready' && <><button onClick={load}>重新分析阶段</button><button onClick={close}>关闭阶段分析</button></>}{status === 'loading' && <button onClick={cancel}>取消阶段分析</button>}</div></div>
    {status === 'loading' && <p>正在分析项目阶段…</p>}
    {status === 'cancelled' && <><p>阶段分析已取消</p><button onClick={load}>重试阶段分析</button></>}
    {status === 'error' && <><p className="error" role="alert">{error}</p><button onClick={load}>重试阶段分析</button></>}
    {status === 'ready' && store.phaseAnalysis && (store.phaseAnalysis.boundaries.length ? <ol className="phase-boundaries">{store.phaseAnalysis.boundaries.map(boundary => {
      const subject = store.allCommits.find(commit => commit.oid === boundary.oid)?.subject ?? boundary.oid.slice(0, 8);
      return <li key={boundary.oid}><label>阶段边界 {subject}<input type="range" min="0" max={Math.max(0, store.allCommits.length - 1)} value={store.phaseOverrides[boundary.oid] ?? boundary.order} aria-label={`阶段边界 ${subject}`} onChange={event => move(boundary.oid, Number(event.target.value))} /></label><small>得分 {boundary.score}：{boundary.reasons.join('；')}</small></li>;
    })}</ol> : <p>当前修订没有达到阈值的阶段边界。</p>)}
  </section>;
}
