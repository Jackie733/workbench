--!strict
-- Durable, append-only requirement design history and explicit authorization.
local Store = require('./store')
local Validity = require('./validity')
local M = {}
local MAX_BODY = 16384
local function join(a, b) return a .. "\\" .. b end
local function workflowPath(paths, req) return join(join(paths.requirements, req.requirementId), "workflow.json") end
local function validText(s, max, empty)
    if type(s)~="string" or #s>max or (not empty and s:match("%S")==nil) or s:find("[%z\1-\8\11\12\14-\31\127]") then return false end
    local i=1
    while i<=#s do
        local b=s:byte(i);local count,minimum
        if b<0x80 then count,minimum=1,0
        elseif b>=0xC2 and b<=0xDF then count,minimum=2,0x80
        elseif b>=0xE0 and b<=0xEF then count,minimum=3,0x800
        elseif b>=0xF0 and b<=0xF4 then count,minimum=4,0x10000
        else return false end
        if i+count-1>#s then return false end
        local code=b%(2^(8-count-1))
        for j=1,count-1 do local n=s:byte(i+j);if n<0x80 or n>0xBF then return false end;code=code*64+n-0x80 end
        if code<minimum or code>0x10FFFF or (code>=0xD800 and code<=0xDFFF) then return false end
        i+=count
    end
    return true
end
local function read(path)
    if not tern.fs.exists(path) then return nil, "missing" end
    local ok, raw = pcall(tern.fs.read, path, Store.maxJson)
    if not ok then return nil, "read_failed" end
    local decoded, value = pcall(tern.json.decode, raw)
    if not decoded or type(value) ~= "table" then return nil, "corrupt_workflow" end
    return value
end
local function identityValid(record, schema)
    local identity=record.requirementContentRevision
    return identity==nil or (schema==2 and type(identity)=="number" and identity>=1 and identity%1==0
        and type(record.requirementRevision)=="number" and identity<=record.requirementRevision)
end
local function validate(w, req)
    return Store.validateWorkflow(w, req)
end
function M.load(paths, requirement)
    local p = workflowPath(paths, requirement)
    local w, err = read(p)
    if err == "missing" then return {schemaVersion=2, projectId=requirement.projectId, requirementId=requirement.requirementId,
        revision=0, latestVersion=0, designs=tern.json.array(), comments=tern.json.array(), approvals=tern.json.array(), requests=tern.json.array()}, nil end
    if not w then return nil, {code=err} end
    local valid, problem = validate(w, requirement)
    if not valid then return nil, {code=problem} end
    return w
end
local function sha256(body, cb)
    -- Hash exact UTF-8 stdin bytes; no temporary plaintext file or shell interpolation.
    local script = "$ErrorActionPreference='Stop'; $h=[Security.Cryptography.SHA256]::Create(); $s=[Console]::OpenStandardInput(); try { [Console]::Write([BitConverter]::ToString($h.ComputeHash($s)).Replace('-','').ToLowerInvariant()) } finally { $s.Dispose(); $h.Dispose() }"
    local argv = {"powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script}
    local ok, problem = pcall(tern.process.run, argv, {stdin=body, timeout_ms=8000}, function(r)
        if r.status ~= 0 or r.timed_out then cb(nil, "sha256_failed") else cb((r.stdout or ""):gsub("%s+$", "")) end
    end)
    if not ok then cb(nil, "sha256_failed:" .. tostring(problem)) end
end
function M.requirementContent(requirement)
    local criteria, labels = tern.json.array(), tern.json.array()
    for _, c in requirement.acceptanceCriteria or {} do
        local item=tern.json.array();table.insert(item,c.id);table.insert(item,c.description);table.insert(item,c.required);table.insert(criteria,item)
    end
    for _, label in requirement.labels or {} do table.insert(labels,label) end
    local values=tern.json.array()
    for _,value in {requirement.title,requirement.type,requirement.priority,requirement.goal,requirement.scope,criteria,labels} do table.insert(values,value) end
    return tern.json.encode(values)
end
function M.requirementSha256(requirement, callback)
    sha256(M.requirementContent(requirement),callback)
end
local function baselineValid(b)
    return type(b)=="table" and type(b.head)=="string" and #b.head<=128 and type(b.fingerprint)=="string"
        and #b.fingerprint==64 and b.fingerprint:match("^[0-9a-fA-F]+$")~=nil and type(b.dirty)=="boolean"
end
function M.approvalState(w, req)
    return Validity.approval(w, req, M.requirementContent(req))
end
M.contentFields = Validity.contentFields
-- Field-level comparison between an existing approval snapshot and the current
-- requirement. Missing or unreadable snapshots are reported as unavailable.
function M.approvalDiff(approval, requirement)
    if type(approval) ~= "table" or type(approval.requirementContent) ~= "string" then
        return {available = false, reason = "missing_snapshot", changes = {}}
    end
    local okBefore, before = pcall(tern.json.decode, approval.requirementContent)
    local okAfter, after = pcall(function() return tern.json.decode(M.requirementContent(requirement)) end)
    if not okBefore or not okAfter or type(before) ~= "table" or type(after) ~= "table" then
        return {available = false, reason = "corrupt_snapshot", changes = {}}
    end
    return Validity.contentDiff(before, after)
end
local function copyArray(a) local b=tern.json.array(); for _,v in a do table.insert(b,v) end; return b end
local function revokeCurrent(w, at, reason)
    if not w.approval or w.approval.revokedAt then return end
    local revoked={};for k,v in w.approval do revoked[k]=v end
    revoked.revokedAt=at;revoked.revocationReason=reason
    for i,decision in w.approvals do if decision.id==revoked.id then w.approvals[i]=revoked;break end end
    w.approval=revoked
end
local function persist(paths, req, token, w, oldRev, cb)
    w.schemaVersion=2
    w.revision=oldRev+1
    local f=workflowPath(paths,req)
    Store.putRecord(paths,f,w,oldRev,token,function(saved,reason,cx)
        if saved then cb(w,req,nil,cx) else cb(nil,nil,{code=reason},cx) end
    end)
end
function M.readDesign(paths, requirement, version)
    local w, err=M.load(paths,requirement); if not w then return nil,err end
    if type(version)~="number" or version%1~=0 or version<1 or version>w.latestVersion then return nil,{code="missing_design"} end
    local d,problem=read(join(join(paths.requirements,requirement.requirementId),"designs\\v"..version..".json"))
    if not d then return nil,{code=problem} end
    local metadata=w.designs[version]
    if (d.schemaVersion~=1 and d.schemaVersion~=2) or d.projectId~=requirement.projectId or d.requirementId~=requirement.requirementId or d.version~=version
        or not validText(d.body,MAX_BODY,false) or type(d.createdAt)~="number" or d.createdAt<0 or d.createdAt%1~=0 or d.sha256~=metadata.sha256
        or d.requirementSha256~=metadata.requirementSha256 or d.requirementRevision~=metadata.requirementRevision
        or not identityValid(d,d.schemaVersion) or (d.schemaVersion==2 and d.requirementContentRevision==nil)
        or d.requirementContentRevision~=metadata.requirementContentRevision then return nil,{code="corrupt_design"} end
    for key in d do
        if key~="schemaVersion" and key~="projectId" and key~="requirementId" and key~="version"
            and key~="requirementRevision" and key~="requirementContentRevision" and key~="requirementSha256" and key~="body" and key~="sha256"
            and key~="source" and key~="createdAt" then return nil,{code="corrupt_design"} end
    end
    if type(d.source)~="table" or (d.source.kind~="manual" and d.source.kind~="file" and d.source.kind~="assistant") then return nil,{code="corrupt_design"} end
    for key,value in d.source do
        if (key~="kind" and key~="path" and key~="entryId" and key~="sessionId" and key~="requestId")
            or not validText(value,1024,true) then return nil,{code="corrupt_design"} end
    end
    return d
end
function M.apply(paths, requirement, token, action, args, expected, cb)
    local function fail(code, detail) cb(nil,nil,{code=code,detail=detail}) end
    if type(cb)~="function" then return end
    if not Store.token(token) or type(args)~="table" or type(expected)~="number" or expected%1~=0
        or type(requirement)~="table" or not Store.token(requirement.requirementId) then fail("invalid_options");return end
    local current,problem=Store.readRequirements(paths)
    local fresh
    for _,r in current do if r.requirementId==requirement.requirementId then fresh=r;break end end
    if not fresh then fail("missing_requirement",problem);return end
    if fresh.revision~=requirement.revision then fail("revision_conflict");return end
    local w,werr=M.load(paths,fresh); if not w then cb(nil,nil,werr);return end
    if w.revision~=expected then fail("revision_conflict");return end
    local nextW={}; for k,v in w do nextW[k]=v end
    nextW.designs=copyArray(w.designs);nextW.comments=copyArray(w.comments);nextW.approvals=copyArray(w.approvals);nextW.requests=copyArray(w.requests)
    local nextReq=fresh
    local function save()
        if nextReq ~= fresh and nextReq.stage ~= fresh.stage then
            Store.workflowStage(paths,fresh,nextReq.stage,fresh.revision,token,function(updated,stageError,cx)
                if not updated then cb(nil,nil,stageError,cx);return end
                persist(paths,updated,token,nextW,w.revision,cb)
            end)
        else persist(paths,fresh,token,nextW,w.revision,cb) end
    end
    if action=="adopt" then
        if not Store.workflowStages[fresh.stage] then fail("stage_not_actionable");return end
        if not validText(args.body,MAX_BODY,false) or type(args.source)~="table" then fail("invalid_design");return end
        for _,k in {"kind","path","entryId","sessionId","requestId"} do if args.source[k]~=nil and not validText(args.source[k],1024,true) then fail("invalid_source");return end end
        for key in args.source do
            if key~="kind" and key~="path" and key~="entryId" and key~="sessionId" and key~="requestId" then fail("invalid_source");return end
        end
        if args.source.kind~="manual" and args.source.kind~="file" and args.source.kind~="assistant" then fail("invalid_source");return end
        local v=w.latestVersion+1
        local dp=join(join(paths.requirements,fresh.requirementId),"designs\\v"..v..".json")
        sha256(args.body,function(hash,why)
            if not hash then fail(why);return end
            sha256(M.requirementContent(fresh),function(reqHash,reqWhy)
                if not reqHash then fail(reqWhy);return end
                local created=os.time()*1000
                local adoptedRevision=fresh.revision+(fresh.stage~="awaiting_approval" and 1 or 0)
                local record={schemaVersion=2,projectId=fresh.projectId,requirementId=fresh.requirementId,version=v,
                    requirementRevision=adoptedRevision,requirementContentRevision=Store.contentRevision(fresh),
                    requirementSha256=reqHash,body=args.body,sha256=hash,source=args.source,createdAt=created}
                local function finish(saved,reason,cx)
                    if not saved then cb(nil,nil,{code=reason},cx);return end
                    table.insert(nextW.designs,{version=v,sha256=hash,requirementSha256=reqHash,requirementRevision=record.requirementRevision,
                        requirementContentRevision=record.requirementContentRevision,createdAt=record.createdAt})
                    nextW.latestVersion=v
                    revokeCurrent(nextW,created,"newer_design")
                    if fresh.stage~="awaiting_approval" then nextReq={};for k,x in fresh do nextReq[k]=x end;nextReq.stage="awaiting_approval";nextReq.revision=fresh.revision+1;nextReq.updatedAt=created end
                    save()
                end
                if tern.fs.exists(dp) then
                    local prior=read(dp)
                    if not prior or prior.schemaVersion~=record.schemaVersion or prior.projectId~=record.projectId
                        or prior.requirementId~=record.requirementId or prior.version~=record.version
                        or prior.body~=record.body or prior.sha256~=record.sha256
                        or prior.requirementSha256~=record.requirementSha256 or prior.requirementContentRevision~=record.requirementContentRevision
                        or prior.requirementRevision~=record.requirementRevision
                        or tern.json.encode(prior.source)~=tern.json.encode(record.source) then fail("immutable_design_conflict");return end
                    record.createdAt=prior.createdAt;record.requirementRevision=prior.requirementRevision
                    finish(true)
                else Store.putImmutableRecord(paths,dp,record,token,finish) end
            end)
        end);return
    elseif action=="comment" then
        if type(args.designVersion)~="number" or args.designVersion<1 or args.designVersion>w.latestVersion or not validText(args.text,4000,false) then fail("invalid_comment");return end
        table.insert(nextW.comments,{designVersion=args.designVersion,text=args.text,createdAt=os.time()*1000});save();return
    elseif action=="approve" or action=="authorize_direct" then
        if not Store.workflowStages[fresh.stage] then fail("stage_not_actionable");return end
        local mode=action=="approve" and "design" or "direct"
        if type(args.clicked)~="boolean" or not args.clicked or not baselineValid(args.baseline) then fail("explicit_confirmation_required");return end
        if mode=="design" and (args.designVersion~=w.latestVersion or w.latestVersion<1) then fail("design_not_current");return end
        if mode=="direct" and (not validText(fresh.scope,MAX_BODY,false) or #fresh.acceptanceCriteria<1 or not validText(args.reason,2000,false)) then fail("direct_basis_required");return end
        local d=mode=="design" and w.designs[w.latestVersion] or nil
        if d and not Validity.matchesRequirement(d,fresh) then fail("design_not_current");return end
        local function makeDecision(reqHash)
            if not reqHash or (d and d.requirementSha256~=reqHash) then fail("requirement_content_changed");return end
            local decision={id=Store.newId("approval",os.time()*1000),mode=mode,requirementRevision=fresh.revision,
                requirementContentRevision=Store.contentRevision(fresh),requirementSha256=reqHash,requirementContent=M.requirementContent(fresh),
                designVersion=mode=="design" and w.latestVersion or 0,designSha256=d and d.sha256 or "",latestVersion=w.latestVersion,
                baseline=args.baseline,approvedAt=os.time()*1000}
            if mode=="direct" then decision.reason=args.reason end
            revokeCurrent(nextW,decision.approvedAt,"superseded_approval")
            table.insert(nextW.approvals,decision);nextW.approval=decision;save()
        end
        sha256(M.requirementContent(fresh),function(hash,why) if not hash then fail(why) else makeDecision(hash) end end);return
    elseif action=="revoke" then
        if not nextW.approval or not validText(args.reason,2000,false) then fail("invalid_revocation");return end
        if nextW.approval.revokedAt then fail("approval_already_revoked");return end
        revokeCurrent(nextW,os.time()*1000,args.reason);save();return
    elseif action=="request" then
        if not Store.workflowStages[fresh.stage] then fail("stage_not_actionable");return end
        if not Store.token(args.requestId) or (args.activity~="clarify" and args.activity~="design" and args.activity~="implement")
            or not Store.token(args.sessionId) or not Store.token(args.instanceId) or type(args.payloadSha256)~="string" or #args.payloadSha256~=64 or not args.payloadSha256:match("^[0-9a-f]+$") then fail("invalid_request");return end
        if action=="request" and args.activity=="implement" then local state=M.approvalState(w,fresh);if not state.valid then fail("approval_invalid",state.reason);return end end
        for _,r in nextW.requests do
            if r.requestId==args.requestId then
                if r.payloadSha256==args.payloadSha256 and r.activity==args.activity and r.sessionId==args.sessionId and r.instanceId==args.instanceId then
                    cb(w,fresh,nil)
                else fail("request_conflict") end
                return
            end
        end
        sha256(M.requirementContent(fresh),function(hash,why)
            if not hash then fail(why);return end
            table.insert(nextW.requests,{requestId=args.requestId,activity=args.activity,sessionId=args.sessionId,instanceId=args.instanceId,
                payloadSha256=args.payloadSha256,status="pending",requirementRevision=fresh.revision,
                requirementContentRevision=Store.contentRevision(fresh),requirementSha256=hash,
                authorizedRequirementRevision=fresh.revision,currentRequirementRevision=fresh.revision,createdAt=os.time()*1000})
            save()
        end);return
    elseif action=="acknowledge_unknown" then
        if args.clicked~=true or not validText(args.note,2000,false) then fail("explicit_confirmation_required");return end
        for _,r in nextW.requests do if r.requestId==args.requestId then
            if r.resolution then cb(w,fresh,nil);return end
            if r.status~="pending" and r.status~="delivery_unknown" then fail("request_already_resolved");return end
            local now=os.time()*1000
            if r.status=="pending" then r.status="delivery_unknown";r.reason="user_ended_waiting";r.receivedAt=now end
            r.resolution={kind="user_acknowledged",note=args.note,at=now}
            save();return
        end end
        fail("request_not_found");return
    elseif action=="receipt" then
        if args.status~="submitted" and args.status~="rejected" and args.status~="delivery_unknown" then fail("invalid_receipt");return end
        local receiptReason=args.reason or ""
        if not validText(receiptReason,1000,true) then fail("invalid_receipt");return end
        for _,r in nextW.requests do if r.requestId==args.requestId then
            if r.status==args.status and (r.reason or "")==receiptReason then cb(w,fresh,nil);return end
            if r.status~="pending" and not (r.status=="delivery_unknown" and args.status~="delivery_unknown") then fail("receipt_conflict");return end
            r.status=args.status;r.reason=receiptReason;r.receivedAt=os.time()*1000
            if args.status~="submitted" then save();return end
            sha256(M.requirementContent(fresh),function(hash,why)
                if not hash then fail(why);return end
                local target=r.activity=="implement" and "implementing" or r.activity=="clarify" and "clarifying" or "designing"
                if hash==r.requirementSha256 and Store.workflowStages[fresh.stage] then
                    if fresh.revision==r.currentRequirementRevision then
                        nextReq={};for k,x in fresh do nextReq[k]=x end
                        nextReq.stage=target;nextReq.updatedAt=os.time()*1000
                        if target~=fresh.stage then nextReq.revision=fresh.revision+1;r.currentRequirementRevision=nextReq.revision end
                    elseif fresh.stage==target and fresh.revision==r.currentRequirementRevision+1 then
                        -- The prior callback may have vanished after the stage CAS.
                        r.currentRequirementRevision=fresh.revision
                    end
                end
                save()
            end);return
        end end
        fail("request_not_found");return
    end
    fail("unknown_action")
end
return M
