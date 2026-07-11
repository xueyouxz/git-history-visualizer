export type ImportPhase = 'queued' | 'cloning' | 'indexing' | 'complete' | 'cancelled' | 'error';
export type ImportRequest = { kind: 'local' | 'remote'; source: string };
export type ImportPreview = ImportRequest & { defaultBranch: string | null; estimatedCommitCount: number | null };
export type TaskState = { id: string; phase: ImportPhase; progress: number; message: string; recoverable?: boolean; repositoryPath?: string };
