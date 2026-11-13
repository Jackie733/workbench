--!strict
-- External declarations only: parsing never adopts, authorizes or creates evidence.
local Store = require('./store')
local M = {}
M.maxBytes = 16384
local function integer(value, minimum)
    return type(value) == "number" and value % 1 == 0 and value >= minimum and value <= 9007199254740991
end
local function text(value, maximum)
    return type(value) == "string" and #value <= maximum and value:match("%S") ~= nil
        and not value:find("[%z\1-\8\11\12\14-\31\127]") and utf8.len(value) ~= nil
end
local function hash(value)
    return type(value) == "string" and #value == 64 and value:match("^[0-9a-f]+$") ~= nil
end
local function keys(value, allowed)
    if type(value) ~= "table" then return false end
    for key in value do if not allowed[key] then return false end end
    return true
end
local function array(value, maximum, itemValid)
    if type(value) ~= "table" or #value > maximum then return false end
    local count = 0
    for index in value do
        if not integer(index, 1) or index > #value then return false end
        count += 1
    end
    if count ~= #value then return false end
    for _, item in value do if not itemValid(item) then return false end end
    return true
end
local function tokens(value, maximum)
    local seen = {}
    return array(value, maximum, function(item)
        if not Store.token(item) or seen[item] then return false end
        seen[item] = true
        return true
    end)
end
function M.path(value)
    if not text(value, 2048) or value:find("[%z\1-\31\127\\]") or value:sub(1, 1) == "/"
        or value:find(":", 1, true) or value:find("//", 1, true) or value:sub(-1) == "/" then return false end
    for segment in value:gmatch("[^/]+") do if segment == "." or segment == ".." then return false end end
    local lower = value:lower()
    return lower ~= ".git" and lower:sub(1, 5) ~= ".git/"
        and lower ~= ".omp/workbench" and lower:sub(1, 15) ~= ".omp/workbench/"
end
function M.links(criterionIds, filePaths)
    local seen = {}
    return tokens(criterionIds, 32) and array(filePaths, 32, function(path)
        if not M.path(path) or seen[path] then return false end
        seen[path] = true
        return true
    end)
end
local common = {schemaVersion=true,kind=true,id=true,projectId=true,requirementId=true,requirementRevision=true,
    requirementContentRevision=true,codeSnapshotSha256=true,planRevision=true,complete=true}
local reviewKeys, planKeys = table.clone(common), table.clone(common)
reviewKeys.scope, reviewKeys.findings = true, true
planKeys.steps = true
local findingKeys = {id=true,severity=true,description=true}
local stepKeys = {id=true,title=true,criterionIds=true,filePaths=true}
local severities = {blocking=true,major=true,minor=true,note=true}
function M.validate(value)
    local function invalid(detail) return nil, {code="invalid_candidate",detail=detail} end
    if type(value) ~= "table" or value.schemaVersion ~= 1 or (value.kind ~= "review" and value.kind ~= "plan")
        or not keys(value, value.kind == "review" and reviewKeys or planKeys) then return invalid("候选版本、类型或字段无效") end
    if not Store.token(value.id) or not Store.token(value.projectId) or not Store.token(value.requirementId)
        or not integer(value.requirementRevision, 1) or not integer(value.requirementContentRevision, 1)
        or value.requirementContentRevision > value.requirementRevision or not integer(value.planRevision, 0)
        or not hash(value.codeSnapshotSha256) or value.complete ~= true then return invalid("候选身份、版本、快照或完整性声明无效") end
    local seen = {}
    if value.kind == "review" then
        if not text(value.scope, 2000) or not array(value.findings, 50, function(item)
            if not keys(item, findingKeys) or not Store.token(item.id) or seen[item.id]
                or not severities[item.severity] or not text(item.description, 4000) then return false end
            seen[item.id] = true
            return true
        end) then return invalid("审查必须声明完整范围；发现字段或稳定 ID 无效") end
    elseif not array(value.steps, 40, function(item)
        if not keys(item, stepKeys) or not Store.token(item.id) or seen[item.id]
            or not text(item.title, 500) or not M.links(item.criterionIds, item.filePaths) then return false end
        seen[item.id] = true
        return true
    end) or #value.steps == 0 then return invalid("计划步骤、稳定 ID 或显式关联无效") end
    return value, nil
end
function M.decode(body)
    if type(body) ~= "string" or #body > M.maxBytes or utf8.len(body) == nil then
        return nil, {code="invalid_candidate",detail="候选文件必须是完整 UTF-8 JSON，且不超过 16 KiB"}
    end
    local ok, value = pcall(tern.json.decode, body)
    if not ok then return nil, {code="invalid_candidate",detail="候选 JSON 无法解析"} end
    return M.validate(value)
end
function M.current(value, requirement, plan, snapshot)
    local candidate, problem = M.validate(value)
    if not candidate then return false, problem end
    if not requirement or value.projectId ~= requirement.projectId or value.requirementId ~= requirement.requirementId then
        return false, {code="candidate_wrong_target"}
    end
    if value.requirementRevision ~= requirement.revision or value.requirementContentRevision ~= Store.contentRevision(requirement)
        or not plan or value.planRevision ~= plan.revision or not snapshot or value.codeSnapshotSha256 ~= snapshot then
        return false, {code="candidate_stale"}
    end
    if value.kind == "plan" then
        local criterionIds = {}
        for _, criterion in requirement.acceptanceCriteria or {} do criterionIds[criterion.id] = true end
        for _, step in value.steps do
            for _, id in step.criterionIds do
                if not criterionIds[id] then return false, {code="candidate_criterion_missing",detail=id} end
            end
        end
    end
    return true, nil
end
function M.importValid(value, kind)
    if kind ~= "review" and kind ~= "plan" then return false end
    local allowed = {id=true,sha256=true,sourceIds=true,entityIds=true}
    if kind == "review" then allowed.reviewId = true end
    local maximum = kind == "review" and 50 or 40
    return keys(value, allowed) and Store.token(value.id) and hash(value.sha256)
        and tokens(value.sourceIds, maximum) and tokens(value.entityIds, maximum)
        and #value.sourceIds == #value.entityIds and (kind ~= "review" or Store.token(value.reviewId))
end
return M
