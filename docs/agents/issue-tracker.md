# Issue tracker: GitHub

本仓库的问题、规格和实现票据存放在 GitHub Issues，所有操作使用 `gh` CLI。从当前仓库的 `origin` 自动识别 `xueyouxz/git-history-visualizer`。

## 基本操作

- 创建 Issue：`gh issue create --title "..." --body-file <file>`
- 读取 Issue：`gh issue view <number> --comments`
- 列出 Issue：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

多行正文优先使用临时文件和 `--body-file`，避免 shell 转义影响内容。

## Pull requests as a triage surface

**PRs as a request surface: no.**

外部 PR 不进入需求 triage 队列。若以后改变流程，可直接修改本文件。

## 技能约定

- “发布到问题跟踪器”表示创建 GitHub Issue。
- “读取相关票据”表示读取 Issue 正文、评论和标签。
- 规格和 `/to-tickets` 生成的实现票据使用 `ready-for-agent` 标签。
- GitHub Issue 编号与 PR 共用编号空间，存在歧义时先查询 PR，再查询 Issue。

## 父子关系与阻塞关系

- 规格 Issue 作为父项，实现票据作为子 Issue。
- 优先使用 GitHub 原生 sub-issue 关系。
- 阻塞关系优先使用 GitHub 原生 issue dependencies。
- 添加原生阻塞边时，必须使用阻塞 Issue 的数据库 ID，不使用页面显示的 Issue 编号。
- 若仓库未启用相关能力，在票据正文中使用 `Blocked by: #<number>`，并在父 Issue 中维护任务列表。
- 只有全部阻塞 Issue 已关闭的票据才进入可实施前沿。
