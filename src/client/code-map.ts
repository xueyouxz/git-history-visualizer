import type { RepositoryTree } from '../shared/history';

export type CodeMapStatus = 'unchanged' | 'added' | 'modified' | 'deleted' | 'renamed';
export type RenamePair = { oldPath: string; path: string };
export type CodeMapRectangle = {
  path: string;
  name: string;
  bytes: number;
  status: CodeMapStatus;
  renamedFrom?: string;
  renamedTo?: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
export type CodeMapDirectory = { name: string; path: string; x: number; y: number; width: number; height: number };

type TreeCommit = { oid: string; parents: string[] };
type LayoutNode = { name: string; path: string; bytes: number; children: LayoutNode[]; file?: Omit<CodeMapRectangle, 'x' | 'y' | 'width' | 'height'> };

const relativeTo = (entryPath: string, currentPath: string) => currentPath ? entryPath.slice(currentPath.length + 1) : entryPath;

export function buildCodeMapLayout(a: RepositoryTree | undefined, b: RepositoryTree, currentPath: string, renames: RenamePair[] = [], width = 960, height = 300): CodeMapRectangle[] {
  const aFiles = new Map((a?.entries ?? []).filter(entry => entry.type === 'blob').map(entry => [entry.path, entry]));
  const bFiles = new Map(b.entries.filter(entry => entry.type === 'blob').map(entry => [entry.path, entry]));
  const renameFrom = new Map(renames.map(rename => [rename.oldPath, rename.path]));
  const renameTo = new Map(renames.map(rename => [rename.path, rename.oldPath]));
  const paths = [...new Set([...aFiles.keys(), ...bFiles.keys()])]
    .filter(filePath => !currentPath || filePath.startsWith(`${currentPath}/`))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const root: LayoutNode = { name: '', path: currentPath, bytes: 0, children: [] };
  for (const filePath of paths) {
    const oldEntry = aFiles.get(filePath); const newEntry = bFiles.get(filePath);
    const renamedFrom = renameTo.get(filePath); const renamedTo = renameFrom.get(filePath);
    const status: CodeMapStatus = renamedFrom || renamedTo ? 'renamed' : !a ? 'unchanged' : !oldEntry ? 'added' : !newEntry ? 'deleted' : oldEntry.oid === newEntry.oid ? 'unchanged' : 'modified';
    const bytes = Math.max(oldEntry?.bytes ?? 0, newEntry?.bytes ?? 0, 1);
    const parts = relativeTo(filePath, currentPath).split('/'); let parent = root; let accumulated = currentPath;
    parts.forEach((part, index) => {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      let child = parent.children.find(candidate => candidate.name === part);
      if (!child) { child = { name: part, path: accumulated, bytes: 0, children: [] }; parent.children.push(child); }
      parent = child;
      if (index === parts.length - 1) parent.file = { path: filePath, name: part, bytes, status, ...(renamedFrom ? { renamedFrom } : {}), ...(renamedTo ? { renamedTo } : {}) };
    });
  }
  const total = (node: LayoutNode): number => {
    node.bytes = node.file?.bytes ?? node.children.reduce((sum, child) => sum + total(child), 0);
    node.children.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    return node.bytes;
  };
  total(root);
  const rectangles: CodeMapRectangle[] = [];
  const place = (node: LayoutNode, x: number, y: number, nodeWidth: number, nodeHeight: number, depth: number) => {
    if (node.file) { rectangles.push({ ...node.file, x, y, width: nodeWidth, height: nodeHeight }); return; }
    const available = Math.max(1, node.children.reduce((sum, child) => sum + child.bytes, 0));
    let offset = 0; const horizontal = depth % 2 === 0;
    node.children.forEach((child, index) => {
      const remaining = (horizontal ? nodeWidth : nodeHeight) - offset;
      const span = index === node.children.length - 1 ? remaining : (horizontal ? nodeWidth : nodeHeight) * child.bytes / available;
      const inset = depth ? 3 : 0; const label = child.file ? 0 : 20;
      place(child, x + (horizontal ? offset : 0) + inset, y + (horizontal ? 0 : offset) + inset + label, Math.max(1, (horizontal ? span : nodeWidth) - inset * 2), Math.max(1, (horizontal ? nodeHeight : span) - inset * 2 - label), depth + 1);
      offset += span;
    });
  };
  place(root, 0, 0, width, height, 0);
  return rectangles.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

export function listCodeMapDirectories(rectangles: CodeMapRectangle[], currentPath: string): CodeMapDirectory[] {
  const prefix = currentPath ? `${currentPath}/` : '';
  const names = [...new Set(rectangles.map(rectangle => relativeTo(rectangle.path, currentPath).split('/')[0]).filter((name, index, all) => name && rectangles.some(rectangle => rectangle.path.startsWith(`${prefix}${name}/`)) && all.indexOf(name) === index))];
  return names.sort((left, right) => left.localeCompare(right, 'en')).map(name => {
    const directoryPath = prefix + name; const files = rectangles.filter(rectangle => rectangle.path.startsWith(`${directoryPath}/`));
    const left = Math.min(...files.map(file => file.x)); const top = Math.max(0, Math.min(...files.map(file => file.y)) - 20);
    const right = Math.max(...files.map(file => file.x + file.width)); const bottom = Math.max(...files.map(file => file.y + file.height));
    return { name, path: directoryPath, x: left, y: top, width: right - left, height: bottom - top };
  });
}

export function buildPlaybackSequence(commits: TreeCommit[], mainline?: Set<string>, selectedOid?: string, selectedPath?: string[]) {
  if (mainline) return commits.filter(commit => mainline.has(commit.oid)).map(commit => commit.oid).reverse();
  if (selectedPath?.length) {
    const selected = new Set(selectedPath); const sequence = commits.filter(commit => selected.has(commit.oid)).reverse();
    return sequence.every((commit, index) => index === 0 || commit.parents.includes(sequence[index - 1].oid)) ? sequence.map(commit => commit.oid) : [];
  }
  const byOid = new Map(commits.map(commit => [commit.oid, commit])); const result: string[] = []; const seen = new Set<string>();
  let cursor = selectedOid;
  while (cursor && !seen.has(cursor)) { seen.add(cursor); result.push(cursor); cursor = byOid.get(cursor)?.parents[0]; }
  return result.reverse();
}
