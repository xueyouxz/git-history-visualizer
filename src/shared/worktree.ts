export type WorktreeTarget = 'terminal' | 'editor';
export type ManagedWorktree = { repositoryId: string; oid: string; path: string; createdAt: string; dirty: boolean; status: string; reused?: boolean };
