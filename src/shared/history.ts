export const REPOSITORY_INDEX_VERSION = 1 as const;
export const CHANGE_SIZE_LIMITS = { small: 10, medium: 100 } as const;
export type ChangeSizeFilter = '' | 'small' | 'medium' | 'large';

export type RepositoryRefKind = 'head' | 'remote' | 'tag';

export type RepositoryRef = {
  name: string;
  shortName: string;
  kind: RepositoryRefKind;
  oid: string;
};

export type IndexedCommit = {
  oid: string;
  parents: string[];
  author: string;
  authoredAt: string;
  subject: string;
  message: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  paths: string[];
};

export type RepositoryIndex = {
  version: typeof REPOSITORY_INDEX_VERSION;
  id: string;
  name: string;
  defaultRef: string;
  refs: RepositoryRef[];
  commits: IndexedCommit[];
};

export type RepositorySummary = Pick<RepositoryIndex, 'id' | 'name' | 'defaultRef'> & {
  commitCount: number;
};

export type TopologyNode = {
  oid: string;
  order: number;
  lane: number;
  isMainline: boolean;
};

export type TopologyEdge = { from: string; to: string };

export type RepositoryTopology = {
  mainlineRef: string;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
};
