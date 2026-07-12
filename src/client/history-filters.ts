import type { ChangeSizeFilter, CommitType } from '../shared/history';

export type HistoryFilters = {
  query: string;
  author: string;
  refFilter: string;
  changeSize: ChangeSizeFilter;
  classificationFilters: CommitType[];
};

export function historyFilterParameters(filters: HistoryFilters) {
  const parameters = new URLSearchParams();
  if (filters.query) parameters.set('query', filters.query);
  if (filters.author) parameters.set('author', filters.author);
  if (filters.refFilter) parameters.set('ref', filters.refFilter);
  if (filters.changeSize) parameters.set('changeSize', filters.changeSize);
  filters.classificationFilters.forEach(type => parameters.append('classification', type));
  return parameters;
}
