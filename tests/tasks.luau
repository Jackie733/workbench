-- Run in the Tern Luau runtime; pass the production tasks module.
return function(Tasks)
    local checks = 0
    local function check(value, message) assert(value, message); checks += 1 end
    local p = {key = "__workbench_contract_" .. tostring(math.random(1, 2147483646))}
    local key = "tasks:" .. p.key
    local ok, err = pcall(function()
        local task = Tasks.new("task-a", "修复登录 🧭\n保留用户改动", "design")
        task.designHead = string.rep("a", 40)
        local function snapshot(id, head, body)
            return {head = task.designHead, text = "---\nworkbench_task: " .. id .. "\nworkbench_baseline: " .. head .. "\n---\n" .. body}
        end
        check(Tasks.validateDesign(snapshot(task.id, task.designHead, "# 实施方案\n保留刷新流程。"), task), "拒绝了属于本任务的有效交付")
        check(not Tasks.validateDesign(snapshot("other-task", task.designHead, "另一项任务"), task), "误接收了其他任务的方案")
        check(not Tasks.validateDesign(snapshot(task.id, string.rep("b", 40), "过期方案"), task), "误接收了错误基线")
        check(not Tasks.validateDesign(snapshot(task.id, task.designHead, " \n"), task), "仅有元数据不能成为可批准方案")
        local changed = snapshot(task.id, task.designHead, "有效正文")
        changed.head = string.rep("c", 40)
        check(not Tasks.validateDesign(changed, task), "设计期间 HEAD 改变后仍允许批准")
        local invalid = pcall(Tasks.new, "../escape", "目标", "direct")
        check(not invalid, "任务标识允许了路径穿越")
        task.phase, task.runRole, task.runMarker = "executing", "execute", "[workbench:task-a:run-1]"
        task.bindings.execute = 123
        task.plan, task.approved = "不应写入 KV 的正文", {head = task.designHead}
        Tasks.save(p, {task}, task.id)
        local stored = tern.kv.get(key)
        check(stored.tasks[1].plan == nil and stored.tasks[1].approved == nil, "持久化了正文或审批")
        local recovered = Tasks.load(p).tasks[1]
        check(recovered.phase == "attention" and recovered.bindings.execute == 123 and recovered.runMarker == task.runMarker,
            "恢复运行任务时丢失身份或误判为已完成")
        tern.kv.set(key, {schema = 999, sentinel = "keep"})
        check(not pcall(Tasks.load, p) and tern.kv.get(key).sentinel == "keep", "损坏存储被静默覆盖")
    end)
    tern.kv.set(key, nil)
    if not ok then error(err) end
    return {passed = checks}
end
