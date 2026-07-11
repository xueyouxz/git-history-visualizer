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
