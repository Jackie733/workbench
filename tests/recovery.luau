--!strict
-- Reproduce loss of a host callback after its real project CAS committed.
-- The real production PowerShell transport runs; only callback delivery is cancelled.
return function(tern, repo, tempRoot, waitOne)
    waitOne()
    local Store = assert(loadstring(tern.fs.read(repo .. "\\lib\\store.luau", 262144)))()
    waitOne()
    local checks, failures = 0, tern.json.array()
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function report() return {checks = checks, failures = failures} end
    local root = "/tmp/" .. assert(tempRoot:match("[^\\]+$"))
    tern.fs.mkdir(tempRoot)
    local paths = assert(Store.paths({host = "wsl.localhost", distro = "Ubuntu"}, root))
    local transport = Store.runProcess
    local cancelAllocationCallback = false
    Store.runProcess = function(env, callback)
        local r = waitOne(transport(env))
        if env.OMPWB_TARGET == paths.project and cancelAllocationCallback and r.status == 0 then
            cancelAllocationCallback = false
            return r
        end
        if callback then callback(r.status, r.stderr, r.timed_out, nil) end
        return r
    end
    local project, initError
    Store.init(paths, {projectId = "recovery-project", root = root, name = "中断恢复",
        token = "recovery-owner", owner = {window = "recovery", panel = 1}, now = os.time() * 1000},
        function(value, err) project, initError = value, err end)
    check(project ~= nil, "初始化恢复项目: " .. tostring(initError and initError.code))
    if not project then return report() end
    local baseline
    Store.create(paths, project, {id = "existing-requirement", title = "已有需求", type = "feature",
        goal = "中断其他保存不能破坏此需求", now = os.time() * 1000}, "recovery-owner",
        function(value, updated) baseline, project = value, updated end)
    check(baseline ~= nil, "创建已有需求基线")
    if not baseline then return report() end
    local before = project.nextNumber
    local fields = {id = "interrupted-requirement", title = "中文中断需求 🧭", type = "bug",
        goal = "中断后正式需求列表仍可读，显式重试不会产生副本", now = os.time() * 1000}
    cancelAllocationCallback = true
    Store.create(paths, project, fields, "recovery-owner", function() end)
    local reserved = Store.readProject(paths)
    check(reserved and reserved.nextNumber == before + 1, "取消回调发生在真实编号分配落盘之后")
    local rows, issues = Store.readRequirements(paths)
    check(#issues == 0, "中断不会留下损坏或空的正式需求目录")
    check(#rows == 1 and rows[1].requirementId == baseline.requirementId
        and rows[1].title == baseline.title and rows[1].revision == baseline.revision,
        "已有需求内容及修订不受中断影响")
    local retried, retryError
    Store.create(paths, reserved, fields, "recovery-owner", function(value, updated, err)
        retried, project, retryError = value, updated, err
    end)
    check(retried ~= nil, "显式重试恢复创建: " .. tostring(retryError and retryError.code))
    if not retried then return report() end
    check(retried.requirementId == fields.id and retried.number == Store.displayNumber(before + 1),
        "保留稳定身份，跳过已消耗编号而非复用")
    local repeated
    Store.create(paths, project, fields, "recovery-owner", function(value) repeated = value end)
    check(repeated and repeated.number == retried.number and Store.readProject(paths).nextNumber == project.nextNumber,
        "再次重试已落盘的同一需求不分配新编号")
    rows, issues = Store.readRequirements(paths)
    check(#issues == 0 and #rows == 2, "恢复后只有已有需求与新需求，没有副本或损坏项")
    Store.releaseLock(paths, "recovery-owner")
    return report()
end
