--!strict
local text = require("./text")
local M = {}
local phases = {draft = true, designing = true, design_ready = true, executing = true, attention = true, review = true, done = true}
local fields = {"id", "title", "goal", "strategy", "phase", "designPath", "head", "designHead", "message", "error", "runRole", "runMarker", "outcome", "legacy"}

-- Constructors/load raise on malformed state. Artifact validation returns false, reason.
function M.new(id, goal, strategy)
    assert(type(id) == "string" and #id <= 96 and id:match("^[%w%-_]+$"), "任务标识无效")
    assert(type(goal) == "string" and goal:match("%S") and #goal <= 4000 and utf8.len(goal), "请填写任务，最多 4000 字节")
    assert(strategy == "design" or strategy == "direct", "任务策略无效")
    return {id = id, title = text.clip(goal:match("[^\r\n]+") or goal, 66), goal = goal,
        strategy = strategy, phase = "draft", bindings = {}, designPath = ".omp/workbench/tasks/" .. id .. "/design.md"}
end

local function clean(t)
    local result = M.new(t.id, t.goal, t.strategy)
    assert(phases[t.phase], "保存的任务阶段无效")
    for _, key in fields do
        local value = t[key]
        if value ~= nil then
            if key == "legacy" then assert(type(value) == "boolean", "任务迁移标记无效")
            else assert(type(value) == "string", "任务字段无效：" .. key) end
            result[key] = value
        end
    end
    assert(type(t.bindings) == "table", "任务会话关联无效")
    for _, role in {"design", "execute"} do
        local pane = t.bindings[role]
        assert(pane == nil or (type(pane) == "number" and pane > 0 and pane % 1 == 0), "任务会话标识无效")
        result.bindings[role] = pane
    end
    assert(result.runRole == nil or result.runRole == "design" or result.runRole == "execute", "运行角色无效")
    if not result.legacy then
        assert(result.designPath == ".omp/workbench/tasks/" .. result.id .. "/design.md", "任务方案路径无效")
    end
    return result
end

function M.save(project, tasks, selected)
    local rows = tern.json.array()
    for _, task in tasks do table.insert(rows, clean(task)) end
    tern.kv.set("tasks:" .. project.key, {schema = 2, tasks = rows, selected = selected})
end

function M.load(project)
    local saved = tern.kv.get("tasks:" .. project.key)
    if saved == nil then return {tasks = {}, selected = nil} end
    assert(type(saved) == "table" and saved.schema == 2 and type(saved.tasks) == "table", "任务存储损坏；未覆盖原数据")
    local rows, ids = {}, {}
    for _, raw in saved.tasks do
        local task = clean(raw)
        assert(not ids[task.id], "任务标识重复；未覆盖原数据")
        ids[task.id] = true
        if task.phase == "designing" or task.phase == "executing" then
            task.phase = "attention"
            task.message = "会话可能仍在运行。请查看原会话或检查方案；恢复不会重发请求。"
        end
        table.insert(rows, task)
    end
    return {tasks = rows, selected = ids[saved.selected] and saved.selected or (rows[1] and rows[1].id)}
end

function M.migrate(legacy, id)
    if type(legacy.goal) ~= "string" or not legacy.goal:match("%S") then return nil end
    local task = M.new(id, legacy.goal, "design")
    task.legacy, task.designPath = true, legacy.design or legacy.designPath or ".omp/workbench/design.md"
    task.bindings = type(legacy.bindings) == "table" and legacy.bindings or {}
    task.message = "旧任务已保留。请检查已有方案；没有恢复任何审批或重发请求。"
    return clean(task)
end

function M.validateDesign(snapshot, task)
    if type(snapshot.text) ~= "string" or not snapshot.text:match("%S") then return false, "方案正文为空" end
    if task.designHead and task.designHead ~= snapshot.head then return false, "设计期间 HEAD 已变化，请重新设计或核对基线" end
    if task.legacy then return true end
    local normalized = snapshot.text:gsub("\r\n", "\n")
    local metadata, body = normalized:match("^%-%-%-\n(.-)\n%-%-%-\n(.*)$")
    if not metadata or not body:match("%S") then return false, "方案缺少任务标识或正文；请让设计会话完成交付" end
    local identities, baselines = {}, {}
    for line in metadata:gmatch("[^\n]+") do
        local id = line:match("^workbench_task:%s*([%w%-_]+)%s*$")
        local head = line:match("^workbench_baseline:%s*([%x]+)%s*$")
        if id then table.insert(identities, id) end
        if head then table.insert(baselines, head) end
    end
    if #identities ~= 1 or identities[1] ~= task.id then return false, "方案不属于当前任务，未进入审批" end
    if not task.designHead or #baselines ~= 1 or baselines[1] ~= task.designHead then return false, "方案基线与设计请求不一致，未进入审批" end
    return true
end
return M
