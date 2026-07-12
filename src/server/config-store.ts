import { randomUUID } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export type EditorConfig = { executable: string; args: string[] };
export type AppConfig = { managedRoot?: string; editor?: EditorConfig };

const validateEditor = (editor: unknown): EditorConfig => {
  if (!editor || typeof editor !== 'object') throw new Error('编辑器配置无效');
  const { executable, args } = editor as Partial<EditorConfig>;
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('编辑器可执行文件必须是绝对路径');
  if (!Array.isArray(args) || args.some(argument => typeof argument !== 'string') || args.filter(argument => argument === '{path}').length !== 1) throw new Error('编辑器参数必须是字符串数组并包含一个 {path} 占位符');
  return { executable: path.resolve(executable), args: [...args] };
};

export class ConfigStore {
  readonly path: string;
  private config: AppConfig = {};
  constructor(configPath = path.join(homedir(), '.git-history-visualizer', 'config.json')) {
    this.path = path.resolve(configPath);
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as AppConfig;
      if (typeof parsed.managedRoot === 'string' && path.isAbsolute(parsed.managedRoot)) this.config.managedRoot = path.resolve(parsed.managedRoot);
      if (parsed.editor) this.config.editor = validateEditor(parsed.editor);
    } catch { /* Invalid or absent configuration uses defaults. */ }
  }
  get value(): AppConfig { return { ...this.config, ...(this.config.editor ? { editor: { ...this.config.editor, args: [...this.config.editor.args] } } : {}) }; }
  async update(patch: AppConfig) {
    const next: AppConfig = { ...this.config };
    if (patch.managedRoot !== undefined) { if (!path.isAbsolute(patch.managedRoot)) throw new Error('受管根目录必须是绝对路径'); next.managedRoot = path.resolve(patch.managedRoot); }
    if (patch.editor !== undefined) next.editor = validateEditor(patch.editor);
    await fs.mkdir(path.dirname(this.path), { recursive: true }); const temporary = `${this.path}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(next, null, 2), { mode: 0o600 }); await fs.rename(temporary, this.path); }
    finally { await fs.rm(temporary, { force: true }); }
    this.config = next; return this.value;
  }
}
