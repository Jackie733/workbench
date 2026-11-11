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
    local criteria = {}
    for index, item in value.acceptanceCriteria do
        local clean = criterion(item, index)
        if not clean then return nil, "验收条件字段无效" end
        table.insert(criteria, clean)
    end
    if type(value.labels) ~= "table" or #value.labels > M.maxLabels then return nil, "标签无效或过多" end
    for _, label in value.labels do
        if not text(label, 40, true) then return nil, "标签内容无效" end
    end
    if value.blockedFrom ~= nil and not M.stages[value.blockedFrom] then return nil, "阻塞来源阶段无效" end
    if value.blockedReason ~= nil and not text(value.blockedReason, 2000, false) then return nil, "阻塞原因无效" end
    if value.extensions ~= nil and type(value.extensions) ~= "table" then return nil, "扩展字段无效" end
    return value
end

function M.newRequirement(project, fields)
    assert(M.validateProject(project), "项目记录无效")
    local criteria = {}
    for index, item in fields.criteria or {} do
        if type(item) == "string" then
            criteria[index] = {id = "C" .. index, description = item, required = true}
        else
            criteria[index] = {id = "C" .. index, description = item.description, required = item.required ~= false}
        end
    end
    local value = {schemaVersion = M.schemaVersion, requirementId = fields.id, projectId = project.projectId,
        number = M.displayNumber(project.nextNumber), revision = 1, title = fields.title, type = fields.type,
        priority = fields.priority or "normal", stage = fields.stage or "backlog", goal = fields.goal,
        scope = fields.scope or "", acceptanceCriteria = criteria, labels = fields.labels or {},
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
    local names = {}
    pcall(function() names = tern.fs.list(paths.requirements) end)
    local rows, failures = {}, {}
    for _, name in names do
        if M.token(name) then
            local path = join(join(paths.requirements, name), "requirement.json")
            local value, problem = readJson(path)
            if value then value = M.validateRequirement(value) end
            if value then table.insert(rows, value) else table.insert(failures, name .. ": " .. tostring(problem)) end
        end
    end
    return rows, failures
end

-- Atomic CAS write. The lock token is checked, the new revision is compared inside
-- PowerShell, and the payload is published with a same-directory MoveFileEx.
M.atomicScript = [==[
$ErrorActionPreference='Stop'
$target=$env:OMPWB_TARGET
$temp=$env:OMPWB_TEMP
$lock=$env:OMPWB_LOCK
$token=$env:OMPWB_TOKEN
$expect=[int]$env:OMPWB_EXPECT
$l=$null
if ([IO.File]::Exists($lock)) { try { $l=[IO.File]::ReadAllText($lock) | ConvertFrom-Json } catch { $l=$null } }
if (-not $l -or $l.token -ne $token) { exit 2 }
if ([IO.File]::Exists($target)) {
  try { $cur=[IO.File]::ReadAllText($target) | ConvertFrom-Json } catch { exit 4 }
  if ([int]$cur.revision -ne $expect) { exit 3 }
} elseif ($expect -ne 0) { exit 3 }
if (-not [IO.File]::Exists($temp)) { exit 5 }
try {
  if (-not ('Wb.MoveFile' -as [type])) {
    Add-Type -Namespace Wb -Name MoveFile -MemberDefinition '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existing, string target, int flags);'
  }
  if (-not [Wb.MoveFile]::MoveFileEx($temp, $target, 0x9)) { exit 6 }
} finally {
  if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) }
}
exit 0
]==]

local function processRun(env, cb)
    local argv = {"powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", M.atomicScript}
    if cb then
        tern.process.run(argv, {env = env, timeout_ms = 8000}, function(result)
            cb(result.status, result.stderr, result.timed_out)
        end)
    else
        local r = tern.process.run(argv, {env = env, timeout_ms = 8000})
        return r
    end
end

local reasons = {[2] = "lock_conflict", [3] = "revision_conflict", [4] = "corrupt_target", [5] = "missing_payload", [6] = "publish_failed"}

-- Test seam: the plugin never replaces this; regressions inject a fake runner.
M.runProcess = processRun

-- value must already be schema-valid; expectedRevision 0 means create.
-- cb receives (ok, reason); without cb an awaitable ProcessResult is returned.
function M.put(paths, file, value, expectedRevision, token, cb)
    local payload = tern.json.encode(value)
    if #payload > M.maxJson then error("记录超过大小上限") end
    local temp = file .. ".tmp-" .. M.newId("w", tern.now())
    tern.fs.write(temp, payload)
    local env = {OMPWB_TARGET = file, OMPWB_TEMP = temp, OMPWB_LOCK = paths.lock,
        OMPWB_TOKEN = token, OMPWB_EXPECT = tostring(expectedRevision)}
    if not cb then return M.runProcess(env, nil) end
    M.runProcess(env, function(status, stderr, timedOut)
        if status == 0 then
            cb(true)
        else
            local reason
            if timedOut then reason = "timeout"
            else reason = reasons[status] or ("write_failed:" .. tostring(stderr or ""):sub(1, 300)) end
            cb(false, reason)
        end
    end)
end

local function lockValue(paths, token, owner, now)
    return {schemaVersion = 1, token = token, owner = owner, updatedAt = now}
end
function M.renewLock(paths, token, owner, now)
    local current = readJson(paths.lock)
    if current and current.token ~= token then return false, "lock_conflict" end
    tern.fs.write(paths.lock, tern.json.encode(lockValue(paths, token, owner, now)))
    return true
end
function M.releaseLock(paths, token)
    local current = readJson(paths.lock)
    if current and current.token == token then pcall(tern.fs.remove, paths.lock) end
end

-- Callback form used by the plugin. The lock is taken first; a valid existing
-- project is returned after checking it belongs to the same root.
function M.init(paths, opts, cb)
    local function fail(reason, detail)
        cb(nil, reason, detail)
    end
    local ok, problem = pcall(function()
        tern.fs.mkdir(paths.store)
        tern.fs.mkdir(paths.requirements)
    end)
    if not ok then fail("mkdir_failed", tostring(problem)); return end
    local current = readJson(paths.lock)
    if current and current.token ~= opts.token and type(current.updatedAt) == "number"
        and opts.now - current.updatedAt < M.lockStaleMs then fail("locked", "另一窗口持有写入锁"); return end
    local wrote = pcall(tern.fs.write, paths.lock, tern.json.encode(lockValue(paths, opts.token, opts.owner, opts.now)))
    if not wrote then fail("lock_write_failed"); return end
    local check = readJson(paths.lock)
    if not check or check.token ~= opts.token then fail("lock_conflict"); return end

    local project = readJson(paths.project)
    if project then
        local valid, detail = M.validateProject(project)
        if not valid then fail("corrupt_project", detail); return end
        if project.root ~= opts.root then fail("project_root_mismatch"); return end
        cb(valid)
        return
    end
    local created = M.newProject({projectId = opts.projectId, root = opts.root, name = opts.name, now = opts.now})
    M.put(paths, paths.project, created, 0, opts.token, function(okay, reason)
        if okay then cb(created) else cb(nil, reason) end
    end)
end

return M
