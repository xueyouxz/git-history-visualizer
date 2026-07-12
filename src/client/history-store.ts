import { create } from 'zustand';
import type { ChangeSizeFilter, IndexedCommit, RepositoryRef, RepositorySummary, RepositoryTopology } from '../shared/history';
export type SemanticZoom = 'global' | 'intermediate' | 'detail';
export type HistoryUrlState = { repositoryId: string; aOid: string; bOid: string; selectedOid: string };

type HistoryState = {
  repositories: RepositorySummary[];
  repositoryId: string;
  range: 'all';
  allCommits: IndexedCommit[];
  commits: IndexedCommit[];
  refs: RepositoryRef[];
  topology?: RepositoryTopology;
  selectedOid: string;
  aOid: string;
  bOid: string;
  hoveredOid: string;
  highlightedPath: string;
  highlightedOids: string[];
  mainlineRef: string;
  query: string;
  author: string;
  refFilter: string;
  changeSize: ChangeSizeFilter;
  semanticZoom: SemanticZoom;
  boxedOids: string[];
  setRepositories: (repositories: RepositorySummary[]) => void;
  openRepository: (repositoryId: string) => void;
  setHistory: (commits: IndexedCommit[], refs: RepositoryRef[], topology: RepositoryTopology) => void;
  setCommits: (commits: IndexedCommit[]) => void;
  setTopology: (topology: RepositoryTopology) => void;
  select: (oid: string) => void;
  setA: (oid: string) => void;
  setB: (oid: string) => void;
  swapAB: () => void;
  clearAB: () => void;
  restoreUrlState: (urlState: HistoryUrlState) => void;
  hover: (oid: string) => void;
  highlightPath: (path: string) => void;
  setMainlineRef: (mainlineRef: string) => void;
  setQuery: (query: string) => void;
  setAuthor: (author: string) => void;
  setRefFilter: (refFilter: string) => void;
  setChangeSize: (changeSize: ChangeSizeFilter) => void;
  setSemanticZoom: (semanticZoom: SemanticZoom) => void;
  setBoxedOids: (boxedOids: string[]) => void;
};

export const useHistoryStore = create<HistoryState>(set => ({
  repositories: [],
  repositoryId: '',
  range: 'all',
  allCommits: [],
  commits: [],
  refs: [],
  selectedOid: '',
  aOid: '',
  bOid: '',
  hoveredOid: '',
  highlightedPath: '',
  highlightedOids: [],
  mainlineRef: '',
  query: '',
  author: '',
  refFilter: '',
  changeSize: '',
  semanticZoom: 'intermediate',
  boxedOids: [],
  setRepositories: repositories => set({ repositories }),
  openRepository: repositoryId => set({ repositoryId, selectedOid: '', aOid: '', bOid: '', hoveredOid: '', highlightedPath: '', highlightedOids: [], boxedOids: [], query: '', author: '', refFilter: '', changeSize: '' }),
  setHistory: (commits, refs, topology) => set(state => {
    const available = new Set(commits.map(commit => commit.oid));
    return {
      allCommits: commits, commits, refs, topology, mainlineRef: topology.mainlineRef,
      selectedOid: available.has(state.selectedOid) ? state.selectedOid : commits[0]?.oid ?? '',
      aOid: available.has(state.aOid) ? state.aOid : '',
      bOid: available.has(state.bOid) ? state.bOid : '',
    };
  }),
  setCommits: commits => set(state => {
    const visible = new Set(commits.map(commit => commit.oid));
    return {
      commits,
      selectedOid: visible.has(state.selectedOid) ? state.selectedOid : commits[0]?.oid ?? '',
      boxedOids: state.boxedOids.filter(oid => visible.has(oid)),
    };
  }),
  setTopology: topology => set({ topology, mainlineRef: topology.mainlineRef }),
  select: selectedOid => set({ selectedOid }),
  setA: aOid => set({ aOid }),
  setB: bOid => set({ bOid }),
  swapAB: () => set(state => ({ aOid: state.bOid, bOid: state.aOid })),
  clearAB: () => set({ aOid: '', bOid: '' }),
  restoreUrlState: urlState => set(urlState),
  hover: hoveredOid => set({ hoveredOid }),
  highlightPath: highlightedPath => set(state => ({
    highlightedPath,
    highlightedOids: highlightedPath ? state.allCommits.filter(commit => commit.paths.some(path => path === highlightedPath || path.startsWith(`${highlightedPath}/`))).map(commit => commit.oid) : [],
  })),
  setMainlineRef: mainlineRef => set({ mainlineRef }),
  setQuery: query => set({ query }),
  setAuthor: author => set({ author }),
  setRefFilter: refFilter => set({ refFilter }),
  setChangeSize: changeSize => set({ changeSize }),
  setSemanticZoom: semanticZoom => set({ semanticZoom }),
  setBoxedOids: boxedOids => set({ boxedOids }),
}));
