--!strict
-- Serial batch scheduler regression: freezing, stop-on-first-failure, time limit,
-- cancellation and no automatic continuation past a stop.
local Batch = require("../lib/batch")

return function()
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function equal(actual, expected, message)
        check(actual == expected, message .. " (got " .. tostring(actual) .. ", want " .. tostring(expected) .. ")")
    end

    local entries = {}
    equal(Batch.add(entries, "npm run test", {"C1"}, 1) ~= nil, true, "合法命令可加入")
    equal(Batch.add(entries, "", {"C1"}, 2), nil, "空命令被拒绝")
    equal(Batch.add(entries, "bad\1command", {}, 2), nil, "控制字符被拒绝")
    Batch.add(entries, "npm run lint", {"C2", "C3"}, 3)
    equal(#entries, 2, "两条命令")
    for index = 1, Batch.MAX_ENTRIES do Batch.add(entries, "cmd " .. tostring(index), {}, 4) end
    equal(#entries, Batch.MAX_ENTRIES, "批量上限生效")

    local frozen, error = Batch.freeze(entries, 1000)
    check(frozen ~= nil, "冻结成功 " .. tostring(error))
    equal(#frozen.entries, Batch.MAX_ENTRIES, "冻结保留全部条目")
    equal(frozen.entries[1].command, "npm run test", "冻结保留顺序")
    entries[1].command = "mutated"
    equal(frozen.entries[1].command, "npm run test", "冻结后修改草稿不影响运行副本")
    equal(frozen.entries[1].criterionIds[1], "C1", "冻结保留条件")

    equal(Batch.freeze({}, 0), nil, "空批量不能开始")
    local tooMany = {}
    for index = 1, Batch.MAX_ENTRIES + 1 do table.insert(tooMany, {command = "cmd " .. tostring(index), criterionIds = {}}) end
    equal(Batch.freeze(tooMany, 0), nil, "超限批量不能开始")

    local batch = assert(Batch.freeze({{command = "a", criterionIds = {"C1"}}, {command = "b", criterionIds = {}}}, 0))
    equal(Batch.current(batch).command, "a", "当前是第一项")
    local decision = Batch.advance(batch, {result = "passed", elapsedMs = 10, codeChanged = false})
    equal(decision.action, "next", "通过后继续")
    equal(decision.entry.command, "b", "继续到第二项")
    equal(batch.index, 2, "索引前进")
    decision = Batch.advance(batch, {result = "passed", elapsedMs = 20, codeChanged = false})
    equal(decision.action, "stop", "最后一项通过后结束")
    equal(decision.reason, "completed", "完成原因")
    equal(batch.state, "completed", "批量完成")
    equal(Batch.remaining(batch), 0, "完成后无剩余")

    for _, result in {"failed", "unknown"} do
        local halted = assert(Batch.freeze({{command = "a", criterionIds = {}}, {command = "b", criterionIds = {}}}, 0))
        local haltedDecision = Batch.advance(halted, {result = result, elapsedMs = 5, codeChanged = false})
        equal(haltedDecision.action, "stop", result .. " 停止调度")
        equal(halted.stopReason, "not_passed", result .. " 停止原因")
        equal(Batch.remaining(halted), 1, result .. " 保留未运行条目计数")
        equal(Batch.current(halted), nil, result .. " 停止后没有当前命令")
    end

    local changed = assert(Batch.freeze({{command = "a", criterionIds = {}}, {command = "b", criterionIds = {}}}, 0))
    equal(Batch.advance(changed, {result = "passed", elapsedMs = 5, codeChanged = true}).reason, "code_changed",
        "代码变化停止批量")

    local slow = assert(Batch.freeze({{command = "a", criterionIds = {}}, {command = "b", criterionIds = {}}}, 0))
    equal(Batch.advance(slow, {result = "passed", elapsedMs = Batch.MAX_TOTAL_MS + 1, codeChanged = false}).reason,
        "time_limit", "总时长上限停止批量")

    local cancelled = assert(Batch.freeze({{command = "a", criterionIds = {}}, {command = "b", criterionIds = {}}}, 0))
    equal(Batch.requestStop(cancelled), true, "运行中可请求停止")
    equal(Batch.advance(cancelled, {result = "passed", elapsedMs = 5, codeChanged = false}).reason, "cancelled",
        "停止请求在命令结束后生效")
    equal(Batch.requestStop(cancelled), false, "已停止的批量不能再次请求")

    local removable = {}
    Batch.add(removable, "a", {}, 0); Batch.add(removable, "b", {}, 0)
    equal(Batch.remove(removable, 1), true, "可移除条目")
    equal(#removable, 1, "移除后只剩一条")
    equal(Batch.remove(removable, 5), false, "越界移除被拒绝")

    for _, item in failures do print("FAIL " .. item) end
    return {checks = checks, failures = failures}
end
