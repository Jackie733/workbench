--!strict
-- Isolated production results/review readers and writers, with only the native
-- CAS transport replaced by an in-memory publisher. No Windows process runs.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local files, modules = {}, {}
local ternStub = {json = {array = function() return {} end,
    encode = function(value) return serde.encode("json", value) end,
    decode = function(raw) return serde.decode("json", raw) end},
    fs = {exists = function(path) return files[path] ~= nil end,
        read = function(path) return assert(files[path], "missing " .. path) end,
        write = function(path, raw) files[path] = raw end,
        mkdir = function() end, remove = function(path) files[path] = nil end},
    now = function() return 1000 end}
ternStub.fs.list = function(path)
    local names, seen = {}, {}
    local prefix = path .. "\\"
    for file in files do
        if file:sub(1, #prefix) == prefix then
            local name = file:sub(#prefix + 1):match("^[^\\]+")
            if name and not seen[name] then seen[name] = true; table.insert(names, name) end
        end
    end
    return names
end
ternStub.process = {run = function(_, options, cb)
    assert(type(options.stdin) == "string", "only hashing may reach the process shim")
    cb({status=0, stdout=serde.hash("sha256", options.stdin), stderr="", timed_out=false})
end}
local function loadModule(name)
    if modules[name] then return modules[name] end
    local chunk = assert(loadstring("local tern, require = ...\n" .. fs.readFile("lib/" .. name .. ".luau")))
    local value = chunk(ternStub, function(relative) return loadModule(relative:match("([^/]+)$")) end)
    modules[name] = value
    return value
end
local Store, Results, Review, Validity = loadModule("store"), loadModule("results"), loadModule("review"), loadModule("validity")
local checks, failures = 0, {}
local function check(ok, message)
    checks += 1
    if not ok then table.insert(failures, message) end
end
local function copy(value)
    return serde.decode("json", serde.encode("json", value))
end
local paths = {requirements = "project\\requirements", lock = "project\\lock.json", project = "project\\project.json"}
local rejectedTarget
Store.runProcess = function(env, cb)
    local target = env.OMPWB_TARGET
    local prior = files[target] and serde.decode("json", files[target])
    local status = 0
    if target == rejectedTarget then status = 6
    elseif (prior and prior.revision or 0) ~= tonumber(env.OMPWB_EXPECT) then status = 3
    else files[target], files[env.OMPWB_TEMP] = files[env.OMPWB_TEMP], nil end
    cb(status, "", false)
end
local SHA = string.rep("a", 64)
local req = {schemaVersion=2, projectId="project-1", requirementId="req-1", revision=5, contentRevision=2,
    acceptanceCriteria={{id="C1", description="入口可用", required=true}}}
local legacy = {id="verification-old", command="false", cwd="/repo", criterionIds={"C-removed"},
    requirementRevision=1, codeSnapshotSha256=SHA, startedAt=1, endedAt=2, exitCode=1,
    timedOut=false, result="failed", stdoutPreview="", stderrPreview="old failure", stdoutBytes=0, stderrBytes=11,
    stdoutTruncated=false, stderrTruncated=false, evidencePath="evidence/verification-old.json"}
local changes = {capturedAt=3, head="", fingerprint=SHA, dirty=false, files={}, filesTruncated=false,
    diff="", diffSha256=SHA, diffTruncated=false, commits={}, commitsTruncated=false}
files[Results.resultsPath(paths, req)] = serde.encode("json", {schemaVersion=1, projectId=req.projectId,
    requirementId=req.requirementId, revision=1, changes=changes, verifications={legacy}})
local old = Results.loadResults(paths, req)
check(old and old.verifications[1].criterionIds[1] == "C-removed", "删除条件不隐藏历史失败证据")
local verification = {id="verification-new", command="true", cwd="/repo", criterionIds={"C1"},
    requirementRevision=req.revision, requirementContentRevision=req.contentRevision,
    codeSnapshotSha256=SHA, startedAt=4, endedAt=5, exitCode=0, timedOut=false, result="passed",
    stdoutPreview="ok", stderrPreview="", stdoutBytes=2, stderrBytes=0, stdoutTruncated=false,
    stderrTruncated=false, evidencePath="evidence/verification-new.json"}
local evidence = {stdout="ok", stderr="", stdoutBytes=2, stderrBytes=0, stdoutTruncated=false, stderrTruncated=false}
local saved, problem
Results.addVerification(paths, req, "owner", verification, evidence, 1, function(value, _, err) saved, problem=value, err end)
check(saved and saved.schemaVersion == 2 and problem == nil, "首次新证据原子升级摘要容器")
check(saved and saved.verifications[1].requirementContentRevision == nil, "升级不回填旧证据身份")
local immutable = serde.decode("json", files[Results.evidencePath(paths, req, verification.id)])
check(immutable.schemaVersion == 2 and immutable.requirementContentRevision == 2 and immutable.stdout == "ok",
    "不可变完整证据保留原始内容身份与真实输出")
local afterStage = copy(req)
afterStage.revision = 6
check(Validity.acceptance(afterStage, saved, {reviews={}}).ok, "阶段转换后新证据仍满足验收")
local afterEdit = copy(afterStage)
afterEdit.revision, afterEdit.contentRevision = 7, 7
check(not Validity.acceptance(afterEdit, saved, {reviews={}}).ok, "内容修改使验收覆盖失效")
local readAfterEdit = Results.loadResults(paths, afterEdit)
check(readAfterEdit and readAfterEdit.verifications[1].result == "failed", "失效证据仍完整可读")
local markedV1 = copy(saved)
markedV1.schemaVersion = 1
check(Results.validateResults(markedV1, req) == nil, "旧结果 schema 禁止新身份字段")
local future = copy(saved)
future.schemaVersion = 3
check(Results.validateResults(future, req) == nil, "未知结果版本拒绝而非重置")
local invalid = copy(verification)
invalid.id, invalid.evidencePath, invalid.requirementContentRevision = "verification-bad", "evidence/verification-bad.json", nil
local invalidError
Results.addVerification(paths, req, "owner", invalid, evidence, saved.revision,
    function(_, _, err) invalidError=err end)
check(invalidError and invalidError.code == "invalid_verification" and files[Results.evidencePath(paths, req, invalid.id)] == nil,
    "新写入不得降级为无身份旧证据")
local conflict
Results.addVerification(paths, req, "owner", verification, evidence, 1,
    function(_, _, err) conflict=err end)
check(conflict and conflict.code == "revision_conflict", "摘要 CAS 冲突不覆盖现有历史")

local legacyAcceptance = {id="acceptance-old", decision="accepted", requirementRevision=1,
    codeSnapshotSha256=SHA, verificationIds={}, reviewIds={}, comment="", createdAt=1}
files[Review.path(paths, req)] = serde.encode("json", {schemaVersion=1, projectId=req.projectId,
    requirementId=req.requirementId, revision=1, reviews={}, acceptances={legacyAcceptance}, reopenings={}})
local reviewed
Review.createReview(paths, req, "owner", {source="manual", scope="全量", codeSnapshotSha256=SHA, findings={}}, 1,
    function(value, err) reviewed, problem=value, err end)
check(reviewed and reviewed.schemaVersion == 3 and problem == nil, "新审查升级容器并保留验收历史")
check(reviewed and reviewed.reviews[1].requirementContentRevision == 2, "审查绑定当前内容身份")
check(reviewed and reviewed.acceptances[1].requirementContentRevision == nil, "旧验收不补造身份")
local accepted
Review.recordAcceptance(paths, req, "owner", {decision="accepted", codeSnapshotSha256=SHA,
    verificationIds={verification.id}, reviewIds={reviewed.reviews[1].id}, comment=""}, reviewed.revision,
    function(value, err) accepted, problem=value, err end)
check(accepted and accepted.acceptances[2].requirementContentRevision == 2 and problem == nil,
    "新人工决定绑定内容身份")
local legacyContainer = copy(accepted)
legacyContainer.schemaVersion = 1
check(Review.validate(legacyContainer, req) == nil, "旧审查 schema 禁止带新身份记录")
local brokenIdentity = copy(accepted)
brokenIdentity.acceptances[2].requirementContentRevision = req.revision + 1
check(Review.validate(brokenIdentity, req) == nil, "未来内容修订被拒绝")
local unknown = copy(accepted)
unknown.acceptances[2].future = true
check(Review.validate(unknown, req) == nil, "验收未知字段保守拒绝")
local beforeFailure = files[Review.path(paths, req)]
rejectedTarget = Review.path(paths, req)
local failedSave
Review.recordAcceptance(paths, req, "owner", {decision="rejected", codeSnapshotSha256=SHA,
    verificationIds={}, reviewIds={}, comment="仍有问题"}, accepted.revision,
    function(_, err) failedSave=err end)
check(failedSave and files[Review.path(paths, req)] == beforeFailure, "发布失败不改写已保存的验收历史")

-- Native authorization is exercised through the same real module and CAS API,
-- with only PowerShell transport/hash calls substituted in this Linux runner.
rejectedTarget = nil
local Workflow = loadModule("workflow")
local project = Store.newProject({projectId=req.projectId, root="/repo", name="身份回归", now=1})
local fullReq = Store.newRequirement(project, {id=req.requirementId, title="入口可用", type="feature",
    goal="用户可以重新登录", scope="仅登录模块", criteria={"入口可用"}, now=1})
fullReq.revision, fullReq.contentRevision = req.revision, req.contentRevision
project.nextNumber = 2
files[paths.project] = serde.encode("json", project)
local reqPath = paths.requirements .. "\\" .. fullReq.requirementId .. "\\requirement.json"
files[reqPath] = serde.encode("json", fullReq)
local currentReq = fullReq
local function apply(action, args)
    local w = assert(Workflow.load(paths, currentReq))
    local value, err
    Workflow.apply(paths, currentReq, "owner", action, args, w.revision, function(savedWorkflow, updated, why)
        value, err = savedWorkflow, why
        if updated then currentReq = updated end
    end)
    return value, err
end
local adopted, adoptError = apply("adopt", {body="按验收条件实现登录入口", source={kind="manual"}})
check(adopted and adoptError == nil and currentReq.stage == "awaiting_approval",
    "采用正式方案按真实 CAS 推进阶段")
check(currentReq.contentRevision == fullReq.contentRevision and currentReq.revision > fullReq.revision,
    "方案采用阶段写入保持内容身份")
local design = Workflow.readDesign(paths, currentReq, 1)
check(design and design.schemaVersion == 2 and design.requirementContentRevision == fullReq.contentRevision,
    "正式方案正文与元数据采用内容身份")
local approved, approveError = apply("approve", {designVersion=1, baseline={head="", fingerprint=SHA, dirty=false}, clicked=true})
check(approved and approveError == nil and Workflow.approvalState(approved, currentReq).valid,
    "新批准可由原生领域写入并校验")
Store.workflowStage(paths, currentReq, "designing", currentReq.revision, "owner", function(updated)
    if updated then currentReq = updated end
end)
check(Workflow.approvalState(assert(Workflow.load(paths, currentReq)), currentReq).valid,
    "真实阶段 CAS 后原生授权依旧有效")
local mutated = copy(currentReq)
mutated.goal = "内容确实改变"
Store.update(paths, mutated, currentReq.revision, "owner", function(updated)
    if updated then currentReq = updated end
end)
check(not Workflow.approvalState(assert(Workflow.load(paths, currentReq)), currentReq).valid,
    "真实内容 CAS 使原生授权失效")
mutated = copy(currentReq)
mutated.goal = fullReq.goal
Store.update(paths, mutated, currentReq.revision, "owner", function(updated)
    if updated then currentReq = updated end
end)
check(not Workflow.approvalState(assert(Workflow.load(paths, currentReq)), currentReq).valid,
    "真实内容改回旧文本不会恢复授权")
check(files[Results.resultsPath(paths, req)] ~= nil and files[Review.path(paths, req)] == beforeFailure,
    "内容与阶段变更不删除交付或验收历史")
for _, failure in failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", checks, #failures))
if #failures > 0 then error("content identity storage contract violated") end
