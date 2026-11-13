# Redesign research and baseline evidence

Date: 2026-11-13. Local baseline: plugin 3.7.1 at `39afcdf`.

This register supports [the revised proposal](REDESIGN_PROPOSAL.md). Official pages were opened during this review; they describe their products, not installed omp/Tern capabilities. Access date is not a product-version guarantee. No vendor feature has been tested inside this workbench as part of this documentation task.

## 1. Rechecked primary sources

| ID | Official source | Verified observation | Workbench decision and limitation |
| --- | --- | --- | --- |
| S1 | [Kiro Quick Spec](https://kiro.dev/docs/specs/quick-spec/) | Front-loads clarification and generates requirements, design, and tasks without approvals between phases | Borrow preparation, retain explicit workbench authorization; withdraw the original claim that all surveyed tools preserve every gate |
| S2 | [Kiro Steering](https://kiro.dev/docs/steering/) | Supports persistent instructions and inclusion modes; documents AGENTS.md support | Prefer existing project context references and visible inclusion rules; do not assume these rules are available in omp |
| S3 | [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | Stale approval dismissal is configurable and uses the approved diff state | Show the exact previously approved content and current differences; this is an analogy, not authority to change local approval rules |
| S4 | [GitHub review workflow](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request) | Viewed files track review progress; submitting a review is a separate action | Reading progress is not test validity or human acceptance; do not derive selective evidence reuse from Viewed |
| S5 | [Azure Test Impact Analysis](https://learn.microsoft.com/en-us/azure/devops/pipelines/test/test-impact-analysis?view=azure-devops) | Documents constrained supported scenarios, selection of impacted/new/previously failing tests, fallback, and periodic full runs | Human file tags are not equivalent to dependency analysis; keep current full invalidation while studying a supported subset |
| S6 | [Linear Inbox](https://linear.app/docs/inbox) | Notifications have read/unread, deletion, and snooze operations alongside issue actions | Maintain unread state separately from unresolved domain conditions; reading a workbench item cannot resolve its gate |
| S7 | [WAI-ARIA Tabs Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/) | Distinguishes focus from activation, specifies keyboard interaction, and conditions automatic activation on latency | Apply interaction principles where Tern supports them; validate native accessibility and do not invent DOM APIs |
| S8 | [Claude Code hooks](https://code.claude.com/docs/en/hooks) | FileChanged observes watched files; TaskCompleted concerns task completion events and supports completion checks | Observation is not a dependency graph or proof of workbench ownership; these are Claude events, not an omp SDK contract |

These sources support the narrow observations above. They do not establish that a universal human-gate policy exists, that a notification center is a workflow queue, or that file overlap proves test independence. Design recommendations in the proposal are our adaptations.

## 2. Local implementation evidence

Use symbol names as the stable lookup; line numbers can drift during implementation.

| ID | File / symbol | Observation | Required action |
| --- | --- | --- | --- |
| L1 | [workflow](../lib/workflow.luau), `requirementContent`, approval creation and `approvalState` | Canonical requirement body is already persisted with approval; validity checks revision and content | Withdraw original E2; implement comparison with malformed/missing-history fallback |
| L2 | [results](../lib/results.luau), `effectiveState`; [review](../lib/review.luau), `acceptanceGate` | Evidence and acceptance independently compare revision/global snapshot | Share evaluation without weakening conservative rules |
| L3 | [store](../lib/store.luau), `criterion`; [review](../lib/review.luau), `acceptanceGate` | Required versus informational criteria already exist | UI improvement, not a new domain classification |
| L4 | [handoff](../omp/handoff.ts), `HandoffService.resolve` | Preview sources, expiry, requirement and intent are checked again | Preserve these checks through navigation and unified presentation |
| L5 | [runtime](../omp/runtime.ts), `Activity`, command validation; [workflow](../lib/workflow.luau), request validation | Only clarify/design/implement are accepted | New review/analyze intent crosses both bridge and durable boundaries |
| L6 | [store](../lib/store.luau), validators and scoped writes; [results](../lib/results.luau), key allowlists | Strict schemas, including script-side validation, reject unrecognized structures | Inventory all readers, writers and recovery paths before extension |
| L7 | [workflow](../lib/workflow.luau), receipt stage update | Stage changes may increment requirement revision | Derived readiness must be read-only; content identity is a separate later change |
| L8 | [phase 6 decision](PHASE_6.md) | Exempts old KV and old tasks/design.md from migration | Does not exempt current requirements from compatibility obligations |
| L9 | [native UI record](PHASE_2_UI.md) | Documents narrow-pane constraints, preserved drafts, and historical IME validation | Re-test the new shell; old screenshots are not evidence for the redesign |
| L10 | [results](../lib/results.luau), `stepKeys`, `verificationKeys` | Steps have evidence IDs; no explicit criterion/file association fields; evidence count is bounded | Plan links and batch limits need explicit schema/capacity consideration |

The initial proposal incorrectly classified approval content snapshots as absent. The earlier review did not catch that field; this deeper source inspection corrects both. The current gate's optional-criterion behavior also predates this redesign.

## 3. Capability probes still required

These are planned investigations, not completed experiments. Use the actual installed SDK and isolated projects; never send test prompts to the user's daily session implicitly.

| Probe | Question | Required record | Conservative fallback |
| --- | --- | --- | --- |
| P1 Native input | Can Tern scope key handlers, detect IME, preserve focus/selection, and expose accessible control names? | Installed version, exact API, minimal fixture, narrow/wide recordings, limitations | Native controls and focus order; omit optional shortcuts |
| P2 Review source | Does native review expose structured findings with stable request/source/scope identity? | Exact SDK/output schema, duplicate/partial/reload samples and attribution rules | Existing literal command prefill and manual finding entry |
| P3 Plan source | Are observed tasks stable and reliably linked to a requirement/request? | Identity and ordering samples; behavior after session change/manual intervention | Observed session tasks only; manual persistent-plan edits |
| P4 Activity extension | How can review/analyze be added without old-peer reinterpretation or unsafe retries? | Versioned envelope and validators, rejection behavior, receipt and restart contract | Existing supported activities only |
| P5 Native cancellation | What does cancellation actually stop for a verification process and its children? | Process API, timeout behavior, evidence after interruption/reload | Stop scheduling remaining commands; label active command unresolved |

Discovery of an event with a matching name does not pass a probe. The source identity, semantics, failure behavior, and installed version must be demonstrated.

## 4. Earlier survey leads retained for follow-up

The initial proposal surveyed the sources below. Their detailed feature claims were not revalidated in this revision and are not release dependencies. Preserve them as research leads; fetch and version-check the relevant source before using a specific capability.

- Spec-driven workflows: [Spec Kit](https://github.com/github/spec-kit), [agentic SDD reference](https://github.github.io/spec-kit/reference/agentic-sdd.html), [Kiro requirements analysis](https://kiro.dev/docs/specs/analyze-requirements/), [Kiro hooks](https://kiro.dev/docs/hooks/).
- Execution granularity: [Factory specification mode](https://docs.factory.com/autonomy-and-safety/specification-mode), [auto-run](https://docs.factory.com/autonomy-and-safety/auto-run), [missions](https://docs.factory.com/missions/overview).
- Planning and review: [Cursor planning](https://cursor.com/docs/agent/planning), [Bugbot](https://cursor.com/docs/bugbot), [Codex code review](https://developers.openai.com/codex/code-review).
- Context and handoff: [Devin Ask](https://docs.devin.ai/work-with-devin/ask-devin), [skills](https://docs.devin.ai/product-guides/skills), [session insights](https://docs.devin.ai/product-guides/session-insights).
- Workflows and resources: [Multica workflows](https://multica.ai/docs/workflows), [inbox](https://multica.ai/docs/inbox), [project resources](https://multica.ai/docs/project-resources), [environments](https://multica.ai/docs/environments), [GitHub integration](https://multica.ai/docs/github-integration).
- Gate variants: [Codecov commit status](https://docs.codecov.com/docs/commit-status), [GitLab quarantine](https://docs.gitlab.com/development/testing_guide/quarantining_tests/), [Jules review plan](https://jules.google/docs/review-plan/).

## 5. Research limits

No production task timing, installed SDK probe, runtime test, or new desktop capture was performed for this document revision. Vendor documentation cannot quantify local efficiency. Baseline measurement and real desktop acceptance are mandatory implementation work. Current observed schema and gate behavior take precedence over aspirational entities in older domain documents when estimating implementation work.
