--!strict
-- Native phased acceptance. All FS operations and every PowerShell CAS use Tern.
-- Explicit legacy fixtures are the only direct writes; domain changes use production APIs.
return function(native, repo, tempRoot, waitOne)
    local fs = {}
    for _, name in {"read","write","list","exists","mkdir","remove"} do
        fs[name]=function(...)
            local value=native.fs[name](...)
            waitOne()
            return value
        end
    end
    local tern=setmetatable({fs=fs},{__index=native})
    local modules={}
    local function loadModule(name)
        if modules[name] then return modules[name] end
        local source=fs.read(repo .. "\\lib\\" .. name .. ".luau",262144)
        local chunk=assert(loadstring("local tern, require=...\n" .. source))
        local value=chunk(tern,function(relative) return loadModule(assert(relative:match("^%./([%w_%-]+)$"))) end)
        modules[name]=value
        waitOne()
        return value
    end
    local Store, Results, Review, Validity=loadModule("store"),loadModule("results"),loadModule("review"),loadModule("validity")
    local transport=Store.runProcess
    Store.runProcess=function(env,cb)
        local result=waitOne(transport(env))
        if cb then cb(result.status,result.stderr,result.timed_out) end
    end
    local root="/tmp/" .. assert(tempRoot:match("[^\\]+$"))
    local paths=assert(Store.paths({host="wsl.localhost",distro="Ubuntu"},root))
    local SHA, RAW, OTHER=string.rep("a",64),string.rep("b",64),string.rep("c",64)
    local token="native-candidate-owner"
    local checks, failures, phase=0,native.json.array(),0
    local req, second, project, plan, data, planCandidate, reviewCandidate
    local function check(ok,message)
        checks+=1
        if not ok then table.insert(failures,message) end
    end
    local function jsonArray(...)
        local out=native.json.array()
        for _, item in {...} do table.insert(out,item) end
        return out
    end
    local function assertResult(value,problem) assert(value,problem and problem.code or "missing result"); return value end
    local function candidate(kind,target,revision,id)
        local value={schemaVersion=1,kind=kind,id=id,projectId=target.projectId,requirementId=target.requirementId,
            requirementRevision=target.revision,requirementContentRevision=Store.contentRevision(target),
            codeSnapshotSha256=SHA,planRevision=revision,complete=true}
        if kind=="plan" then value.steps=jsonArray({id="P1",title="外部声明步骤",criterionIds=jsonArray("C1"),filePaths=jsonArray("src/entry.luau")})
        else value.scope="完整需求与代码快照"; value.findings=jsonArray() end
        return value
    end
    local function observed(target)
        Results.putChanges(paths,target,token,{capturedAt=os.time()*1000,head="",fingerprint=SHA,dirty=false,
            files=jsonArray(),filesTruncated=false,diff="",diffSha256=SHA,diffTruncated=false,commits=jsonArray(),commitsTruncated=false},0,
            function(value,_,problem) assertResult(value,problem) end)
    end
    local function planAction(action,args)
        Results.applyPlan(paths,req,token,action,args,plan.revision,function(value,_,problem)
            plan=assertResult(value,problem)
        end)
    end
    local function adoptPlan(value,sha,expected)
        local saved,problem
        Results.adoptCandidate(paths,req,token,value,sha,expected,function(a,_,c) saved=a; if not a then problem=c end end)
        return saved,problem
    end
    local function adoptReview(target,value,expected)
        local saved,problem
        Review.adoptCandidate(paths,target,token,value,RAW,expected,function(a,b) saved,problem=a,b end)
        return saved,problem
    end
    local function legacyReview(target,schema)
        local review={id="review-old",source="manual",scope="历史完整审查",codeSnapshotSha256=SHA,
            requirementRevision=target.revision,createdAt=1,
            findings=jsonArray({id="finding-old",severity="blocking",description="历史阻断保留",createdAt=1}),events=jsonArray()}
        if schema==2 then review.requirementContentRevision=Store.contentRevision(target) end
        return {schemaVersion=schema,projectId=target.projectId,requirementId=target.requirementId,revision=1,
            reviews=jsonArray(review),acceptances=jsonArray({id="acceptance-old",decision="accepted",requirementRevision=1,
                codeSnapshotSha256=SHA,verificationIds=jsonArray(),reviewIds=jsonArray(),comment="历史决定",createdAt=1}),
            reopenings=jsonArray({id="reopening-old",acceptanceId="acceptance-old",reason="人工重开",at=2})}
    end
    return function()
        phase+=1
        if phase==1 then
            fs.mkdir(tempRoot)
            Store.init(paths,{projectId="native-candidates",root=root,name="原生候选采用验收",token=token,
                owner={window="native-candidate-acceptance",panel=1},now=os.time()*1000},
                function(value,problem) project=assertResult(value,problem) end)
            Store.create(paths,project,{id="req-candidate",title="显式候选采用",type="feature",goal="保留人工门禁",
                criteria={"入口可核对"},now=os.time()*1000},token,function(value,updated,problem)
                req,project=assertResult(value,problem),updated
            end)
        elseif phase==2 then
            observed(req)
            check(assert(Results.loadResults(paths,req)).changes.fingerprint==SHA,"native snapshot observation persisted")
            fs.write(Results.planPath(paths,req),native.json.encode({schemaVersion=1,projectId=req.projectId,requirementId=req.requirementId,
                revision=1,designVersion=0,steps=jsonArray({id="step-old",title="旧步骤",status="done",updatedAt=1,evidenceIds=jsonArray()}),
                changeReason="历史",updatedAt=1}))
            plan=assert(Results.loadPlan(paths,req))
        elseif phase==3 then
            planAction("links",{stepId="step-old",criterionIds=jsonArray("C1"),filePaths=jsonArray("src/legacy.luau")})
            check(plan.schemaVersion==2 and plan.steps[1].status=="done" and plan.steps[1].criterionIds[1]=="C1",
                "real CAS upgrades legacy plan1 to plan2 with explicit links and unchanged completion")
        elseif phase==4 then
            planAction("status",{stepId="step-old",status="active"})
            planCandidate=candidate("plan",req,plan.revision,"native-plan-import")
            local value,problem=adoptPlan(planCandidate,RAW,plan.revision)
            plan=assertResult(value,problem)
            check(plan.schemaVersion==2 and #plan.steps==2 and plan.steps[2].status=="pending"
                and plan.candidateImports[1].sourceIds[1]=="P1" and plan.candidateImports[1].entityIds[1]==plan.steps[2].id,
                "repeated plan2 native CAS appends stable source/internal mapping")
        elseif phase==5 then
            local bytes=fs.read(Results.planPath(paths,req))
            local replay,problem=adoptPlan(planCandidate,RAW,0)
            check(replay and not problem and replay.revision==plan.revision and fs.read(Results.planPath(paths,req))==bytes,
                "native repeated same candidate ID/hash does not write or advance revision")
            local conflict,why=adoptPlan(planCandidate,OTHER,plan.revision)
            check(not conflict and why and why.code=="candidate_conflict" and fs.read(Results.planPath(paths,req))==bytes,
                "native changed candidate hash conflicts without overwriting plan history")
            local err
            Results.applyPlan(paths,req,token,"links",{stepId=plan.steps[2].id,criterionIds=jsonArray("missing"),filePaths=jsonArray()},plan.revision,
                function(_,_,problem2) err=problem2 end)
            check(err and err.code=="candidate_criterion_missing","native link update rejects unknown current criteria")
        elseif phase==6 then
            fs.write(Review.path(paths,req),native.json.encode(legacyReview(req,1)))
            Review.createReview(paths,req,token,{source="manual",scope="人工完整审查",codeSnapshotSha256=SHA,findings=jsonArray()},1,
                function(value,problem) data=assertResult(value,problem) end)
            check(data.schemaVersion==3 and #data.reviews==2 and #data.acceptances==1 and #data.reopenings==1
                and data.reviews[1].requirementContentRevision==nil,"real CAS upgrades review1 to review3 preserving all historical identities")
        elseif phase==7 then
            reviewCandidate=candidate("review",req,plan.revision,"native-review-import")
            local value,problem=adoptReview(req,reviewCandidate,data.revision)
            data=assertResult(value,problem)
            check(#data.reviews==3 and data.reviews[3].source=="external" and #data.reviews[3].findings==0
                and data.candidateImports[1].reviewId==data.reviews[3].id,"repeated review3 native CAS appends full clean external review")
        elseif phase==8 then
            local bytes=fs.read(Review.path(paths,req))
            local replay,problem=adoptReview(req,reviewCandidate,0)
            check(replay and not problem and replay.revision==data.revision and fs.read(Review.path(paths,req))==bytes,
                "native clean review replay is idempotent")
            local gate=Validity.acceptance(req,assert(Results.loadResults(paths,req)),assert(Review.load(paths,req)))
            check(not gate.ok and gate.findings.blockingOpen==1 and #data.reviews[1].events==0 and #data.acceptances==1,
                "full clean native import cannot resolve historical blocker or fabricate acceptance")
            Store.create(paths,project,{id="req-candidate-v2",title="审查v2兼容",type="chore",goal="保留旧身份",
                criteria={"可核对"},now=os.time()*1000},token,function(value,updated,problem2)
                second,project=assertResult(value,problem2),updated
            end)
        elseif phase==9 then
            observed(second)
            fs.write(Review.path(paths,second),native.json.encode(legacyReview(second,2)))
            local value,problem=adoptReview(second,candidate("review",second,0,"native-v2-import"),1)
            local upgraded=assertResult(value,problem)
            check(upgraded.schemaVersion==3 and #upgraded.reviews==2 and upgraded.reviews[1].requirementContentRevision==Store.contentRevision(second)
                and #upgraded.acceptances==1 and #upgraded.reopenings==1,"real CAS upgrades review2 to review3 preserving markers and decisions")
        elseif phase==10 then
            Review.disposeFinding(paths,req,token,{reviewId="review-old",findingId="finding-old",action="waived",reason="明确人工豁免"},data.revision,
                function(value,problem) data=assertResult(value,problem) end)
            check(data.schemaVersion==3 and #data.candidateImports==1 and #data.reviews==3 and #data.reviews[1].events==1,
                "manual disposition on existing review3 retains imported provenance")
            local onDisk=assert(Review.load(paths,req))
            check(onDisk.candidateImports[1].id=="native-review-import" and onDisk.reviews[1].events[1].action=="waived",
                "review3 native writer publishes readable audit history")
        elseif phase==11 then
            local reqRows,problems=Store.readRequirements(paths)
            check(#reqRows==2 and #problems==0,"mixed upgraded candidate histories leave both requirements intact")
            Store.releaseLock(paths,token,function(ok) check(ok,"native candidate lock released") end)
            fs.write(tempRoot .. "\\result.json",native.json.encode({checks=checks,failures=failures,phase=phase}))
        end
        return {checks=checks,failures=failures,phase=phase,done=phase>=11}
    end
end
