--!strict
-- Requirement-scoped implementation plan, observed code results and verification evidence.
local Store = require('./store')
local Validity = require('./validity')
local M = {}
local MAX_STEPS, MAX_FILES, MAX_COMMITS, MAX_VERIFICATIONS = 40, 256, 50, 50
local MAX_DIFF = 48 * 1024
local statuses = {pending = true, active = true, done = true, blocked = true, skipped = true}

local function join(a, b) return a .. "\\" .. b end
local function requirementDir(paths, req) return join(paths.requirements, req.requirementId) end
function M.planPath(paths, req) return join(requirementDir(paths, req), "plan.json") end
function M.resultsPath(paths, req) return join(requirementDir(paths, req), "results.json") end
function M.evidencePath(paths, req, id) return join(join(requirementDir(paths, req), "evidence"), id .. ".json") end

local function text(value, max, empty)
    if type(value) ~= "string" or #value > max or (not empty and value:match("%S") == nil)
        or value:find("[%z\1-\8\11\12\14-\31\127]") then return false end
    return utf8.len(value) ~= nil
end
local function hash(value) return type(value) == "string" and #value == 64 and value:match("^[0-9a-f]+$") ~= nil end
local function integer(value, minimum) return type(value) == "number" and value % 1 == 0 and value >= minimum end
local function read(file)
    if not tern.fs.exists(file) then return nil, "missing" end
    local ok, raw = pcall(tern.fs.read, file, Store.maxJson)
    if not ok then return nil, "read_failed" end
    local decoded, value = pcall(tern.json.decode, raw)
    if not decoded or type(value) ~= "table" then return nil, "corrupt_record" end
    return value
end
local function allowed(value, keys)
    for key in value do if not keys[key] then return false end end
    return true
end

local planKeys = {schemaVersion=true, projectId=true, requirementId=true, revision=true, designVersion=true,
    steps=true, changeReason=true, updatedAt=true}
local stepKeys = {id=true, title=true, status=true, reason=true, updatedAt=true, evidenceIds=true}
local function validateStep(step)
    if type(step) ~= "table" or not Store.token(step.id) or not step.id:match("^step%-[%w]+$")
        or not text(step.title, 500, false) or not statuses[step.status] or not integer(step.updatedAt, 0)
        or (step.reason ~= nil and not text(step.reason, 1000, false))
        or type(step.evidenceIds) ~= "table" or #step.evidenceIds > 20 then return false end
    for _, id in step.evidenceIds do if not Store.token(id) then return false end end
    return allowed(step, stepKeys)
end
function M.validatePlan(plan, req)
    if type(plan) ~= "table" or plan.schemaVersion ~= 1 or plan.projectId ~= req.projectId
        or plan.requirementId ~= req.requirementId or not integer(plan.revision, 0)
        or (plan.designVersion ~= nil and not integer(plan.designVersion, 0))
        or type(plan.steps) ~= "table" or #plan.steps > MAX_STEPS
        or not text(plan.changeReason or "", 500, true) or not integer(plan.updatedAt, 0)
        or not allowed(plan, planKeys) then return nil, "corrupt_plan" end
    local ids = {}
    for index, step in plan.steps do
        if type(index) ~= "number" or index % 1 ~= 0 or index < 1 or not validateStep(step) or ids[step.id] then return nil, "corrupt_plan" end
        ids[step.id] = true
    end
    return plan
end
function M.loadPlan(paths, req)
    local file = M.planPath(paths, req)
    local plan, err = read(file)
    if err == "missing" then return {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=0, designVersion=0, steps=tern.json.array(), changeReason="", updatedAt=0}, nil end
    if not plan then return nil, {code=err} end
    local valid, problem = M.validatePlan(plan, req)
    if not valid then return nil, {code=problem} end
    return plan, nil
end
local function copySteps(steps)
    local out = tern.json.array()
    for _, step in steps do
        local copy = {id=step.id, title=step.title, status=step.status, updatedAt=step.updatedAt, evidenceIds=tern.json.array()}
        if step.reason ~= nil then copy.reason = step.reason end
        for _, id in step.evidenceIds do table.insert(copy.evidenceIds, id) end
        table.insert(out, copy)
    end
    return out
end
function M.applyPlan(paths, req, token, action, args, expected, cb)
    local function fail(code, detail) cb(nil, nil, {code=code, detail=detail}) end
    if not Store.token(token) or type(args) ~= "table" or not integer(expected, 0) then fail("invalid_options"); return end
    local plan, problem = M.loadPlan(paths, req)
    if not plan then cb(nil, nil, problem); return end
    if plan.revision ~= expected then fail("revision_conflict"); return end
    local nextPlan = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=plan.revision + 1, designVersion=plan.designVersion or 0, steps=copySteps(plan.steps),
        changeReason="", updatedAt=os.time() * 1000}
    if action == "generate" then
        if #plan.steps > 0 then fail("plan_not_empty"); return end
        if #(req.acceptanceCriteria or {}) == 0 then fail("no_criteria"); return end
        for _, criterion in req.acceptanceCriteria do
            local title = tostring(criterion.id) .. " · " .. tostring(criterion.description)
            if not text(title, 500, false) then fail("criterion_title_too_long", criterion.id); return end
            table.insert(nextPlan.steps, {id=Store.newId("step", os.time() * 1000), title=title, status="pending",
                updatedAt=nextPlan.updatedAt, evidenceIds=tern.json.array()})
        end
        nextPlan.changeReason = "从验收条件生成"
    elseif action == "add" then
        if #plan.steps >= MAX_STEPS then fail("plan_step_limit"); return end
        if not text(args.title, 500, false) then fail("invalid_step"); return end
        table.insert(nextPlan.steps, {id=Store.newId("step", os.time() * 1000), title=args.title, status="pending",
            updatedAt=nextPlan.updatedAt, evidenceIds=tern.json.array()})
        nextPlan.changeReason = "新增步骤：" .. args.title:sub(1, 200)
    elseif action == "status" then
        if not Store.token(args.stepId) or not statuses[args.status] then fail("invalid_step"); return end
        if args.status == "blocked" and not text(args.reason, 1000, false) then fail("blocked_reason_required"); return end
        local found
        for _, step in nextPlan.steps do
            if step.id == args.stepId then
                step.status, step.updatedAt, found = args.status, nextPlan.updatedAt, true
                step.reason = args.status == "blocked" and args.reason or nil
            end
        end
        if not found then fail("missing_step"); return end
        nextPlan.changeReason = "步骤状态：" .. args.status
    else fail("invalid_action"); return end
    Store.putScoped(paths, M.planPath(paths, req), nextPlan, plan.revision, token, function(saved, reason, cx)
        if saved then cb(nextPlan, nil, cx) else cb(nil, nil, {code=reason}, cx) end
    end)
end

local resultKeys = {schemaVersion=true, projectId=true, requirementId=true, revision=true, baseline=true,
    changes=true, verifications=true}
local baselineKeys = {requestId=true, head=true, fingerprint=true, dirty=true, capturedAt=true, files=true, filesTruncated=true}
local changeKeys = {capturedAt=true, head=true, fingerprint=true, dirty=true, files=true, filesTruncated=true,
    diff=true, diffSha256=true, diffTruncated=true, commits=true, commitsTruncated=true}
local commitKeys = {hash=true, at=true, author=true, subject=true}
local verificationKeys = {id=true, command=true, cwd=true, criterionIds=true, requirementRevision=true,
    codeSnapshotSha256=true, startedAt=true, endedAt=true, exitCode=true, timedOut=true, result=true,
    stdoutPreview=true, stderrPreview=true, stdoutBytes=true, stderrBytes=true, stdoutTruncated=true,
    stderrTruncated=true, evidencePath=true}
local evidenceKeys = {schemaVersion=true, projectId=true, requirementId=true, revision=true, id=true, command=true,
    cwd=true, criterionIds=true, requirementRevision=true, codeSnapshotSha256=true, startedAt=true, endedAt=true,
    exitCode=true, timedOut=true, result=true, stdout=true, stderr=true, stdoutBytes=true, stderrBytes=true,
    stdoutTruncated=true, stderrTruncated=true}

local function validateFiles(files)
    if type(files) ~= "table" or #files > MAX_FILES then return false end
    for _, file in files do
        if type(file) ~= "table" or not text(file.path, 2048, false) or file.path:sub(1, 1) == "/"
            or type(file.status) ~= "string" or #file.status > 4
            or (file.sha256 ~= nil and not hash(file.sha256))
            or not allowed(file, {path=true, status=true, sha256=true}) then return false end
    end
    return true
end
local function validateBaseline(b, requirementId)
    return type(b) == "table" and Store.token(b.requestId) and type(b.head) == "string" and #b.head <= 128
        and hash(b.fingerprint) and type(b.dirty) == "boolean" and integer(b.capturedAt, 0)
        and validateFiles(b.files) and type(b.filesTruncated) == "boolean" and allowed(b, baselineKeys)
end
local function validateChanges(c)
    if type(c) ~= "table" or not integer(c.capturedAt, 0) or type(c.head) ~= "string" or #c.head > 128
        or not hash(c.fingerprint) or type(c.dirty) ~= "boolean" or not validateFiles(c.files)
        or type(c.filesTruncated) ~= "boolean" or type(c.diff) ~= "string" or #c.diff > MAX_DIFF
        or not hash(c.diffSha256) or type(c.diffTruncated) ~= "boolean" or not allowed(c, changeKeys) then return false end
    if type(c.commits) ~= "table" or #c.commits > MAX_COMMITS or type(c.commitsTruncated) ~= "boolean" then return false end
    for _, commit in c.commits do
        if type(commit) ~= "table" or type(commit.hash) ~= "string" or #commit.hash < 40 or #commit.hash > 64
            or not commit.hash:match("^[0-9a-f]+$")
            or not integer(commit.at, 0) or not text(commit.author, 200, true) or not text(commit.subject, 500, true)
            or not allowed(commit, commitKeys) then return false end
    end
    return true
end
local function validateVerification(v, req)
    if type(v) ~= "table" or not Store.token(v.id) or not v.id:match("^verification%-[%w]+$")
        or not text(v.command, 4000, false) or not text(v.cwd, 2048, false) or v.cwd:sub(1, 1) ~= "/"
        or type(v.criterionIds) ~= "table" or #v.criterionIds > 32 or not integer(v.requirementRevision, 1)
        or not hash(v.codeSnapshotSha256) or not integer(v.startedAt, 0) or not integer(v.endedAt, 0)
        or (v.exitCode ~= nil and not integer(v.exitCode, -1)) or type(v.timedOut) ~= "boolean"
        or (v.result ~= "passed" and v.result ~= "failed" and v.result ~= "unknown")
        or type(v.stdoutPreview) ~= "string" or #v.stdoutPreview > 512 or type(v.stderrPreview) ~= "string" or #v.stderrPreview > 512
        or not integer(v.stdoutBytes, 0) or not integer(v.stderrBytes, 0)
        or type(v.stdoutTruncated) ~= "boolean" or type(v.stderrTruncated) ~= "boolean"
        or type(v.evidencePath) ~= "string" or v.evidencePath ~= "evidence/" .. v.id .. ".json"
        or not allowed(v, verificationKeys) then return false end
    local seen = {}
    for _, id in v.criterionIds do
        if not Store.token(id) or seen[id] then return false end
        seen[id] = true
        local found = false
        for _, criterion in req.acceptanceCriteria or {} do if criterion.id == id then found = true; break end end
        if not found then return false end
    end
    return true
end
function M.validateResults(results, req)
    if type(results) ~= "table" or results.schemaVersion ~= 1 or results.projectId ~= req.projectId
        or results.requirementId ~= req.requirementId or not integer(results.revision, 0)
        or type(results.verifications) ~= "table" or #results.verifications > MAX_VERIFICATIONS
        or not allowed(results, resultKeys) then return nil, "corrupt_results" end
    if results.baseline ~= nil and not validateBaseline(results.baseline, req.requirementId) then return nil, "corrupt_results" end
    if results.changes ~= nil and not validateChanges(results.changes) then return nil, "corrupt_results" end
    local ids = {}
    for _, v in results.verifications do
        if not validateVerification(v, req) or ids[v.id] then return nil, "corrupt_results" end
        ids[v.id] = true
    end
    return results
end
function M.loadResults(paths, req)
    local results, err = read(M.resultsPath(paths, req))
    if err == "missing" then return {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=0, baseline=nil, changes=nil, verifications=tern.json.array()}, nil end
    if not results then return nil, {code=err} end
    local valid, problem = M.validateResults(results, req)
    if not valid then return nil, {code=problem} end
    return results, nil
end
local function copyVerifications(items)
    local out = tern.json.array()
    for _, item in items do table.insert(out, item) end
    return out
end
local function saveResults(paths, req, token, expected, nextResults, cb)
    Store.putScoped(paths, M.resultsPath(paths, req), nextResults, expected, token, function(saved, reason, cx)
        if saved then cb(nextResults, nil, cx) else cb(nil, nil, {code=reason}, cx) end
    end)
end
function M.recordBaseline(paths, req, token, baseline, requestId, cb)
    local function fail(code) cb(nil, nil, {code=code}) end
    if not Store.token(token) or not Store.token(requestId) or type(baseline) ~= "table" then fail("invalid_baseline"); return end
    local current, problem = M.loadResults(paths, req)
    if not current then cb(nil, nil, problem); return end
    if current.baseline and current.baseline.requestId == requestId then cb(current, nil); return end
    local nextResults = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=current.revision + 1, baseline={requestId=requestId, head=baseline.head or "",
            fingerprint=baseline.fingerprint, dirty=baseline.dirty == true, capturedAt=os.time() * 1000,
            files=baseline.files or tern.json.array(), filesTruncated=baseline.filesTruncated == true},
        changes=nil, verifications=copyVerifications(current.verifications)}
    local valid, why = M.validateResults(nextResults, req)
    if not valid then fail(why); return end
    saveResults(paths, req, token, current.revision, nextResults, cb)
end
function M.putChanges(paths, req, token, changes, expected, cb)
    local current, problem = M.loadResults(paths, req)
    if not current then cb(nil, nil, problem); return end
    if current.revision ~= expected then cb(nil, nil, {code="revision_conflict"}); return end
    local nextResults = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=current.revision + 1, baseline=current.baseline, changes=changes,
        verifications=copyVerifications(current.verifications)}
    local valid, why = M.validateResults(nextResults, req)
    if not valid then cb(nil, nil, {code=why}); return end
    saveResults(paths, req, token, current.revision, nextResults, cb)
end
function M.addVerification(paths, req, token, verification, evidence, expected, cb)
    local current, problem = M.loadResults(paths, req)
    if not current then cb(nil, nil, problem); return end
    if current.revision ~= expected then cb(nil, nil, {code="revision_conflict"}); return end
    if not validateVerification(verification, req) then cb(nil, nil, {code="invalid_verification"}); return end
    for _, item in current.verifications do if item.id == verification.id then cb(nil, nil, {code="verification_exists"}); return end end
    local record = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId, revision=1,
        id=verification.id, command=verification.command, cwd=verification.cwd,
        criterionIds=verification.criterionIds, requirementRevision=verification.requirementRevision,
        codeSnapshotSha256=verification.codeSnapshotSha256, startedAt=verification.startedAt, endedAt=verification.endedAt,
        exitCode=verification.exitCode, timedOut=verification.timedOut, result=verification.result,
        stdout=evidence.stdout, stderr=evidence.stderr, stdoutBytes=evidence.stdoutBytes, stderrBytes=evidence.stderrBytes,
        stdoutTruncated=evidence.stdoutTruncated, stderrTruncated=evidence.stderrTruncated}
    if not allowed(record, evidenceKeys) then cb(nil, nil, {code="invalid_verification"}); return end
    Store.putScoped(paths, M.evidencePath(paths, req, verification.id), record, 0, token, function(saved, reason, cx)
        if not saved then cb(nil, nil, {code=reason}, cx); return end
        local nextResults = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
            revision=current.revision + 1, baseline=current.baseline, changes=current.changes,
            verifications=copyVerifications(current.verifications)}
        table.insert(nextResults.verifications, verification)
        local valid, why = M.validateResults(nextResults, req)
        if not valid then cb(nil, nil, {code=why}, cx); return end
        saveResults(paths, req, token, current.revision, nextResults, cb)
    end)
end
M.validateChanges = validateChanges
function M.effectiveState(results, req, verification)
    return Validity.verification(results, req, verification)
end
return M
