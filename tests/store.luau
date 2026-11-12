--!strict
-- Real Tern/PowerShell regression. The harness passes an await helper;
-- with no argument it yields a call slice, with an awaitable it awaits it.
return function(tern, repo, tempRoot, yield)
    assert(type(yield) == "function", "需要支持无参数协作式让出的 await helper")
    yield()
    local Store = assert(loadstring(tern.fs.read(repo .. "\\lib\\store.luau", 262144)))()
    yield()
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
    check(Store.lockOwner({window = "", panel = 1}), "首窗口空 window 是合法锁身份")
    check(not Store.lockOwner({window = "  ", panel = 1}), "空白 window 仍被拒绝")
    check(not Store.lockOwner({window = "store-test", panel = 0}), "面板 ID 必须为正整数")
    check(not Store.lockOwner({window = "store-test"}), "锁 owner 必须包含面板 ID")

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

    -- Storage operations use the production PowerShell transport, awaited by the harness.
    local rawRun = Store.runProcess
    Store.runProcess = function(env, cb)
        local result, freshCx = yield(rawRun(env, nil))
        if cb then cb(result.status, result.stderr, result.timed_out, freshCx) end
        return result
    end
    local function initWith(token, now, takeover, ownerWindow)
        local projectOut, err
        Store.init(paths, {projectId = "proj-abc", root = linuxRoot, name = "测试项目", token = token,
            owner = {window = ownerWindow == nil and "store-test" or ownerWindow, panel = 1}, now = now, takeover = takeover},
            function(value, problem)
                projectOut, err = value, problem
            end)
        return projectOut, err and err.code
    end
    -- Tern 首个原生窗口的 window key 是空字符串；锁必须能读回自己写下的身份。
    local created = initWith("token-a", 1000, false, "")
    check(created ~= nil, "首次初始化创建项目")
    checkEqual(tern.json.decode(tern.fs.read(paths.lock)).owner.window, "", "首窗口锁保存空 window 身份")
    local reread = Store.readProject(paths)
    check(reread ~= nil and reread.projectId == "proj-abc", "项目可从磁盘读回")
    local again = initWith("token-a", 2000)
    check(again ~= nil and again.revision == 1, "重复初始化不提升 revision")
    local locked, lockReason = initWith("token-b", 3000)
    check(locked == nil and lockReason == "locked", "新鲜锁拒绝另一写入者")
    local stale, staleReason = initWith("token-b", 18000)
    check(stale == nil and staleReason == "takeover_required", "过期锁要求明确接管")
    local taken = initWith("token-b", 18000, true)
    check(taken ~= nil, "显式接管过期锁")
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
    local lockBytes = tern.fs.read(paths.lock)
    local invalidOwner = tern.json.decode(lockBytes)
    invalidOwner.owner = {}
    local futureLock = tern.json.decode(lockBytes)
    futureLock.schemaVersion = 2
    for _, invalidLock in {"null", tern.json.encode(invalidOwner), tern.json.encode(futureLock)} do
        tern.fs.write(paths.lock, invalidLock)
        local rejected, rejection = initWith(token, 20000, true)
        check(rejected == nil and rejection == "corrupt_lock", "未知或损坏锁不能通过接管被覆盖")
        check(tern.fs.read(paths.lock) == invalidLock, "拒绝认领后锁原文保持不变")
    end
    tern.fs.write(paths.lock, lockBytes)
    local projectBytes = tern.fs.read(paths.project)
    tern.fs.write(paths.project, '{"revision":0}')
    local refusedCreate, createConflict = put(bumped, 0)
    check(refusedCreate == false and createConflict == "revision_conflict", "创建不能覆盖已存在的无效版本记录")
    check(tern.fs.read(paths.project) == '{"revision":0}', "拒绝创建后保留无效目标原文")
    tern.fs.write(paths.project, projectBytes)
    yield()
    local requirementPath = paths.requirements .. "\\req-1\\requirement.json"
    tern.fs.mkdir(paths.requirements .. "\\req-1")
    local wrote, writeReason
    Store.put(paths, requirementPath, requirement, 0, token, function(ok, reason) wrote, writeReason = ok, reason end)
    check(wrote == true, "创建需求文件: " .. tostring(writeReason))
    local rows, problems = Store.readRequirements(paths)
    checkEqual(#rows, 1, "列出需求")
    checkEqual(#problems, 0, "无损坏需求")
    local createDone, createdReq, createdProject, createError = false
    Store.create(paths, Store.readProject(paths), {id = "req-real", title = "真实创建", type = "feature",
        goal = "保存唯一编号", now = 22000}, token, function(req, updatedProject, err)
        createdReq, createdProject, createError, createDone = req, updatedProject, err, true
    end)
    check(createDone and createdReq ~= nil, "真实 create 保存需求")
    check(createdReq and createdReq.stage == "backlog" and createdReq.number ~= nil, "create 固定 backlog 并分配编号")
    local repeatedDone, repeated
    Store.create(paths, Store.readProject(paths), {id = "req-real", title = "真实创建", type = "feature",
        goal = "保存唯一编号", now = 22001}, token, function(req) repeated, repeatedDone = req, true end)
    check(repeatedDone, "稳定 ID 重试完成")
    check(repeated and repeated.number == createdReq.number, "相同 requirementId 重试不产生重复编号")
    local changedRetryDone, changedRetryError
    Store.create(paths, Store.readProject(paths), {id = "req-real", title = "不同草稿", type = "feature",
        goal = "保存唯一编号", now = 22002}, token, function(_, _, err)
        changedRetryError, changedRetryDone = err, true
    end)
    check(changedRetryDone and changedRetryError.code == "requirement_id_conflict",
        "相同 ID 的不一致重试保留现有数据并返回冲突")
    local editDone, edited, editError = false
    local changed = {}
    for key, value in createdReq do changed[key] = value end
    changed.title, changed.stage = "更新标题", "done"
    Store.update(paths, changed, createdReq.revision, token, function(req, err)
        edited, editError, editDone = req, err, true
    end)
    check(editDone and edited ~= nil, "真实 update 保存 revision CAS")
    check(edited and edited.stage == "backlog", "普通 update 不能伪造 lifecycle stage")
    local updateA, updateB, doneA, doneB
    local changeA, changeB = {}, {}
    check(edited and edited.updatedAt >= edited.createdAt and edited.updatedAt % 1 == 0,
        "更新业务时间戳为 epoch 毫秒整数")
    for key, value in edited do changeA[key], changeB[key] = value, value end
    changeA.title, changeB.title = "并发 A", "并发 B"
    Store.update(paths, changeA, edited.revision, token, function(req) updateA, doneA = req, true end)
    Store.update(paths, changeB, edited.revision, token, function(req) updateB, doneB = req, true end)
    check(doneA and doneB, "两次更新操作均返回")
    check((updateA ~= nil) ~= (updateB ~= nil), "并发同 revision 仅一个 writer 成功")
    tern.fs.mkdir(paths.requirements .. "\\bad")
    tern.fs.write(paths.requirements .. "\\bad\\requirement.json", "{")
    local _, bad = Store.readRequirements(paths)
    checkEqual(#bad, 1, "损坏需求被报告而非吞掉")
    Store.runProcess = rawRun
    local realUpdate = Store.allocate(Store.readProject(paths))
    local realResult = yield(Store.put(paths, paths.project, realUpdate, realUpdate.revision - 1, token))
    check(realResult.status == 0, "真实 PowerShell CAS 写入")
    local conflict = yield(Store.put(paths, paths.project, Store.allocate(realUpdate), realUpdate.revision - 1, token))
    check(conflict.status == 3, "真实 PowerShell CAS 拒绝并发旧 revision")
    local beforeCorrupt = tern.fs.read(paths.project, 262144)
    tern.fs.write(paths.project, "{")
    local corruptWrite = yield(Store.put(paths, paths.project, realUpdate, realUpdate.revision, token))
    check(corruptWrite.status == 4, "真实 PowerShell 拒绝损坏目标")
    check(tern.fs.read(paths.project, 262144) == "{", "损坏项目元数据保持原样")
    tern.fs.write(paths.project, beforeCorrupt)
    pcall(tern.fs.remove, tempRoot)
    return {checks = checks, failures = failures}
end
