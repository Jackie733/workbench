--!strict
local serde=require("@lune/serde")
tern={ui={},json={array=function() return {} end,encode=function(v) return serde.encode("json",v) end}}
local Context=require("../lib/context")
local Fixtures=require("./af-fixtures")
local checks=0
local function check(ok,message) checks+=1;assert(ok,message) end
local function reading(s)
    local before=serde.encode("json",s)
    local value=Context.readiness(s.ui.byId[s.ui.selected],s.ui,s)
    check(serde.encode("json",s)==before,"read model must not mutate inputs")
    return value
end
local approved=Fixtures.make("approved")
local value=reading(approved)
check(value.next.activity=="implement","valid approval must prepare implementation, not reapproval")
check(value.next.kind=="navigate" and value.next.target=="af-requirement","preparation is targeted navigation, not execution")
check(value.lifecycle=="awaiting_approval","derived readiness must preserve lifecycle")
local stale=reading(Fixtures.make("disconnected"))
check(stale.connection.state=="disconnected" and stale.state~="ready","disconnection must not imply fresh readiness")
local unknown=reading(Fixtures.make("delivery_unknown"))
check(unknown.request.state=="delivery_unknown" and unknown.next.tab=="design","unknown delivery requires original request reconciliation")
check(unknown.state~="ready","unresolved delivery must not present ready execution")
local other=Fixtures.make("approved")
-- Identical content/revision but a different stable requirement identity:
-- authorization must not follow the selected view's stale workflow object.
other.ui.byId[other.ui.selected].requirementId="af-other"
check(reading(other).next.activity==nil,"a different requirement must not inherit authorization")
local running=reading(Fixtures.make("running"))
check(running.connection.runState=="working" and running.request.state=="none","session activity must not fabricate request ownership")
local complete=reading(Fixtures.make("awaiting_acceptance"))
check(complete.state=="ready" and complete.next.tab=="acceptance","current evidence must retain acceptance navigation")
local missing=Fixtures.make("awaiting_acceptance")
missing.ui.trace.results.changes=nil
check(reading(missing).state~="ready","missing snapshot must not show ready acceptance")

-- Requirement ownership isolation across results, reviews and transient pendingSend.
local wrongResults=Fixtures.make("awaiting_acceptance")
wrongResults.ui.trace.results.requirementId="af-other"
check(reading(wrongResults).state=="unknown","foreign results.json must not satisfy current snapshot gate")

local wrongReviews=Fixtures.make("awaiting_acceptance")
wrongReviews.ui.review.data.requirementId="af-other"
wrongReviews.ui.review.data.reviews={{id="rev-other",events={},findings={{id="f1",severity="blocking",description="foreign"}}}}
check(reading(wrongReviews).state=="ready","foreign open blocking finding must not block another requirement")

local wrongPending=Fixtures.make("approved")
wrongPending.ui.handoff.pendingSend={requestId="req-other-send",requirementId="af-other",state="delivery_unknown",createdAt=1700000000000}
local wrongPendingRead=reading(wrongPending)
check(wrongPendingRead.request.state=="none" and wrongPendingRead.next.activity=="implement",
    "foreign pendingSend must not hijack this requirement's request state")

local ownPending=Fixtures.make("awaiting_approval")
ownPending.ui.handoff.pendingSend={requestId="req-own-send",requirementId="af-requirement",state="delivery_unknown",createdAt=1700000000000}
check(reading(ownPending).request.state=="delivery_unknown","matching pendingSend must remain attached to its requirement")

-- Unified Action Contract taxonomy (navigate / read / edit / decide / execute).
for _, act in {"wb-open-design", "wb-open-implementation", "requirement=af-1", "back-workspace", "handoff-prepare", "change:layout=board", "lifecycle-open=block"} do
    local spec=Context.describeAction(act)
    check(spec.kind=="navigate" and not spec.mutatesRevision and not spec.writesFiles and not spec.requiresLock,
        "navigate action must not mutate revisions or files: "..act)
end
for _, act in {"reload", "audit-refresh", "activity-refresh", "handoff-baseline", "handoff-preview", "results-preview-verification"} do
    local spec=Context.describeAction(act)
    check(spec.kind=="read" and not spec.mutatesRevision and not spec.writesFiles,
        "pure read action must not claim revision/file mutation: "..act)
end
for _, act in {"results-refresh-changes", "handoff-reconcile-baseline", "results-run-verification", "handoff-send"} do
    local spec=Context.describeAction(act)
    check(spec.kind=="execute" and spec.mutatesRevision and spec.writesFiles and spec.requiresLock and #spec.impact>0,
        "explicit mutating execute command must declare revision/file side effects: "..act)
end
for _, act in {"handoff-approve", "handoff-authorize-direct", "handoff-revoke", "review-accept", "review-reject", "review-reopen", "lifecycle-confirm"} do
    local spec=Context.describeAction(act)
    check(spec.kind=="decide" and spec.mutatesRevision and spec.writesFiles and spec.requiresLock,
        "decision action must declare revision mutation and lock requirement: "..act)
end

-- pendingBaselineSync detection and explicit gating.
local histSync=Fixtures.make("approved")
histSync.ui.writable=true
histSync.ui.handoff.workflow.requests={{requestId="req-hist-1",activity="implement",status="submitted",createdAt=1700000001000}}
check(Context.pendingBaselineSync(histSync.ui.byId[histSync.ui.selected],histSync.ui.handoff,histSync.ui.trace)~=nil,
    "historical submitted implement request without results baseline should expose explicit sync")
local syncGate=Context.evaluateAction("handoff-reconcile-baseline",histSync)
check(syncGate.allowed and syncGate.target.requestId=="req-hist-1","reconcile action should target exact historical request")
histSync.ui.trace.results.baseline={requestId="req-hist-1",head="af-head"}
check(Context.pendingBaselineSync(histSync.ui.byId[histSync.ui.selected],histSync.ui.handoff,histSync.ui.trace)==nil,
    "matching recorded baseline should clear pendingBaselineSync")

-- Gate parity & failure structure via Context.evaluateAction.
local directMissing=Fixtures.make("awaiting_approval")
directMissing.ui.writable=true
directMissing.ui.handoff.baseline={head="af-head",fingerprint=string.rep("ab12",16),dirty=false}
directMissing.ui.handoff.baselineCheckedAt=1700000000000
directMissing.ui.handoff.fields={directReason={text="直接原因"},revokeReason={text=""}}
directMissing.ui.byId[directMissing.ui.selected].acceptanceCriteria={}
local directGate=Context.evaluateAction("handoff-authorize-direct",directMissing)
check(not directGate.allowed and directGate.failure~=nil and directGate.failure.code=="scope_or_criteria_missing",
    "direct implement must be rejected symmetrically when acceptance criteria are empty")

local acceptBad=Fixtures.make("awaiting_acceptance")
acceptBad.ui.writable=true
acceptBad.ui.trace.results.changes=nil
local acceptGate=Context.evaluateAction("review-accept",acceptBad)
check(not acceptGate.allowed and acceptGate.failure and #Context.formatFailure(acceptGate)>0,
    "review-accept must expose exact acceptance gate problem on refusal")

-- Smoke check all 11 canonical AF fixtures through read model & action contract without mutation.
for _, name in Fixtures.names do
    local s=Fixtures.make(name)
    local req=s.ui.selected and s.ui.byId[s.ui.selected] or nil
    if req then
        local r=reading(s)
        check(r.lifecycle==req.stage,"fixture "..name.." should preserve lifecycle")
        Context.evaluateAction("handoff-send",s,req)
        Context.evaluateAction("review-accept",s,req)
        Context.evaluateAction("wb-open-implementation",s,req)
    else
        check(Context.readiness(nil,s.ui,s)==nil,"empty fixture has nil readiness")
    end
end

print(string.format("%d checks, 0 failures",checks))
