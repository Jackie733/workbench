--!strict
local serde=require("@lune/serde")
local function node(k,p,c) return {k=k,p=p or {},c=c} end
tern={ui={
    node=node,
    span=function(t,s) return {t=t,s=s} end,
    text=function(spans) return node("text",{spans=spans}) end,
    badge=function(t,tone) return node("badge",{text=t,tone=tone}) end,
    button=function(t,p) local o=p or {};o.text=t;return node("button",o) end,
},json={array=function() return {} end,encode=function(v) return serde.encode("json",v) end}}
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

-- AF-04 component contract: a choice is not a button wall, a status is not a
-- control, and one synchronous build exposes at most one filled primary.
local few=Context.choices("priority","优先级","normal",{{value="low",label="低"},{value="normal",label="普通"},{value="high",label="高"}})
check(few.c and few.c[1] and few.c[1].k=="tabs" and few.c[1].p.variant=="segmented",
    "up to four choices use one native segmented control")
local many=Context.choices("stage","阶段","all",{{value="a",label="A"},{value="b",label="B"},{value="c",label="C"},{value="d",label="D"},{value="e",label="E"}})
check(many.c and many.c[1] and many.c[1].k=="select","more than four choices use a native select")
local locked=Context.choices("type","类型","bug",{{value="bug",label="缺陷"}}, "只读")
check(locked.c and locked.c[1] and locked.c[1].k=="text","a disabled choice is read-only text, not a control")
local status=Context.status("待批准","pending")
check(status.k=="text" and status.p.actions==nil,"status renders as text with no action")
local tag=Context.tag("维护")
check(tag.k=="badge" and tag.p.actions==nil,"classification tag is a passive chip")

local function countPrimary(view)
    local n=0
    local function walk(value)
        if type(value)~="table" then return end
        if value.k=="button" and value.p.variant=="primary" then n+=1 end
        for _,child in value.c or {} do walk(child) end
    end
    walk(view)
    return n
end
local page=Fixtures.make("approved")
page.ui.writable, page.ui.tab = true, "requirements"
Context.beginRender(page)
check(countPrimary(Context.button("新建","new-requirement","primary"))==1,"page primary stays primary")
check(countPrimary(Context.button("保存","save-requirement","primary"))==0,"a non-page action cannot be promoted to primary")
page.ui.tab="form"
Context.beginRender(page)
check(countPrimary(Context.button("保存","save-requirement"))==1,"the form page promotes only its save action")
check(countPrimary(Context.button("新建","new-requirement"))==0,"navigation is not promoted on the form page")
Context.renderState, Context.renderPage, Context.renderPrimary = nil, nil, nil

print(string.format("%d checks, 0 failures",checks))
