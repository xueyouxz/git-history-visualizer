export type SyncPhase = 'queued' | 'fetching' | 'indexing' | 'complete' | 'cancelled' | 'error';
export type SyncTask = { id: string; repositoryId: string; phase: SyncPhase; progress: number; message: string; recoverable?: boolean; newCommits?: number; removedRefs?: number };
export const isTerminalSyncPhase = (phase: SyncPhase) => phase === 'complete' || phase === 'cancelled' || phase === 'error';
