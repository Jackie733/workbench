--!strict
-- Phase 2 storage regression. Runs inside Tern's Luau VM (Carly lua):
--   return tern.json.encode(run(tern, repoUnc, tempUnc))
-- The fake process implements the same contract as the PowerShell CAS script so
-- this covers the production Lua boundary; the real script is smoke-tested once
-- through M.put without a callback.
return function(tern, repo, tempRoot, yield)
    yield = yield or function() end
    local Store = assert(loadstring(tern.fs.read(repo .. "\\lib\\store.luau", 262144)))()
    local failures, checks = {}, 0
    local function check(condition, message)
        checks = checks + 1
        if not condition then table.insert(failures, message) end
    end
    local function checkEqual(actual, expected, message)
        check(actual == expected, message .. " (got " .. tostring(actual) .. ", want " .. tostring(expected) .. ")")
    end
    local function checkError(call, message)
        local ok = pcall(call)
        check(not ok, message)
    end

    tern.fs.mkdir(tempRoot)
    local loc = {host = "wsl.localhost", distro = "Ubuntu"}
    local linuxRoot = "/tmp/" .. (tempRoot:match("[^\\]+$") or "wb-store-test")
    local paths, pathError = Store.paths(loc, linuxRoot)
    check(paths ~= nil, "paths 应接受本机 WSL 项目: " .. tostring(pathError))
    if not paths then return {checks = checks, failures = failures} end
    checkEqual(paths.store:gsub("\\", "/"), ("//wsl.localhost/Ubuntu/tmp/%s/.omp/workbench"):format(linuxRoot:match("[^/]+$")), "workbench 目录")
    check(Store.paths({host = "example.com", distro = "Ubuntu"}, "/home/a") == nil, "拒绝远程 host")
    check(Store.paths(loc, "relative") == nil, "拒绝相对路径")
    check(Store.paths(loc, "/home/a\\b") == nil, "拒绝含反斜杠的 Linux 路径")

    -- Schema and numbering, independent of I/O.
    local project = Store.newProject({projectId = "proj-abc", root = linuxRoot, name = "测试项目", now = 1000})
    check(Store.validateProject(project) ~= nil, "合法项目通过校验")
    local extra = {schemaVersion = 1}
    for key, value in project do extra[key] = value end
    extra.unknown = true
    check(Store.validateProject(extra) == nil, "拒绝未知项目字段")
    local allocated = Store.allocate(project)
    checkEqual(allocated.revision, 2, "分配编号提升项目 revision")
    checkEqual(allocated.nextNumber, 2, "分配编号提升 nextNumber")
    checkEqual(project.nextNumber, 1, "分配编号不修改旧项目")

    local requirement = Store.newRequirement(project, {id = "req-1", title = "登录过期修复", type = "bug",
        priority = "high", goal = "过期时显示入口", criteria = {"C1 显示入口", "C2 有效会话不受影响"}, labels = {"auth"}, now = 3000})
    checkEqual(requirement.number, "REQ-0001", "首个需求编号")
    checkEqual(requirement.acceptanceCriteria[2].id, "C2", "验收条件获得稳定 ID")
    check(Store.validateRequirement(requirement) ~= nil, "合法需求通过校验")
    for key, variant in pairs({stage = "weird", type = "task", priority = "bogus"}) do
        local copy = {}
        for k, v in requirement do copy[k] = v end
        copy[key] = variant
        check(Store.validateRequirement(copy) == nil, "拒绝非法字段 " .. key)
    end
    local tooMany = {}
    for index = 1, Store.maxCriteria + 1 do tooMany[index] = "C" .. index end
    checkError(function()
        Store.newRequirement(project, {id = "req-2", title = "t", type = "feature", goal = "g", criteria = tooMany, now = 3000})
    end, "拒绝过多验收条件")
    checkError(function()
        Store.newRequirement(project, {id = "req-3", title = "t", type = "feature", goal = string.rep("x", Store.maxGoal + 1), now = 3000})
    end, "拒绝超长目标")
    yield()

    -- Init, lock freshness and takeover.
    local realRunProcess = Store.runProcess
    Store.runProcess = function(env, cb)
        local function finish(code, detail)
            cb(code, detail or "", false)
        end
        local lockRead, lock = pcall(function() return tern.json.decode(tern.fs.read(env.OMPWB_LOCK, 16384)) end)
        if not lockRead or type(lock) ~= "table" or lock.token ~= env.OMPWB_TOKEN then return finish(2, "lock") end
        local expect = tonumber(env.OMPWB_EXPECT)
        if tern.fs.exists(env.OMPWB_TARGET) then
            local read, current = pcall(function() return tern.json.decode(tern.fs.read(env.OMPWB_TARGET, 262144)) end)
            if not read or type(current) ~= "table" then return finish(4, "corrupt") end
            if current.revision ~= expect then return finish(3, "revision") end
        elseif expect ~= 0 then
            return finish(3, "revision")
        end
        local payload = tern.fs.read(env.OMPWB_TEMP, 262144)
        tern.fs.write(env.OMPWB_TARGET, payload)
        pcall(tern.fs.remove, env.OMPWB_TEMP)
        return finish(0)
    end
    local function initWith(token, now)
        local projectOut, reason
        Store.init(paths, {projectId = "proj-abc", root = linuxRoot, name = "测试项目", token = token,
            owner = {window = "", panel = 1}, now = now}, function(value, problem)
            projectOut, reason = value, problem
        end)
        return projectOut, reason
    end
    local created = initWith("token-a", 1000)
    check(created ~= nil, "首次初始化创建项目")
    local reread = Store.readProject(paths)
    check(reread ~= nil and reread.projectId == "proj-abc", "项目可从磁盘读回")
    local again = initWith("token-a", 2000)
    check(again ~= nil and again.revision == 1, "重复初始化不提升 revision")
    local locked, lockReason = initWith("token-b", 3000)
    check(locked == nil and lockReason == "locked", "新鲜锁拒绝另一写入者")
    local taken = initWith("token-b", 18000)
    check(taken ~= nil, "过期锁可被接管")
    yield()
    tern.fs.write(paths.project, tern.json.encode({schemaVersion = 1, projectId = "proj-abc", root = "/other",
        name = "x", revision = 1, nextNumber = 1, createdAt = 1000}))
    local mismatch, mismatchReason = initWith("token-b", 19000)
    check(mismatch == nil and mismatchReason == "project_root_mismatch", "拒绝根目录不匹配的项目")

    -- CAS: every write compares the stored revision inside the writer.
    local token = "token-b"
    local function put(value, expect)
        local ok, reason
        Store.put(paths, paths.project, value, expect, token, function(passed, problem) ok, reason = passed, problem end)
        return ok, reason
    end
    local bumped = Store.allocate(Store.newProject({projectId = "proj-abc", root = linuxRoot, name = "测试项目", now = 1000}))
    check(put(bumped, 1) == true, "CAS 以旧 revision 更新")
    check(Store.readProject(paths).revision == 2, "更新后的 revision 落盘")
    checkEqual(select(2, put(Store.allocate(bumped), 1)), "revision_conflict", "旧 revision 被拒绝")
    local staleToken
    Store.put(paths, paths.project, bumped, 2, "token-c", function(ok, reason) staleToken = reason end)
    checkEqual(staleToken, "lock_conflict", "错误锁 token 被拒绝")
    yield()
    local requirementPath = paths.requirements .. "\\req-1\\requirement.json"
    tern.fs.mkdir(paths.requirements .. "\\req-1")
    local wrote, writeReason
    Store.put(paths, requirementPath, requirement, 0, token, function(ok, reason) wrote, writeReason = ok, reason end)
    check(wrote == true, "创建需求文件: " .. tostring(writeReason))
    local rows, problems = Store.readRequirements(paths)
    checkEqual(#rows, 1, "列出需求")
    checkEqual(#problems, 0, "无损坏需求")
    tern.fs.mkdir(paths.requirements .. "\\bad")
    tern.fs.write(paths.requirements .. "\\bad\\requirement.json", "{")
    local _, bad = Store.readRequirements(paths)
    checkEqual(#bad, 1, "损坏需求被报告而非吞掉")
    tern.fs.write(paths.project, "{")
    local corrupt
    Store.put(paths, paths.project, bumped, 2, token, function(ok, reason) corrupt = reason end)
    checkEqual(corrupt, "corrupt_target", "损坏目标被拒绝")

    Store.runProcess = realRunProcess
    pcall(tern.fs.remove, tempRoot)
    return {checks = checks, failures = failures}
end
