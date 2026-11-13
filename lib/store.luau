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

local projectKeys = {schemaVersion = true, projectId = true, root = true, name = true, revision = true,
    nextNumber = true, createdAt = true}
local requirementKeys = {schemaVersion = true, requirementId = true, projectId = true, number = true,
    revision = true, title = true, type = true, priority = true, stage = true, goal = true, scope = true,
    acceptanceCriteria = true, labels = true, createdAt = true, updatedAt = true, blockedFrom = true,
    blockedReason = true, extensions = true}

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
    if type(value) ~= "table" or value.schemaVersion ~= M.schemaVersion then return nil, "需求 schema 不匹配" end
    local ok, problem = keys(value, requirementKeys)
    if not ok then return nil, problem end
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
    local value = {schemaVersion = M.schemaVersion, requirementId = fields.id, projectId = project.projectId,
        number = M.displayNumber(project.nextNumber), revision = 1, title = fields.title, type = fields.type,
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
  if ($cur -isnot [System.Management.Automation.PSCustomObject] -or
    $cur.schemaVersion -ne 1 -or ($cur.revision -isnot [int] -and $cur.revision -isnot [long]) -or
    [long]$cur.revision -lt 1) { exit 4 }
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
    local encoded, payload = pcall(tern.json.encode, value)
    if not encoded then if cb then cb(false, "encode_failed"); return end; error(payload) end
    if #payload > M.maxJson then if cb then cb(false, "record_too_large"); return end; error("记录超过大小上限") end
    local temp = file .. ".tmp-" .. M.newId("w", tern.now())
    local wrote, writeError = pcall(tern.fs.write, temp, payload)
    if not wrote then if cb then cb(false, "temp_write_failed:" .. tostring(writeError)); return end; return nil, writeError end
    local env = {OMPWB_TARGET = file, OMPWB_TEMP = temp, OMPWB_LOCK = paths.lock,
        OMPWB_GATE = paths.lock .. ".gate", OMPWB_LOCK_TEMP = paths.lock .. ".tmp-" .. M.newId("l", tern.now()),
        OMPWB_TOKEN = token, OMPWB_EXPECT = tostring(expectedRevision)}
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
        OMPWB_TOKEN = token, OMPWB_EXPECT = tostring(expectedRevision)}
    local spawned, errorValue = pcall(M.runProcess, env, function(status, stderr, timedOut, cx)
        if status == 0 then cb(true, nil, cx)
        else cb(false, timedOut and "timeout" or reasons[status] or ("write_failed:" .. tostring(stderr or ""):sub(1, 300)), cx) end
    end)
    if not spawned then cb(false, "process_failed:" .. tostring(errorValue)); pcall(tern.fs.remove, temp) end
end
function M.putRecord(paths, file, value, expectedRevision, token, cb)
    local prefix = paths.requirements .. "\\"
    local id = type(file) == "string" and file:sub(1,#prefix)==prefix and file:sub(#prefix + 1):match("^([%w_%-]+)\\workflow%.json$")
    local allowed={schemaVersion=true,projectId=true,requirementId=true,revision=true,latestVersion=true,designs=true,
        comments=true,approvals=true,approval=true,requests=true}
    local valid=type(value)=="table" and value.requirementId==id and M.token(value.projectId)
        and value.schemaVersion==1 and integer(value.revision,1) and integer(value.latestVersion,0)
        and type(value.designs)=="table" and #value.designs==value.latestVersion
        and type(value.comments)=="table" and type(value.approvals)=="table" and type(value.requests)=="table"
    if valid then for key in value do if not allowed[key] then valid=false;break end end end
    if not M.token(token) or not id or not valid or not integer(expectedRevision,0) or value.revision~=expectedRevision+1 then
        cb(false,"invalid_path_or_record");return
    end
    casPublish(paths, file, value, expectedRevision, token, cb)
end
-- Plan, result and immutable verification records share the same requirement scope
-- and gate. Evidence is create-only; mutable summaries require the exact prior revision.
function M.putScoped(paths, file, value, expectedRevision, token, cb)
    local prefix = paths.requirements .. "\\"
    local relative = type(file) == "string" and file:sub(1, #prefix) == prefix and file:sub(#prefix + 1)
    local id = relative and (relative:match("^([%w_%-]+)\\plan%.json$") or relative:match("^([%w_%-]+)\\results%.json$")
        or relative:match("^([%w_%-]+)\\reviews%.json$") or relative:match("^([%w_%-]+)\\resources%.json$"))
    local evidenceId = relative and relative:match("^([%w_%-]+)\\evidence\\verification%-[%w_%-]+%.json$")
    local requirementId = id or evidenceId
    local valid = type(value) == "table" and requirementId and value.requirementId == requirementId
        and M.token(value.projectId) and value.schemaVersion == 1 and integer(value.revision, 1)
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
        or value.schemaVersion ~= 1 or type(value.body) ~= "string" or #value.body>16384
        or type(value.sha256)~="string" or #value.sha256~=64 or not value.sha256:match("^[0-9a-f]+$")
        or type(value.requirementSha256)~="string" or #value.requirementSha256~=64
        or not value.requirementSha256:match("^[0-9a-f]+$") then
        cb(false,"invalid_path_or_record"); return
    end
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
    clarifying = {done=true},
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
return M
