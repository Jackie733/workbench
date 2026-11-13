--!strict
-- Phase 2 storage: project metadata and requirements under <repo>/.omp/workbench.
-- Pure validation is at the top so it can be exercised without I/O; write paths use
-- the same CAS + lock protocol for every file (revision checked inside PowerShell).
local M = {}

M.schemaVersion = 1
M.maxJson = 262144
M.lockStaleMs = 15000
M.stages = {backlog = true, clarifying = true, designing = true, awaiting_approval = true,
    implementing = true, verifying = true, awaiting_acceptance = true, done = true, blocked = true, cancelled = true}
M.types = {feature = true, bug = true, chore = true}
M.priorities = {low = true, normal = true, high = true, urgent = true}
M.workflowStages = {backlog=true,clarifying=true,designing=true,awaiting_approval=true,implementing=true}
M.maxGoal = 16000
M.maxScope = 16000
M.maxCriteria = 32
M.maxLabels = 16
M.maxLifecycleEvents = 200

local projectKeys = {schemaVersion = true, projectId = true, root = true, name = true, revision = true,
    nextNumber = true, createdAt = true}
local requirementKeys = {schemaVersion = true, requirementId = true, projectId = true, number = true,
    revision = true, title = true, type = true, priority = true, stage = true, goal = true, scope = true,
    acceptanceCriteria = true, labels = true, createdAt = true, updatedAt = true, blockedFrom = true,
    blockedReason = true, extensions = true, contentRevision = true, lifecycleEvents = true}

local function integer(value, min)
    return type(value) == "number" and value % 1 == 0 and value >= min
end
local function text(value, max, required)
    if type(value) ~= "string" or #value > max or value:find("[%z\1-\8\11\12\14-\31\127]") then return false end
    local index = 1
    while index <= #value do
        local byte = value:byte(index)
        local count, minimum
        if byte < 0x80 then count, minimum = 1, 0
        elseif byte >= 0xC2 and byte <= 0xDF then count, minimum = 2, 0x80
        elseif byte >= 0xE0 and byte <= 0xEF then count, minimum = 3, 0x800
        elseif byte >= 0xF0 and byte <= 0xF4 then count, minimum = 4, 0x10000
        else return false end
        if index + count - 1 > #value then return false end
        local code = byte % (2 ^ (8 - count - 1))
        for offset = 1, count - 1 do
            local nextByte = value:byte(index + offset)
            if nextByte < 0x80 or nextByte > 0xBF then return false end
            code = code * 64 + nextByte - 0x80
        end
        if code < minimum or code > 0x10FFFF or (code >= 0xD800 and code <= 0xDFFF) then return false end
        index += count
    end
    return not required or value:match("%S") ~= nil
end
local function keys(value, allowed)
    for key in value do
        if not allowed[key] then return false, "未知字段 " .. tostring(key) end
    end
    return true
end
local function criterion(value, id)
    if type(value) ~= "table" then return nil end
    if not text(value.id, 32, true) or not text(value.description, 1000, true) or type(value.required) ~= "boolean" then return nil end
    return {id = value.id, description = value.description, required = value.required}
end

local function array(value, maximum)
    if type(value) ~= "table" or (maximum and #value > maximum) then return false end
    local count = 0
    for key in value do
        if not integer(key, 1) or key > #value then return false end
        count += 1
    end
    return count == #value
end
local function lifecycleTarget(stage, action, blockedFrom)
    local terminal = stage == "done" or stage == "cancelled"
    if action == "block" and not terminal and stage ~= "blocked" then return "blocked" end
    if action == "unblock" and stage == "blocked" and M.stages[blockedFrom]
        and blockedFrom ~= "blocked" and blockedFrom ~= "done" and blockedFrom ~= "cancelled" then return blockedFrom end
    if action == "cancel" and not terminal then return "cancelled" end
    if action == "reopen" and terminal then return "clarifying" end
    return nil
end
local eventKeys = {id=true,action=true,from=true,to=true,reason=true,at=true,previousBlockedFrom=true,previousBlockedReason=true}
local function validEvents(events)
    if not array(events, M.maxLifecycleEvents) then return false end
    local ids = {}
    for _, event in events do
        if type(event) ~= "table" or not keys(event, eventKeys) or not M.token(event.id) or ids[event.id]
            or not M.stages[event.from] or not M.stages[event.to] or not text(event.reason, 2000, true)
            or not integer(event.at, 0) or lifecycleTarget(event.from, event.action, event.to) ~= event.to then return false end
        if (event.previousBlockedFrom ~= nil and (event.from ~= "blocked" or not M.stages[event.previousBlockedFrom]))
            or (event.previousBlockedReason ~= nil and (event.from ~= "blocked" or not text(event.previousBlockedReason, 2000, false)))
            or (event.action == "unblock" and event.previousBlockedFrom ~= nil and event.previousBlockedFrom ~= event.to) then return false end
        ids[event.id] = true
    end
    return true
end
function M.contentRevision(requirement)
    return requirement.contentRevision or requirement.revision
end
local function sameContent(a, b)
    for _, field in {"title", "type", "priority", "goal", "scope"} do
        if a[field] ~= b[field] then return false end
    end
    if #a.acceptanceCriteria ~= #b.acceptanceCriteria or #a.labels ~= #b.labels then return false end
    for index, item in a.acceptanceCriteria do
        local other = b.acceptanceCriteria[index]
        if item.id ~= other.id or item.description ~= other.description or item.required ~= other.required then return false end
    end
    for index, label in a.labels do if b.labels[index] ~= label then return false end end
    return true
end
local function upgradeRequirement(value, current)
    value.schemaVersion = 2
    value.contentRevision = current and (sameContent(value, current) and M.contentRevision(current) or value.revision) or 1
    value.lifecycleEvents = value.lifecycleEvents or tern.json.array()
    return value
end

function M.token(value)
    return type(value) == "string" and #value > 0 and #value <= 96 and value:match("^[%w_%-]+$") ~= nil
end
-- Tern 首个原生窗口的 key 就是空字符串；空字符串是真实身份，不是缺失。
-- claim/renew 必须先用与读取端相同的规则校验，否则会写出自己读不回的锁。
function M.lockOwner(value)
    if type(value) ~= "table" then return false end
    if not text(value.window, 128, false) then return false end
    if value.window ~= "" and not value.window:match("%S") then return false end
    return integer(value.panel, 1) and value.panel <= 9007199254740991
end
function M.displayNumber(number)
    return string.format("REQ-%04d", number)
end
function M.newId(prefix, seed)
    return string.format("%s-%x%06x%06x", prefix, math.floor(seed or os.time() * 1000) % 0xFFFFFFFF,
        math.random(0, 0xFFFFFF), math.random(0, 0xFFFFFF))
end

function M.validateProject(value)
    if type(value) ~= "table" or value.schemaVersion ~= M.schemaVersion then return nil, "项目 schema 不匹配" end
    local ok, problem = keys(value, projectKeys)
    if not ok then return nil, problem end
    if not M.token(value.projectId) or not text(value.root, 2048, true) or value.root:sub(1, 1) ~= "/"
        or not text(value.name, 200, true) then return nil, "项目身份或名称无效" end
    if not integer(value.revision, 1) or not integer(value.nextNumber, 1) or not integer(value.createdAt, 0) then
        return nil, "项目版本或编号无效"
    end
    return value
end

function M.newProject(fields)
    local value = {schemaVersion = M.schemaVersion, projectId = fields.projectId, root = fields.root,
        name = fields.name, revision = 1, nextNumber = 1, createdAt = fields.now}
    local ok, problem = M.validateProject(value)
    if not ok then error(problem) end
    return value
end

function M.validateRequirement(value)
    if type(value) ~= "table" or (value.schemaVersion ~= 1 and value.schemaVersion ~= 2) then return nil, "需求 schema 不匹配" end
    local ok, problem = keys(value, requirementKeys)
    if not ok then return nil, problem end
    if value.schemaVersion == 1 then
        if value.contentRevision ~= nil or value.lifecycleEvents ~= nil then return nil, "旧版需求含身份或生命周期字段" end
    elseif not integer(value.contentRevision, 1) or not integer(value.revision, 1) or value.contentRevision > value.revision
        or not validEvents(value.lifecycleEvents) then return nil, "需求内容版本或生命周期历史无效" end
    if not M.token(value.requirementId) or not M.token(value.projectId)
        or type(value.number) ~= "string" or not value.number:match("^REQ%-%d%d%d%d+$") then
        return nil, "需求身份或编号无效"
    end
    if not integer(value.revision, 1) or not integer(value.createdAt, 0) or not integer(value.updatedAt, 0) then
        return nil, "需求版本或时间无效"
    end
    if not text(value.title, 200, true) or not M.types[value.type] or not M.priorities[value.priority]
        or not M.stages[value.stage] then return nil, "需求标题、类型、优先级或阶段无效" end
    if not text(value.goal, M.maxGoal, true) or not text(value.scope, M.maxScope, false) then
        return nil, "需求目标或范围无效或过长"
    end
    if type(value.acceptanceCriteria) ~= "table" or #value.acceptanceCriteria > M.maxCriteria then
        return nil, "验收条件无效或过多"
    end
    local criteria, criterionIds, count = tern.json.array(), {}, 0
    for index in value.acceptanceCriteria do
        if type(index) ~= "number" or index % 1 ~= 0 or index < 1 then return nil, "验收条件必须是连续数组" end
        count += 1
    end
    if count ~= #value.acceptanceCriteria then return nil, "验收条件必须是连续数组" end
    for index = 1, count do
        local item = value.acceptanceCriteria[index]
        if type(item) == "table" then
            for key in item do
                if key ~= "id" and key ~= "description" and key ~= "required" then return nil, "验收条件含未知字段" end
            end
        end
        local clean = criterion(item, index)
        if not clean or criterionIds[clean.id] then return nil, "验收条件字段无效或 ID 重复" end
        criterionIds[clean.id] = true
        table.insert(criteria, clean)
    end
    if type(value.labels) ~= "table" or #value.labels > M.maxLabels then return nil, "标签无效或过多" end
    local labels, labelCount = tern.json.array(), 0
    for index in value.labels do
        if type(index) ~= "number" or index % 1 ~= 0 or index < 1 then return nil, "标签必须是连续数组" end
        labelCount += 1
    end
    if labelCount ~= #value.labels then return nil, "标签必须是连续数组" end
    for index = 1, labelCount do
        local label = value.labels[index]
        if not text(label, 40, true) then return nil, "标签内容无效" end
        table.insert(labels, label)
    end
    if value.blockedFrom ~= nil and not M.stages[value.blockedFrom] then return nil, "阻塞来源阶段无效" end
    if value.blockedReason ~= nil and not text(value.blockedReason, 2000, false) then return nil, "阻塞原因无效" end
    if value.extensions ~= nil and type(value.extensions) ~= "table" then return nil, "扩展字段无效" end
    value.acceptanceCriteria = criteria
    value.labels = labels
    return value
end

function M.newRequirement(project, fields)
    assert(M.validateProject(project), "项目记录无效")
    local criteria = tern.json.array()
    for index, item in fields.criteria or {} do
        if type(item) == "string" then
            table.insert(criteria, {id = "C" .. index, description = item, required = true})
        else
            table.insert(criteria, {id = "C" .. index, description = item.description, required = item.required ~= false})
        end
    end
    local labels = tern.json.array()
    for _, label in fields.labels or {} do table.insert(labels, label) end
    local value = {schemaVersion = 2, requirementId = fields.id, projectId = project.projectId,
        number = M.displayNumber(project.nextNumber), revision = 1, contentRevision = 1, lifecycleEvents = tern.json.array(),
        title = fields.title, type = fields.type,
        priority = fields.priority or "normal", stage = "backlog", goal = fields.goal,
        scope = fields.scope or "", acceptanceCriteria = criteria, labels = labels,
        createdAt = fields.now, updatedAt = fields.now}
    if fields.blockedFrom ~= nil then value.blockedFrom = fields.blockedFrom end
    if fields.blockedReason ~= nil then value.blockedReason = fields.blockedReason end
    local ok, problem = M.validateRequirement(value)
    if not ok then error(problem) end
    return value
end

function M.allocate(project)
    local nextProject = {schemaVersion = M.schemaVersion, projectId = project.projectId, root = project.root,
        name = project.name, revision = project.revision + 1, nextNumber = project.nextNumber + 1,
        createdAt = project.createdAt}
    assert(M.validateProject(nextProject), "项目记录无效")
    return nextProject
end

-- Paths are Windows UNC paths; only local WSL hosts are accepted.
local function join(a, b) return a .. "\\" .. b end
function M.unc(location, linuxPath)
    if type(location) ~= "table" or type(location.host) ~= "string" or type(location.distro) ~= "string" then return nil end
    if (location.host:lower() ~= "wsl.localhost" and location.host:lower() ~= "wsl$") or not M.token(location.distro) then return nil end
    if type(linuxPath) ~= "string" or linuxPath:sub(1, 1) ~= "/" or #linuxPath > 2048
        or linuxPath:find("[%z\1-\31]") or linuxPath:find("\\") then return nil end
    return "\\\\" .. location.host .. "\\" .. location.distro .. linuxPath:gsub("/", "\\")
end
function M.paths(location, projectRoot)
    local root = M.unc(location, projectRoot)
    if not root then return nil, "项目路径不属于本机 WSL" end
    local store = join(root, ".omp\\workbench")
    return {root = root, store = store, project = join(store, "project.json"),
        requirements = join(store, "requirements"), lock = join(store, "lock.json")}
end

local function readJson(path, max)
    if not tern.fs.exists(path) then return nil, "missing" end
    local ok, raw = pcall(tern.fs.read, path, max or M.maxJson)
    if not ok then return nil, tostring(raw) end
    local decoded, value = pcall(tern.json.decode, raw)
    if not decoded or type(value) ~= "table" then return nil, "invalid_json" end
    return value
end
function M.readProject(paths)
    local value, problem = readJson(paths.project)
    if not value then return nil, problem end
    return M.validateProject(value)
end
function M.readRequirements(paths)
    local project, projectProblem = M.readProject(paths)
    if not project then return {}, {"project: " .. tostring(projectProblem)} end
    local names, listProblem = {}, nil
    local listed, result = pcall(function() return tern.fs.list(paths.requirements) end)
    if listed then names = result else listProblem = tostring(result) end
    if listProblem then return {}, {listProblem} end
    local rows, failures, byNumber = {}, {}, {}
    for _, name in names do
        if M.token(name) then
            local path = join(join(paths.requirements, name), "requirement.json")
            local value, problem = readJson(path)
            if value then
                local valid, validationProblem = M.validateRequirement(value)
                value, problem = valid, validationProblem
            end
            if value and value.projectId ~= project.projectId then value, problem = nil, "project_id_mismatch" end
            if value and name ~= value.requirementId then value, problem = nil, "requirement_id_mismatch" end
            if value and byNumber[value.number] then
                local first = byNumber[value.number]
                failures[#failures + 1] = first.requirementId .. ": duplicate_number"
                failures[#failures + 1] = name .. ": duplicate_number"
                for index, row in rows do if row == first then table.remove(rows, index); break end end
                byNumber[value.number] = false
            elseif value and byNumber[value.number] == false then
                failures[#failures + 1] = name .. ": duplicate_number"
            elseif value then
                table.insert(rows, value)
                byNumber[value.number] = value
            else table.insert(failures, name .. ": " .. tostring(problem)) end
        else
            failures[#failures + 1] = tostring(name) .. ": invalid_requirement_directory"
        end
    end
    local maxNumber = 0
    for _, row in rows do
        local number = tonumber(row.number:match("^REQ%-(%d+)$"))
        if number and number > maxNumber then maxNumber = number end
    end
    if project.nextNumber <= maxNumber then failures[#failures + 1] = "project: next_number_behind_requirements" end
    return rows, failures
end

-- Atomic CAS write. The lock token is checked, the new revision is compared inside
-- PowerShell, and the payload is published with a same-directory MoveFileEx.
M.atomicScript = [==[
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$target=$env:OMPWB_TARGET
$temp=$env:OMPWB_TEMP
$lock=$env:OMPWB_LOCK
$token=$env:OMPWB_TOKEN
$expect=[int]$env:OMPWB_EXPECT
$gate=$env:OMPWB_GATE
$gateStream=$null
$deadline=[DateTime]::UtcNow.AddSeconds(2)
while (-not $gateStream -and [DateTime]::UtcNow -lt $deadline) {
  try { $gateStream=[IO.File]::Open($gate,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::Write,[IO.FileShare]::None) }
  catch { Start-Sleep -Milliseconds 25 }
}
if (-not $gateStream) {
  if ($temp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
  exit 7
}
try {
$l=$null
if ([IO.File]::Exists($lock)) {
  try { $l=[IO.File]::ReadAllText($lock) | ConvertFrom-Json } catch { exit 8 }
  if ($null -eq $l -or $l -isnot [System.Management.Automation.PSCustomObject]) { exit 8 }
}
if ($null -ne $l) {
  $lockKeys=@($l.PSObject.Properties.Name | Sort-Object) -join ','
  if ($l.schemaVersion -isnot [int] -or $l.schemaVersion -ne 1 -or $l.token -notmatch '^[A-Za-z0-9_-]{1,96}$' -or
    ($l.updatedAt -isnot [int] -and $l.updatedAt -isnot [long]) -or [long]$l.updatedAt -lt 0 -or
    $null -eq $l.owner -or $l.owner -isnot [System.Management.Automation.PSCustomObject] -or
    $lockKeys -ne 'owner,schemaVersion,token,updatedAt') { exit 8 }
  $ownerKeys=@($l.owner.PSObject.Properties.Name | Sort-Object) -join ','
  if ($ownerKeys -ne 'panel,window' -or $l.owner.window -isnot [string] -or
    $l.owner.window.Length -gt 128 -or
    ($l.owner.window -ne '' -and [string]::IsNullOrWhiteSpace($l.owner.window)) -or
    $l.owner.window -match '[\x00-\x1F\x7F]' -or
    ($l.owner.panel -isnot [int] -and $l.owner.panel -isnot [long]) -or
    [long]$l.owner.panel -lt 1 -or [long]$l.owner.panel -gt 9007199254740991) { exit 8 }
}
if ($env:OMPWB_MODE -eq 'claim') {
  if ($l -and $l.token -ne $token) {
    if ([long]$env:OMPWB_NOW - [long]$l.updatedAt -lt [long]$env:OMPWB_STALE) { exit 9 }
    if ($env:OMPWB_TAKEOVER -ne '1') { exit 10 }
  }
  if (-not ('Wb.MoveFile' -as [type])) {
    Add-Type -Namespace Wb -Name MoveFile -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string target, int flags);'
  }
  [IO.File]::WriteAllText($env:OMPWB_LOCK_TEMP,$env:OMPWB_LOCK_VALUE,[Text.UTF8Encoding]::new($false))
  if (-not [Wb.MoveFile]::MoveFileEx($env:OMPWB_LOCK_TEMP,$lock,0x9)) { exit 6 }
  exit 0
}
if ($env:OMPWB_MODE -eq 'renew' -or $env:OMPWB_MODE -eq 'release') {
  if (-not $l -or $l.token -ne $token) { exit 2 }
  if ($env:OMPWB_MODE -eq 'renew') {
    if (-not ('Wb.MoveFile' -as [type])) {
      Add-Type -Namespace Wb -Name MoveFile -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string target, int flags);'
    }
    [IO.File]::WriteAllText($env:OMPWB_LOCK_TEMP,$env:OMPWB_LOCK_VALUE,[Text.UTF8Encoding]::new($false))
    if (-not [Wb.MoveFile]::MoveFileEx($env:OMPWB_LOCK_TEMP,$lock,0x9)) { exit 6 }
  } else { [IO.File]::Delete($lock) }
  exit 0
}
if (-not $l -or $l.token -ne $token) { exit 2 }
if ($env:OMPWB_MODE -eq 'publish_directory') {
  $source=$env:OMPWB_SOURCE
  if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { exit 11 }
  if (-not [IO.Directory]::Exists($source) -or -not [IO.File]::Exists([IO.Path]::Combine($source,'requirement.json'))) { exit 12 }
  if (-not ('Wb.MoveFile' -as [type])) {
    Add-Type -Namespace Wb -Name MoveFile -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string target, int flags);'
  }
  if (-not [Wb.MoveFile]::MoveFileEx($source,$target,0x8)) {
    if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { exit 11 }
    exit 6
  }
  exit 0
}
if ([IO.File]::Exists($target)) {
  if ($expect -eq 0) { exit 3 }
  try { $cur=[IO.File]::ReadAllText($target) | ConvertFrom-Json } catch { exit 4 }
  $schema2Target=$target -match '\\(requirement|workflow|plan|results|reviews)\.json$' -or $target -match '\\evidence\\verification-[A-Za-z0-9_-]+\.json$'
  $schema3Target=$target -match '\\reviews\.json$'
  if ($cur -isnot [System.Management.Automation.PSCustomObject] -or
    ($cur.schemaVersion -ne 1 -and
      -not ($env:OMPWB_SCHEMA2 -eq '1' -and $schema2Target -and $cur.schemaVersion -eq 2) -and
      -not ($env:OMPWB_SCHEMA3 -eq '1' -and $schema3Target -and $cur.schemaVersion -eq 3)) -or
    ($cur.revision -isnot [int] -and $cur.revision -isnot [long]) -or [long]$cur.revision -lt 1) { exit 4 }
  if ([long]$cur.revision -ne $expect) { exit 3 }
} elseif ($expect -ne 0) { exit 3 }
if (-not [IO.File]::Exists($temp)) { exit 5 }
try {
  if (-not ('Wb.MoveFile' -as [type])) {
    Add-Type -Namespace Wb -Name MoveFile -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string target, int flags);'
  }
  $flags=if ($expect -eq 0) { 0x8 } else { 0x9 }
  if (-not [Wb.MoveFile]::MoveFileEx($temp, $target, $flags)) {
    if ($expect -eq 0 -and [IO.File]::Exists($target)) { exit 3 }
    exit 6
  }
} finally {
  if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
}
} finally {
  if ($temp -and [IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
  if ($env:OMPWB_LOCK_TEMP -and [IO.File]::Exists($env:OMPWB_LOCK_TEMP)) { [IO.File]::Delete($env:OMPWB_LOCK_TEMP) }
  if ($gateStream) { $gateStream.Dispose() }
  # Keep the inert gate file: unlinking after release can race a waiter.
}
exit 0
]==]
local reasons = {[2] = "lock_conflict", [3] = "revision_conflict", [4] = "corrupt_target",
    [5] = "missing_payload", [6] = "publish_failed", [7] = "busy", [8] = "corrupt_lock",
    [9] = "locked", [10] = "takeover_required", [11] = "publish_conflict", [12] = "missing_stage"}
local function removeStage(stage)
    pcall(tern.fs.remove, join(stage, "requirement.json"))
    pcall(tern.fs.remove, stage)
end
local function publishDirectory(paths, source, target, token, cb)
    local env = {OMPWB_MODE = "publish_directory", OMPWB_TARGET = target, OMPWB_SOURCE = source,
        OMPWB_LOCK = paths.lock, OMPWB_GATE = paths.lock .. ".gate",
        OMPWB_LOCK_TEMP = paths.lock .. ".tmp-" .. M.newId("l", tern.now()), OMPWB_TOKEN = token}
    local spawned, errorValue = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        if status == 0 then cb(true, nil, false, cx)
        else cb(false, timedOut and "timeout" or reasons[status] or ("publish_failed:" .. tostring(stderr or ""):sub(1, 300)),
            timedOut == true, cx) end
    end)
    if not spawned then cb(false, "process_failed:" .. tostring(errorValue), true) end
end
local function processRun(env, cb)
    local argv = {"powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", M.atomicScript}
    if cb then
        tern.process.run(argv, {env = env, timeout_ms = 8000}, function(result, cx)
            cb(result.status, result.stderr, result.timed_out, cx)
        end)
    else
        local r = tern.process.run(argv, {env = env, timeout_ms = 8000})
        return r
    end
end


-- Keeps the native awaitable result when called without a callback.
M.runProcess = processRun

-- value must already be schema-valid; expectedRevision 0 means create.
-- cb receives (ok, reason); without cb an awaitable ProcessResult is returned.
local function allowedFile(paths, file, value)
    if type(value) ~= "table" or type(file) ~= "string" then return false end
    if file == paths.project then return M.validateProject(value) ~= nil end
    local suffix, prefix = "\\requirement.json", paths.requirements .. "\\"
    if file:sub(1, #prefix) ~= prefix or file:sub(-#suffix) ~= suffix then return false end
    local id = file:sub(#prefix + 1, #file - #suffix)
    return M.token(id) and id == value.requirementId and M.validateRequirement(value) ~= nil
end

function M.put(paths, file, value, expectedRevision, token, cb)
    if not M.token(token) or not allowedFile(paths, file, value) then
        if cb then cb(false, "invalid_path_or_record"); return end
        error("拒绝非 workbench 文件或无效记录")
    end
    if not integer(expectedRevision, 0) then
        if cb then cb(false, "invalid_revision"); return end
        error("无效预期版本")
    end
    if file ~= paths.project then
        local current, problem = readJson(file)
        if current then
            if not M.validateRequirement(current) then
                if cb then cb(false, "corrupt_requirement"); return end
                error("损坏的需求记录")
            end
            if current.revision ~= expectedRevision then
                if cb then cb(false, "revision_conflict"); return end
                error("需求版本冲突")
            end
            local priorEvents = current.lifecycleEvents or {}
            if #(value.lifecycleEvents or {}) < #priorEvents then
                if cb then cb(false, "invalid_lifecycle_history"); return end
                error("生命周期历史不可删除")
            end
            for index, event in priorEvents do
                local nextEvent = value.lifecycleEvents[index]
                for key, item in event do
                    if nextEvent[key] ~= item then
                        if cb then cb(false, "invalid_lifecycle_history"); return end
                        error("生命周期历史不可修改")
                    end
                end
            end
        elseif problem ~= "missing" then
            if cb then cb(false, "corrupt_requirement"); return end
            error("损坏的需求记录")
        end
        if value.revision ~= expectedRevision + 1 then
            if cb then cb(false, "invalid_revision"); return end
            error("无效需求版本")
        end
        upgradeRequirement(value, current)
    end
    local encoded, payload = pcall(tern.json.encode, value)
    if not encoded then if cb then cb(false, "encode_failed"); return end; error(payload) end
    if #payload > M.maxJson then if cb then cb(false, "record_too_large"); return end; error("记录超过大小上限") end
    local temp = file .. ".tmp-" .. M.newId("w", tern.now())
    local wrote, writeError = pcall(tern.fs.write, temp, payload)
    if not wrote then if cb then cb(false, "temp_write_failed:" .. tostring(writeError)); return end; return nil, writeError end
    local env = {OMPWB_TARGET = file, OMPWB_TEMP = temp, OMPWB_LOCK = paths.lock,
        OMPWB_GATE = paths.lock .. ".gate", OMPWB_LOCK_TEMP = paths.lock .. ".tmp-" .. M.newId("l", tern.now()),
        OMPWB_TOKEN = token, OMPWB_EXPECT = tostring(expectedRevision), OMPWB_SCHEMA2 = file ~= paths.project and "1" or "0"}
    if not cb then return M.runProcess(env, nil) end
    local spawned, errorValue = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        if status == 0 then cb(true, nil, cx)
        else cb(false, timedOut and "timeout" or reasons[status] or ("write_failed:" .. tostring(stderr or ""):sub(1, 300)), cx) end
    end)
    if not spawned then cb(false, "process_failed:" .. tostring(errorValue)) end
    if not spawned then pcall(tern.fs.remove, temp) end
end
-- CAS publication for requirement-scoped workflow metadata. Paths are constrained
-- to the corresponding requirement directory; publication uses the same gate.
local function casPublish(paths, file, value, expectedRevision, token, cb)
    local encoded, payload = pcall(tern.json.encode, value)
    if not encoded then cb(false, "encode_failed"); return end
    if #payload > M.maxJson then cb(false, "record_too_large"); return end
    local directory = file:match("^(.*)\\[^\\]+$")
    local made, mkdirError = pcall(tern.fs.mkdir, directory)
    if not made then cb(false, "mkdir_failed:" .. tostring(mkdirError)); return end
    local temp = file .. ".tmp-" .. M.newId("w", tern.now())
    local wrote, writeError = pcall(tern.fs.write, temp, payload)
    if not wrote then cb(false, "temp_write_failed:" .. tostring(writeError)); return end
    local env = {OMPWB_TARGET = file, OMPWB_TEMP = temp, OMPWB_LOCK = paths.lock,
        OMPWB_GATE = paths.lock .. ".gate", OMPWB_LOCK_TEMP = paths.lock .. ".tmp-" .. M.newId("l", tern.now()),
        OMPWB_TOKEN = token, OMPWB_EXPECT = tostring(expectedRevision),
        OMPWB_SCHEMA2 = (file:match("\\workflow%.json$") or file:match("\\plan%.json$") or file:match("\\results%.json$")
            or file:match("\\reviews%.json$") or file:match("\\evidence\\")) and "1" or "0",
        OMPWB_SCHEMA3 = file:match("\\reviews%.json$") and "1" or "0"}
    local spawned, errorValue = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        if status == 0 then cb(true, nil, cx)
        else cb(false, timedOut and "timeout" or reasons[status] or ("write_failed:" .. tostring(stderr or ""):sub(1, 300)), cx) end
    end)
    if not spawned then cb(false, "process_failed:" .. tostring(errorValue)); pcall(tern.fs.remove, temp) end
end
local function hash(value)
    return type(value) == "string" and #value == 64 and value:match("^[0-9a-f]+$") ~= nil
end
local function identity(record, schema)
    return record.requirementContentRevision == nil or (schema == 2 and integer(record.requirementContentRevision, 1)
        and integer(record.requirementRevision, 1) and record.requirementContentRevision <= record.requirementRevision)
end
local workflowKeys = {schemaVersion=true,projectId=true,requirementId=true,revision=true,latestVersion=true,
    designs=true,comments=true,approvals=true,approval=true,requests=true}
local designKeys = {version=true,sha256=true,requirementSha256=true,requirementRevision=true,requirementContentRevision=true,createdAt=true}
local approvalKeys = {id=true,mode=true,requirementRevision=true,requirementContentRevision=true,requirementSha256=true,
    requirementContent=true,designVersion=true,designSha256=true,latestVersion=true,baseline=true,approvedAt=true,
    reason=true,revokedAt=true,revocationReason=true}
local requestKeys = {requestId=true,activity=true,sessionId=true,instanceId=true,payloadSha256=true,status=true,
    requirementRevision=true,requirementContentRevision=true,authorizedRequirementRevision=true,requirementSha256=true,
    currentRequirementRevision=true,createdAt=true,reason=true,receivedAt=true,resolution=true}
local function equalRecord(a, b)
    if type(a) ~= type(b) then return false end
    if type(a) ~= "table" then return a == b end
    for key, value in a do if not equalRecord(value, b[key]) then return false end end
    for key in b do if a[key] == nil then return false end end
    return true
end
-- Shared by Workflow.load and lifecycle: never repair or discard unknown history.
function M.validateWorkflow(w, req)
    local function fail() return nil, "corrupt_workflow" end
    if type(w) ~= "table" or (w.schemaVersion ~= 1 and w.schemaVersion ~= 2) or not keys(w, workflowKeys)
        or w.projectId ~= req.projectId or w.requirementId ~= req.requirementId
        or not integer(w.revision, 1) or not integer(w.latestVersion, 0)
        or not array(w.designs) or #w.designs ~= w.latestVersion or not array(w.comments)
        or not array(w.approvals) or not array(w.requests) then return fail() end
    for index, d in w.designs do
        if type(d) ~= "table" or not keys(d, designKeys) or d.version ~= index or not hash(d.sha256)
            or not hash(d.requirementSha256) or not integer(d.requirementRevision, 1)
            or not integer(d.createdAt, 0) or not identity(d, w.schemaVersion) then return fail() end
    end
    for _, c in w.comments do
        if type(c) ~= "table" or not keys(c, {designVersion=true,text=true,createdAt=true})
            or not integer(c.designVersion, 1) or c.designVersion > w.latestVersion
            or not text(c.text, 4000, true) or not integer(c.createdAt, 0) then return fail() end
    end
    local approvalIds = {}
    for _, a in w.approvals do
        if type(a) ~= "table" or not keys(a, approvalKeys) or not M.token(a.id) or approvalIds[a.id]
            or (a.mode ~= "design" and a.mode ~= "direct") or not integer(a.requirementRevision, 1)
            or not identity(a, w.schemaVersion) or not hash(a.requirementSha256)
            or type(a.requirementContent) ~= "string" or not integer(a.latestVersion, 0)
            or not integer(a.designVersion, 0) or not integer(a.approvedAt, 0) or type(a.baseline) ~= "table" then return fail() end
        local b = a.baseline
        if not keys(b, {head=true,fingerprint=true,dirty=true,files=true,filesTruncated=true}) or type(b.head) ~= "string" or #b.head > 128
            or type(b.fingerprint) ~= "string" or #b.fingerprint ~= 64 or not b.fingerprint:match("^[0-9a-fA-F]+$")
            or type(b.dirty) ~= "boolean" or (a.reason ~= nil and not text(a.reason, 2000, true))
            or (a.mode == "direct" and not text(a.reason, 2000, true))
            or (a.mode == "design" and (not hash(a.designSha256) or a.designVersion < 1))
            or (a.revokedAt ~= nil and (not integer(a.revokedAt, 0) or not text(a.revocationReason, 2000, true)))
            or (a.revocationReason ~= nil and a.revokedAt == nil) then return fail() end
        if (b.filesTruncated ~= nil and type(b.filesTruncated) ~= "boolean") or (b.files ~= nil and not array(b.files)) then return fail() end
        for _, file in b.files or {} do
            if type(file) ~= "table" or not keys(file, {path=true,status=true,sha256=true}) or not text(file.path, 2048, true)
                or not text(file.status, 32, true) or (file.sha256 ~= nil and not hash(file.sha256)) then return fail() end
        end
        approvalIds[a.id] = a
    end
    if w.approval ~= nil and (type(w.approval) ~= "table" or not approvalIds[w.approval.id]
        or not equalRecord(w.approval, approvalIds[w.approval.id])) then return fail() end
    local requestIds = {}
    for _, r in w.requests do
        if type(r) ~= "table" or not keys(r, requestKeys) or not M.token(r.requestId) or requestIds[r.requestId]
            or (r.activity ~= "clarify" and r.activity ~= "design" and r.activity ~= "implement")
            or not M.token(r.sessionId) or not M.token(r.instanceId) or not hash(r.requirementSha256)
            or not hash(r.payloadSha256) or not integer(r.requirementRevision, 1) or not identity(r, w.schemaVersion)
            or not integer(r.authorizedRequirementRevision, 1) or not integer(r.currentRequirementRevision, 1)
            or not integer(r.createdAt, 0)
            or (r.status ~= "pending" and r.status ~= "submitted" and r.status ~= "rejected" and r.status ~= "delivery_unknown")
            or (r.reason ~= nil and not text(r.reason, 1000, false))
            or (r.receivedAt ~= nil and not integer(r.receivedAt, 0))
            or (r.status ~= "pending" and (not text(r.reason or "", 1000, false) or not integer(r.receivedAt, 0))) then return fail() end
        if r.resolution ~= nil then
            local resolution = r.resolution
            if type(resolution) ~= "table" or not keys(resolution, {kind=true,note=true,at=true})
                or resolution.kind ~= "user_acknowledged" or not text(resolution.note, 2000, true)
                or not integer(resolution.at, 0) or r.status == "pending" then return fail() end
        end
        requestIds[r.requestId] = true
    end
    return w
end
function M.putRecord(paths, file, value, expectedRevision, token, cb)
    local prefix = paths.requirements .. "\\"
    local id = type(file) == "string" and file:sub(1,#prefix)==prefix and file:sub(#prefix + 1):match("^([%w_%-]+)\\workflow%.json$")
    local valid = type(value) == "table" and value.requirementId == id and M.token(value.projectId)
        and M.validateWorkflow(value, value) ~= nil
    if not M.token(token) or not id or not valid or not integer(expectedRevision,0) or value.revision~=expectedRevision+1 then
        cb(false,"invalid_path_or_record");return
    end
    casPublish(paths, file, value, expectedRevision, token, cb)
end
-- Plan, result and immutable verification records share the same requirement scope
-- and gate. Evidence is create-only; mutable summaries require the exact prior revision.
local scopedKeys = {
    plan = {schemaVersion=true,projectId=true,requirementId=true,revision=true,designVersion=true,steps=true,changeReason=true,updatedAt=true,candidateImports=true},
    resources = {schemaVersion=true,projectId=true,requirementId=true,revision=true,resources=true,updatedAt=true},
    results = {schemaVersion=true,projectId=true,requirementId=true,revision=true,baseline=true,changes=true,verifications=true},
    reviews = {schemaVersion=true,projectId=true,requirementId=true,revision=true,reviews=true,acceptances=true,reopenings=true,candidateImports=true},
    evidence = {schemaVersion=true,projectId=true,requirementId=true,revision=true,id=true,command=true,cwd=true,criterionIds=true,
        requirementRevision=true,requirementContentRevision=true,codeSnapshotSha256=true,startedAt=true,endedAt=true,exitCode=true,
        timedOut=true,result=true,stdout=true,stderr=true,stdoutBytes=true,stderrBytes=true,stdoutTruncated=true,stderrTruncated=true},
}
local function identityTree(value, schema)
    if not identity(value, schema) then return false end
    for _, item in value do
        if type(item) == "table" and not identityTree(item, schema) then return false end
    end
    return true
end
function M.putScoped(paths, file, value, expectedRevision, token, cb)
    local prefix = paths.requirements .. "\\"
    local relative = type(file) == "string" and file:sub(1, #prefix) == prefix and file:sub(#prefix + 1)
    local id = relative and (relative:match("^([%w_%-]+)\\plan%.json$") or relative:match("^([%w_%-]+)\\results%.json$")
        or relative:match("^([%w_%-]+)\\reviews%.json$") or relative:match("^([%w_%-]+)\\resources%.json$"))
    local evidenceId = relative and relative:match("^([%w_%-]+)\\evidence\\verification%-[%w_%-]+%.json$")
    local requirementId = id or evidenceId
    local kind = evidenceId and "evidence" or (relative and relative:match("\\([%a]+)%.json$"))
    local valid = type(value) == "table" and requirementId and value.requirementId == requirementId
        and M.token(value.projectId) and integer(value.revision, 1) and scopedKeys[kind] and keys(value, scopedKeys[kind])
        and (value.schemaVersion == 1 or (value.schemaVersion == 2 and kind ~= "resources")
            or (value.schemaVersion == 3 and kind == "reviews"))
        and identityTree(value, value.schemaVersion == 3 and 2 or value.schemaVersion)
        and ((kind ~= "plan" and kind ~= "reviews" and value.candidateImports == nil)
            or (kind == "plan" and ((value.schemaVersion == 1 and value.candidateImports == nil)
                or (value.schemaVersion == 2 and array(value.candidateImports, 40))))
            or (kind == "reviews" and ((value.schemaVersion < 3 and value.candidateImports == nil)
                or (value.schemaVersion == 3 and array(value.candidateImports, 50)))))
        and (not evidenceId or value.schemaVersion == 1 or integer(value.requirementContentRevision, 1))
    if valid and evidenceId then valid = expectedRevision == 0 and value.revision == 1
    elseif valid then valid = integer(expectedRevision, 0) and value.revision == expectedRevision + 1 end
    if not M.token(token) or not requirementId or not valid then cb(false, "invalid_path_or_record"); return end
    casPublish(paths, file, value, expectedRevision, token, cb)
end
function M.putImmutableRecord(paths, file, value, token, cb)
    local prefix = paths.requirements .. "\\"
    if type(file) ~= "string" or file:sub(1,#prefix)~=prefix then cb(false,"invalid_path_or_record"); return end
    local id, version = file:sub(#prefix + 1):match("^([%w_%-]+)\\designs\\v(%d+)%.json$")
    if not M.token(token) or not id or type(value)~="table" or not integer(value.version,1)
        or tonumber(version) ~= value.version or value.requirementId ~= id or not M.token(value.projectId)
        or (value.schemaVersion ~= 1 and value.schemaVersion ~= 2) or not identity(value, value.schemaVersion)
        or (value.schemaVersion == 2 and not integer(value.requirementContentRevision, 1))
        or not integer(value.requirementRevision, 1) or not integer(value.createdAt, 0)
        or not text(value.body, 16384, true)
        or type(value.sha256)~="string" or #value.sha256~=64 or not value.sha256:match("^[0-9a-f]+$")
        or type(value.requirementSha256)~="string" or #value.requirementSha256~=64
        or not value.requirementSha256:match("^[0-9a-f]+$") then
        cb(false,"invalid_path_or_record"); return
    end
    if not keys(value, {schemaVersion=true,projectId=true,requirementId=true,version=true,requirementRevision=true,
        requirementContentRevision=true,requirementSha256=true,body=true,sha256=true,source=true,createdAt=true})
        or type(value.source) ~= "table" or not keys(value.source, {kind=true,path=true,entryId=true,sessionId=true,requestId=true})
        or (value.source.kind ~= "manual" and value.source.kind ~= "file" and value.source.kind ~= "assistant") then
        cb(false, "invalid_path_or_record"); return
    end
    for _, item in value.source do if not text(item, 1024, false) then cb(false, "invalid_path_or_record"); return end end
    local encoded, payload = pcall(tern.json.encode, value)
    if not encoded then cb(false, "encode_failed"); return end
    if #payload > M.maxJson then cb(false, "record_too_large"); return end
    local directory = file:match("^(.*)\\[^\\]+$")
    local made, mkdirError = pcall(tern.fs.mkdir,directory)
    if not made then cb(false,"mkdir_failed:"..tostring(mkdirError));return end
    local temp = file .. ".tmp-" .. M.newId("w", tern.now())
    local wrote, why = pcall(tern.fs.write, temp, payload)
    if not wrote then cb(false, "temp_write_failed:" .. tostring(why)); return end
    local env = {OMPWB_TARGET=file, OMPWB_TEMP=temp, OMPWB_LOCK=paths.lock, OMPWB_GATE=paths.lock .. ".gate",
        OMPWB_LOCK_TEMP=paths.lock .. ".tmp-" .. M.newId("l", tern.now()), OMPWB_TOKEN=token, OMPWB_EXPECT="0"}
    local spawned, problem = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        if status == 0 then cb(true,nil,cx)
        else cb(false,timedOut and "timeout" or reasons[status] or ("write_failed:" .. tostring(stderr or ""):sub(1,300)),cx) end
    end)
    if not spawned then pcall(tern.fs.remove,temp); cb(false,"process_failed:"..tostring(problem)) end
end

local function lockValue(paths, token, owner, now)
    return {schemaVersion = 1, token = token, owner = owner, updatedAt = now}
end
local function lockOperation(paths, mode, token, owner, now, takeover, cb)
    local env = {OMPWB_MODE = mode, OMPWB_LOCK = paths.lock, OMPWB_GATE = paths.lock .. ".gate",
        OMPWB_LOCK_TEMP = paths.lock .. ".tmp-" .. M.newId("l", now or 0),
        OMPWB_TOKEN = token, OMPWB_NOW = tostring(now or 0), OMPWB_STALE = tostring(M.lockStaleMs),
        OMPWB_TAKEOVER = takeover and "1" or "0",
        OMPWB_LOCK_VALUE = tern.json.encode(lockValue(paths, token, owner, now or 0))}
    local spawned, errorValue = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        local code = status == 0 and nil or (timedOut and "timeout" or reasons[status] or "lock_failed")
        if cb then cb(status == 0, code and {code = code, detail = stderr} or nil, cx) end
    end)
    if not spawned and cb then cb(false, {code = "process_failed", detail = tostring(errorValue)}) end
end
function M.renewLock(paths, token, owner, now, cb)
    if not M.token(token) or not M.lockOwner(owner) or not integer(now, 0) then
        if cb then cb(false, {code = "invalid_lock_options"}) end
        return
    end
    lockOperation(paths, "renew", token, owner, now, false, cb)
end
function M.releaseLock(paths, token, cb)
    if not M.token(token) then if cb then cb(false, {code = "invalid_token"}) end; return end
    lockOperation(paths, "release", token, {}, os.time() * 1000, false, cb)
end
function M.init(paths, opts, cb)
    local function fail(code, detail, cx) cb(nil, {code = code, detail = detail}, cx) end
    if type(opts) ~= "table" or not M.token(opts.token) or not M.lockOwner(opts.owner) or not integer(opts.now, 0) then
        fail("invalid_init_options"); return
    end
    local ok, problem = pcall(function() tern.fs.mkdir(paths.store); tern.fs.mkdir(paths.requirements) end)
    if not ok then fail("mkdir_failed", tostring(problem)); return end
    local project, projectProblem = readJson(paths.project)
    if projectProblem ~= "missing" and not project then fail("corrupt_project", projectProblem); return end
    if project then
        local valid, detail = M.validateProject(project)
        if not valid then fail("corrupt_project", detail); return end
        if project.root ~= opts.root then fail("project_root_mismatch"); return end
        if project.projectId ~= opts.projectId then fail("project_id_mismatch"); return end
    else
        local created, detail = pcall(M.newProject, {projectId = opts.projectId, root = opts.root, name = opts.name, now = opts.now})
        if not created then fail("invalid_project_options", tostring(detail)); return end
        project = detail
    end
    if projectProblem == "missing" then
        local listed, names = pcall(function() return tern.fs.list(paths.requirements) end)
        if not listed then fail("requirements_list_failed", tostring(names)); return end
        if #names > 0 then fail("orphan_requirements", "项目元数据缺失但需求目录非空"); return end
    end
    if projectProblem ~= "missing" then
        local _, failures = M.readRequirements(paths)
        if #failures > 0 then fail("corrupt_requirements", table.concat(failures, "; ")); return end
    end
    lockOperation(paths, "claim", opts.token, opts.owner, opts.now, opts.takeover == true, function(claimed, err, cx)
        if not claimed then fail(err.code, err.detail, cx); return end
        if projectProblem == "missing" then
            M.put(paths, paths.project, project, 0, opts.token, function(saved, reason, freshCx)
                if saved then cb(project, nil, freshCx) else fail(reason, nil, freshCx) end
            end)
        else cb(project, nil, cx) end
    end)
end
function M.create(paths, project, fields, token, cb)
    if not M.token(token) then cb(nil, nil, {code = "invalid_token"}); return end
    local current, problem = M.readProject(paths)
    if not current then cb(nil, nil, {code = problem or "corrupt_project"}); return end
    local _, failures = M.readRequirements(paths)
    if #failures > 0 then cb(nil, nil, {code = "corrupt_requirements", detail = table.concat(failures, "; ")}); return end
    if current.projectId ~= project.projectId or current.root ~= project.root then cb(nil, nil, {code = "project_mismatch"}); return end
    local req
    local okay, detail = pcall(function() req = M.newRequirement(current, fields) end)
    if not okay then cb(nil, nil, {code = "invalid_requirement", detail = tostring(detail)}); return end
    local reqPath = join(join(paths.requirements, req.requirementId), "requirement.json")
    local existing, existingProblem = readJson(reqPath)
    if existing then
        local valid, why = M.validateRequirement(existing)
        if not valid or existing.projectId ~= current.projectId then
            cb(nil, nil, {code = "corrupt_requirement", detail = why})
            return
        end
        local sameCriteria, sameLabels = #existing.acceptanceCriteria == #req.acceptanceCriteria,
            #existing.labels == #req.labels
        if sameCriteria then
            for index, item in req.acceptanceCriteria do
                local prior = existing.acceptanceCriteria[index]
                if not prior or prior.id ~= item.id or prior.description ~= item.description or prior.required ~= item.required then
                    sameCriteria = false
                    break
                end
            end
        end
        if sameLabels then
            for index, label in req.labels do
                if existing.labels[index] ~= label then sameLabels = false; break end
            end
        end
        if existing.title ~= req.title or existing.type ~= req.type or existing.priority ~= req.priority
            or existing.goal ~= req.goal or existing.scope ~= req.scope or not sameCriteria or not sameLabels then
            cb(nil, nil, {code = "requirement_id_conflict", detail = "ID 已存在且草稿内容不同"})
        else cb(existing, current, nil) end
        return
    elseif existingProblem ~= "missing" then cb(nil, nil, {code = "corrupt_requirement", detail = existingProblem}); return end
    local stage = join(paths.store, ".pending-" .. req.requirementId .. "-" .. M.newId("a", tern.now()))
    local stageFile = join(stage, "requirement.json")
    local encoded, payload = pcall(tern.json.encode, req)
    if not encoded then cb(nil, nil, {code = "encode_failed", detail = tostring(payload)}); return end
    if #payload > M.maxJson then cb(nil, nil, {code = "record_too_large"}); return end
    local staged, stageProblem = pcall(function()
        tern.fs.mkdir(stage)
        tern.fs.write(stageFile, payload)
    end)
    if not staged then
        removeStage(stage)
        cb(nil, nil, {code = "stage_write_failed", detail = tostring(stageProblem)})
        return
    end
    local allocated = M.allocate(current)
    M.put(paths, paths.project, allocated, current.revision, token, function(saved, reason, cx)
        if not saved then
            if reason ~= "timeout" and not tostring(reason):match("^process_failed:") then removeStage(stage) end
            cb(nil, nil, {code = reason}, cx)
            return
        end
        publishDirectory(paths, stage, join(paths.requirements, req.requirementId), token,
            function(published, why, uncertain, freshCx)
                if published then cb(req, allocated, nil, freshCx)
                else
                    if not uncertain then removeStage(stage) end
                    cb(nil, allocated, {code = why}, freshCx)
                end
            end)
    end)
end
function M.update(paths, requirement, expectedRevision, token, cb)
    if not M.token(token) then cb(nil, {code = "invalid_token"}); return end
    if type(requirement) ~= "table" or not M.token(requirement.requirementId) then
        cb(nil, {code = "invalid_requirement_id"}); return
    end
    if not keys(requirement, requirementKeys) or (requirement.schemaVersion ~= nil
        and requirement.schemaVersion ~= 1 and requirement.schemaVersion ~= 2) then
        cb(nil, {code = "invalid_requirement"}); return
    end
    if not integer(expectedRevision, 1) then cb(nil, {code = "invalid_revision"}); return end
    local path = join(join(paths.requirements, requirement.requirementId), "requirement.json")
    local current, problem = readJson(path)
    if not current then cb(nil, {code = problem == "missing" and "missing_requirement" or "corrupt_requirement"}); return end
    local valid, detail = M.validateRequirement(current)
    if not valid or current.requirementId ~= requirement.requirementId then
        cb(nil, {code = "corrupt_requirement", detail = detail}); return
    end
    local project, projectProblem = M.readProject(paths)
    if not project then cb(nil, {code = "corrupt_project", detail = projectProblem}); return end
    if current.projectId ~= project.projectId then cb(nil, {code = "project_mismatch"}); return end
    local _, failures = M.readRequirements(paths)
    if #failures > 0 then cb(nil, {code = "corrupt_requirements", detail = table.concat(failures, "; ")}); return end
    local changed = {}
    for key, value in current do changed[key] = value end
    for _, key in {"title", "type", "priority", "goal", "scope", "acceptanceCriteria", "labels"} do
        if requirement[key] ~= nil then changed[key] = requirement[key] end
    end
    changed.revision, changed.updatedAt = expectedRevision + 1, os.time() * 1000
    local okay, validationProblem = M.validateRequirement(changed)
    if not okay then cb(nil, {code = "invalid_requirement", detail = validationProblem}); return end
    M.put(paths, path, changed, expectedRevision, token, function(saved, reason, cx)
        if saved then cb(changed, nil, cx) else cb(nil, {code = reason}, cx) end
    end)
end
function M.workflowStage(paths, requirement, stage, expectedRevision, token, cb)
    if stage=="backlog" or not M.workflowStages[stage] or not M.token(token) then cb(nil,{code="invalid_stage_transition"}); return end
    local file = join(join(paths.requirements,requirement.requirementId),"requirement.json")
    local current,problem=readJson(file)
    if not current or not M.validateRequirement(current) then cb(nil,{code="corrupt_requirement",detail=problem});return end
    if current.revision~=expectedRevision or current.projectId~=requirement.projectId then cb(nil,{code="revision_conflict"});return end
    if not M.workflowStages[current.stage] then cb(nil,{code="invalid_stage_transition"});return end
    local nextReq={};for k,v in current do nextReq[k]=v end
    nextReq.stage=stage;nextReq.revision=current.revision+1;nextReq.updatedAt=os.time()*1000
    M.put(paths,file,nextReq,current.revision,token,function(ok,reason,cx)
        if ok then cb(nextReq,nil,cx) else cb(nil,{code=reason},cx) end
    end)
end
local reviewTransitions = {
    verifying = {implementing=true},
    awaiting_acceptance = {implementing=true,verifying=true},
    implementing = {verifying=true,awaiting_acceptance=true},
    done = {awaiting_acceptance=true,implementing=true,verifying=true},
}
-- Human review/acceptance transitions. Kept separate from workflow actions so
-- a terminal requirement cannot silently adopt or approve new designs.
function M.advanceStage(paths, requirement, stage, expectedRevision, token, cb)
    if not M.token(token) or not reviewTransitions[stage] then cb(nil,{code="invalid_stage_transition"}); return end
    local file = join(join(paths.requirements,requirement.requirementId),"requirement.json")
    local current,problem=readJson(file)
    if not current or not M.validateRequirement(current) then cb(nil,{code="corrupt_requirement",detail=problem});return end
    if current.revision~=expectedRevision or current.projectId~=requirement.projectId then cb(nil,{code="revision_conflict"});return end
    if not reviewTransitions[stage][current.stage] then cb(nil,{code="invalid_stage_transition"});return end
    local nextReq={};for k,v in current do nextReq[k]=v end
    nextReq.stage=stage;nextReq.revision=current.revision+1;nextReq.updatedAt=os.time()*1000
    M.put(paths,file,nextReq,current.revision,token,function(ok,reason,cx)
        if ok then cb(nextReq,nil,cx) else cb(nil,{code=reason},cx) end
    end)
end
-- Explicit one-file lifecycle changes never rewrite workflow/results/review history.
function M.lifecycle(paths, requirement, action, reason, expectedRevision, token, cb)
    local function fail(code, detail) cb(nil, {code=code,detail=detail}) end
    if not M.token(token) then fail("invalid_token"); return end
    if type(requirement) ~= "table" or not M.token(requirement.requirementId) then fail("invalid_requirement_id"); return end
    if not integer(expectedRevision, 1) then fail("invalid_revision"); return end
    if not text(reason, 2000, true) then fail("invalid_lifecycle_reason"); return end
    local project, projectProblem = M.readProject(paths)
    if not project then fail("corrupt_project", projectProblem); return end
    local rows, failures = M.readRequirements(paths)
    if #failures > 0 then fail("corrupt_requirements", table.concat(failures, "; ")); return end
    local current
    for _, row in rows do if row.requirementId == requirement.requirementId then current = row; break end end
    if not current then fail("missing_requirement"); return end
    if current.revision ~= expectedRevision or current.projectId ~= requirement.projectId then fail("revision_conflict"); return end
    local target = lifecycleTarget(current.stage, action, current.blockedFrom)
    if not target then fail("invalid_stage_transition"); return end
    local events = current.lifecycleEvents or {}
    if #events >= M.maxLifecycleEvents then fail("lifecycle_history_full"); return end
    local directory = join(paths.requirements, current.requirementId)
    local workflow, workflowProblem = readJson(join(directory, "workflow.json"))
    if workflow then
        local valid, detail = M.validateWorkflow(workflow, current)
        if not valid then fail("corrupt_workflow", detail); return end
        for _, request in workflow.requests do
            if (request.status == "pending" or request.status == "delivery_unknown")
                and (not request.resolution or request.resolution.kind ~= "user_acknowledged") then
                fail("unresolved_request", request.requestId); return
            end
        end
    elseif workflowProblem ~= "missing" then fail("corrupt_workflow", workflowProblem); return end
    local nextReq = {}
    for key, value in current do nextReq[key] = value end
    nextReq.lifecycleEvents = tern.json.array()
    for _, event in events do table.insert(nextReq.lifecycleEvents, event) end
    local at = os.time() * 1000
    local event = {id=M.newId("lifecycle", tern.now()),action=action,from=current.stage,to=target,reason=reason,at=at}
    if current.stage == "blocked" then
        event.previousBlockedFrom, event.previousBlockedReason = current.blockedFrom, current.blockedReason
    end
    table.insert(nextReq.lifecycleEvents, event)
    nextReq.stage, nextReq.revision, nextReq.updatedAt = target, current.revision + 1, at
    if action == "block" then nextReq.blockedFrom, nextReq.blockedReason = current.stage, reason
    else nextReq.blockedFrom, nextReq.blockedReason = nil, nil end
    upgradeRequirement(nextReq, current)
    M.put(paths, join(directory, "requirement.json"), nextReq, expectedRevision, token, function(saved, problem, cx)
        if saved then cb(nextReq, nil, cx) else cb(nil, {code=problem}, cx) end
    end)
end
return M
