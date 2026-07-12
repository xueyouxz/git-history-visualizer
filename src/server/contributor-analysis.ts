import {
  CONTRIBUTOR_ANALYSIS_VERSION,
  OTHER_CONTRIBUTOR_ID,
  type ContributorEvolution,
} from '../shared/history.js';

type ContributorCommit = {
  oid: string;
  authorId: string;
  author: string;
  additions: number;
  deletions: number;
};

export function analyzeContributors(commits: ContributorCommit[], revisionFingerprint: string, windowSize = 12, maximumContributors = 6): ContributorEvolution {
  const totals = new Map<string, { name: string; lines: number }>();
  commits.forEach(commit => {
    const current = totals.get(commit.authorId) ?? { name: commit.author, lines: 0 };
    current.lines += commit.additions + commit.deletions; totals.set(commit.authorId, current);
  });
  const major = [...totals.entries()].sort((left, right) => right[1].lines - left[1].lines || left[1].name.localeCompare(right[1].name, 'en') || left[0].localeCompare(right[0], 'en'))
    .slice(0, maximumContributors);
  const majorIds = new Set(major.map(([authorId]) => authorId));
  const hasOther = totals.size > major.length;
  const contributors = major.map(([authorId, value]) => ({ authorId, name: value.name, aggregate: false }));
  if (hasOther) contributors.push({ authorId: OTHER_CONTRIBUTOR_ID, name: '其他', aggregate: true });
  const points = commits.map((commit, order) => {
    const window = commits.slice(Math.max(0, order - windowSize + 1), order + 1);
    const lines = new Map<string, number>();
    window.forEach(item => {
      const key = majorIds.has(item.authorId) ? item.authorId : OTHER_CONTRIBUTOR_ID;
      lines.set(key, (lines.get(key) ?? 0) + item.additions + item.deletions);
    });
    const total = [...lines.values()].reduce((sum, value) => sum + value, 0);
    return {
      oid: commit.oid,
      order,
      shares: contributors.map(contributor => {
        const contributorLines = lines.get(contributor.authorId) ?? 0;
        return { authorId: contributor.authorId, lines: contributorLines, share: total ? contributorLines / total : 0 };
      }),
    };
  });
  return { version: CONTRIBUTOR_ANALYSIS_VERSION, revisionFingerprint, windowSize, contributors, points };
}
