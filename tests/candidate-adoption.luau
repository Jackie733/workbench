--!strict
-- All adoption/edit calls use production modules and Store.putScoped serialization/CAS.
return function(env)
    local Store, Results, Review, Validity = env.Store, env.Results, env.Review, env.Validity
    local files, json, state = env.files, env.json, env.state
    local checks, failures = 0, {}
    local function check(ok, message) checks+=1; if not ok then table.insert(failures,message) end end
    local function clone(value) return json.decode(json.encode(value)) end
    local function put(path,value) files[path]=json.encode(value) end
    local SHA, RAW, OTHER = string.rep("a",64), string.rep("b",64), string.rep("c",64)
    local paths = {project="project\\project.json", requirements="project\\requirements", lock="project\\lock.json"}
    local project = Store.newProject({projectId="project-1",root="/repo",name="candidate regression",now=1})
    local req = Store.newRequirement(project,{id="req-1",title="entry",type="feature",goal="entry works",criteria={"entry works"},now=1})
    project.nextNumber=2
    req.revision, req.contentRevision = 5, 2
    local reqPath = paths.requirements .. "\\req-1\\requirement.json"
    local planPath, resultsPath, reviewsPath = Results.planPath(paths,req), Results.resultsPath(paths,req), Review.path(paths,req)
    local changes = {capturedAt=1,head="",fingerprint=SHA,dirty=false,files={},filesTruncated=false,
        diff="",diffSha256=SHA,diffTruncated=false,commits={},commitsTruncated=false}
    local function reset()
        table.clear(files); state.writes, state.reject, state.race = 0,nil,nil
        put(paths.project,project); put(reqPath,req)
        put(resultsPath,{schemaVersion=2,projectId=req.projectId,requirementId=req.requirementId,revision=1,changes=changes,verifications={}})
    end
    local function candidate(kind)
        local value = {schemaVersion=1,kind=kind,id=kind .. "-candidate",projectId=req.projectId,requirementId=req.requirementId,
            requirementRevision=req.revision,requirementContentRevision=req.contentRevision,codeSnapshotSha256=SHA,planRevision=0,complete=true}
        if kind == "plan" then value.steps={{id="P1",title="implement entry",criterionIds={"C1"},filePaths={"src/entry.luau"}}}
        else value.scope="full requirement and workspace"; value.findings={{id="F1",severity="blocking",description="entry missing"}} end
        return value
    end
    local function adopt(kind,value,sha,expected,selected)
        local saved, problem, cx
        if kind == "plan" then
            Results.adoptCandidate(paths,selected or req,"owner",value,sha or RAW,expected or 0,
                function(a,b,c,d) saved=a; if a then cx=c else problem,cx=c,d end end)
        else
            Review.adoptCandidate(paths,selected or req,"owner",value,sha or RAW,expected or 0,
                function(a,b,c) saved,problem,cx=a,b,c end)
        end
        return saved,problem,cx
    end
    local function refused(kind,value,code,sha,expected,selected)
        local beforePlan,beforeReviews,beforeReq,beforeResults,writes=files[planPath],files[reviewsPath],files[reqPath],files[resultsPath],state.writes
        local saved,problem=adopt(kind,value,sha,expected,selected)
        check(not saved and problem and problem.code == code,kind .. " rejects " .. code)
        check(files[planPath]==beforePlan and files[reviewsPath]==beforeReviews and files[reqPath]==beforeReq
            and files[resultsPath]==beforeResults and state.writes==writes,kind .. " refusal leaves all history unchanged")
    end
    for _, kind in {"plan","review"} do
        reset()
        local value=candidate(kind)
        local input=json.encode(value)
        local saved,problem,cx=adopt(kind,value)
        check(saved and not problem and cx==env.cx,kind .. " adoption publishes through real Store and preserves callback context")
        check(saved and saved.schemaVersion==(kind=="plan" and 2 or 3),kind .. " writes current schema")
        local manifest=saved and saved.candidateImports[1]
        local entity=kind=="plan" and saved.steps[1] or saved.reviews[1].findings[1]
        check(manifest and manifest.sourceIds[1]==(kind=="plan" and "P1" or "F1") and manifest.entityIds[1]==entity.id
            and entity.id~=manifest.sourceIds[1],kind .. " persists stable external/internal mapping")
        check(json.encode(value)==input and files[reqPath]==json.encode(req),kind .. " adoption does not mutate candidate or requirement")
        local priorBytes=files[kind=="plan" and planPath or reviewsPath]
        local writes=state.writes
        local replay=adopt(kind,value)
        check(replay and state.writes==writes and files[kind=="plan" and planPath or reviewsPath]==priorBytes,
            kind .. " same ID/hash replay is no-write success despite changed domain revision")
        refused(kind,value,"candidate_conflict",OTHER)
        -- A replay is identity-scoped, but deliberately survives freshness drift.
        local drift=clone(req); drift.revision+=1; put(reqPath,drift)
        local observed=clone(json.decode(files[resultsPath])); observed.changes.fingerprint=OTHER; put(resultsPath,observed)
        replay=adopt(kind,value)
        check(replay and state.writes==writes,kind .. " replay precedes fresh requirement/snapshot checks")
        local wrong=clone(value); wrong.projectId="other-project"
        refused(kind,wrong,"candidate_wrong_target")
        for field, bad in {requirementRevision=4,requirementContentRevision=1,planRevision=1,codeSnapshotSha256=OTHER} do
            reset(); local stale=clone(value); stale[field]=bad
            refused(kind,stale,"candidate_stale")
        end
        reset(); put(reqPath,drift); refused(kind,value,"candidate_stale")
        reset(); drift=clone(req); drift.contentRevision=3; put(reqPath,drift); refused(kind,value,"candidate_stale")
        reset(); files[resultsPath]=nil; refused(kind,value,"candidate_stale")
        reset(); local observed2=json.decode(files[resultsPath]); observed2.changes.fingerprint=OTHER; put(resultsPath,observed2)
        refused(kind,value,"candidate_stale")
        reset(); local partial=clone(value); partial.complete=false; refused(kind,partial,"invalid_candidate")
        local malformed=clone(value); malformed.status="done"; refused(kind,malformed,"invalid_candidate")
        malformed=clone(value); local items=kind=="plan" and malformed.steps or malformed.findings
        table.insert(items,clone(items[1])); refused(kind,malformed,"invalid_candidate")
        malformed=clone(value); items=kind=="plan" and malformed.steps or malformed.findings
        items.extra=clone(items[1]); refused(kind,malformed,"invalid_candidate")
        reset(); files[reqPath]="{"; refused(kind,value,"corrupt_requirements")
        reset(); files[resultsPath]="{"; refused(kind,value,"corrupt_record")
        reset(); put(planPath,{schemaVersion=99}); refused(kind,value,"corrupt_plan")
        reset(); state.reject=kind=="plan" and planPath or reviewsPath
        refused(kind,value,"publish_failed")
        check(json.encode(value)==input,kind .. " failed save keeps caller candidate immutable")
        reset(); state.race=function(target)
            if target==planPath then put(target,{schemaVersion=2,projectId=req.projectId,requirementId=req.requirementId,
                revision=1,designVersion=0,steps={},candidateImports={},changeReason="concurrent edit",updatedAt=1})
            else put(target,{schemaVersion=3,projectId=req.projectId,requirementId=req.requirementId,
                revision=1,reviews={},acceptances={},reopenings={},candidateImports={}}) end
        end
        local lost,conflict=adopt(kind,value)
        check(not lost and conflict and conflict.code=="revision_conflict",kind .. " native CAS rejects concurrent publication")
        check(json.decode(files[kind=="plan" and planPath or reviewsPath]).revision==1 and state.writes==0,
            kind .. " CAS failure retains concurrent history")
    end
    reset()
    local unknown=candidate("plan"); unknown.steps[1].criterionIds={"removed"}
    refused("plan",unknown,"candidate_criterion_missing")
    unknown=candidate("plan"); unknown.steps[1].filePaths={".omp/workbench/reviews.json"}
    refused("plan",unknown,"invalid_candidate")
    -- Upgrade a historical plan without inventing links or changing its completed state.
    local oldPlan={schemaVersion=1,projectId=req.projectId,requirementId=req.requirementId,revision=1,designVersion=0,
        steps={{id="step-old",title="historical",status="done",updatedAt=1,evidenceIds={"verification-old"}}},changeReason="old",updatedAt=1}
    put(planPath,oldPlan)
    local planned=candidate("plan"); planned.planRevision=1
    local adopted=adopt("plan",planned,RAW,1)
    check(adopted and #adopted.steps==2 and adopted.steps[1].status=="done" and adopted.steps[1].criterionIds==nil,
        "plan adoption appends and keeps legacy step history without fabricated links")
    local linked,linkError
    Results.applyPlan(paths,req,"owner","links",{stepId="step-old",criterionIds={"C1"},filePaths={"src/entry.luau"}},2,
        function(a,_,c) linked=a; if not a then linkError=c end end)
    check(linked and not linkError and linked.steps[1].criterionIds[1]=="C1" and #linked.candidateImports==1,
        "explicit link editing upgrades old step and preserves import manifests")
    Results.applyPlan(paths,req,"owner","links",{stepId="step-old",criterionIds={"deleted"},filePaths={}},3,
        function(_,_,err) linkError=err end)
    check(linkError and linkError.code=="candidate_criterion_missing","link edits reject unknown current criterion")
    local deleted=clone(req); deleted.acceptanceCriteria={}; put(reqPath,deleted)
    check(Results.loadPlan(paths,deleted)~=nil,"deleted criterion links remain readable as history")
    local badVersion=clone(linked); badVersion.schemaVersion=1
    badVersion.candidateImports=nil
    check(Results.validatePlan(badVersion,req)==nil,"schema1 plan cannot smuggle v2 links/manifests")
    badVersion=clone(linked); badVersion.schemaVersion=3
    check(Results.validatePlan(badVersion,req)==nil,"unknown plan schema rejected conservatively")
    badVersion=clone(linked); badVersion.candidateImports[1].entityIds[1]="step-missing"
    check(Results.validatePlan(badVersion,req)==nil,"orphan plan mapping rejected")
    -- A clean full-scope review appends; it never disposes an older blocker or creates acceptance.
    reset()
    local manual
    Review.createReview(paths,req,"owner",{source="manual",scope="full",codeSnapshotSha256=SHA,
        findings={{severity="blocking",description="historical blocker"}}},0,function(value) manual=value end)
    local clean=candidate("review"); clean.findings={}
    local cleaned=adopt("review",clean,RAW,1)
    check(cleaned and #cleaned.reviews==2 and #cleaned.reviews[2].findings==0 and #cleaned.acceptances==0
        and #cleaned.reviews[1].events==0 and cleaned.reviews[1].source=="manual","clean review only appends external provenance")
    local gate=Validity.acceptance(req,assert(Results.loadResults(paths,req)),cleaned)
    check(not gate.ok and gate.findings.blockingOpen==1,"full clean review cannot erase historical open blocker")
    check(cleaned.candidateImports[1].reviewId==cleaned.reviews[2].id and #cleaned.candidateImports[1].sourceIds==0,
        "empty full review still has owning review import mapping")
    local legacy=clone(manual); legacy.schemaVersion=2; legacy.candidateImports=nil
    check(Review.validate(legacy,req)~=nil,"schema2 historical reviews remain readable")
    legacy.schemaVersion=1; legacy.reviews[1].requirementContentRevision=nil
    check(Review.validate(legacy,req)~=nil,"schema1 historical reviews remain readable")
    local invalid=clone(cleaned); invalid.schemaVersion=4
    check(Review.validate(invalid,req)==nil,"unknown review schema rejected conservatively")
    invalid=clone(cleaned); invalid.schemaVersion=2
    check(Review.validate(invalid,req)==nil,"old review schema rejects import manifest")
    invalid=clone(cleaned); invalid.candidateImports[1].reviewId="review-missing"
    check(Review.validate(invalid,req)==nil,"orphan review mapping rejected")
    invalid=clone(cleaned); table.insert(invalid.candidateImports,clone(invalid.candidateImports[1]))
    check(Review.validate(invalid,req)==nil,"duplicate persisted review import IDs rejected")
    -- Cached readers make mutation-on-failed-save observable, rather than merely checking bytes.
    local originalLoad=Review.load
    local cached=clone(cleaned)
    local before=json.encode(cached)
    Review.load=function() return cached,nil end
    state.reject=reviewsPath
    local disposed,disposeError
    Review.disposeFinding(paths,req,"owner",{reviewId=cached.reviews[1].id,findingId=cached.reviews[1].findings[1].id,
        action="resolved",reason="explicit human disposition"},cached.revision,function(a,b) disposed,disposeError=a,b end)
    check(not disposed and disposeError and json.encode(cached)==before,"failed disposition leaves loaded historical tables immutable")
    local nextReview=candidate("review"); nextReview.id="another-review"
    local failed,why=adopt("review",nextReview,RAW,cached.revision)
    check(not failed and why and json.encode(cached)==before,"failed candidate adoption leaves loaded review/import/acceptance tables immutable")
    Review.load=originalLoad
    state.reject=nil
    local disposedData
    Review.disposeFinding(paths,req,"owner",{reviewId=manual.reviews[1].id,findingId=manual.reviews[1].findings[1].id,
        action="waived",reason="human waiver"},cleaned.revision,function(value) disposedData=value end)
    check(disposedData and #disposedData.candidateImports==1 and disposedData.reviews[2].source=="external",
        "manual dispositions preserve imported provenance and every review")
    -- Legacy decisions and reopenings survive the new schema with their exact identity.
    reset()
    local history={schemaVersion=1,projectId=req.projectId,requirementId=req.requirementId,revision=1,reviews={},
        acceptances={{id="acceptance-old",decision="accepted",requirementRevision=1,codeSnapshotSha256=SHA,
            verificationIds={},reviewIds={},comment="historical decision",createdAt=1}},
        reopenings={{id="reopening-old",acceptanceId="acceptance-old",reason="human reopened",at=2}}}
    put(reviewsPath,history)
    local historical=adopt("review",candidate("review"),RAW,1)
    check(historical and #historical.acceptances==1 and #historical.reopenings==1
        and historical.acceptances[1].requirementContentRevision==nil
        and json.encode(historical.acceptances)==json.encode(history.acceptances)
        and json.encode(historical.reopenings)==json.encode(history.reopenings),
        "adoption upgrades without rewriting historical acceptance or reopening identity")
    local historicalBefore=files[reviewsPath]
    state.reject=reviewsPath
    local another=candidate("review"); another.id="save-failed-review"
    refused("review",another,"publish_failed",RAW,2)
    check(files[reviewsPath]==historicalBefore,"candidate save failure leaves acceptance/reopening bytes unchanged")
    -- Cached plans and caller-owned link lists must also survive failed publication.
    reset()
    local firstPlan=adopt("plan",candidate("plan"))
    local loadPlan=Results.loadPlan
    local cachedPlan=clone(firstPlan)
    local planBefore=json.encode(cachedPlan)
    Results.loadPlan=function() return cachedPlan,nil end
    state.reject=planPath
    local nextPlan=candidate("plan"); nextPlan.id="another-plan"; nextPlan.planRevision=1
    refused("plan",nextPlan,"publish_failed",RAW,1)
    check(json.encode(cachedPlan)==planBefore,"failed adoption cannot mutate cached plan or stable mapping")
    local links={stepId=cachedPlan.steps[1].id,criterionIds={"C1"},filePaths={"src/other.luau"}}
    local linksBefore=json.encode(links)
    Results.applyPlan(paths,req,"owner","links",links,1,function() end)
    check(json.encode(cachedPlan)==planBefore and json.encode(links)==linksBefore,
        "failed link publication cannot mutate historical steps or caller-owned arrays")
    Results.loadPlan=loadPlan
    -- Every current writer preserves import mappings, including status/add and decisions.
    state.reject=nil
    local statusPlan
    Results.applyPlan(paths,req,"owner","status",{stepId=firstPlan.steps[1].id,status="active"},1,
        function(value) statusPlan=value end)
    local addedPlan
    Results.applyPlan(paths,req,"owner","add",{title="manual follow-up"},statusPlan.revision,
        function(value) addedPlan=value end)
    check(addedPlan and #addedPlan.candidateImports==1 and #addedPlan.steps==2
        and addedPlan.steps[2].criterionIds~=nil and addedPlan.steps[2].filePaths~=nil,
        "manual status/add retain imports and create explicit empty link arrays")
    reset()
    local generated
    Results.applyPlan(paths,req,"owner","generate",{},0,function(value) generated=value end)
    check(generated and generated.steps[1].criterionIds[1]=="C1" and #generated.steps[1].filePaths==0
        and generated.schemaVersion==2,"generated steps carry explicit criterion/file associations")
    return {checks=checks,failures=failures}
end
