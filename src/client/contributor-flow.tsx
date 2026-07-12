import { useEffect, useMemo, useState } from 'react';
import { CONTRIBUTOR_ANALYSIS_VERSION, type ContributorEvolution } from '../shared/history';
import type { Api } from './api';
import { useHistoryStore } from './history-store';
import { historyFilterParameters } from './history-filters';

type Band = { authorId: string; name: string; path: string; aggregate: boolean };

function buildBands(evolution: ContributorEvolution): Band[] {
  const width = 1000; const height = 180; const inset = 10;
  return evolution.contributors.map((contributor, contributorIndex) => {
    const bounds = evolution.points.map((point, pointIndex) => {
      const x = evolution.points.length === 1 ? width / 2 : inset + pointIndex * (width - inset * 2) / Math.max(1, evolution.points.length - 1);
      const lower = point.shares.slice(0, contributorIndex).reduce((sum, share) => sum + share.share, 0);
      const own = point.shares[contributorIndex]?.share ?? 0;
      return { x, top: inset + (1 - lower - own) * (height - inset * 2), bottom: inset + (1 - lower) * (height - inset * 2) };
    });
    const top = bounds.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(2)},${point.top.toFixed(2)}`).join(' ');
    const bottom = [...bounds].reverse().map(point => `L${point.x.toFixed(2)},${point.bottom.toFixed(2)}`).join(' ');
    return { ...contributor, path: `${top} ${bottom} Z` };
  });
}

export function ContributorFlow({ api }: { api: Api }) {
  const store = useHistoryStore();
  const [evolution, setEvolution] = useState<ContributorEvolution>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!store.repositoryId) return;
    const controller = new AbortController(); setError('');
    const parameters = historyFilterParameters(store); parameters.set('version', String(CONTRIBUTOR_ANALYSIS_VERSION)); parameters.set('window', '12');
    api<ContributorEvolution>(`/api/repositories/${encodeURIComponent(store.repositoryId)}/contributors?${parameters}`, { signal: controller.signal })
      .then(result => {
        setEvolution(result);
        if (store.selectedContributorId) {
          const nextMajorIds = result.contributors.filter(contributor => !contributor.aggregate).map(contributor => contributor.authorId);
          const selectionStillVisible = result.contributors.some(contributor => contributor.authorId === store.selectedContributorId);
          store.selectContributor(selectionStillVisible ? store.selectedContributorId : '', nextMajorIds);
        }
      }).catch(cause => { if (cause.name !== 'AbortError') setError(cause.message); });
    return () => controller.abort();
  }, [store.repositoryId, store.query, store.author, store.refFilter, store.changeSize, store.classificationFilters]);
  const bands = useMemo(() => evolution ? buildBands(evolution) : [], [evolution]);
  const majorIds = evolution?.contributors.filter(contributor => !contributor.aggregate).map(contributor => contributor.authorId) ?? [];
  const choose = (authorId: string) => store.selectContributor(authorId, majorIds);
  return <div className="contributor-flow-panel">
    <div className="contributor-heading"><div><strong>贡献者流带</strong><p>带宽表示固定 12 个提交窗口内的变更行占比，不能代表贡献价值。</p></div>{store.selectedContributorId && <button onClick={() => choose('')}>清除贡献者选择</button>}</div>
    {evolution ? <>
      <svg className="contributor-flow" viewBox="0 0 1000 180" role="img" aria-labelledby="contributor-title contributor-description">
        <title id="contributor-title">贡献者演化流带</title><desc id="contributor-description">{evolution.points.length} 个提交，{evolution.contributors.length} 条贡献者流带</desc>
        {bands.map((band, index) => <path key={band.authorId} d={band.path} className={`contributor-band band-${index % 7} ${store.selectedContributorId === band.authorId ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`贡献者 ${band.name}`} onClick={() => choose(band.authorId)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(band.authorId); } }} />)}
      </svg>
      <div className="contributor-legend" aria-label="贡献者图例">{evolution.contributors.map((contributor, index) => <button key={contributor.authorId} className={`legend-band-${index % 7}`} aria-pressed={store.selectedContributorId === contributor.authorId} aria-label={`贡献者 ${contributor.name}`} onClick={() => choose(contributor.authorId)}>{contributor.name}{contributor.aggregate ? '（聚合）' : ''}</button>)}</div>
    </> : <p>正在计算贡献者演化…</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
