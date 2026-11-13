# Workbench redesign: information architecture and delivery efficiency

> 历史归档：本文不再定义下一轮范围；当前依据见 [设计](../../../DESIGN.md) 与 [任务](../../../TASKS.md)。下文授权与阶段状态只描述历史。

- Updated: 2026-11-13. Baseline: plugin 3.7.1, commit `39afcdf`.
- Status: revised proposal; documentation work is authorized. Recommendations below are not approval to implement scope extensions.
- Authority: [the charter](../DESIGN_AND_IMPLEMENTATION_PLAN.md) remains the confirmed product contract. This proposal supersedes the initial 2026-11-12 redesign recommendations, not existing implementation records.
- Evidence: [research and baseline corrections](REDESIGN_RESEARCH.md).
- Execution: [phases, probes, and acceptance scenarios](REDESIGN_IMPLEMENTATION_PLAN.md).

## 1. Problem and intended outcome

The current workbench has persistent authorization, evidence, review, and acceptance mechanisms, but navigation and repetitive handoff work obscure them. Eight top-level destinations mix requirement stages, projections, audit, and runtime diagnostics. Persistent implementation plans and observed session tasks are easy to confuse. Users repeatedly assemble context, enter verification commands, transcribe findings, and discover missing evidence late.

The design principle for this project is to automate preparation and mechanical work while preserving explicit authorization and human acceptance. This is a product choice, not a claim that all researched products retain the same gates. In particular, Kiro Quick Spec removes intermediate approval gates; only its up-front clarification pattern is relevant here.

Expected outcomes:

1. One requirement workspace with clear navigation and recoverable drafts.
2. Less context assembly, navigation, and review transcription.
3. Earlier visibility of missing or stale evidence.
4. No weakening of workbench-mediated authorization, source identity, or acceptance rules.

Non-goals: multiple active workbench requests, agent orchestration, automatic sending/retry, automatic acceptance, automatic commit/push/merge, collaboration, a new model client, and complex reporting. Existing phase 6 release acceptance remains incomplete; redesign work does not close it.

## 2. Evidence and baseline corrections

| Topic | Verified baseline | Consequence |
| --- | --- | --- |
| Approval snapshots | `workflow.requirementContent` serializes title, type, priority, goal, scope, criteria, and labels; approval records already store it and its hash | Reapproval diff should reuse existing data; the original E2 schema extension is unnecessary for these fields |
| Evidence validity | `results.effectiveState` checks requirement revision and global code fingerprint; `review.acceptanceGate` independently checks the same snapshot relationship | Extract one validity policy before displaying readiness in more places |
| Optional criteria | `Criterion.required` and conditional enforcement already exist | Expose existing semantics; do not claim a new gate capability or silently downgrade required criteria |
| Handoff protection | `HandoffService.resolve` rechecks preview expiry, source files, requirement, authorization, and request intent | Preserve these guards in the unified UI; do not rebuild them as weaker view-only checks |
| Activity protocol | Runtime and durable workflow accept `clarify`, `design`, and `implement` | Review/analyze are protocol work, even if findings are still entered manually |
| Storage | Strict schema versions and key allowlists exist in multiple readers/writers | An additive field is not automatically compatible; version increments require a reader/writer/recovery plan |
| Phase 6 exemption | Applies to legacy KV and `.omp/workbench/tasks` | It does not authorize abandoning current requirements, approvals, or evidence |
| Revision semantics | Stage transitions can increment requirement revision; approvals and verification bind revisions | Do not introduce automatic persisted readiness transitions without resolving invalidation semantics |

The original survey also suggested useful mechanisms from Spec Kit, Factory, Cursor, Devin, Multica, and Codex. Unverified details remain research leads, not implementation dependencies. The research register distinguishes fetched official evidence from analogy and local capability probes.

## 3. Information architecture

```text
Global shell: project, connection freshness, target session label, active request owner
  Requirements: one dataset, filters and sorting; List / Board layout
    Needs attention: unresolved actionable conditions
    Open requirement -> requirement workspace
  Activity: cross-requirement audit search and export
  Session: observed tasks, tools, detailed binding and diagnostics

Requirement workspace
  Back / requirement switcher / number and title / persisted stage
  Readiness summary and next missing action
  Prepare handoff (secondary action; opens an inline panel)
  Requirement | Design | Delivery | Acceptance | History
```

### 3.1 Navigation and action hierarchy

- Requirements and Board share filters, sort order, selection, and source data. Back restores the originating item, scroll, filter, and layout.
- Workspace tabs are the only section navigation. A lifecycle indicator, if retained, is informational; it is not another clickable stage navigation.
- Design contains one full design document, version comparison, comments, approval, and direct-implementation authorization.
- Delivery contains the implementation plan, baseline/diff, and verification. Session tasks remain an observed session view with explicit links only when identity is known.
- Acceptance retains manual review, finding dispositions, and the human acceptance action. History is the requirement-filtered audit view, not a second independent history store.
- Each page has one emphasized next action. Prepare handoff remains available without competing with Approve, Run verification, or Accept.
- The handoff panel offers distinct Prefill and Send actions. Opening it does neither. Do not label the panel opener as if it sends immediately.
- Global Activity and requirement History are two projections of the same events. Failed writes and unresolved delivery remain visible even when the event stream is filtered.

### 3.2 Narrow panels and accessibility

Use a single-column default in the right pane. Reuse the review pilot's task grouping and progressive disclosure, not its two-column layout unconditionally. At a wide size, use columns only when their content remains readable.

Proposed desktop test widths: approximately 360, 492, and 800 logical pixels, recording the actual Tern size and display scaling. At narrow width, secondary metadata collapses; the title, target, connection warning, and next action remain identifiable. Long documents use bounded previews with an explicit full-content view. Avoid stacking a sticky title, progress strip, metrics tiles, and action toolbar above a nearly empty content area.

Preserve drafts, selection, and scroll across tabs; preserve the appropriate focus target on Back and panel close. Async status updates must not steal input focus. Loading, empty, read-only, disconnected, corrupt-data, and save-conflict states require explicit content and recovery actions.

Keyboard behavior follows native Tern capabilities. Verify tab focus/activation, visible focus, and accessible names with the installed SDK and real desktop. WAI-ARIA tabs guidance is an interaction reference, not proof that Tern supports DOM roles. Optional J/K, number, and Space shortcuts apply only in their focused non-editing contexts; disable them during text entry and IME composition. Enter must not send, approve, or accept merely because a page has a primary action.

## 4. State, revision, and readiness contract

### 4.1 Separate four facts

| Fact | Owner | Meaning |
| --- | --- | --- |
| Requirement lifecycle | Durable domain state | Human decisions and explicitly initiated workflow transitions |
| Active request state | Request/runtime identity | Delivery, execution, waiting, and unknown outcome |
| Connection state | Binding observer | Fresh, stale, or disconnected transport |
| Readiness | Derived read model | Current gate inputs and missing actions, with freshness |

Readiness must not write lifecycle state or increment requirement revision. In the initial redesign, show “ready for acceptance” as a derived indication and keep persisted stage unchanged. The board groups by persisted stage; it may show a readiness badge, clearly distinguished from the column. Do not display unreachable empty columns as if their workflow exists; unknown or legacy stage values must remain visible in an explicit fallback group.

### 4.2 Revision boundary

Keep current revision and approval semantics in early phases. Navigation, reading, notification acknowledgment, and readiness recomputation perform no requirement writes.

Before adding persisted lifecycle transitions, specify a separate content identity from the entity CAS revision. Entity revision still increments on every write; a content identity changes only when a defined approval/evidence input changes. The initial conservative content field set is the existing `requirementContent` serialization. Metadata exclusions require a separate decision, not an accidental optimization. Design identity, code snapshot, and execution authorization remain separate inputs.

This is a proposed domain/schema change, not an implemented `contentRevision` field. It must cover Approval, DesignVersion, request intent, Verification, Acceptance, readers on both sides of the bridge, and recovery. Old records stay under old conservative rules until their identity can be established without inventing history. Do not revive an invalid approval merely because serialization was upgraded.

### 4.3 Future explicit transitions

| Trigger | Intended behavior | Boundary |
| --- | --- | --- |
| User marks blocked | Save reason and previous stage | Does not imply execution stopped |
| User unblocks | Reevaluate gates, then return to a valid prior stage | Stale authorization must remain stale |
| User cancels | Save reason; expose separate interruption action for active work | Cancellation is not proof of process termination |
| User reopens | Preserve acceptance history and enter a new actionable lifecycle | No inherited current acceptance |
| User starts verification | May record verifying once revision semantics are approved | Command start is not successful verification |
| Evidence becomes ready | Recompute derived readiness only | No automatic persisted transition |
| User accepts/rejects | Recheck current facts and record the explicit decision | Acceptance alone can mark done |

A human-triggered command may have a documented state effect. Passive tool events, idle, and computed readiness must not independently advance the lifecycle. This clarifies the original proposal's conflicting automatic-transition language.

### 4.4 Shared gate evaluation

One domain validity function must serve the Delivery evidence list, readiness summary, queue, and acceptance enforcement. It returns structured reasons and referenced evidence, not UI text alone. The summary identifies which gate it describes; a generic x/y must not mix implementation authorization, verification coverage, and review blockers into a misleading completion percentage.

Missing or stale code observation yields unknown readiness, not green. Show last observation time and revalidate at the final action. A badge is an observation, never an authorization token. Preserve the existing conservative verification and historical blocking-finding rules while extracting this function.

## 5. Unified handoff and context

### 5.1 Identity and delivery

The selected requirement, active request owner, and draft target are distinct. Switching to requirement B while A runs must not reassign A's events or mutate a draft for C. Each draft carries its own target and can be retained without being queued for sending.

The preview captures the target project/requirement/session/instance, source versions, exact payload hash, intent, approval where required, and baseline where required. Preserve existing expiry and source-file checks. Resolve current binding and versions again at Prefill/Send; a changed target, source, approval, or requirement requires a new preview. Previewing does not claim that the session is reserved.

Use one presentation vocabulary for receipts, backed by explicit command-type adapters. Do not collapse “prefilled”, “submitted”, “consumed”, “ended”, and “accepted” into success. Associate asynchronous receipts with the original request and binding, never the currently selected requirement. A duplicate click must not create a second execution. `delivery_unknown` requires reconciliation or an explicit acknowledgment record; opening its page is insufficient. Busy sessions retain drafts without automatic queueing or steering. Existing omp text is never overwritten.

Review remains the existing native command prefill until an activity contract is proven. A new `review` or `analyze` activity requires coordinated runtime validation, durable request schema, dispatch, receipt, recovery, and old-peer rejection behavior. Do not disguise an unsupported activity as `design` or `implement` to pass validation.

### 5.2 Context assembly

Start with deterministic assembly of selected requirement content, design version, resource paths, and user excerpts. Prefer referencing existing project instructions over creating a competing conventions file. Show source, inclusion reason, and content size; do not assume omp already loaded or did not load a file.

Persistent resource bindings and optional conventions/verification files are separate extensions. Canonicalize paths, respect project boundaries and explicit external-attachment consent, deduplicate sources, and enforce bounded payloads. Missing, changed, or oversized resources are visible; never silently send truncated context as complete. Resource edits require a new preview but do not rewrite past handoffs.

“Reuse last handoff” creates a new editable draft and new request identity, re-resolves resources, and shows changed versions. It never reuses a consumed preview token or old delivery authorization. History retention and deletion must avoid duplicating sensitive bodies unnecessarily. A manifest and immutable reference are preferable where sufficient.

Model-generated requirement checks, gap scans, and retrospectives are optional explicit requests, not hidden work on panel open. Their results are attributed candidates. “Read-only” prompt wording is not an OS sandbox. If the installed provider cannot enforce read-only tools, describe the limitation and do not claim enforcement.

## 6. Approval, verification, review, and attention

### 6.1 Approval

Adopting a candidate creates a formal version; the same page then exposes approval. These remain distinct decisions and must not auto-send implementation.

Reapproval compares existing `Approval.requirementContent` with current canonical content and compares immutable design versions. Show changed fields, invalidation reason, baseline changes, and a way to inspect full content. An absent/unreadable snapshot means comparison unavailable, not no changes. Compare from the relevant prior approval, not merely the latest candidate. Recheck identity at confirmation to avoid approving content changed after rendering.

Direct implementation is an explicit user choice with scope, criteria, reason, and baseline. A bug/chore label may suggest the option but never grants authorization or proves low risk.

### 6.2 Verification: immediate efficiency without weaker validity

- Detect command candidates from repository scripts, build files, and prior evidence without executing discovery commands. Preview exact command, cwd, criteria, timeout, and relevant environment before running.
- Expose required versus informational criteria using the existing `required` field. Changing this field is a requirement edit with existing invalidation, never a shortcut that silently waives a failed required check.
- Present criteria coverage and reasons for stale/unknown/failed evidence. Keep global code-snapshot and requirement-revision invalidation in the initial release.
- Reuse a command as a draft; do not treat historic success as current evidence.

Batch verification is a separately approved extension. One explicit action freezes an ordered command list, criteria, cwd, timeout, and requirement identity. Execute serially with one owned active batch; no parallel requests or automatic retries. Record evidence per command. Stop on the first failure/unknown result by default; remaining commands are not run. Cancellation stops scheduling, preserves completed results, and reports any still-running command honestly.

Observe code before and after each command. If a command modifies the worktree, or the requirement/binding changes, stop the batch and invalidate affected evidence under existing rules. Do not stamp all results with the final batch snapshot. Reload does not resume execution; reconcile completed evidence and unresolved command status first. Bound the batch by the existing evidence capacity and a declared total duration, not only per-command timeouts.

### 6.3 Selective invalidation: deferred experiment

Manual criterion-to-file associations may prioritize rerun suggestions; they cannot keep evidence valid. No-intersection is not proof of independence.

Before selective validity can be proposed for implementation, demonstrate complete supported dependency mapping; global inputs such as lockfiles, shared config, test helpers and toolchain; additions/deletions/renames and untracked files; mapping version and provenance; execution-time mutations; and fallback on missing, truncated, or unsupported observations. A supported-scope policy must be explicit and reject unknown cases.

Run a shadow experiment first: calculate hypothetical reuse while actual gates retain full invalidation, and compare with full reruns. Any missed affected check blocks rollout. This experiment provides evidence for a bounded policy; it cannot prove universal absence of regressions. Approval to run the experiment is not approval to weaken the production gate.

### 6.4 Review and implementation reconciliation

Findings from native review are candidates until adopted by a human. Capability probes must establish source identity, stable IDs, scope, priority mapping, duplicates, partial output, and restart behavior. Keep manual entry as fallback. Finding-to-fix creates an implementation draft carrying finding IDs and snapshot; existing authorization still applies.

Incremental review is a later extension. Record the reviewed base/head snapshots, scope, predecessor, and coverage completeness. First review, unknown ancestry, changed baseline, incomplete previous scope, or unavailable snapshots require a full-scope proposal. A clean partial review means no findings in that scope, never globally clean. Unresolved historical blocking findings remain blocking until explicitly resolved or waived with a reason.

Plan-to-criterion links require explicit stable IDs; current step titles are not an association protocol. File overlap means possibly related, not complete. Reliable structured events may propose changes; adoption remains human. Gap scans append candidate steps without rewriting existing IDs. Bind suggestions to the observed requirement/plan/snapshot and reject stale adoption. Do not promise session-task links when their ownership is unknown.

### 6.5 Needs attention

Separate unread notifications from actionable domain conditions. Reading may clear an unread marker; it never clears missing approval, failed verification, unresolved delivery, or a blocked requirement. Suppressing notifications about one's own actions must not suppress failures caused by those actions.

Derive items from domain records using stable condition/entity keys. Resolve them only when their underlying predicate becomes false or an explicit domain resolution is recorded. Show a requirement once with multiple reasons, prioritize unresolved delivery and blockers, and preserve a visible explanation when data freshness is unknown. Reload reconstructs actionable items; there is no second queue database that can drift from the gates.

## 7. Compatibility and scope decisions

### 7.1 Current-data compatibility

Legacy KV exclusion remains unchanged. Current schema-1 data must remain readable without silent reset, deletion, or fabricated validity.

Recommended extension strategy: ship explicit versioned readers first; retain v1 history; write a newer version only for an approved changed entity through a specified, recoverable upgrade. Before any such write, document the schema/read/write matrix, unknown-field behavior, backup or journal, CAS, lock ownership, and crash recovery. A simple version constant bump is insufficient: inspect validators and recovery scripts across Luau and TypeScript.

A new reader must handle a partially upgraded project without treating missing fields as trusted facts. Unknown future versions are read-only errors. Old binaries must reject newer data safely; “rollback” after new writes requires the documented restore path, not an assertion that old binaries can read new schemas. No implementation of this strategy is authorized by documenting it.

### 7.2 Decision register

| ID | Recommendation | Status and prerequisite |
| --- | --- | --- |
| D1 | Derived readiness first; defer new persisted stage writes | Recommended; revision contract needed before later lifecycle work |
| D2 | Requirement drill-down with shared List/Board and restored navigation | Recommended within existing object-centered scope |
| D3 / E3 | Defer selective validity; allow advisory mapping only | Production policy remains global invalidation |
| D4 / E5 / E6 | Probe review and plan sources before committing to implementation | Explicit source/protocol changes require a follow-up decision |
| D5 / E4 | Include serial batch verification as an optional delivery slice | Scope approval and batch recovery contract required |
| D6 | Activity / History / Prepare handoff as conceptual names | Chinese UI copy to be validated in desktop tasks |
| E1 | Persistent resources and optional conventions/verify files | Schema, retention, and compatibility decision required |
| E2 | Reuse existing approval content for diff | Original extension withdrawn; new snapshot fields need separate justification |
| E7 | Native focus behavior first; optional shortcuts after probes | No invented Tern keyboard API |
| E8 | Separate content identity from CAS revision | New domain extension; defer until all binding consumers are specified |
| E9 | Review/analyze intent, plan links, incremental review metadata, persisted handoff history | Explicit inventory and approval required; not hidden inside a view-only phase |

“Recommended” records the proposed implementation default, not user approval. Phase entry checks should ask only about concrete unresolved extensions that block that phase; ordinary reversible work already authorized does not need repeated confirmation.

## 8. Delivery sequence

The detailed task and acceptance matrix lives in [the implementation plan](REDESIGN_IMPLEMENTATION_PLAN.md).

| Phase | Deliverable | Dependency | Exit evidence |
| --- | --- | --- | --- |
| R0 | Contract inventory and shared readiness evaluator | Baseline inspection | Existing gate behavior preserved; no lifecycle writes |
| R1 | Object-centered shell, navigation, readiness, basic attention view | R0 | Real narrow/wide desktop navigation, recovery, focus and stale-state evidence |
| R2 | Unified handoff presentation and reapproval diff | R1 | Cross-requirement identity, preview drift, duplicate/unknown receipt regressions |
| R3 | Command presets, criteria coverage, optional serial batches | R0; E4 only for batch slice | Per-command evidence, cancellation, mutation and reload scenarios |
| R4 | Persistent context and explicit lifecycle extensions | R2; E1/E8 and compatibility decisions | Version/recovery matrix and invalidation checks |
| R5 | Structured review/reconciliation and optional incremental scope | Successful capability probes; E5/E6/E9 | Candidate identity, stale adoption, duplicate and coverage checks |
| R6 | Selective invalidation research only | Supported dependency model | Shadow results and separate rollout decision; no production gate change |

Optional keyboard enhancements can follow a successful probe in R1; they do not block native focus support. Approval diff does not depend on E2. R3 command presets do not depend on batch approval, persistent verify configuration, or selective invalidation. Early visibility work must not wait for structured AI integration.

## 9. Measurement and release evidence

Capture a manual baseline before implementation using at least five small/direct-authorization tasks and five formal-design tasks where practical. If fewer are available, report actual counts and treat the result as exploratory. Use comparable task types and the same environment; record idle time separately.

| Measure | Definition | Proposed target, not observed result |
| --- | --- | --- |
| Context assembly | Active time from opening handoff to a ready preview; exclude model latency | Median reduction of 25% against the matched baseline |
| Navigation | Destination changes needed to locate and act on the next blocker | At most one jump from the workspace readiness summary |
| Reapproval effort | Active review time and whether changed content was correctly identified | Lower median time with no missed seeded changes |
| Evidence discovery | Time/location where missing evidence becomes visible | Visible in Delivery and workspace summary before Acceptance |
| Transcription | Manually typed adopted findings / all adopted findings | Decrease only after structured import is validated |
| Batch benefit | Human start actions and active interaction time for the same commands | Fewer start actions without omitted required checks |

Report failures, unknown outcomes, and total sample counts alongside medians. Do not optimize a rerun ratio before selective validity is justified; fewer tests is not itself a safety result. No telemetry or new persistent counters are required for initial measurement.

Guardrails: zero unauthorized implementation through workbench entry points; zero AI-authored human acceptance; zero silent draft loss, wrong-target sends, or gate bypass in the acceptance suite. These do not claim control over direct omp use or external editors.

A release requires the named automated regressions and real Windows Tern scenarios to pass with evidence. Documentation completeness and static checks are not runtime acceptance.
