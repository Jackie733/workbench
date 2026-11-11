--!strict
local project = require("./lib/project")
local policy = require("./lib/policy")
local tasks = require("./lib/tasks")
local view = require("./lib/view")
local ID = "multi-model-workbench"
local states, operations = {}, {}
local opening, serial = false, 0
local publish, resumeForm, dispatch

local function unique()
    serial += 1
    return string.format("t%.0f-%d-%d", tern.now() * 1000, math.random(1, 2147483646), serial)
end
local function later(label, fn, delay)
    tern.timer(delay or 0, function(cx)
        if not cx then return end
        local ok, err = pcall(fn, cx)
        if not ok then
            tern.log.warn("工作台 " .. label .. ": " .. tostring(err))
            cx:toast("error", "任务工作台", tostring(err))
        end
    end)
end
local function selected(s)
    s.task = nil
    for _, task in s.tasks do if task.id == s.selected then s.task = task; break end end
    return s.task
end
local function rememberWidth(cx, s)
    local pane = cx.session:pane(s.panel)
    local layout = pane and pane.tab and cx.session:layout(pane.tab)
    local function find(node)
        if not node or not node.split then return nil end
        if node.split == "right" then
            if node[1] and node[1].pane == s.panel then return node.ratio end
            if node[2] and node[2].pane == s.panel then return 1 - node.ratio end
        end
        return find(node[1]) or find(node[2])
    end
    local ratio = layout and find(layout.root)
    if ratio and ratio >= 0.12 and ratio <= 0.45 then tern.kv.set("panel-width:" .. cx:window_key(), ratio) end
end
local function stateFor(cx, pane)
    if states[pane] then return states[pane] end
    local info = cx.canvas:get(pane)
    if not info or info.owner ~= ID then return nil end
    local ok, meta = pcall(tern.json.decode, info.about or "")
    if not ok or type(meta) ~= "table" or (meta.schema ~= 1 and meta.schema ~= 2) then return nil end
    if meta.schema == 2 and meta.window ~= cx:window_key() then return nil end
    local p = project.parse(meta.root)
    if not p then return nil end
    local saved = tasks.load(p)
    if #saved.tasks == 0 and meta.schema == 1 then
        local migrated = tasks.migrate(meta, unique())
        if migrated then saved.tasks, saved.selected = {migrated}, migrated.id; tasks.save(p, saved.tasks, saved.selected) end
    end
    local s = {panel = pane, project = p, tasks = saved.tasks, selected = saved.selected,
        section = "overview", gen = 0, origin = meta.origin, form = meta.form}
    if type(s.form) == "table" and type(s.form.pane) == "number" and type(s.form.token) == "string" then
        s.formPane, s.busy = s.form.pane, "填写任务"
    else s.form = nil end
    selected(s)
    states[pane] = s
    if s.form and resumeForm then resumeForm(s) end
    return s
end
local function observed(cx, s)
    local out = {}
    if not s.task then return out end
    local agents, panes = cx.agents:list(), cx.session:panes()
    for _, role in {"design", "execute"} do
        out[role] = policy.validateTarget(s.project, s.task.bindings[role], agents, panes, false)
    end
    return out
end
publish = function(cx, s)
    if not cx.canvas:get(s.panel) then states[s.panel] = nil; return end
    selected(s)
    local about = tern.json.encode({schema = 2, window = cx:window_key(), root = s.project.windowsRoot, origin = s.origin, form = s.form})
    if #about > 2000 then error("项目路径过长，无法保存工作台身份") end
    cx.canvas:set(s.panel, {title = "任务 · " .. (s.project.linuxRoot:match("[^/]+$") or "项目"),
        about = about, view = view.build(s, observed(cx, s))})
end
local function persist(cx, s)
    tasks.save(s.project, s.tasks, s.selected)
    publish(cx, s)
end
local function fail(cx, s, message)
    s.busy, s.confirm = nil, nil
    if s.task then s.task.error = tostring(message) else s.error = tostring(message) end
    cx:toast("error", "任务未继续", tostring(message))
    if s.panel then publish(cx, s) end
end
local function safe(cx, s, fn)
    local ok, err = pcall(fn)
    if not ok then fail(cx, s, err) end
end
local function current(cx, s, token)
    return states[s.panel] == s and s.gen == token and cx.canvas:get(s.panel) ~= nil
end
local function begin(cx, s, label)
    if s.busy then cx:toast("info", "请先完成当前操作", s.busy); return nil end
    s.gen += 1
    s.busy, s.confirm = label, nil
    if s.task then s.task.error = nil end
    s.error = nil
    publish(cx, s)
    return s.gen
end
local function finish(cx, s, token)
    if not current(cx, s, token) then return end
    s.busy = nil
    publish(cx, s)
end
local function callback(s, token, fn)
    return function(value, err, cx)
        if not cx or not current(cx, s, token) then return end
        safe(cx, s, function() if err then fail(cx, s, err) else fn(value, cx) end end)
    end
end
local function inspect(cx, s, token, path, fn)
    local ok, err = project.inspect(s.project, path, function(snapshot, failure, fresh)
        if not fresh or not current(fresh, s, token) then return end
        safe(fresh, s, function()
            if failure then fail(fresh, s, failure); return end
            if snapshot.root ~= s.project.linuxRoot then fail(fresh, s, "项目根已改变；请从项目重新打开工作台"); return end
            fn(snapshot, fresh)
        end)
    end)
    if not ok then fail(cx, s, err) end
end
local function target(cx, s, task, role, idle)
    return policy.validateTarget(s.project, task.bindings[role], cx.agents:list(), cx.session:panes(), idle)
end
local function writerConflict(cx, s, task)
    for _, other in s.tasks do
        if other ~= task and other.runRole == "execute" and (other.phase == "executing" or other.phase == "attention") then
            local agent = target(cx, s, other, "execute", false)
            if agent and agent.state ~= "idle" then return "“" .. other.title .. "”仍在执行或等待输入，请先处理，避免多个写入者" end
        end
    end
end

-- Only the source session or an explicit user choice is reused. Other idle
-- conversations are not ours to occupy; unassigned roles start from omp config.
local function chooseTarget(cx, s, token, role, fn)
    if not current(cx, s, token) then return end
    local task = s.task
    if task.bindings[role] then
        local a, err = target(cx, s, task, role, true)
        if not a then fail(cx, s, err .. " 可在“详情”更换会话。"); return end
        fn({pane = a.pane, model = policy.model(a)}, cx)
    else
        fn({new = true, model = "新建 omp 会话 · @" .. role}, cx)
    end
end
local function stage(cx, s, token, details)
    if not current(cx, s, token) then return end
    s.busy, s.confirm = nil, details
    tasks.save(s.project, s.tasks, s.selected)
    publish(cx, s)
end
local function deliver(cx, s, token, confirmation)
    local task, captured = s.task, confirmation.target
    local conflict = writerConflict(cx, s, task)
    if conflict then fail(cx, s, conflict); return end
    if not captured.new then
        local a, err = target(cx, s, task, confirmation.role, true)
        if not a or a.pane ~= captured.pane or policy.model(a) ~= captured.model then
            fail(cx, s, err or "目标会话或模型已变化，请重新准备"); return
        end
    end
    task.runRole, task.runMarker = confirmation.role, confirmation.marker
    task.phase = confirmation.kind == "design" and "designing" or "executing"
    task.error, task.message = nil, "请求已提交；会话结束后仍需检查交付与验收。"
    -- Persist intent before delivery. Reload never submits or retries this intent.
    tasks.save(s.project, s.tasks, s.selected)
    local ok, result = pcall(function()
        if captured.new then
            return cx.agents:start({cwd = s.project.windowsRoot, command = confirmation.command,
                prompt = confirmation.prompt, how = "tab"})
        end
        cx.agents:ask(captured.pane, confirmation.prompt)
        return captured.pane
    end)
    if not ok then
        task.phase, task.error = "attention", "发送状态待确认。请查看原会话，不要盲目重发：" .. tostring(result)
    else
        task.bindings[confirmation.role] = result
    end
    s.busy, s.confirm = nil, nil
    persist(cx, s)
    if ok then cx.layout:focus(result) end
end

local function send(cx, s, token, confirmation)
    if not confirmation.target.new then deliver(cx, s, token, confirmation); return end
    local ok, failure = project.prepareLaunch(s.project, confirmation.role, function(command, err, fresh)
        if not fresh or not current(fresh, s, token) then return end
        safe(fresh, s, function()
            if err then fail(fresh, s, err); return end
            confirmation.command = command
            -- Preparing a launcher is asynchronous; recheck the approved snapshot afterwards.
            inspect(fresh, s, token, confirmation.approval and s.task.designPath or nil, function(snapshot, ready)
                if confirmation.approval then
                    if not policy.approvalMatches(confirmation.approval, snapshot) then
                        fail(ready, s, "启动准备期间方案或 HEAD 已变化，未发送"); return
                    end
                elseif snapshot.head ~= confirmation.head then
                    fail(ready, s, "启动准备期间 HEAD 已变化，未发送"); return
                end
                deliver(ready, s, token, confirmation)
            end)
        end)
    end)
    if not ok then fail(cx, s, failure) end
end

local function readPlan(cx, s, task, fromFinished)
    local agent = target(cx, s, task, "design", false)
    if not fromFinished and agent and agent.state ~= "idle" then
        cx:toast("info", "设计会话尚未结束", "请在会话中处理问题，或等待方案交付。"); return
    end
    local token = begin(cx, s, "检查任务方案")
    if not token then return end
    if fromFinished then
        task.phase, task.message = "attention", "设计回合已结束，正在核对交付。"
        tasks.save(s.project, s.tasks, s.selected)
    end
    inspect(cx, s, token, task.designPath, function(snapshot, fresh)
        local valid, err = tasks.validateDesign(snapshot, task)
        if not valid then fail(fresh, s, err); return end
        task.plan, task.phase, task.error = snapshot.text, "design_ready", nil
        task.message = "已核对任务与基线。请审阅方案，批准后才开始实施。"
        s.busy, s.section = nil, "plan"
        persist(fresh, s)
    end)
end

operations.start = function(cx, s)
    local task = s.task
    if not task or task.phase ~= "draft" then cx:toast("info", "此任务已开始", "请打开原会话继续，工作台不会重发已有请求。"); return end
    local token = begin(cx, s, "准备任务")
    if not token then return end
    inspect(cx, s, token, nil, function(snapshot, fresh)
        local role = task.strategy == "design" and "design" or "execute"
        local conflict = writerConflict(fresh, s, task)
        if conflict then fail(fresh, s, conflict); return end
        task.head = snapshot.head
        if role == "design" then task.designHead = snapshot.head end
        local marker = "[workbench:" .. task.id .. ":" .. unique() .. "]"
        local prompt = marker .. "\n项目：" .. s.project.linuxRoot .. "\n基线 HEAD：" .. snapshot.head .. "\n任务：\n" .. task.goal
        if role == "design" then
            prompt ..= "\n\n只研究设计，不实施代码、不提交 Git。唯一允许写入的文件是项目内的 " .. task.designPath
                .. "（可创建它的父目录）。将完整方案保存到该 UTF-8 Markdown 文件；不要只回复在聊天里。文件必须以以下 frontmatter 开始：\n---\nworkbench_task: " .. task.id
                .. "\nworkbench_baseline: " .. snapshot.head .. "\n---\n\n正文写明目标/非目标、接口与文件范围、实施步骤、验收及风险，区分事实与未验证项。保留用户已有改动。交付后停止，等待用户批准；不要自动发起执行。"
        else
            prompt ..= "\n\n按此需求实施，不扩大范围，保留用户已有改动，只安排一个主要写入者。完成后做针对性验证并报告真实结果、未验证项及风险。不要自动提交、推送或调用 AGY。"
        end
        chooseTarget(fresh, s, token, role, function(captured, ready)
            stage(ready, s, token, {kind = role == "design" and "design" or "direct", role = role, target = captured,
                title = role == "design" and "开始这项设计？" or "开始执行这项任务？", label = role == "design" and "开始设计" or "开始执行",
                model = captured.model,
                body = task.goal .. "\n\n" .. (role == "design"
                    and "只研究并交付方案，不修改项目代码。方案经过你批准后，才会交给执行者。"
                    or "按需求实施并报告真实验证结果；保留已有改动，不自动提交或推送。")
                    .. (snapshot.dirty and "\n\n当前工作区有未提交改动，必须保留。" or ""),
                prompt = prompt, marker = marker, head = snapshot.head})
        end)
    end)
end
operations.approve = function(cx, s)
    local task = s.task
    if not task or task.phase ~= "design_ready" then cx:toast("info", "请先检查任务方案"); return end
    local designer = target(cx, s, task, "design", false)
    if designer and designer.state ~= "idle" then fail(cx, s, "设计会话仍在工作或等待输入，请先处理"); return end
    local token = begin(cx, s, "准备方案审批")
    if not token then return end
    inspect(cx, s, token, task.designPath, function(snapshot, fresh)
        local valid, err = tasks.validateDesign(snapshot, task)
        if not valid then fail(fresh, s, err); return end
        local marker = "[workbench:" .. task.id .. ":" .. unique() .. "]"
        local approval = {head = snapshot.head, digest = snapshot.digest, relativePath = snapshot.relativePath}
        local prompt = marker .. "\n按用户批准的以下固定方案实施，不扩大范围。\n项目：" .. s.project.linuxRoot
            .. "\n批准基线：" .. snapshot.head .. "\n方案文件：" .. snapshot.relativePath .. "\nSHA-256：" .. snapshot.digest
            .. "\n以附带正文为准；基线变化或设计矛盾时停止报告。保留用户已有改动，只安排一个主要写入者。完成后运行针对性验证并报告真实结果、未验证项和风险。不要自动提交、推送或调用 AGY。\n\n<approved-design>\n"
            .. snapshot.text .. "\n</approved-design>"
        chooseTarget(fresh, s, token, "execute", function(captured, ready)
            task.plan = snapshot.text
            stage(ready, s, token, {kind = "execute", role = "execute", target = captured, title = "批准这份方案并执行？", label = "批准并执行",
                model = captured.model .. (snapshot.dirty and " · 保留已有改动" or ""), body = snapshot.text,
                prompt = prompt, marker = marker, approval = approval})
        end)
    end)
end
operations.confirm = function(cx, s)
    local confirmation = s.confirm
    if not confirmation then return end
    local token = begin(cx, s, "核对发送条件")
    if not token then return end
    if confirmation.kind == "interrupt" then
        local a, err = target(cx, s, s.task, confirmation.role, false)
        if not a or a.pane ~= confirmation.target.pane then fail(cx, s, err or "会话已变化"); return end
        cx.agents:interrupt(a.pane)
        s.task.phase, s.task.message = "attention", "已请求中断；请核对实际停止情况，已有写入不会撤销。"
        s.busy = nil
        persist(cx, s)
        return
    elseif confirmation.kind == "complete" then
        local a = target(cx, s, s.task, "execute", false)
        if a and a.state ~= "idle" then fail(cx, s, "执行会话仍在运行或等待输入，不能标记验收完成"); return end
        s.task.phase, s.task.message, s.task.error = "done", "用户已确认验收；工作台没有代替测试结果作判断。", nil
        s.busy = nil
        persist(cx, s)
        return
    elseif confirmation.kind == "review" then
        local a, err = target(cx, s, s.task, "execute", true)
        if not a or a.pane ~= confirmation.target.pane or policy.model(a) ~= confirmation.target.model then fail(cx, s, err or "审查会话或模型已变化"); return end
        local ok, failure = pcall(function() cx.agents:ask(a.pane, "/review") end)
        if not ok then fail(cx, s, "审查提交状态待确认，请查看原会话：" .. tostring(failure)); return end
        s.busy = nil
        publish(cx, s)
        cx.layout:focus(a.pane)
        return
    end
    inspect(cx, s, token, confirmation.approval and s.task.designPath or nil, function(snapshot, fresh)
        if confirmation.approval then
            if not policy.approvalMatches(confirmation.approval, snapshot) then fail(fresh, s, "方案文件或 HEAD 已变化，本次审批失效，未发送"); return end
        elseif snapshot.head ~= confirmation.head then fail(fresh, s, "确认期间 HEAD 已变化，请重新准备任务"); return end
        send(fresh, s, token, confirmation)
    end)
end
operations["copy-prompt"] = function(cx, s)
    if s.confirm and s.confirm.prompt then
        cx:copy(s.confirm.prompt)
        cx:toast("info", "已复制完整待发送指令", "没有发送模型请求。")
    end
end
operations.cancel = function(cx, s)
    s.gen += 1
    s.busy, s.confirm = nil, nil
    publish(cx, s)
end
operations["check-plan"] = function(cx, s) if s.task then readPlan(cx, s, s.task, false) end end
operations.preview = function(cx, s)
    if not s.task then return end
    local token = begin(cx, s, "打开完整方案")
    if token then inspect(cx, s, token, s.task.designPath, function(_, fresh)
        fresh:open(s.project.windowsRoot .. "\\" .. s.task.designPath:gsub("/", "\\"), "tab")
        finish(fresh, s, token)
    end) end
end
operations.refresh = function(cx, s)
    s.error = nil
    if s.task then s.task.error = nil end
    publish(cx, s)
end
for _, roleName in {"design", "execute"} do
    local role = roleName
    operations["focus-" .. role] = function(cx, s)
        if not s.task then return end
        local a, err = target(cx, s, s.task, role, false)
        if not a then fail(cx, s, err .. "。可在“详情”选择会话，已有方案仍会保留。"); return end
        cx.layout:focus(a.pane)
    end
    operations["choose-" .. role] = function(cx, s)
        if not s.task then return end
        local running = target(cx, s, s.task, role, false)
        if running and running.state ~= "idle" then fail(cx, s, "原会话仍在运行，请先处理或中断，不能改变关联"); return end
        local token = begin(cx, s, "选择任务会话")
        if not token then return end
        local items = {{label = "新建独立 omp 会话", detail = "下次明确开始时使用 @" .. role .. "；现在不启动", new = true}}
        local agents, panes = cx.agents:list(), cx.session:panes()
        for _, a in agents do
            if policy.validateTarget(s.project, a.pane, agents, panes, false) then
                table.insert(items, {label = policy.model(a), detail = a.state .. " · " .. a.cwd, pane = a.pane})
            end
        end
        cx:pick({placeholder = role == "design" and "设计会话" or "执行会话", items = items}):next(callback(s, token, function(choice, fresh)
            if choice then
                s.task.bindings[role] = choice.pane
                s.task.message = choice.new and "下次开始时创建独立角色会话。" or "会话已关联；提交时显示实际模型。"
                tasks.save(s.project, s.tasks, s.selected)
            end
            finish(fresh, s, token)
        end))
    end
end
operations.review = function(cx, s)
    if not s.task then return end
    local a, err = target(cx, s, s.task, "execute", true)
    if not a then fail(cx, s, err); return end
    s.confirm = {kind = "review", title = "打开 omp 原生审查？", label = "打开审查", model = policy.model(a),
        role = "execute", target = {pane = a.pane, model = policy.model(a)}, body = "向此会话发送 `/review`，然后在 omp 原生菜单选择范围。不会另建审查引擎，也不会自动开始模型审查。"}
    publish(cx, s)
end
operations.complete = function(cx, s)
    if not s.task then return end
    if s.task.phase ~= "review" and not (s.task.phase == "attention" and s.task.runRole == "execute") then
        cx:toast("info", "请先完成执行并核对结果"); return
    end
    s.confirm = {kind = "complete", title = "确认已经验收？", label = "标记已验收", model = "由你确认，不根据模型空闲自动判定",
        body = "请先核实变更与真实验证结果。标记只记录你的验收结论，不会运行测试、提交或关闭会话。"}
    publish(cx, s)
end
operations.interrupt = function(cx, s)
    if not s.task then return end
    local role = s.task.runRole or "execute"
    local a, err = target(cx, s, s.task, role, false)
    if not a then fail(cx, s, err); return end
    s.confirm = {kind = "interrupt", role = role, target = {pane = a.pane}, title = "中断当前任务会话？", label = "请求中断",
        model = policy.model(a), body = "只向此会话发送原生中断。不会关闭会话、回滚改动，也不保证终止所有后台工具。"}
    publish(cx, s)
end
operations.files = function(cx, s) cx:open(s.project.windowsRoot) end
operations.git = function(cx, s)
    local token = begin(cx, s, "打开原生 Git")
    if not token then return end
    cx.git:open(s.project.windowsRoot, {how = "tab"}):next(callback(s, token, function(_, fresh) finish(fresh, s, token) end))
end
operations.agy = function(cx, s)
    if not s.task then return end
    local token = begin(cx, s, "准备 AGY 交接")
    if token then inspect(cx, s, token, nil, function(snapshot, fresh)
        fresh:copy("只读独立审查，不修改文件。\n项目：" .. s.project.linuxRoot .. "\n任务：" .. s.task.goal
            .. "\nHEAD：" .. snapshot.head .. "\n方案：" .. s.task.designPath
            .. "\n请另行冻结待审查 diff，核对执行会话的真实验证结果。报告文件位置、触发条件、证据和未验证风险。")
        finish(fresh, s, token)
        fresh:toast("info", "已复制 AGY 交接", "没有启动 AGY 或发送模型请求。")
    end) end
end
operations.hide = function(cx, s)
    rememberWidth(cx, s)
    states[s.panel] = nil
    cx.layout:close(s.panel)
end

local function restorePanel(cx, s)
    local form = s.form
    if not form then return end
    local exists = cx.session:pane(form.pane)
    cx.layout:unpark(s.panel, {focus = false})
    if exists then
        cx.layout:move(s.panel, form.pane, "swap", {focus = false})
        cx.layout:close(form.pane) -- Only our own temporary form, never a user program.
    end
    s.form, s.formPane, s.busy = nil, nil, nil
    cx.layout:focus(s.panel)
end
resumeForm = function(s)
    if s.polling then return end
    s.polling = true
    local function tick(cx)
        if not states[s.panel] or not cx.canvas:get(s.panel) then s.polling = nil; return end
        local form = s.form
        if not form then s.polling = nil; return end
        safe(cx, s, function()
            local result = tern.kv.get("form:" .. form.token)
            if result then
                if not result.cancelled then
                    local task = tasks.new(form.edit or unique(), result.goal, result.strategy)
                    if form.edit then
                        for i, old in s.tasks do
                            if old.id == form.edit then task.bindings = old.bindings; s.tasks[i] = task; break end
                        end
                    else
                        local preferred = policy.validateTarget(s.project, s.origin, cx.agents:list(), cx.session:panes(), false)
                        if preferred and policy.model(preferred) ~= "未知" then
                            task.bindings[task.strategy == "design" and "design" or "execute"] = preferred.pane
                        end
                        table.insert(s.tasks, task)
                    end
                    s.selected = task.id
                    tasks.save(s.project, s.tasks, s.selected)
                end
                restorePanel(cx, s)
                selected(s)
                tern.kv.set("form:" .. form.token, nil)
                s.polling, s.section = nil, "overview"
                publish(cx, s)
                if not result.cancelled then operations.start(cx, s) end
            elseif not cx.session:pane(form.pane) then
                restorePanel(cx, s)
                s.polling = nil
                publish(cx, s)
            end
        end)
        if s.form then later("表单", tick, 250) end
    end
    later("表单", tick, 150)
end
local function openForm(cx, s, edit)
    local token = begin(cx, s, "填写任务")
    if not token then return end
    local task = edit and s.task or nil
    if edit and (not task or task.phase ~= "draft") then finish(cx, s, token); return end
    rememberWidth(cx, s)
    local formToken = unique()
    local pane = cx:new_block(ID .. ".task-form", {formToken, s.project.linuxRoot, task and task.goal or "", task and task.strategy or "design"},
        "beside", {target = s.panel, dir = "right", ratio = 0.5})
    if not pane then fail(cx, s, "任务表单未加载，请检查 Tern 插件状态"); return end
    s.form, s.formPane = {pane = pane, token = formToken, edit = task and task.id}, pane
    cx.layout:move(pane, s.panel, "swap", {focus = false})
    cx.layout:park(s.panel)
    publish(cx, s)
    cx.layout:focus(pane)
    resumeForm(s)
end
operations["new-task"] = function(cx, s) openForm(cx, s, false) end
operations["edit-task"] = function(cx, s) openForm(cx, s, true) end

local function rememberProject(p)
    local recent = tern.kv.get("recent-projects") or {}
    local nextList = {p.windowsRoot}
    for _, path in recent do if path ~= p.windowsRoot and #nextList < 12 then table.insert(nextList, path) end end
    tern.kv.set("recent-projects", nextList)
end
local function board(cx)
    for _, info in cx.canvas:list() do
        if info.owner == ID then
            local s = stateFor(cx, info.pane)
            if s then return s end
        end
    end
    return nil
end
local function openProject(cx, path, origin)
    if opening then cx:toast("info", "正在读取项目"); return end
    local p, err = project.parse(path)
    if not p then cx:toast("error", "请从本机 WSL Git 项目打开", err); return end
    local old = board(cx)
    if old and old.busy then cx.layout:focus(old.formPane or old.panel); return end
    opening = true
    local ok, failure = project.inspect(p, nil, function(snapshot, problem, fresh)
        opening = false
        if not fresh then return end
        if problem then fresh:toast("error", "无法读取项目", problem); return end
        local canonical, parseError = project.atRoot(p, snapshot.root)
        if not canonical then fresh:toast("error", "项目根无效", parseError); return end
        local existing = board(fresh)
        safe(fresh, existing or {}, function()
            rememberProject(canonical)
            if existing and existing.project.key == canonical.key then
                if origin and origin ~= existing.panel then existing.origin = origin end
                fresh.layout:focus(existing.panel)
                publish(fresh, existing)
                return
            end
            local saved = tasks.load(canonical)
            local s = existing or {gen = 0}
            s.project, s.tasks, s.selected, s.section, s.origin = canonical, saved.tasks, saved.selected, "overview", origin
            s.confirm, s.error = nil, nil
            selected(s)
            if not existing then
                local pane, openError = fresh.canvas:open({title = "任务", about = tern.json.encode({schema = 2, window = fresh:window_key(), root = canonical.windowsRoot, origin = origin}),
                    view = view.build(s, {}), how = "beside", target = origin, dir = "left",
                    ratio = math.clamp(tonumber(tern.kv.get("panel-width:" .. fresh:window_key())) or 0.20, 0.12, 0.45)})
                if not pane then fresh:toast("error", "无法打开任务导航", openError); return end
                s.panel = pane
                states[pane] = s
            else
                states[s.panel] = s
            end
            publish(fresh, s)
            fresh.layout:focus(s.panel)
        end)
    end)
    if not ok then opening = false; cx:toast("error", "项目读取未启动", failure) end
end
operations["switch-project"] = function(cx, s)
    local items, seen = {}, {}
    for _, pane in cx.session:panes() do
        local p = project.parse(pane.cwd)
        if p and not seen[p.key] then
            seen[p.key] = true
            table.insert(items, {label = p.linuxRoot:match("[^/]+$") or p.linuxRoot, detail = p.linuxRoot, path = p.windowsRoot, origin = pane.pane})
        end
    end
    for _, path in tern.kv.get("recent-projects") or {} do
        local p = project.parse(path)
        if p and not seen[p.key] then seen[p.key] = true; table.insert(items, {label = p.linuxRoot:match("[^/]+$") or p.linuxRoot, detail = p.linuxRoot, path = path}) end
    end
    cx:pick({placeholder = "切换任务项目（不发送请求）", items = items}):next(function(choice, err, fresh)
        if fresh and not err and choice then later("切换项目", function(nextCx) openProject(nextCx, choice.path, choice.origin) end) end
    end)
end
local function openWorkbench(cx)
    local focused = cx.session:focused()
    local s = board(cx)
    if s and (focused == s.panel or focused == s.formPane) then
        cx.layout:focus(s.formPane or s.panel); publish(cx, s); return
    end
    local pane = focused and cx.session:pane(focused)
    if pane then
        local p = project.parse(pane.cwd)
            or policy.projectForTarget(focused, cx.agents:list(), cx.session:panes())
        if p then openProject(cx, p.windowsRoot, focused)
        elseif s then cx.layout:focus(s.formPane or s.panel)
        else cx:toast("info", "请从可确认身份的本机 WSL 项目打开任务工作台") end
    elseif s then cx.layout:focus(s.formPane or s.panel)
    else cx:toast("info", "请从本机 WSL 项目打开任务工作台") end
end

dispatch = function(cx, s, action, value)
    if s.busy and action ~= "cancel" and action ~= "refresh" then cx:toast("info", "请先完成当前操作", s.busy); return end
    if s.form then cx.layout:focus(s.form.pane); return end
    if action == "select" then
        if s.confirm then s.confirm = nil; s.gen += 1 end
        for _, task in s.tasks do
            if task.id == value then s.selected, s.section = value, "overview"; selected(s); persist(cx, s); return end
        end
        return
    elseif action == "section" then
        if value == "overview" or value == "plan" or value == "details" then s.section = value; publish(cx, s) end
        return
    end
    local operation = operations[action]
    if operation then operation(cx, s) else cx:toast("error", "未知任务操作", action) end
end
tern.command({id = "open", title = "打开 / 恢复任务工作台", group = "多模型工作台", run = function() later("打开", openWorkbench) end})
tern.on("canvas_action", function(ev)
    if ev.owner ~= ID then return false end
    later("操作 " .. ev.act, function(cx)
        local s = stateFor(cx, ev.pane)
        if s then safe(cx, s, function() dispatch(cx, s, ev.act, ev.value) end) end
    end)
    return true
end)

local function refreshSoon()
    for _, s in states do
        if not s.refreshQueued then
            s.refreshQueued = true
            later("刷新", function(cx)
                s.refreshQueued = nil
                if cx.canvas:get(s.panel) then safe(cx, s, function() publish(cx, s) end) else states[s.panel] = nil end
            end, 100)
        end
    end
end
local function belongs(cx, task, pane)
    if not task.runMarker then return false end
    local messages = cx.agents:transcript(pane, {last = 12})
    for i = #messages, 1, -1 do
        if messages[i].role == "user" then return messages[i].text:sub(1, #task.runMarker) == task.runMarker end
    end
    return false
end
tern.on("agent_finished", function(ev)
    later("任务回合结束", function(cx)
        for _, s in states do
            for _, task in s.tasks do
                local role = task.runRole
                if role and task.bindings[role] == ev.pane and (task.phase == "designing" or task.phase == "executing" or task.phase == "attention") then
                    safe(cx, s, function()
                        if ev.result ~= "done" or not belongs(cx, task, ev.pane) then
                            task.phase = "attention"
                            task.error = ev.result == "done" and "原会话已有其他请求；未把它的回复算作本任务交付。" or "会话报告“" .. ev.result .. "”，请查看原会话；没有自动重发。"
                            persist(cx, s)
                        elseif role == "design" then
                            if s.selected == task.id and not s.busy then readPlan(cx, s, task, true)
                            else task.phase, task.message = "attention", "设计回合已结束，请选择此任务并检查方案交付。"; persist(cx, s) end
                        else
                            task.phase, task.message, task.error = "review", "执行回合已结束。请核对变更和验证报告，再运行原生审查或确认验收。", nil
                            persist(cx, s)
                        end
                    end)
                end
            end
        end
    end)
end)
for _, name in {"agent_state", "pane_closed", "cwd"} do tern.on(name, function() refreshSoon() end) end
-- A reload does not fire window_start again; the boot timer also restores owned panels.
later("恢复工作台", function(cx)
    for _, info in cx.canvas:list() do
        if info.owner == ID then
            local ok, s = pcall(stateFor, cx, info.pane)
            if ok and s then safe(cx, s, function() publish(cx, s) end)
            elseif not ok then cx:toast("error", "任务恢复失败（原数据保留）", tostring(s)) end
        end
    end
end, 100)
tern.on("budget", function(ev)
    if ev.state == "paused" then tern.log.warn("工作台回调暂停：" .. tostring(ev.hook) .. "；不会重发模型请求") end
end)
