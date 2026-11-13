# Redesign implementation and validation plan

Date: 2026-11-13. Status: R0-R2 and R3a implemented with automated regressions ([R0](REDESIGN_R0.md), [R1](REDESIGN_R1.md), [R2](REDESIGN_R2.md), [R3a](REDESIGN_R3A.md)); P2-P4 probed ([results](REDESIGN_PROBES.md)). R3b-R6 proposed, blocked on E1/E4/E5/E6/E8/E9 decisions. Real Tern desktop evidence for R1 (V04-V06, V12) and R2 (V07-V09) remains open, as do the host-side parts of R0's V02/V03.

Read with [the proposal](REDESIGN_PROPOSAL.md), [research register](REDESIGN_RESEARCH.md), and [confirmed charter](../DESIGN_AND_IMPLEMENTATION_PLAN.md). This plan is documentation, not approval of E1/E4/E5/E6/E8/E9. Existing phase 6 release acceptance remains open.

## 1. Phase entry and completion rules

Before a phase, inspect the installed SDK and affected source contracts, identify concrete extensions from the proposal's decision register, and resolve only the decisions that block that phase. Keep optional slices independent. Do not repeatedly seek permission for reversible work already authorized.

Complete a phase only after relevant deterministic regressions and named desktop scenarios have actual results. Record command, environment/version, result, artifact location, and remaining limitation. If desktop access is unavailable, report that exit condition as incomplete. Do not use old screenshots, source-text assertions, or a passing build as interaction evidence.

Keep changes within existing domain/view/host/bridge boundaries. Extract shared gate evaluation before increasing its consumers; avoid a broad host rewrite or a new state framework. No new dependency, service, or model API is required for the first three phases. Evaluate any proposed dependency against installed versions, size, native compatibility, and maintenance cost before adoption.

## 2. Work packages

| Phase | Work and code touchpoints | Prerequisites | Exit conditions |
| --- | --- | --- | --- |
| R0: invariant baseline | Inventory validators in `lib/store.luau`, `lib/workflow.luau`, `lib/results.luau`, `lib/review.luau`, `omp/runtime.ts`, `omp/handoff.ts`; centralize evidence validity and structured gate reasons in `lib/validity.luau` | Read actual test harnesses; record baseline fixtures and behavior | Done for V01-V03 domain regressions ([record](REDESIGN_R0.md)); domain writes unchanged; source inventory includes script-side validators. Host/bridge and desktop parts of V02/V03 remain open |
| R1: shell and visibility | `lib/ui.luau`, `lib/context.luau`, `host.luau`, affected views: three global destinations, shared List/Board, workspace tabs, read-only readiness and basic attention projection | R0; P1 before optional keyboard APIs | Implemented and covered by view/host regressions ([record](REDESIGN_R1.md)); V04-V06 and V12 on real Tern remain open |
| R2: handoff and approval | `lib/handoff.luau`, `lib/runview.luau`, `lib/reviewview.luau`, host callbacks and existing bridge: common panel/receipt vocabulary with adapters; existing approval snapshot diff; direct-authorization entry | R1; retain supported activities; no E2 extension needed | Implemented with view/host/domain regressions ([record](REDESIGN_R2.md)); V07-V09 desktop scenarios remain open |
| R3a: verification convenience | `host.luau`, `lib/results.luau`, Delivery view: read-only command discovery, historical command drafts, coverage matrix | R0; preserve existing command execution path | Implemented with view/host regressions ([record](REDESIGN_R3A.md)); V10 real command scenarios were not rerun |
| R3b: optional serial batch | Verification scheduler and per-command evidence; bounded total time and count; cancellation and reconciliation | E4 decision, P5, batch schema inventory if persistence is needed | V10-V11 pass; no parallel commands, auto-resume, retry, or final-snapshot relabeling |
| R4a: persistent context | Resource manifest, optional conventions/verify configuration, retained handoff metadata | E1 and relevant E9 decision; upgrade/recovery design | V07/V13 pass; no duplicate instruction store by default; changed sources invalidate previews |
| R4b: lifecycle | Explicit block/cancel/reopen and revision/content-identity separation across all consumers | E8 and transition/schema approval; R0; compatibility matrix | V02/V13/V14 pass; old invalid approvals never resurrect; derived readiness remains read-only |
| R5: structured candidates | Review import, stable plan links, human adoption; optional incremental coverage records | P2-P4 probed: no structured review source in installed omp; plan is observation-only ([results](REDESIGN_PROBES.md)). E5/E6/E9 decisions and compatible readers still required | V08/V15-V16 pass; unsupported output degrades to manual flow |
| R6: selective validity research | Advisory mappings and shadow comparison to full runs | Defined supported dependency model and experiment approval | V17 results documented; production still uses full invalidation; rollout requires separate review |

R3a can proceed without R3b or R4a. R2 uses existing data and transport adapters; if true protocol unification needs new intents or durable fields, move that slice to the relevant approved extension. Full AI-generated analysis/retrospective features remain optional backlog work, not implicit R2 completion criteria.

## 3. Behavioral acceptance matrix

| ID | Scenario | Required result | Evidence type |
| --- | --- | --- | --- |
| V01 | Current, stale, failed, unknown and missing verification; required/informational criteria; open historical blockers | Delivery, readiness, queue and acceptance agree; no new bypass; optional checks do not satisfy required checks accidentally | Domain regressions with shared fixtures |
| V02 | View ready requirement; navigate, acknowledge notification, recompute readiness repeatedly | No requirement write/revision change; no evidence invalidation from viewing | Domain/host regression |
| V03 | External code change or unavailable/truncated observation after badge rendered | Readiness becomes stale/unknown; final acceptance rechecks current facts; no trusting cached green badge | Host/bridge regression and isolated Git scenario |
| V04 | List/Board filtering; open detail, change tab, Back; reopen with `/wb` | Same dataset/order/filter; selection, scroll and draft preserved; one workbench pane | Desktop recording/state evidence |
| V05 | Approximately 360/492/800 logical pixels, long title/body, save error, read-only and disconnected state | Main content/action usable, explicit full preview, no obscured error or third pane; record actual sizes | Desktop screenshots and task walkthrough |
| V06 | Chinese IME, multiline input, selection, undo, tab navigation, shortcut keys in editor, close panel | No text loss or accidental action; scoped shortcuts; predictable visible focus; native accessibility limitations recorded | Real desktop input test |
| V07 | A running, B selected, C draft; existing omp draft; busy target; `/new`/resume/rebind after preview | No attribution change, overwrite, auto queue or wrong-target send; source drift requires fresh preview | Bridge/host regressions plus desktop scenario |
| V08 | Double click, duplicate/late/out-of-order receipt, unknown delivery, reload | One execution intent; receipt tied to original identity; explicit reconciliation; no auto resend | Existing transport harness extended for affected behavior |
| V09 | Reapprove after requirement/design/baseline change; malformed snapshot; change after comparison rendered | Correct old/current comparison; unavailable comparison shown honestly; final identity check rejects drift | Domain/host regression and desktop comparison |
| V10 | Command candidate with spaces/Chinese cwd; missing script; failed/timeout command; code changed during command | Discovery does not execute; exact preview; true exit/timeout and per-command snapshot recorded; changed code invalidates evidence | Isolated command/Git integration |
| V11 | Serial batch fails, cancels, reaches time/count limit, reloads, or source/requirement changes | Stop scheduling; completed evidence retained; remaining commands not run; active outcome reconciled; no auto resume | Scheduler/host integration with bounded commands |
| V12 | Read a failed/unknown-delivery item; self-triggered failure; reload queue | Only unread marker clears; actionable condition remains until resolved; stable deduplication | Domain and desktop scenario |
| V13 | v1-only and mixed-version project; unknown fields/version; upgrade interrupted; old binary after new write | No reset or lost history; documented reader/restore behavior; CAS and writer ownership enforced | Storage/recovery fixtures in isolated project |
| V14 | Block/unblock/cancel/reopen during active work and after authorization changes | Reason/history retained; no false claim that process stopped; rechecked gates; entity/content revision behavior matches contract | Domain/host regression |
| V15 | Findings/tasks with missing identity, duplicate IDs, partial/malformed output, stale plan or snapshot | Untrusted output stays candidate or rejected; adoption explicit; no completion guessed from prose or file overlap | Protocol and adoption regressions |
| V16 | First/partial/incremental review; base changes; unresolved prior blocker; clean delta | Full-scope fallback where needed; scope represented honestly; clean delta never clears old blockers | Domain coverage fixtures |
| V17 | Shared dependency, lockfile, config, helper, toolchain, added/deleted/renamed/untracked file, incomplete mapping | Shadow reuse never changes production validity; missed impact blocks proposed rollout | Recorded full-run comparison, supported-scope report |

The matrix describes future required validation, not tests already run. Choose the narrowest harness for each behavioral change; do not add tests that merely assert page wording or mirror layout implementation.

## 4. Storage and protocol extension checklist

For each approved extension, produce a concrete table before writing code:

1. Entity/file, old/new schema, exact added/changed fields, bounded size, and retention policy.
2. Luau, TypeScript, script-side, audit/export, and recovery readers/writers that consume it.
3. Old-data interpretation, old-peer rejection, partial-upgrade behavior, lock/CAS ownership, and unknown-version read-only behavior.
4. Upgrade journal/backup strategy and interruption points; how a failed upgrade resumes without overwriting unrelated changes.
5. Restore/rollback boundary after new writes; no promise of downgrade compatibility without evidence.
6. How approval, evidence, and acceptance remain conservative; no reconstructed historical facts.

Expected inventory includes resource bindings, retained handoff snapshots, new activities, plan criterion/file IDs, content identity, and incremental review coverage. Do not bundle these into “new optional fields” without enumerating their consumers. Existing approval content and `Criterion.required` are excluded because they already exist.

## 5. Probe execution and fallback

Use P1-P5 from [the research register](REDESIGN_RESEARCH.md). Inspect installed versions first. Keep each probe bounded, isolated, and capable of reporting unsupported behavior. Record exact API names, sample payloads with sensitive text removed, identity assumptions, observed failure cases, and fallback.

Unsupported keyboard shortcuts do not block native focus/navigation improvements. Unsupported review/task structures do not block manual entry or deterministic handoff assembly. A capability probe is complete when it proves support or establishes an actionable fallback; it need not invent an API to satisfy the preferred design.

## 6. Measurement and release record

Before R1/R2, record task cohort, baseline navigation/assembly time, correctness observations, environment, and sample size using a local manual worksheet. Repeat comparable tasks after the relevant phase; report active human time separately from model/process waiting. Use the proposal's targets as hypotheses, not retrospective success labels.

For each phase, append a completion record with:

- Scope actually delivered and extension decisions referenced.
- Commands/scenarios actually executed, outcomes, and evidence paths.
- Compatibility, native accessibility, dependency/size impact, and known limits.
- Unfinished exit criteria and exact external blockers.

Do not change the charter's historical phase-completion claims or mark phase 6 accepted until its real-project release scenario has been completed. The documentation-only revision uses link, scope, and consistency checks; no application build is necessary.
