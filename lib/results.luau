--!strict
-- Requirement-scoped implementation plan, observed code results and verification evidence.
local Store = require('./store')
local Validity = require('./validity')
local Candidates = require('./candidates')
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
    steps=true, changeReason=true, updatedAt=true, candidateImports=true}
local stepKeys = {id=true, title=true, status=true, reason=true, updatedAt=true, evidenceIds=true,
    criterionIds=true, filePaths=true}
local function array(value, maximum)
    if type(value) ~= "table" or #value > maximum then return false end
    local count = 0
    for key in value do
        if not integer(key, 1) or key > #value then return false end
        count += 1
    end
    return count == #value
end
local function clone(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for key, item in value do out[key] = clone(item) end
    return out
end
local function validateStep(step, schema)
    if type(step) ~= "table" or not Store.token(step.id) or not step.id:match("^step%-[%w]+$")
        or not text(step.title, 500, false) or not statuses[step.status] or not integer(step.updatedAt, 0)
        or (step.reason ~= nil and not text(step.reason, 1000, false))
        or not array(step.evidenceIds, 20) then return false end
    for _, id in step.evidenceIds do if not Store.token(id) then return false end end
    if step.criterionIds ~= nil or step.filePaths ~= nil then
        if schema ~= 2 or not Candidates.links(step.criterionIds, step.filePaths) then return false end
    end
    return allowed(step, stepKeys)
end
function M.validatePlan(plan, req)
    if type(plan) ~= "table" or (plan.schemaVersion ~= 1 and plan.schemaVersion ~= 2) or plan.projectId ~= req.projectId
        or plan.requirementId ~= req.requirementId or not integer(plan.revision, 0)
        or (plan.designVersion ~= nil and not integer(plan.designVersion, 0))
        or not array(plan.steps, MAX_STEPS)
        or not text(plan.changeReason or "", 500, true) or not integer(plan.updatedAt, 0)
        or not allowed(plan, planKeys) then return nil, "corrupt_plan" end
    if (plan.schemaVersion == 1 and plan.candidateImports ~= nil)
        or (plan.schemaVersion == 2 and not array(plan.candidateImports, MAX_STEPS)) then return nil, "corrupt_plan" end
    local ids = {}
    for _, step in plan.steps do
        if not validateStep(step, plan.schemaVersion) or ids[step.id] then return nil, "corrupt_plan" end
        ids[step.id] = true
    end
    local imports, mapped = {}, {}
    for _, item in plan.candidateImports or {} do
        if not Candidates.importValid(item, "plan") or imports[item.id] then return nil, "corrupt_plan" end
        imports[item.id] = true
        for _, id in item.entityIds do
            if not ids[id] or mapped[id] then return nil, "corrupt_plan" end
            mapped[id] = true
        end
    end
    return plan
end
function M.loadPlan(paths, req)
    local file = M.planPath(paths, req)
    local plan, err = read(file)
    if err == "missing" then return {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
        revision=0, designVersion=0, steps=tern.json.array(), candidateImports=tern.json.array(),
        changeReason="", updatedAt=0}, nil end
    if not plan then return nil, {code=err} end
    local valid, problem = M.validatePlan(plan, req)
    if not valid then return nil, {code=problem} end
    return plan, nil
end
local function copySteps(steps)
    local out = tern.json.array()
    for _, step in steps do
        local copy = clone(step)
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
    local nextPlan = {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
        revision=plan.revision + 1, designVersion=plan.designVersion or 0, steps=copySteps(plan.steps),
        candidateImports=clone(plan.candidateImports or tern.json.array()), changeReason="", updatedAt=os.time() * 1000}
    if action == "generate" then
        if #plan.steps > 0 then fail("plan_not_empty"); return end
        if #(req.acceptanceCriteria or {}) == 0 then fail("no_criteria"); return end
        for _, criterion in req.acceptanceCriteria do
            local title = tostring(criterion.id) .. " · " .. tostring(criterion.description)
            if not text(title, 500, false) then fail("criterion_title_too_long", criterion.id); return end
            local criterionIds = tern.json.array()
            table.insert(criterionIds, criterion.id)
            table.insert(nextPlan.steps, {id=Store.newId("step", os.time() * 1000), title=title, status="pending",
                updatedAt=nextPlan.updatedAt, evidenceIds=tern.json.array(),
                criterionIds=criterionIds, filePaths=tern.json.array()})
        end
        nextPlan.changeReason = "从验收条件生成"
    elseif action == "add" then
        if #plan.steps >= MAX_STEPS then fail("plan_step_limit"); return end
        if not text(args.title, 500, false) then fail("invalid_step"); return end
        table.insert(nextPlan.steps, {id=Store.newId("step", os.time() * 1000), title=args.title, status="pending",
            updatedAt=nextPlan.updatedAt, evidenceIds=tern.json.array(),
            criterionIds=tern.json.array(), filePaths=tern.json.array()})
        nextPlan.changeReason = "新增步骤：" .. args.title:sub(1, 200)
    elseif action == "links" then
        if not Store.token(args.stepId) or not Candidates.links(args.criterionIds, args.filePaths) then fail("invalid_links"); return end
        local rows, failures = Store.readRequirements(paths)
        if #failures > 0 then fail("corrupt_requirements"); return end
        local fresh
        for _, row in rows do if row.requirementId == req.requirementId and row.projectId == req.projectId then fresh = row; break end end
        if not fresh then fail("candidate_wrong_target"); return end
        if fresh.revision ~= req.revision then fail("candidate_stale"); return end
        local criteria = {}
        for _, criterion in fresh.acceptanceCriteria do criteria[criterion.id] = true end
        for _, id in args.criterionIds do if not criteria[id] then fail("candidate_criterion_missing"); return end end
        local found
        for _, step in nextPlan.steps do
            if step.id == args.stepId then
                step.criterionIds, step.filePaths = clone(args.criterionIds), clone(args.filePaths)
                step.updatedAt, found = nextPlan.updatedAt, true
            end
        end
        if not found then fail("missing_step"); return end
        nextPlan.changeReason = "更新步骤条件与文件链接"
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
    local valid, why = M.validatePlan(nextPlan, req)
    if not valid then fail(why); return end
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
    requirementContentRevision=true,
    codeSnapshotSha256=true, startedAt=true, endedAt=true, exitCode=true, timedOut=true, result=true,
    stdoutPreview=true, stderrPreview=true, stdoutBytes=true, stderrBytes=true, stdoutTruncated=true,
    stderrTruncated=true, evidencePath=true}
local evidenceKeys = {schemaVersion=true, projectId=true, requirementId=true, revision=true, id=true, command=true,
    cwd=true, criterionIds=true, requirementRevision=true, requirementContentRevision=true, codeSnapshotSha256=true, startedAt=true, endedAt=true,
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
local function validateVerification(v, schemaVersion)
    if type(v) ~= "table" or not Store.token(v.id) or not v.id:match("^verification%-[%w]+$")
        or not text(v.command, 4000, false) or not text(v.cwd, 2048, false) or v.cwd:sub(1, 1) ~= "/"
        or type(v.criterionIds) ~= "table" or #v.criterionIds > 32 or not integer(v.requirementRevision, 1)
        or (v.requirementContentRevision ~= nil and (schemaVersion ~= 2
            or not integer(v.requirementContentRevision, 1) or v.requirementContentRevision > 9007199254740991
            or v.requirementContentRevision > v.requirementRevision))
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
    end
    return true
end
function M.validateResults(results, req)
    if type(results) ~= "table" or (results.schemaVersion ~= 1 and results.schemaVersion ~= 2) or results.projectId ~= req.projectId
        or results.requirementId ~= req.requirementId or not integer(results.revision, 0)
        or type(results.verifications) ~= "table" or #results.verifications > MAX_VERIFICATIONS
        or not allowed(results, resultKeys) then return nil, "corrupt_results" end
    if results.baseline ~= nil and not validateBaseline(results.baseline, req.requirementId) then return nil, "corrupt_results" end
    if results.changes ~= nil and not validateChanges(results.changes) then return nil, "corrupt_results" end
    local ids = {}
    for _, v in results.verifications do
        if not validateVerification(v, results.schemaVersion) or ids[v.id] then return nil, "corrupt_results" end
        ids[v.id] = true
    end
    return results
end
function M.loadResults(paths, req)
    local results, err = read(M.resultsPath(paths, req))
    if err == "missing" then return {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
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
    local nextResults = {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
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
    local nextResults = {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
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
    if not validateVerification(verification, 2) or verification.requirementContentRevision == nil
        or not Validity.matchesRequirement(verification, req) then cb(nil, nil, {code="invalid_verification"}); return end
    for _, item in current.verifications do if item.id == verification.id then cb(nil, nil, {code="verification_exists"}); return end end
    local record = {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId, revision=1,
        id=verification.id, command=verification.command, cwd=verification.cwd,
        criterionIds=verification.criterionIds, requirementRevision=verification.requirementRevision,
        requirementContentRevision=verification.requirementContentRevision,
        codeSnapshotSha256=verification.codeSnapshotSha256, startedAt=verification.startedAt, endedAt=verification.endedAt,
        exitCode=verification.exitCode, timedOut=verification.timedOut, result=verification.result,
        stdout=evidence.stdout, stderr=evidence.stderr, stdoutBytes=evidence.stdoutBytes, stderrBytes=evidence.stderrBytes,
        stdoutTruncated=evidence.stdoutTruncated, stderrTruncated=evidence.stderrTruncated}
    if not allowed(record, evidenceKeys) then cb(nil, nil, {code="invalid_verification"}); return end
    Store.putScoped(paths, M.evidencePath(paths, req, verification.id), record, 0, token, function(saved, reason, cx)
        if not saved then cb(nil, nil, {code=reason}, cx); return end
        local nextResults = {schemaVersion=2, projectId=req.projectId, requirementId=req.requirementId,
            revision=current.revision + 1, baseline=current.baseline, changes=current.changes,
            verifications=copyVerifications(current.verifications)}
        table.insert(nextResults.verifications, verification)
        local valid, why = M.validateResults(nextResults, req)
        if not valid then cb(nil, nil, {code=why}, cx); return end
        saveResults(paths, req, token, current.revision, nextResults, cb)
    end)
end
function M.adoptCandidate(paths, req, token, candidate, sha256, expected, cb)
    local function fail(code, detail) cb(nil, nil, {code=code, detail=detail}) end
    local valid, invalid = Candidates.validate(candidate)
    if not valid then cb(nil, nil, invalid); return end
    if candidate.kind ~= "plan" or not hash(sha256) or not Store.token(token) or not integer(expected, 0) then
        fail("invalid_candidate"); return
    end
    if candidate.projectId ~= req.projectId or candidate.requirementId ~= req.requirementId then fail("candidate_wrong_target"); return end
    local rows, failures = Store.readRequirements(paths)
    if #failures > 0 then fail("corrupt_requirements"); return end
    local fresh
    for _, row in rows do if row.requirementId == req.requirementId and row.projectId == req.projectId then fresh = row; break end end
    if not fresh then fail("candidate_wrong_target"); return end
    local plan, problem = M.loadPlan(paths, fresh)
    if not plan then cb(nil, nil, problem); return end
    local results, resultsProblem = M.loadResults(paths, fresh)
    if not results then cb(nil, nil, resultsProblem); return end
    for _, item in plan.candidateImports or {} do
        if item.id == candidate.id then
            if item.sha256 ~= sha256 then fail("candidate_conflict") else cb(plan, nil) end
            return
        end
    end
    if plan.revision ~= expected then fail("revision_conflict"); return end
    if fresh.revision ~= req.revision or Store.contentRevision(fresh) ~= Store.contentRevision(req) then fail("candidate_stale"); return end
    local current, stale = Candidates.current(candidate, fresh, plan, results.changes and results.changes.fingerprint)
    if not current then cb(nil, nil, stale); return end
    if #plan.steps + #candidate.steps > MAX_STEPS or #(plan.candidateImports or {}) >= MAX_STEPS then fail("plan_step_limit"); return end
    local now = os.time() * 1000
    local nextPlan = clone(plan)
    nextPlan.schemaVersion, nextPlan.revision, nextPlan.updatedAt = 2, plan.revision + 1, now
    nextPlan.candidateImports = nextPlan.candidateImports or tern.json.array()
    nextPlan.changeReason = "采用外部 JSON 计划候选：" .. candidate.id
    local import = {id=candidate.id, sha256=sha256, sourceIds=tern.json.array(), entityIds=tern.json.array()}
    for _, step in candidate.steps do
        local id = Store.newId("step", now)
        table.insert(nextPlan.steps, {id=id, title=step.title, status="pending", updatedAt=now,
            evidenceIds=tern.json.array(), criterionIds=clone(step.criterionIds), filePaths=clone(step.filePaths)})
        table.insert(import.sourceIds, step.id)
        table.insert(import.entityIds, id)
    end
    table.insert(nextPlan.candidateImports, import)
    local checked, why = M.validatePlan(nextPlan, fresh)
    if not checked then fail(why); return end
    Store.putScoped(paths, M.planPath(paths, fresh), nextPlan, plan.revision, token, function(saved, reason, cx)
        if saved then cb(nextPlan, nil, cx) else cb(nil, nil, {code=reason}, cx) end
    end)
end
M.validateChanges = validateChanges
function M.effectiveState(results, req, verification)
    return Validity.verification(results, req, verification)
end
return M
