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
print(string.format("%d checks, 0 failures",checks))
