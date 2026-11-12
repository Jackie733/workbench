--!strict
-- Real Tern/PowerShell concurrency; waitOne accepts nil to yield, waitAll=await_all.
-- Callback delivery is adapted; the production writer and filesystem are not mocked.
return function(tern, repo, tempRoot, waitOne, waitAll)
    waitOne()
    local Store = assert(loadstring(tern.fs.read(repo .. "\\lib\\store.luau", 262144)))()
    waitOne()
    local checks, failures = 0, tern.json.array()
    local function check(condition, message)
        checks += 1
        if not condition then table.insert(failures, message) end
    end
    local function result() return {checks = checks, failures = failures} end
    tern.fs.mkdir(tempRoot)
    local linuxRoot = "/tmp/" .. assert(tempRoot:match("[^\\]+$"))
    local paths = assert(Store.paths({host = "wsl.localhost", distro = "Ubuntu"}, linuxRoot))
    local transport = Store.runProcess
    local function synchronous(env, callback)
        local r = waitOne(transport(env))
        if callback then callback(r.status, r.stderr, r.timed_out, nil) end
        return r
    end
    Store.runProcess = synchronous
    local project, initError
    local function options(token, panel)
        return {projectId = "concurrency-project", root = linuxRoot, name = "并发验证",
            token = token, owner = {window = "concurrency", panel = panel}, now = os.time() * 1000}
    end
    Store.init(paths, options("initial-owner", 1), function(value, err) project, initError = value, err end)
    check(project ~= nil, "初始化真实项目: " .. tostring(initError and initError.code))
    if not project then return result() end
    local requirement, createError
    Store.create(paths, project, {id = "concurrent-requirement", title = "原始内容", type = "feature",
        goal = "并发保存不能覆盖更新", now = os.time() * 1000}, "initial-owner", function(value, updated, err)
            requirement, project, createError = value, updated, err
        end)
    check(requirement ~= nil, "创建真实需求: " .. tostring(createError and createError.code))
    if not requirement then return result() end

    local pending = {}
    local function defer(env, callback)
        table.insert(pending, {future = transport(env), callback = callback})
    end
    local function deliver()
        local futures = {}
        for _, operation in pending do table.insert(futures, operation.future) end
        local results = waitAll(futures)
        local deliveries = pending
        pending = {}
        for index, operation in deliveries do
            local r = results[index]
            operation.callback(r.status, r.stderr, r.timed_out, nil)
        end
    end
    Store.runProcess = defer
    local winners, errors = {}, {}
    for index, title in {"并发甲", "并发乙"} do
        local edited = table.clone(requirement)
        edited.title = title
        Store.update(paths, edited, requirement.revision, "initial-owner", function(value, err)
            winners[index], errors[index] = value, err
        end)
    end
    deliver()
    check((winners[1] ~= nil) ~= (winners[2] ~= nil), "同 revision 的同时保存只有一个成功")
    local winnerIndex = winners[1] and 1 or 2
    local loserIndex = winnerIndex == 1 and 2 or 1
    check(errors[loserIndex] and errors[loserIndex].code == "revision_conflict", "失败者明确收到版本冲突")
    local stored = tern.json.decode(tern.fs.read(paths.requirements .. "\\" .. requirement.requirementId .. "\\requirement.json"))
    check(winners[winnerIndex] and stored.title == winners[winnerIndex].title
        and stored.revision == requirement.revision + 1, "落盘内容与唯一成功的保存一致")
    check(stored.updatedAt >= requirement.updatedAt and stored.updatedAt >= 1700000000000,
        "保存时间为 Unix 毫秒，不使用进程单调时钟")
    local leftovers = 0
    for _, name in tern.fs.list(paths.requirements .. "\\" .. requirement.requirementId) do
        if name:find(".tmp-", 1, true) then leftovers += 1 end
    end
    check(leftovers == 0, "冲突后不遗留明文临时需求文件")

    Store.runProcess = synchronous
    local released
    Store.releaseLock(paths, "initial-owner", function(ok) released = ok end)
    check(released == true, "释放原写入者")
    Store.runProcess = defer
    local owners, claimErrors = {}, {}
    for index, token in {"owner-a", "owner-b"} do
        Store.init(paths, options(token, index + 1), function(value, err) owners[index], claimErrors[index] = value, err end)
    end
    deliver()
    check((owners[1] ~= nil) ~= (owners[2] ~= nil), "两个窗口同时认领时只有一个写入者")
    local ownerIndex = owners[1] and 1 or 2
    local deniedIndex = ownerIndex == 1 and 2 or 1
    check(claimErrors[deniedIndex] and claimErrors[deniedIndex].code == "locked", "竞争失败的窗口明确只读")
    local lock = tern.json.decode(tern.fs.read(paths.lock))
    local ownerToken = ownerIndex == 1 and "owner-a" or "owner-b"
    check(lock.token == ownerToken, "锁归属与唯一成功的认领一致")
    Store.runProcess = synchronous
    local deniedSave, deniedError
    local edited = table.clone(stored)
    edited.title = "不应覆盖"
    Store.update(paths, edited, stored.revision, deniedIndex == 1 and "owner-a" or "owner-b",
        function(value, err) deniedSave, deniedError = value, err end)
    check(deniedSave == nil and deniedError and deniedError.code == "lock_conflict", "失去写入权的窗口无法保存")
    local unchanged = tern.json.decode(tern.fs.read(paths.requirements .. "\\" .. requirement.requirementId .. "\\requirement.json"))
    check(unchanged.title == stored.title and unchanged.revision == stored.revision, "被拒绝的保存保持原内容及版本")
    Store.releaseLock(paths, ownerToken)
    return result()
end
