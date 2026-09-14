# HiFiScout development in ChatGPT Work

Work needs a selected skill, an actual checkout and executable tools. Reading files through the
GitHub connector alone establishes none of those. Install the personal `hifiscout-work` entry skill
in Work; it reads this repository's current `AGENTS.md` and relevant `.agents/skills` before acting.
Repository skills remain canonical; the personal skill is a small routing/bootstrap entrypoint.

## Prepare the session

Reuse a verified HiFiScout checkout or clone `https://github.com/apaapapapapa/HiFiScout.git` into a
new directory. Preserve existing edits. Read `AGENTS.md`, the loop skill and delivery skill as relevant.
Use `node scripts/work-doctor.ts` (a Node release with native TypeScript support) before dependencies
are installed. It reports repository identity, `vp` availability and `gh` authentication separately.
It neither starts a loop nor proves that dependencies or tests pass.

Read the Vite+, Node and npm pins from `package.json`. Use the official Vite+ installer at that
version, with its Node manager, or install those exact packages in a separate tool directory and
prepend its `node_modules/.bin` to PATH. After dependency installation, put the repository's
`node_modules/.bin` first so the test runner and test imports resolve the same Vite+ installation. The npm `vite-plus` executable is the local CLI; it does not
provide `vp env`, and needs the pinned Node/npm already on PATH. Never change the repository pins,
ignore engine failures or rewrite the lockfile to accommodate Work's default runtime.

Run `vp install --frozen-lockfile`, `node scripts/work-doctor.ts` and `vp run harness loop help`.
Keep the tool PATH in subsequent executions, including the loop evaluator's child processes.
The harness and aggregate-check TypeScript entrypoints use `node --import tsx`, which avoids
opening the tsx CLI's control socket in environments that prohibit local socket listeners.
This preserves TypeScript loading and does not change the checks or their results.
Confirm the GitHub connector through a read of this repository. Connector authentication does not
populate `gh` or Git push credentials. Use the native handoff below when shell authentication is absent.
Report an actual access/install failure with its evidence; do not work around enforced denials.

Initialize a loop only for a concrete task that fits its scope. Freeze its target and budgets after
environment setup, then execute `init`, `prepare`, `begin`, `apply`, `evaluate` and inspect `status`.
Normal small edits and changes to the harness, CI, agent instructions or toolchain use the normal
engineering PR workflow and applicable harness checks. Do not put protected changes in a repair loop.

## Native GitHub connector handoff

The host performs GitHub operations with its authenticated tools; the controller validates imported
evidence and advances the same journal. No token export, background service or unattended CI worker
is added. Remote mutations still require the user's existing authority and GitHub permissions.

1. Apply a patch in the owned worktree. Use GitHub's blob/tree/commit tools to publish its **exact tree
   and parent list** on `automation/loop/<task-id>`, updating only the expected owned branch without
   force. Preserve file modes and deletions. If the connector creates a different commit SHA, fetch
   that commit, then run `loop adopt <state> <root> <local-sha> <fetched-remote-sha>`. Adoption requires
   identical tree and parents, a clean owned workspace and an active, unevaluated attempt. Evaluate
   the adopted SHA; never attach an earlier SHA's passing report to it. A failed candidate may exist
   on GitHub, but cannot advance through publication until evaluated successfully.
2. Create/reuse the PR to main only after source passes. Retain actual API/tool responses, collect
   the snapshot below and run `loop handoff publish <state> <root> <evidence.json>`. Repeating it
   preserves the original review deadline. PR creation triggers the repository's normal review;
   on an updated PR reconcile a single authorized review request by its SHA before sending again.
3. Collect reviews and all unresolved threads. `loop handoff review ...` accepts a `receipt` with
   the existing review schema. A `codex` receipt additionally requires the actual full-SHA REST
   review object as `codexReview` (matching bot, commit, state and submitted timestamp). Reactions
   and abbreviated-SHA comments alone do not satisfy this adapter. A real `self` review can be
   imported only when the frozen review policy/deadline allows it; it must cover every changed path.
   Review and merge-readiness handoffs require an open, unmerged PR; review cannot be backfilled
   after delivery. Every review submission must name this PR in its REST `pull_request_url`, and
   `codexReview` must also be present in the complete submitted review collection.
4. Run `loop handoff merge-ready ...` with newly collected evidence. Only a reviewed merge/deployment
   contract with passing PR gates returns `expectedHeadSha`. Pass that SHA to the GitHub merge tool;
   if the head changes, stop and reevaluate. This command does not merge or mark completion.
5. Collect the merged PR and **main/push CI for its merge SHA**, then `loop handoff observe ...`.
   Repeat with fresh evidence while pending and within budget. Deployment targets additionally
   require the owning artifact contents and downstream receipts described in the delivery guide.

Each input is `{ "snapshot": <DeliverySnapshot>, "reviewSubmissionPages": <retained REST pages>,
"receipt": <optional review>,
"codexReview": <optional raw review> }`. `DeliverySnapshot` is defined in
`scripts/harness/delivery.ts`; retain the original responses alongside the assembled input.

| Snapshot field | Actual evidence |
| --- | --- |
| `repository`, `collectedAt` | Requested repository and completion time of this collection |
| `pull`, `pullAfter` | Full PR REST response before and after collecting other evidence |
| `reviewPages` | Complete GraphQL pages with repository/PR identity, head SHA, review decision, thread IDs and cursor metadata |
| `ciRuns` | All relevant `ci.yml` run pages for the PR head, or merge SHA with main/push event |
| `statuses` | Complete commit-status pages for that same source SHA |
| `deployment`, `downstream` | Owning run/artifact/receipt data, or null/empty when unavailable |

Each thread page must contain `data.repository.nameWithOwner` and the pull request's `number`,
`url` and `headRefOid`, as well as `reviewThreads.nodes` with IDs and resolution flags. Request these
fields in GraphQL. Retain each request cursor as top-level `after` (null on the first page), and each
response's `pageInfo.hasNextPage/endCursor`; the controller checks the cursor chain and duplicate IDs.
GitHub second-precision review timestamps are normalized before comparison with the receipt.

If the connector only returns complete review thread nodes, retain that raw response and the full
PR before/after reads and actual connector call parameters. Bind the wrapper's repository/number/URL
to that recorded call, not values copied from the target contract. Use `after: null` and wrap nodes
as one page with `hasNextPage: false` only when the tool guarantees
the complete collection. Never claim completeness from a truncated/first-page result. If it does not
return GitHub's review decision, use null. Normalize a connector's boolean `is_resolved` to the
schema's `isResolved` explicitly, retaining the original response. Every action after publish requires
`reviewSubmissionPages`: ordered objects with `url` and `items` holding each full REST review response,
including dismissed states. Fetch `https://api.github.com/repos/<owner>/<repo>/pulls/<number>/reviews?per_page=100&page=1`
and consecutive pages until one has fewer than 100 entries; an exact multiple needs the final empty
page. The controller rejects a missing/foreign/skipped page, a full final page or duplicate IDs across
pages. Do not flatten pages or declare completeness without retaining those responses. Active changes-requested reviews block
the handoff even when the aggregate decision is null. Do not invent an
APPROVED decision: an explicit approval requirement remains unknown until actually observed.
Unknown collection coverage remains unknown. Snapshots older than five minutes or from the future,
moved PR heads, dirty source and mismatched identities are rejected. Both full PR reads must agree
on number, repository, head branch/SHA, base branch/SHA and state; a retargeted PR requires a new
collection and cannot authorize a merge through this handoff.

## Session continuity

At a handoff retain the spec, journal, owned Git worktrees/manifests and generated evidence together.
The Work scratch filesystem may disappear; a conversation summary or status alone cannot restore
the run. Use the host's supported durable artifact mechanism when resumption is required and verify
the retained copy. On resume inspect `status`/`history` and reconcile actual checkout identity.
Never create a new task ID to reset an exhausted or lost run's budget.

Report these states distinctly: skill selected, environment prepared, loop running, source verified,
delivery verified. A registered skill enables discovery for relevant Work tasks; it does not run on
every ChatGPT message, provide a scheduler, or activate an unattended repair worker on CI.
