import { create } from 'zustand';
import { OTHER_CONTRIBUTOR_ID, type ChangeSizeFilter, type CommitClassification, type CommitType, type IndexedCommit, type RepositoryPhases, type RepositoryRef, type RepositorySummary, type RepositoryTopology } from '../shared/history';
export type SemanticZoom = 'global' | 'intermediate' | 'detail';
export type HistoryUrlState = { repositoryId: string; aOid: string; bOid: string; selectedOid: string };

type HistoryState = {
  repositories: RepositorySummary[];
  repositoryId: string;
  revisionFingerprint: string;
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
  selectedContributorId: string;
  contributorMajorIds: string[];
  contributorHighlightOids: string[];
  contributorPaths: string[];
  classifications: Record<string, CommitClassification>;
  classificationFilters: CommitType[];
  phaseAnalysis?: RepositoryPhases;
  phaseOverrides: Record<string, number>;
  mainlineRef: string;
  query: string;
  author: string;
  refFilter: string;
  changeSize: ChangeSizeFilter;
  semanticZoom: SemanticZoom;
  boxedOids: string[];
  setRepositories: (repositories: RepositorySummary[]) => void;
  openRepository: (repositoryId: string) => void;
  setHistory: (commits: IndexedCommit[], refs: RepositoryRef[], topology: RepositoryTopology, revisionFingerprint: string) => void;
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
  selectContributor: (authorId: string, majorIds: string[]) => void;
  setClassifications: (classifications: CommitClassification[]) => void;
  toggleClassification: (type: CommitType) => void;
  setPhaseAnalysis: (analysis: RepositoryPhases, overrides: Record<string, number>) => void;
  setPhaseBoundary: (oid: string, order: number) => void;
  clearPhaseAnalysis: () => void;
  setMainlineRef: (mainlineRef: string) => void;
  setQuery: (query: string) => void;
  setAuthor: (author: string) => void;
  setRefFilter: (refFilter: string) => void;
  setChangeSize: (changeSize: ChangeSizeFilter) => void;
  setSemanticZoom: (semanticZoom: SemanticZoom) => void;
  setBoxedOids: (boxedOids: string[]) => void;
};

const contributorHighlight = (commits: IndexedCommit[], selectedContributorId: string, contributorMajorIds: string[]) => {
  const selected = selectedContributorId ? commits.filter(commit => selectedContributorId === OTHER_CONTRIBUTOR_ID ? !contributorMajorIds.includes(commit.authorId) : commit.authorId === selectedContributorId) : [];
  return {
    contributorHighlightOids: selected.map(commit => commit.oid),
    contributorPaths: [...new Set(selected.flatMap(commit => commit.paths))].sort((left, right) => left.localeCompare(right, 'en')),
  };
};

export const useHistoryStore = create<HistoryState>(set => ({
  repositories: [],
  repositoryId: '',
  revisionFingerprint: '',
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
  selectedContributorId: '',
  contributorMajorIds: [],
  contributorHighlightOids: [],
  contributorPaths: [],
  classifications: {},
  classificationFilters: [],
  phaseOverrides: {},
  mainlineRef: '',
  query: '',
  author: '',
  refFilter: '',
  changeSize: '',
  semanticZoom: 'intermediate',
  boxedOids: [],
  setRepositories: repositories => set({ repositories }),
  openRepository: repositoryId => set({ repositoryId, revisionFingerprint: '', selectedOid: '', aOid: '', bOid: '', hoveredOid: '', highlightedPath: '', highlightedOids: [], selectedContributorId: '', contributorMajorIds: [], contributorHighlightOids: [], contributorPaths: [], classifications: {}, classificationFilters: [], phaseAnalysis: undefined, phaseOverrides: {}, boxedOids: [], query: '', author: '', refFilter: '', changeSize: '' }),
  setHistory: (commits, refs, topology, revisionFingerprint) => set(state => {
    const available = new Set(commits.map(commit => commit.oid));
    return {
      allCommits: commits, commits, refs, topology, revisionFingerprint, mainlineRef: topology.mainlineRef,
      selectedOid: available.has(state.selectedOid) ? state.selectedOid : commits[0]?.oid ?? '',
      aOid: available.has(state.aOid) ? state.aOid : '',
      bOid: available.has(state.bOid) ? state.bOid : '',
      ...contributorHighlight(commits, state.selectedContributorId, state.contributorMajorIds),
    };
  }),
  setCommits: commits => set(state => {
    return {
      commits,
      ...contributorHighlight(commits, state.selectedContributorId, state.contributorMajorIds),
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
  selectContributor: (selectedContributorId, contributorMajorIds) => set(state => {
    return {
      selectedContributorId,
      contributorMajorIds,
      ...contributorHighlight(state.commits, selectedContributorId, contributorMajorIds),
    };
  }),
  setClassifications: results => set({ classifications: Object.fromEntries(results.map(result => [result.oid, result])) }),
  toggleClassification: type => set(state => ({ classificationFilters: state.classificationFilters.includes(type) ? state.classificationFilters.filter(current => current !== type) : [...state.classificationFilters, type].sort((left, right) => left.localeCompare(right, 'en')) })),
  setPhaseAnalysis: (phaseAnalysis, phaseOverrides) => set({ phaseAnalysis, phaseOverrides }),
  setPhaseBoundary: (oid, order) => set(state => ({ phaseOverrides: { ...state.phaseOverrides, [oid]: order } })),
  clearPhaseAnalysis: () => set({ phaseAnalysis: undefined, phaseOverrides: {} }),
  setMainlineRef: mainlineRef => set({ mainlineRef }),
  setQuery: query => set({ query }),
  setAuthor: author => set({ author }),
  setRefFilter: refFilter => set({ refFilter }),
  setChangeSize: changeSize => set({ changeSize }),
  setSemanticZoom: semanticZoom => set({ semanticZoom }),
  setBoxedOids: boxedOids => set({ boxedOids }),
}));
