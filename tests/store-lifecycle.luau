--!strict
-- Deterministic real Store API tests; only I/O and the atomic transport are replaced.
return function(source, json)
    local checks, failures = 0, {}
    local function check(value, message)
        checks += 1
        if not value then table.insert(failures, message) end
    end
    local function equal(actual, expected, message)
        check(actual == expected, message .. " (got " .. tostring(actual) .. ", want " .. tostring(expected) .. ")")
    end
    local files, fault, beforePublish, writes, serial = {}, nil, nil, 0, 0
    local paths = {project="store\\project.json",requirements="store\\requirements",lock="store\\lock.json",store="store"}
    local reqFile = paths.requirements .. "\\req-1\\requirement.json"
    local workflowFile = paths.requirements .. "\\req-1\\workflow.json"
    local function save(path, value) files[path] = json.encode(value) end
    local function read(path) return json.decode(assert(files[path])) end
    local function copy(value) return json.decode(json.encode(value)) end
    local stub = {json=json,now=function() return 10000 end,fs={
        exists=function(path) return files[path] ~= nil end,
        read=function(path) return assert(files[path], "missing file") end,
        write=function(path, bytes)
            if fault == "temp" then error("injected temp failure") end
            files[path] = bytes
        end,
        mkdir=function() end,
        remove=function(path) files[path] = nil end,
        list=function(dir)
            local names, seen = {}, {}
            for path in files do
                if path:sub(1,#dir+1) == dir .. "\\" then
                    local name = path:sub(#dir+2):match("^([^\\]+)")
                    if name and not seen[name] then seen[name]=true;table.insert(names,name) end
                end
            end
            table.sort(names)
            return names
        end,
    }}
    local chunk = assert(loadstring("local tern, os = ...\n" .. source, "@lib/store.luau"))
    local Store = chunk(stub, {time=function() return 10 end})
    Store.newId = function(prefix) serial += 1; return prefix .. "-" .. tostring(serial) end
    local cx = {tag="atomic-context"}
    Store.runProcess = function(env, cb)
        writes += 1
        if fault == "spawn" then error("injected spawn failure") end
        if beforePublish then local hook=beforePublish;beforePublish=nil;hook() end
        local status, timedOut = 0, false
        local lock = read(paths.lock)
        if lock.token ~= env.OMPWB_TOKEN then status=2
        elseif fault == "publish" then status=6
        elseif fault == "timeout" then status=6;timedOut=true
        else
            local expected = tonumber(env.OMPWB_EXPECT)
            local current = files[env.OMPWB_TARGET] and read(env.OMPWB_TARGET)
            if current and (expected == 0 or current.revision ~= expected) then status=3
            elseif not current and expected ~= 0 then status=3
            elseif current and current.schemaVersion ~= 1 and not (current.schemaVersion == 2 and env.OMPWB_SCHEMA2 == "1") then status=4
            elseif not files[env.OMPWB_TEMP] then status=5
            else files[env.OMPWB_TARGET] = files[env.OMPWB_TEMP] end
        end
        files[env.OMPWB_TEMP] = nil
        cb(status, "injected", timedOut, cx)
    end
    local project = Store.newProject({projectId="project-1",root="/project",name="Project",now=1000})
    project.nextNumber = 2
    local function reset(legacy, stage)
        files={};fault=nil;beforePublish=nil;writes=0
        save(paths.project, project)
        save(paths.lock, {schemaVersion=1,token="owner",owner={window="",panel=1},updatedAt=1000})
        local req = Store.newRequirement(project, {id="req-1",title="A",type="feature",goal="Goal",criteria={"First"},labels={"one","two"},now=1000})
        req.number="REQ-0001";req.stage=stage or "backlog"
        if legacy then req.schemaVersion=1;req.revision=7;req.contentRevision=nil;req.lifecycleEvents=nil end
        save(reqFile, req)
        return req
    end
    local function update(req, patch, expected)
        local draft=copy(req)
        for key,value in patch or {} do draft[key]=value end
        local out, problem, context
        Store.update(paths,draft,expected or req.revision,"owner",function(a,b,c) out,problem,context=a,b,c end)
        return out,problem,context
    end
    local function lifecycle(req, action, reason, expected, token)
        local out, problem, context
        Store.lifecycle(paths,req,action,reason == nil and "Explicit reason" or reason,expected or req.revision,token or "owner",
            function(a,b,c) out,problem,context=a,b,c end)
        return out,problem,context
    end
    local function workflow(schema)
        return {schemaVersion=schema or 2,projectId="project-1",requirementId="req-1",revision=1,latestVersion=0,
            designs={},comments={},approvals={},requests={}}
    end
    local function request(status)
        return {requestId="request-1",activity="clarify",sessionId="session-1",instanceId="instance-1",payloadSha256=string.rep("a",64),
            requirementRevision=1,requirementContentRevision=1,requirementSha256=string.rep("b",64),authorizedRequirementRevision=1,
            currentRequirementRevision=1,createdAt=1000,status=status,reason=status~="pending" and "delivery not known" or nil,
            receivedAt=status~="pending" and 1001 or nil}
    end

    local req=reset(true)
    local bytes=files[reqFile]
    local rows, problems=Store.readRequirements(paths)
    equal(#rows,1,"legacy requirement readable");equal(#problems,0,"legacy read has no failures")
    equal(Store.contentRevision(rows[1]),7,"legacy identity uses exact CAS revision")
    equal(files[reqFile],bytes,"legacy inspection never rewrites bytes")
    local upgraded=assert(update(req))
    equal(upgraded.schemaVersion,2,"normal no-op update upgrades schema atomically")
    equal(upgraded.contentRevision,7,"legacy no-op preserves identity")
    equal(upgraded.revision,8,"no-op still increments CAS")
    equal(#upgraded.lifecycleEvents,0,"upgrade introduces empty history without rebinding")
    req=assert(update(upgraded,{title="B"}))
    equal(req.contentRevision,9,"content change takes new CAS identity")
    req=assert(update(req,{title="A"}))
    equal(req.contentRevision,10,"A to B to A never resurrects old identity")
    local unchanged=assert(update(req))
    equal(unchanged.contentRevision,10,"schema2 no-op preserves content identity")
    for _,patch in {{type="bug"},{priority="high"},{goal="Other"},{scope="Scope"},
        {acceptanceCriteria={{id="other",description="First",required=true}}},
        {acceptanceCriteria={{id="other",description="Different",required=true}}},
        {acceptanceCriteria={{id="other",description="Different",required=false}}},{labels={"two","one"}}} do
        local prior=unchanged.contentRevision
        unchanged=assert(update(unchanged,patch))
        check(unchanged.contentRevision>prior,"every canonical field including criterion ID/required and label order changes identity")
    end
    req=reset(true)
    local staged
    Store.workflowStage(paths,req,"clarifying",req.revision,"owner",function(value) staged=value end)
    check(staged~=nil,"legacy workflowStage succeeds");equal(staged.schemaVersion,2,"workflowStage upgrades schema")
    equal(staged.contentRevision,7,"workflowStage preserves legacy identity")
    req=reset(true,"implementing")
    Store.advanceStage(paths,req,"verifying",req.revision,"owner",function(value) staged=value end)
    equal(staged.schemaVersion,2,"advanceStage upgrades schema");equal(staged.contentRevision,7,"advanceStage preserves identity")

    req=reset(false)
    local blocked,_,context=lifecycle(req,"block")
    check(blocked~=nil,"block succeeds");equal(context,cx,"CAS callback context preserved")
    equal(blocked.blockedFrom,"backlog","block remembers prior stage");equal(blocked.blockedReason,"Explicit reason","active block reason stored")
    equal(blocked.contentRevision,1,"block preserves content identity")
    equal(blocked.lifecycleEvents[1].from,"backlog","event source recorded");equal(blocked.lifecycleEvents[1].to,"blocked","event target recorded")
    equal(blocked.lifecycleEvents[1].reason,"Explicit reason","event reason recorded");equal(blocked.lifecycleEvents[1].at,10000,"deterministic timestamp recorded")
    local resumed=assert(lifecycle(blocked,"unblock","Ready"))
    equal(resumed.stage,"backlog","unblock restores source");equal(resumed.blockedFrom,nil,"unblock clears source");equal(resumed.blockedReason,nil,"unblock clears active reason")
    equal(resumed.lifecycleEvents[1].id,blocked.lifecycleEvents[1].id,"prior event retained")
    local cancelled=assert(lifecycle(assert(lifecycle(resumed,"block")),"cancel","Stop"))
    equal(cancelled.stage,"cancelled","blocked can cancel");equal(cancelled.blockedReason,nil,"cancel clears active block")
    local reopened=assert(lifecycle(cancelled,"reopen","New work"))
    equal(reopened.stage,"clarifying","cancelled reopens to clarifying");equal(#reopened.lifecycleEvents,5,"all explicit actions append history")
    equal(reopened.contentRevision,1,"all lifecycle writes preserve identity")
    for stage in Store.stages do
        req=reset(false,stage)
        if stage~="blocked" and stage~="done" and stage~="cancelled" then
            check(lifecycle(req,"block")~=nil,"block allowed from "..stage)
            req=reset(false,stage);check(lifecycle(req,"cancel")~=nil,"cancel allowed from "..stage)
        elseif stage=="done" or stage=="cancelled" then
            local _,err=lifecycle(req,"cancel");equal(err.code,"invalid_stage_transition","terminal cancel rejected")
            check(lifecycle(req,"reopen")~=nil,"terminal reopen allowed from "..stage)
        end
    end
    req=reset(false,"done")
    local reviewFile=paths.requirements.."\\req-1\\reviews.json"
    save(reviewFile,{schemaVersion=1,revision=4,acceptances={{id="acceptance-1",decision="accepted"}}})
    local reviewBytes=files[reviewFile]
    check(lifecycle(req,"reopen")~=nil,"accepted done reopens")
    equal(files[reviewFile],reviewBytes,"reopen leaves acceptance history bytes untouched")
    local bypass
    Store.advanceStage(paths,req,"clarifying",req.revision,"owner",function(_,err) bypass=err end)
    equal(bypass.code,"invalid_stage_transition","reasonless done reopen removed")

    for _,reason in {"", " \t\n", string.rep("x",2001), string.char(0xC0,0xAF), "bad\0reason"} do
        req=reset(false);bytes=files[reqFile]
        local _,err=lifecycle(req,"block",reason)
        equal(err.code,"invalid_lifecycle_reason","invalid reason rejected");equal(files[reqFile],bytes,"invalid reason preserves disk")
    end
    req=reset(false)
    for _,status in {"pending","delivery_unknown"} do
        local w=workflow();w.requests={request(status)};save(workflowFile,w);bytes=files[reqFile]
        local _,err=lifecycle(req,"cancel")
        equal(err.code,"unresolved_request","unresolved "..status.." blocks lifecycle");equal(files[reqFile],bytes,"request guard does not mutate requirement")
    end
    local w=workflow();w.requests={request("delivery_unknown")};w.requests[1].resolution={kind="user_acknowledged",note="Checked externally",at=1002};save(workflowFile,w)
    check(lifecycle(req,"cancel")~=nil,"explicit user acknowledgement permits lifecycle")
    for _,bad in {function(value) value.extra=true end,function(value) value.schemaVersion=3 end,
        function(value) value.requests={request("pending")};value.requests[1].extra=true end,
        function(value) value.requests={request("delivery_unknown")};value.requests[1].resolution={kind="user_acknowledged",note="",at=1} end,
        function(value) value.schemaVersion=1;value.requests={request("pending")} end} do
        req=reset(false);w=workflow();bad(w);save(workflowFile,w);bytes=files[reqFile]
        local _,err=lifecycle(req,"cancel");equal(err.code,"corrupt_workflow","unknown or malformed workflow rejected conservatively")
        equal(files[reqFile],bytes,"corrupt workflow preserved requirement")
    end
    req=reset(true);w=workflow(1);save(workflowFile,w)
    check(lifecycle(req,"block")~=nil,"legacy requirement and workflow lifecycle upgrades safely")
    equal(read(workflowFile).schemaVersion,1,"lifecycle never migrates workflow as side effect")
    for _,action in {"unblock","cancel"} do
        req=reset(true,"blocked")
        req.blockedFrom="designing";req.blockedReason="Legacy external dependency";save(reqFile,req)
        local changed=assert(lifecycle(req,action,"Explicit transition"))
        equal(changed.schemaVersion,2,"legacy blocked transition upgrades schema")
        equal(#changed.lifecycleEvents,1,"legacy block does not fabricate prior events")
        local event=changed.lifecycleEvents[1]
        equal(event.previousBlockedFrom,"designing","legacy block origin preserved by "..action)
        equal(event.previousBlockedReason,"Legacy external dependency","legacy block reason preserved by "..action)
        equal(event.at,10000,"only actual new transition timestamp recorded")
        equal(changed.blockedFrom,nil,"legacy active block origin cleared after "..action)
        equal(changed.blockedReason,nil,"legacy active block reason cleared after "..action)
        equal(event.reason,"Explicit transition","transition reason distinct from prior blocking reason")
    end
    req=reset(true,"blocked");req.blockedReason="";save(reqFile,req)
    local partial=assert(lifecycle(req,"cancel"))
    equal(partial.lifecycleEvents[1].previousBlockedFrom,nil,"partial legacy block invents no origin")
    equal(partial.lifecycleEvents[1].previousBlockedReason,"","blank legacy reason preserved verbatim")
    req=reset(true,"blocked");req.blockedReason="Known reason";save(reqFile,req)
    equal(select(2,lifecycle(req,"unblock")).code,"invalid_stage_transition","legacy missing origin cannot unblock")
    local corruptEvent=copy(partial)
    corruptEvent.lifecycleEvents[1].previousBlockedReason=string.rep("x",2001)
    equal(Store.validateRequirement(corruptEvent),nil,"prior block reason remains bounded")
    corruptEvent=copy(partial);corruptEvent.lifecycleEvents[1].previousBlockedFrom="unknown"
    equal(Store.validateRequirement(corruptEvent),nil,"prior block origin remains validated")
    corruptEvent=copy(partial);corruptEvent.lifecycleEvents[1].from="backlog"
    equal(Store.validateRequirement(corruptEvent),nil,"prior block metadata forbidden on nonblocked transitions")
    req=reset(false);files[workflowFile]="not json"
    equal(select(2,lifecycle(req,"block")).code,"corrupt_workflow","invalid workflow JSON rejected")
    req=reset(false)
    for _,patch in {{schemaVersion=3},{extra=true},{contentRevision=2},{lifecycleEvents={{id="event",action="cancel",from="done",to="cancelled",reason="No",at=1}}}} do
        local value=copy(req);for key,item in patch do value[key]=item end
        equal(Store.validateRequirement(value),nil,"invalid requirement schema/identity/history rejected")
    end
    local legacy=copy(req);legacy.schemaVersion=1
    equal(Store.validateRequirement(legacy),nil,"schema1 cannot smuggle schema2 identity fields")
    req=reset(false)
    for index=1,Store.maxLifecycleEvents do req=assert(lifecycle(req,index%2==1 and "block" or "unblock")) end
    bytes=files[reqFile]
    equal(select(2,lifecycle(req,"cancel")).code,"lifecycle_history_full","history limit fails without truncating")
    equal(files[reqFile],bytes,"full history retained byte for byte")
    local rewritten=copy(req);rewritten.revision+=1;rewritten.lifecycleEvents[1].reason="Changed"
    local putReason
    Store.put(paths,reqFile,rewritten,req.revision,"owner",function(_,err) putReason=err end)
    equal(putReason,"invalid_lifecycle_history","low-level put cannot rewrite prior event")

    for _,failure in {"temp","spawn","publish","timeout"} do
        req=reset(true);bytes=files[reqFile];fault=failure
        local out,err=lifecycle(req,"block")
        equal(out,nil,"failed publication returns no updated requirement")
        check(err~=nil,"publication failure reports error: "..failure)
        equal(files[reqFile],bytes,"publication failure rolls back schema/history: "..failure)
    end
    req=reset(false);bytes=files[reqFile]
    equal(select(2,lifecycle(req,"block",nil,nil,"other")).code,"lock_conflict","wrong owner rejected by transport")
    equal(files[reqFile],bytes,"lock conflict preserves bytes")
    local newer=assert(lifecycle(req,"block"))
    equal(select(2,lifecycle(req,"cancel")).code,"revision_conflict","exact stale lifecycle CAS rejected")
    equal(select(2,update(req,{title="Changed"})).code,"revision_conflict","exact stale content CAS rejected")
    beforePublish=function() local raced=read(reqFile);raced.revision+=1;save(reqFile,raced) end
    equal(select(2,lifecycle(newer,"cancel")).code,"revision_conflict","atomic CAS still catches read/publish race")
    equal(read(reqFile).stage,"blocked","raced publication cannot change stage")
    req=reset(false);save(paths.requirements.."\\other\\requirement.json",{schemaVersion=99})
    equal(select(2,lifecycle(req,"block")).code,"corrupt_requirements","other corrupt requirement blocks lifecycle")
    req=reset(false);save(paths.project,{schemaVersion=2})
    equal(select(2,lifecycle(req,"block")).code,"corrupt_project","project schema remains1")

    -- Scoped schema gates execute the actual production publication path.
    req=reset(false)
    local function scoped(name,value,expected)
        local saved,err
        Store.putScoped(paths,paths.requirements.."\\req-1\\"..name,value,expected or 0,"owner",function(a,b) saved,err=a,b end)
        return saved,err
    end
    for _,name in {"results","reviews","plan","resources"} do
        local value={schemaVersion=2,projectId="project-1",requirementId="req-1",revision=1}
        local ok,err=scoped(name..".json",value)
        equal(ok,name=="results" or name=="reviews","scoped schema2 is restricted to results/reviews")
        if name=="results" or name=="reviews" then
            value.revision=2;check(scoped(name..".json",value,1),"existing schema2 passes atomic schema gate")
            value.revision=3;value.unknown=true;equal(select(2,scoped(name..".json",value,2)),"invalid_path_or_record","scoped unknown top-level fields rejected")
        else equal(err,"invalid_path_or_record","plan/resources remain schema1") end
    end
    local old=workflow(1)
    old.latestVersion=1
    old.designs={{version=1,sha256=string.rep("a",64),requirementSha256=string.rep("b",64),requirementRevision=1,createdAt=1000}}
    local saved
    Store.putRecord(paths,workflowFile,old,0,"owner",function(ok) saved=ok end)
    check(saved,"legacy workflow still writable")
    old.schemaVersion=2;old.revision=2
    Store.putRecord(paths,workflowFile,old,1,"owner",function(ok) saved=ok end)
    check(saved,"workflow schema2 atomically upgrades schema1")
    equal(read(workflowFile).designs[1].requirementContentRevision,nil,"upgrading container does not mark legacy nested records")
    local marked=copy(old);marked.revision=3;marked.designs[1].requirementContentRevision=1
    Store.putRecord(paths,workflowFile,marked,2,"owner",function(ok) saved=ok end)
    check(saved,"schema2 nested design identity accepted")
    local invalid=copy(marked);invalid.revision=4;invalid.designs[1].unknown=true
    Store.putRecord(paths,workflowFile,invalid,3,"owner",function(ok) saved=ok end)
    equal(saved,false,"unknown schema2 nested design field rejected")
    invalid=copy(marked);invalid.revision=4;invalid.schemaVersion=1
    Store.putRecord(paths,workflowFile,invalid,3,"owner",function(ok) saved=ok end)
    equal(saved,false,"schema1 nested design rejects identity marker")
    local decision={id="approval-1",mode="direct",requirementRevision=1,requirementContentRevision=1,
        requirementSha256=string.rep("c",64),requirementContent="snapshot",designVersion=0,designSha256="",latestVersion=1,
        baseline={head="",fingerprint=string.rep("d",64),dirty=false},approvedAt=1000,reason="Explicit authorization"}
    local approved=copy(marked);approved.revision=4;approved.approvals={decision};approved.approval=copy(decision)
    Store.putRecord(paths,workflowFile,approved,3,"owner",function(ok) saved=ok end)
    check(saved,"schema2 marked approval history and exact pointer accepted")
    approved.revision=5;approved.approval.reason="Tampered pointer"
    Store.putRecord(paths,workflowFile,approved,4,"owner",function(ok) saved=ok end)
    equal(saved,false,"approval pointer cannot diverge from historical decision")
    local design={schemaVersion=2,projectId="project-1",requirementId="req-1",version=1,requirementRevision=1,requirementContentRevision=1,
        body="Design",sha256=string.rep("c",64),requirementSha256=string.rep("d",64),source={kind="manual"},createdAt=1000}
    local designFile=paths.requirements.."\\req-1\\designs\\v1.json"
    Store.putImmutableRecord(paths,designFile,design,"owner",function(ok) saved=ok end)
    check(saved,"new schema2 immutable design published")
    Store.putImmutableRecord(paths,designFile,design,"owner",function(ok) saved=ok end)
    equal(saved,false,"immutable design cannot overwrite prior version")
    design.schemaVersion=1;design.version=2
    Store.putImmutableRecord(paths,designFile:gsub("v1","v2"),design,"owner",function(ok) saved=ok end)
    equal(saved,false,"legacy design rejects content identity marker")
    local evidence={schemaVersion=2,projectId="project-1",requirementId="req-1",revision=1,requirementRevision=1,requirementContentRevision=1}
    check(scoped("evidence\\verification-one.json",evidence),"schema2 evidence can be created")
    equal(select(2,scoped("evidence\\verification-one.json",evidence)),"revision_conflict","evidence remains create-only")
    evidence.schemaVersion=1
    equal(select(2,scoped("evidence\\verification-two.json",evidence)),"invalid_path_or_record","schema1 evidence rejects marker")
    return {checks=checks,failures=failures}
end
