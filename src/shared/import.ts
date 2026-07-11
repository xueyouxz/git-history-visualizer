export type ImportPhase = 'queued' | 'cloning' | 'indexing' | 'complete' | 'error';
export type ImportRequest = { kind: 'local' | 'remote'; source: string };
export type TaskState = { id: string; phase: ImportPhase; progress: number; message: string; recoverable?: boolean; repositoryPath?: string };
