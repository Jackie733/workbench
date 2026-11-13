--!strict
-- Native acceptance: real Tern FS + PowerShell CAS; only callback delivery is
-- deliberately dropped. Caller advances one phase per Carly lua invocation.
return function(native, repo, tempRoot, oldSource, waitOne)
    local fs = {}
    for _, name in {"read", "write", "list", "exists", "mkdir", "remove"} do
        fs[name] = function(...)
            local value = native.fs[name](...)
            waitOne()
            return value
        end
    end
    local tern = setmetatable({fs=fs}, {__index=native})
    local Store = assert(loadstring("local tern=...\n" .. fs.read(repo .. "\\lib\\store.luau", 262144)))(tern)
    local Old = assert(loadstring("local tern=...\n" .. oldSource))(tern)
    local root = "/tmp/" .. assert(tempRoot:match("[^\\]+$"))
    local paths = assert(Store.paths({host="wsl.localhost", distro="Ubuntu"}, root))
    local file = paths.requirements .. "\\req-native\\requirement.json"
    local transport, drop = Store.runProcess, false
    Store.runProcess = function(env, cb)
        local result = waitOne(transport(env))
        if drop and env.OMPWB_TARGET == file and result.status == 0 then drop=false; return end
        if cb then cb(result.status, result.stderr, result.timed_out) end
    end
    local checks, failures, phase = 0, native.json.array(), 0
    local req, project, legacyBytes, savedBytes
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function disk()
        local rows, problems = Store.readRequirements(paths)
        assert(#problems == 0, table.concat(problems, "; "))
        for _, row in rows do if row.requirementId == "req-native" then return row end end
        error("missing requirement")
    end
    local function move(action)
        local updated, problem
        Store.lifecycle(paths, req, action, "人工原因：接口依赖 🧭", req.revision, "native-owner",
            function(value, err) updated, problem=value, err end)
        check(updated ~= nil and problem == nil, action .. " publishes through real CAS")
        if updated then req=updated end
    end
    return function()
        phase += 1
        if phase == 1 then
            fs.mkdir(tempRoot)
            Store.init(paths, {projectId="native-project", root=root, name="原生生命周期验收", token="native-owner",
                owner={window="native-acceptance",panel=1}, now=os.time()*1000},
                function(value, err) project=value; assert(value, err and err.code) end)
            Store.create(paths, project, {id="req-native",title="旧需求",type="feature",goal="保留历史",
                criteria={"可核对"},now=os.time()*1000}, "native-owner",
                function(value, updated, err) req,project=value,updated;assert(value,err and err.code) end)
            req.schemaVersion, req.contentRevision, req.lifecycleEvents = 1, nil, nil
            req.revision = 7
            fs.write(file, native.json.encode(req)) -- explicit legacy fixture, not product migration
            legacyBytes = fs.read(file)
            check(Old.validateRequirement(native.json.decode(legacyBytes)) ~= nil, "old reader accepts legacy fixture")
            check(disk().schemaVersion == 1, "new reader preserves legacy record without eager write")
        elseif phase == 2 then
            local callback = false
            drop = true
            Store.lifecycle(paths, req, "block", "等待接口，保留中文原因", req.revision, "native-owner",
                function() callback=true end)
            check(not callback and not drop, "callback lost only after successful native CAS")
            local committed = disk()
            check(committed.schemaVersion == 2 and committed.stage == "blocked" and committed.contentRevision == 7
                and committed.revision == 8 and #committed.lifecycleEvents == 1, "re-read recovers committed upgrade and single event")
            local staleError
            Store.lifecycle(paths, req, "block", "不得重复", req.revision, "native-owner",
                function(_, err) staleError=err end)
            check(staleError and staleError.code == "revision_conflict", "stale replay rejected instead of duplicating event")
            check(#disk().lifecycleEvents == 1, "replay leaves history unchanged")
            req=committed
        elseif phase == 3 then
            move("unblock")
            check(req.stage == "backlog" and req.contentRevision == 7 and #req.lifecycleEvents == 2,
                "unblock returns to original stage without changing content identity")
            check(req.lifecycleEvents[2].previousBlockedReason == "等待接口，保留中文原因", "prior block reason retained")
        elseif phase == 4 then
            move("cancel")
            check(req.stage == "cancelled" and req.contentRevision == 7, "cancel preserves identity and records intent, not process termination")
        elseif phase == 5 then
            move("reopen")
            check(req.stage == "clarifying" and req.revision == 11 and req.contentRevision == 7
                and #req.lifecycleEvents == 4, "reopen preserves complete lifecycle chain")
            savedBytes=fs.read(file)
        elseif phase == 6 then
            local unknown = native.json.decode(savedBytes)
            unknown.schemaVersion=3
            local raw=native.json.encode(unknown)
            fs.write(file, raw)
            local _, problems=Store.readRequirements(paths)
            check(#problems > 0, "unknown schema reported, not replaced by empty data")
            local err
            Store.lifecycle(paths, req, "cancel", "拒绝未知数据", req.revision, "native-owner",
                function(_, problem) err=problem end)
            check(err ~= nil and fs.read(file) == raw, "unknown schema write rejected without changing bytes")
            fs.write(file, savedBytes)
        elseif phase == 7 then
            Store.create(paths, project, {id="req-second",title="第二项需求",type="chore",goal="混合版本读取",now=os.time()*1000},
                "native-owner", function(value, updated, err) project=updated;assert(value,err and err.code) end)
            fs.write(file, legacyBytes)
            local rows, problems=Store.readRequirements(paths)
            check(#rows == 2 and #problems == 0, "mixed v1/v2 project readable without resetting either entity")
            check(fs.read(file) == legacyBytes, "mixed-version scan is read-only")
            fs.write(file, savedBytes)
            check(Old.validateRequirement(native.json.decode(savedBytes)) == nil, "pre-R4b reader rejects v2 requirement")
            local _, oldProblems=Old.readRequirements(paths)
            check(#oldProblems > 0 and fs.read(file) == savedBytes, "old project reader reports incompatibility without rewriting data")
            Store.releaseLock(paths, "native-owner", function(ok) check(ok, "native lock released") end)
            fs.write(tempRoot .. "\\result.json", native.json.encode({checks=checks,failures=failures,phase=phase}))
        end
        return {checks=checks,failures=failures,phase=phase,done=phase>=7}
    end
end
