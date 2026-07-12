export const REPOSITORY_INDEX_VERSION = 2 as const;
export const CONTRIBUTOR_ANALYSIS_VERSION = 1 as const;
export const OTHER_CONTRIBUTOR_ID = 'other' as const;
export const COMMIT_CLASSIFICATION_VERSION = 1 as const;
export const PHASE_ANALYSIS_VERSION = 1 as const;
export const COMMIT_TYPES = ['feature', 'fix', 'refactor', 'test', 'docs', 'build/config', 'merge', 'mixed'] as const;
export type CommitType = typeof COMMIT_TYPES[number];
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
  authorId: string;
  authoredAt: string;
  subject: string;
  message: string;
  additions: number;
  deletions: number;
  filesChanged: number;
  paths: string[];
};

export type ContributorIdentity = { authorId: string; name: string; aggregate: boolean };
export type ContributorShare = { authorId: string; lines: number; share: number };
export type ContributorPoint = { oid: string; order: number; shares: ContributorShare[] };
export type ContributorEvolution = {
  version: typeof CONTRIBUTOR_ANALYSIS_VERSION;
  revisionFingerprint: string;
  windowSize: number;
  contributors: ContributorIdentity[];
  points: ContributorPoint[];
};

export type CommitClassification = { oid: string; type: CommitType; reasons: string[]; confidence: number };
export type RepositoryClassifications = {
  version: typeof COMMIT_CLASSIFICATION_VERSION;
  revisionFingerprint: string;
  results: CommitClassification[];
};

export type PhaseBoundary = { oid: string; order: number; score: number; reasons: string[] };
export type RepositoryPhases = {
  version: typeof PHASE_ANALYSIS_VERSION;
  revisionFingerprint: string;
  boundaries: PhaseBoundary[];
};

export type RepositoryIndex = {
  version: typeof REPOSITORY_INDEX_VERSION;
  id: string;
  name: string;
  revisionFingerprint: string;
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

export type RepositoryTreeEntry = {
  path: string;
  type: 'tree' | 'blob';
  oid: string;
  bytes?: number;
};

export type RepositoryTree = {
  oid: string;
  path: string;
  entries: RepositoryTreeEntry[];
};

export const DIFF_LIMITS = { fileBytes: 512 * 1024, recoveryFileBytes: 2 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 } as const;
export type DiffRelation = 'same' | 'a-ancestor-of-b' | 'b-ancestor-of-a' | 'diverged';
export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type DiffFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
  binary: boolean;
  unknownEncoding: boolean;
  truncated: boolean;
  similarity?: number;
  inferred: boolean;
  patch: string;
};

export type RepositoryComparison = {
  a: string;
  b: string;
  effectiveA: string;
  parentIndex?: number;
  relation: DiffRelation;
  commonAncestor: string;
  pathA: string[];
  pathB: string[];
  files: DiffFile[];
  truncated: boolean;
  totalPatchBytes: number;
};
