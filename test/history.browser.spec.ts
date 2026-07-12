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
  await expect(graph).toHaveAccessibleName(/1 个提交/);
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
  await expect(page.locator('.evolution-paths')).toContainText('add unicode guide');
  await expect(page.getByText(/推断重命名，100% 相似/)).toBeVisible();
  await expect(page.getByText(/二进制文件，只显示元数据/)).toBeVisible();
  await expect(page.getByText(/无法按 UTF-8 解码/)).toBeVisible();
  await page.getByRole('button', { name: '替换无效字节后查看' }).click();
  const unknownFile = page.locator('.diff-file').filter({ has: page.getByRole('heading', { name: 'unknown.txt' }) });
  await expect(unknownFile).toContainText('�');
  await expect(page.getByRole('button', { name: '左右对照' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.locator('.split-diff').evaluateAll(diffs => diffs.every(diff => {
    const panes = [...diff.querySelectorAll('pre')]; return panes.length === 2 && panes[0].textContent?.split('\n').length === panes[1].textContent?.split('\n').length;
  }))).toBe(true);
  const contextFile = page.locator('.diff-file').filter({ has: page.getByRole('heading', { name: 'context.txt' }) });
  const collapsedContextLength = await contextFile.locator('pre').first().textContent().then(text => text?.length ?? 0);
  await page.getByRole('button', { name: '展开上下文' }).click();
  await expect(page.getByRole('button', { name: '折叠上下文' })).toBeVisible();
  await expect.poll(async () => contextFile.locator('pre').first().textContent().then(text => text?.length ?? 0)).toBeGreaterThan(collapsedContextLength);
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

  await page.route('**/*', async route => {
    if (!new URL(route.request().url()).pathname.endsWith('/diff')) return route.continue();
    await new Promise(resolve => setTimeout(resolve, 2_000)); await route.continue();
  });
  await page.getByRole('button', { name: /initial，Alice/ }).click();
  await page.getByRole('button', { name: '设当前为 A' }).click();
  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await page.getByRole('button', { name: '设当前为 B' }).click();
  await page.getByRole('button', { name: '取消计算' }).click();
  await expect(page.getByText(/差异计算已取消/)).toBeVisible();
  await expect(page.locator('.ab-summary')).toContainText('initial');
  await expect(page.locator('.ab-summary')).toContainText('add unicode guide');
  await page.unrouteAll({ behavior: 'wait' });

  await page.getByLabel('忽略空白').uncheck();
  await expect(page.getByLabel('忽略空白')).not.toBeChecked();
  await page.route('**/*', route => new URL(route.request().url()).pathname.endsWith('/diff')
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '模拟差异失败' }) })
    : route.continue());
  await page.getByLabel('忽略空白').check();
  await expect(page.getByRole('alert')).toContainText('模拟差异失败');
  await expect(page.locator('.ab-summary')).toContainText('initial');
  await expect(page.locator('.ab-summary')).toContainText('add unicode guide');
});

test('代码地图支持下钻、跨视图联动和可中断的确定性播放', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Git 历史可视化' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: '代码地图' }).click();
  await expect(page.getByText('面积表示 Git blob 字节数')).toBeVisible();
  await expect(page.getByRole('button', { name: /README.md.*字节/ })).toBeVisible();

  await page.getByRole('button', { name: /目录 docs/ }).click();
  await expect(page.getByRole('navigation', { name: '代码地图路径' })).toContainText('docs');
  await expect(page.getByRole('button', { name: /含 空格.md.*字节/ })).toBeVisible();
  await page.getByRole('button', { name: /含 空格.md.*字节/ }).hover();
  await expect(page.locator('.commit-node.path-related')).toHaveCount(2);
  await page.getByRole('button', { name: '根目录' }).click();

  const selectedSubject = page.locator('.inspector h2');
  await page.getByRole('button', { name: '播放主线路径' }).click();
  await expect(selectedSubject).toHaveText('initial');
  await page.getByRole('button', { name: '暂停播放' }).click();
  const paused = await selectedSubject.textContent();
  await page.waitForTimeout(350);
  await expect(selectedSubject).toHaveText(paused ?? '');
  await page.getByRole('button', { name: '继续播放' }).click();
  await expect(selectedSubject).toHaveText('merge feature', { timeout: 5_000 });
  await expect(page.locator('.code-map-canvas')).toHaveAttribute('aria-label', '8 个文件的代码地图');
  const completedLayout = await page.locator('.map-file').evaluateAll(files => files.map(file => ({ label: file.getAttribute('aria-label'), style: file.getAttribute('style') })));
  await page.getByRole('button', { name: '播放主线路径' }).click();
  await expect(selectedSubject).toHaveText('initial');
  await expect(selectedSubject).toHaveText('merge feature', { timeout: 5_000 });
  await expect.poll(() => page.locator('.map-file').evaluateAll(files => files.map(file => ({ label: file.getAttribute('aria-label'), style: file.getAttribute('style') })))).toEqual(completedLayout);
  await page.getByRole('button', { name: '播放主线路径' }).click();
  await expect(selectedSubject).toHaveText('initial');
  await page.getByRole('button', { name: '取消播放' }).click();
  await page.waitForTimeout(350);
  await expect(selectedSubject).toHaveText('initial');
});

test('贡献者流带选择联动 DAG 与代码地图，清除后保留 A/B', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Git 历史可视化' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /initial，Alice/ }).click();
  await page.getByRole('button', { name: '设当前为 A' }).click();
  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await page.getByRole('button', { name: '设当前为 B' }).click();

  await page.getByRole('tab', { name: '贡献者' }).click();
  await expect(page.getByText(/固定 12 个提交窗口内的变更行占比.*不能代表贡献价值/)).toBeVisible();
  await page.getByLabel('贡献者图例').getByRole('button', { name: '贡献者 Bob' }).click();
  await expect(page.locator('.commit-node.contributor-related')).toHaveCount(1);
  await page.getByLabel('贡献者图例').getByRole('button', { name: '贡献者 Alice' }).click();
  await expect(page.locator('.commit-node.contributor-related')).toHaveCount(2);
  await page.getByLabel('贡献者图例').getByRole('button', { name: '贡献者 Bob' }).click();
  await expect(page.locator('.commit-node.contributor-related')).toHaveCount(1);

  await page.getByRole('tab', { name: '并列分析' }).click();
  await expect(page.locator('.analysis-side-by-side .contributor-flow-panel')).toBeVisible();
  await expect(page.locator('.analysis-side-by-side .code-map-panel')).toBeVisible();
  await expect(page.locator('.map-file.contributor-related').first()).toBeVisible();
  await page.getByRole('button', { name: '清除贡献者选择' }).click();
  await expect(page.locator('.commit-node.contributor-related')).toHaveCount(0);
  await expect(page.locator('.marker-a')).toHaveCount(1);
  await expect(page.locator('.marker-b')).toHaveCount(1);
});

test('提交分类显示依据和置信度，支持多类型筛选且保留 A/B', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Git 历史可视化' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /merge feature，Merge Bot/ }).click();
  await page.getByRole('button', { name: '设当前为 A' }).click();
  await expect(page.locator('.commit-classification')).toContainText('merge');
  await expect(page.locator('.commit-classification')).toContainText('100%');
  await expect(page.locator('.commit-classification')).toContainText('多个父提交');
  await expect(page.locator('.commit-node.classification-merge')).toHaveCount(1);
  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await page.getByRole('button', { name: '设当前为 B' }).click();

  await page.getByRole('checkbox', { name: 'merge' }).check();
  await expect(page.locator('.commit-node')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'add unicode guide' })).toBeVisible();
  await expect(page.locator('.marker-a')).toHaveCount(1);
  await expect(page.locator('.marker-b')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'docs' }).check();
  await expect(page.getByRole('checkbox', { name: 'merge' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'docs' })).toBeChecked();
  await expect.poll(() => page.locator('.commit-node').evaluateAll(nodes => nodes.every(node => node.classList.contains('classification-merge') || node.classList.contains('classification-docs')))).toBe(true);
  await expect(page.locator('.marker-b')).toHaveCount(1);
  await expect(page.locator('.classification-legend')).toContainText('build/config');
  await page.getByRole('checkbox', { name: 'merge' }).uncheck();
  await page.getByRole('checkbox', { name: 'docs' }).uncheck();
  await expect(page.locator('.marker-b')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'add unicode guide' })).toBeVisible();
});

test('分类请求失败不清空原始 DAG', async ({ page }) => {
  await page.route('**/classifications?*', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '模拟分类失败' }) }));
  await page.goto('/');
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/, { timeout: 15_000 });
  await expect(page.getByRole('alert')).toContainText('模拟分类失败');
});

test('阶段建议显示背景和依据，拖动边界只调整叠加层并可关闭', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/, { timeout: 15_000 });
  await expect(page.locator('.phase-region')).toHaveCount(2);
  await expect(page.locator('.phase-analysis')).toContainText('tag v1-feature');
  const boundary = page.getByRole('slider', { name: /阶段边界/ }).first();
  const movedBoundary = await boundary.inputValue() === '1' ? '2' : '1';
  await boundary.fill(movedBoundary);
  await expect(boundary).toHaveValue(movedBoundary);
  await expect.poll(() => page.evaluate(() => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).some(key => key?.startsWith('ghv:phases:v1:')))).toBe(true);
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/);
  await page.getByRole('button', { name: '关闭阶段分析' }).click();
  await expect(page.locator('.phase-region')).toHaveCount(0);
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/);
  await page.getByRole('button', { name: '启用阶段分析' }).click();
  await expect(page.locator('.phase-region')).toHaveCount(2);
});

test('阶段分析失败和取消不影响核心视图，并支持重试', async ({ page }) => {
  await page.route('**/phases?*', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '模拟阶段失败' }) }));
  await page.goto('/');
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/, { timeout: 15_000 });
  await expect(page.locator('.phase-analysis').getByRole('alert')).toContainText('模拟阶段失败');
  await page.getByRole('button', { name: /initial，Alice/ }).click();
  await page.getByRole('button', { name: '设当前为 A' }).click();
  await page.getByRole('button', { name: /add unicode guide，Bob/ }).click();
  await page.getByRole('button', { name: '设当前为 B' }).click();
  await expect(page.locator('.comparison-path')).toBeVisible();
  await page.getByRole('tab', { name: '代码地图' }).click();
  await expect(page.getByRole('button', { name: /README.md.*字节/ })).toBeVisible();
  await page.unroute('**/phases?*');
  await page.getByRole('button', { name: '重试阶段分析' }).click();
  await expect(page.locator('.phase-region')).toHaveCount(2);

  await page.route('**/phases?*', async route => { await new Promise(resolve => setTimeout(resolve, 2_000)); await route.continue(); });
  await page.getByRole('button', { name: '重新分析阶段' }).click();
  await page.getByRole('button', { name: '取消阶段分析' }).click();
  await expect(page.locator('.phase-analysis')).toContainText('阶段分析已取消');
  await expect(page.locator('svg.dag')).toHaveAccessibleName(/4 个提交/);
});
