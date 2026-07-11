import { expect, test } from '@playwright/test';

test('探索 DAG 时缩放、选择、搜索、筛选、主线和框选状态一致', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Git 历史可视化' })).toBeVisible({ timeout: 15_000 });
  const graph = page.locator('svg.dag');
  await expect(graph).toHaveAccessibleName(/4 个提交.*refs\/heads\/main/);
  const initialLayout = await page.locator('.commit-node').evaluateAll(nodes => nodes.map(node => ({ transform: node.getAttribute('transform'), label: node.querySelector('button')?.getAttribute('aria-label') })));

  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await expect(page.getByRole('heading', { name: 'add unicode guide' })).toBeVisible();

  await page.getByRole('button', { name: '细节' }).click();
  await expect(page.getByRole('button', { name: '细节' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.commit-node .meta')).toHaveCount(4);
  await page.getByRole('button', { name: '中级' }).click();
  await expect(page.locator('.commit-node .subject')).toHaveCount(4);
  await expect(page.locator('.commit-node .meta')).toHaveCount(0);
  await page.getByRole('button', { name: '全局' }).click();
  await expect(page.getByRole('button', { name: '全局' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.commit-node .subject')).toHaveCount(1);
  await page.getByRole('button', { name: /initial，Alice/ }).hover();
  await expect(page.locator('.commit-node .subject')).toHaveCount(2);

  await page.getByRole('searchbox', { name: '搜索' }).fill('unicode');
  await expect(graph).toHaveAccessibleName(/1 个提交/);
  await expect(page.getByRole('heading', { name: 'add unicode guide' })).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索' }).fill('');
  await expect(graph).toHaveAccessibleName(/4 个提交/);

  await page.getByLabel('引用').selectOption('refs/heads/feature');
  await expect(graph).toHaveAccessibleName(/2 个提交/);
  await page.getByLabel('引用').selectOption('');
  await expect(graph).toHaveAccessibleName(/4 个提交/);

  await page.getByLabel('作者').selectOption('Bob');
  await expect(graph).toHaveAccessibleName(/1 个提交/);
  await page.getByLabel('作者').selectOption('');
  await page.getByLabel('变更规模').selectOption('small');
  await expect(graph).toHaveAccessibleName(/2 个提交/);
  await page.getByLabel('变更规模').selectOption('');
  await expect(graph).toHaveAccessibleName(/4 个提交/);

  await page.locator('.sidebar label').filter({ hasText: /^主线/ }).locator('select').selectOption('refs/remotes/origin/feature');
  await expect(graph).toHaveAccessibleName(/refs\/remotes\/origin\/feature/);

  const bounds = await graph.boundingBox();
  if (!bounds) throw new Error('DAG 不可见');
  await page.keyboard.down('Shift');
  await page.mouse.move(bounds.x + 20, bounds.y + 30);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .72, bounds.y + bounds.height * .36);
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(page.locator('.graph-caption')).toContainText(/已框选 [1-9]\d* 个提交，共 [1-9]\d* 行变更/);

  await page.getByText('拓扑文本摘要').click();
  await expect(page.locator('.graph-summary button').first()).toBeVisible();

  await page.reload();
  await expect(graph).toHaveAccessibleName(/4 个提交.*refs\/heads\/main/);
  await expect.poll(() => page.locator('.commit-node').evaluateAll(nodes => nodes.map(node => ({ transform: node.getAttribute('transform'), label: node.querySelector('button')?.getAttribute('aria-label') })))).toEqual(initialLayout);
});

test('设置、交换、清除并恢复 A/B，显示非颜色标记和文件差异', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Git 历史可视化' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /initial，Alice/ }).click();
  await page.getByRole('button', { name: '设当前为 A' }).click();
  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await page.getByRole('button', { name: '设当前为 B' }).click();

  await expect(page.getByRole('button', { name: /initial，Alice.*版本 A/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /add unicode guide，Bob.*版本 B/ })).toBeVisible();
  await expect(page.locator('.marker-a')).toContainText('A');
  await expect(page.locator('.marker-b')).toContainText('B');
  await expect(page.locator('.comparison-path')).toContainText('同祖先链', { timeout: 15_000 });
  await expect(page.getByText(/推断重命名，100% 相似/)).toBeVisible();
  await expect(page.getByText(/二进制文件，只显示元数据/)).toBeVisible();
  await expect(page.getByText(/无法按 UTF-8 解码/)).toBeVisible();
  await expect(page.getByRole('button', { name: '左右对照' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '统一 diff' }).click();
  await expect(page.locator('.unified-diff').first()).toBeVisible();
  await page.getByLabel('文件类型').selectOption('.md');
  await expect(page.locator('.diff-file')).toHaveCount(1);

  await page.getByRole('button', { name: '交换 A/B' }).click();
  await expect(page.locator('.ab-summary')).toContainText('add unicode guide');
  await page.reload();
  await expect(page.locator('.ab-summary')).toContainText('add unicode guide');
  await expect(page.locator('.comparison-path')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '清除' }).click();
  await expect(page.locator('.ab-summary')).toContainText('未设置');
});
