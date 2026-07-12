import type { CommitClassification, CommitType, IndexedCommit } from '../shared/history.js';

type ScoredType = Exclude<CommitType, 'merge' | 'mixed'>;
const messageRules: Array<{ type: ScoredType; pattern: RegExp; reason: string }> = [
  { type: 'feature', pattern: /\b(feat(?:ure)?|implement|introduce)\b/i, reason: '提交信息表示新增能力' },
  { type: 'fix', pattern: /\b(fix|bug|hotfix|repair|resolve)\b/i, reason: '提交信息表示修复问题' },
  { type: 'refactor', pattern: /\b(refactor|restructure|cleanup|rename|move)\b/i, reason: '提交信息表示重构或整理' },
  { type: 'test', pattern: /\b(test|spec|coverage)\b/i, reason: '提交信息涉及测试' },
  { type: 'docs', pattern: /\b(doc|docs|documentation|readme|guide)\b/i, reason: '提交信息涉及文档' },
  { type: 'build/config', pattern: /\b(build|config|configure|ci|release|dependency|dependencies)\b/i, reason: '提交信息涉及构建或配置' },
];

const pathRules: Array<{ type: ScoredType; pattern: RegExp; reason: string }> = [
  { type: 'test', pattern: /(^|\/)(?:__tests__|tests?|spec)(\/|$)|\.(?:test|spec)\.[^/]+$/i, reason: '变更路径属于测试文件' },
  { type: 'docs', pattern: /(^|\/)(?:docs?|readme(?:\.[^/]+)?)(\/|$)|\.(?:md|mdx|rst|adoc)$/i, reason: '变更路径属于文档' },
  { type: 'build/config', pattern: /(^|\/)(?:\.github\/workflows|dockerfile|makefile)(\/|$)|(?:^|\/)(?:package(?:-lock)?\.json|[^/]*lock|tsconfig[^/]*\.json|[^/]*\.config\.[^/]+)$|\.(?:ya?ml|toml)$/i, reason: '变更路径属于构建或配置' },
];

export function classifyCommit(commit: IndexedCommit): CommitClassification {
  if (commit.parents.length > 1) return { oid: commit.oid, type: 'merge', reasons: ['提交包含多个父提交'], confidence: 1 };
  const scores = new Map<ScoredType, { score: number; reasons: string[] }>();
  const add = (type: ScoredType, score: number, reason: string) => {
    const current = scores.get(type) ?? { score: 0, reasons: [] };
    current.score += score; if (!current.reasons.includes(reason)) current.reasons.push(reason); scores.set(type, current);
  };
  messageRules.forEach(rule => { if (rule.pattern.test(`${commit.subject}\n${commit.message}`)) add(rule.type, 5, rule.reason); });
  pathRules.forEach(rule => { if (commit.paths.some(changedPath => rule.pattern.test(changedPath))) add(rule.type, 4, rule.reason); });
  if (!scores.size) {
    if (commit.additions > commit.deletions) add('feature', 2, '新增行多于删除行且无更强分类信号');
    else if (commit.deletions > commit.additions) add('refactor', 2, '删除行多于新增行且无更强分类信号');
    else add('refactor', 1, '增删规模接近且无更强分类信号');
  }
  const ranked = [...scores.entries()].sort((left, right) => right[1].score - left[1].score || left[0].localeCompare(right[0], 'en'));
  const strong = ranked.filter(([, value]) => value.score >= 3);
  if (strong.length > 1) return { oid: commit.oid, type: 'mixed', reasons: strong.flatMap(([, value]) => value.reasons), confidence: Math.min(.95, .55 + strong.reduce((sum, [, value]) => sum + value.score, 0) * .04) };
  const [type, value] = ranked[0];
  return { oid: commit.oid, type, reasons: value.reasons, confidence: Math.min(.98, .45 + value.score * .1) };
}
