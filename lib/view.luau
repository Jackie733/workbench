--!strict
local ui = tern.ui
local text = require("./text")
local M = {}
local phases = {draft = {"待开始", "muted"}, designing = {"设计中", "accent"},
    design_ready = {"待批准", "pending"}, executing = {"执行中", "accent"},
    attention = {"需要你处理", "warning"}, review = {"待验收", "pending"}, done = {"已验收", "success"}}
local function button(label, action, variant, disabled)
    return ui.button(label, {key = action, variant = variant or "quiet", size = "sm", disabled = disabled, actions = {click = action}})
end
local function row(key, children)
    return ui.node("row", {key = key, gap = "sm", align = "center", wrap = true}, children)
end
local function note(value) return ui.text({ui.span(value, "muted")}) end
local function prose(value)
    return (value:gsub("^%-%-%-\r?\n.-\r?\n%-%-%-\r?\n", "", 1))
end
local function model(a) return a and a.model and a.model ~= "no-model" and a.model or "由 omp 角色配置启动" end
local function menu(task, confirmation)
    local items = {{id = "refresh", label = "刷新状态"}, {id = "switch-project", label = "切换项目…"}, {id = "files", label = "项目文件"}, {id = "git", label = "Git 变更"}}
    if task then
        table.insert(items, "-")
        table.insert(items, {id = "edit-task", label = "编辑需求", disabled = task.phase ~= "draft" and "已开始的任务请在原会话继续讨论" or false})
        table.insert(items, {id = "check-plan", label = "检查方案交付"})
        table.insert(items, {id = "agy", label = "复制 AGY 审查交接"})
        table.insert(items, {id = "interrupt", label = "中断当前任务会话…", danger = true})
    end
    if confirmation and confirmation.prompt then table.insert(items, {id = "copy-prompt", label = "复制本次完整指令"}) end
    table.insert(items, "-")
    table.insert(items, {id = "hide", label = "关闭导航（会话继续运行）"})
    return ui.node("menu", {key = "more", title = "更多操作", trigger = "quiet", align = "end", items = items})
end

function M.build(s, observed)
    local task = s.task
    local nodes = {
        ui.node("row", {key = "head", justify = "between", align = "center"}, {
            ui.text({ui.span("任务", "title")}),
            row("controls", {button("新任务", "new-task", "quiet", s.busy), menu(task, s.confirm)}),
        }),
        ui.text({ui.span(s.project.linuxRoot:match("[^/]+$") or s.project.linuxRoot, "strong"), ui.span(" · " .. s.project.distro, "muted")}),
    }
    if s.error then
        table.insert(nodes, ui.card("未能继续", {ui.text(s.error), button("重新检查", "refresh")}, {key = "error", tone = "error"}))
    end
    if #s.tasks == 0 then
        table.insert(nodes, ui.node("empty", {key = "empty", icon = "message", title = "从一个任务开始", text = "描述需求；会话关联和方案交接由工作台处理。"}, {
            button("开始一个任务", "new-task", "primary", s.busy),
        }))
        table.insert(nodes, note("直接执行小修改，或先设计、批准后再实施。"))
    else
        local rows = {}
        for _, item in s.tasks do
            local phase = phases[item.phase] or phases.attention
            table.insert(rows, ui.node("row", {key = item.id, role = item.id == s.selected and "workbench.task.selected" or "workbench.task",
                actions = {click = "select=" .. item.id}, title = item.goal}, {
                ui.node("col", {key = "label", grow = 1, basis = 0, gap = "xs"}, {
                    ui.text({ui.span(item.title, item.id == s.selected and "strong" or "")}),
                    ui.text({ui.span(phase[1], phase[2])}),
                }),
            }))
        end
        table.insert(nodes, ui.node("scroll", {key = "taskScroll", max = {h = "4lines"}}, {
            ui.node("col", {key = "tasks", gap = "xs"}, rows),
        }))
    end
    if task then
        local phase = phases[task.phase] or phases.attention
        table.insert(nodes, ui.rule())
        table.insert(nodes, row("taskHead", {ui.text({ui.span(task.title, "strong")}), ui.badge(phase[1], phase[2])}))
        -- Canvas forwards action events only; grouped buttons deliberately replace select-only tabs.
        if not s.confirm then
            table.insert(nodes, ui.node("buttons", {key = "sections", variant = "toolbar", size = "sm", label = "任务视图"}, {
                ui.button("概览", {key = "overview", on = s.section == "overview", actions = {click = "section=overview"}}),
                ui.button("方案", {key = "plan", on = s.section == "plan", actions = {click = "section=plan"}}),
                ui.button("详情", {key = "details", on = s.section == "details", actions = {click = "section=details"}}),
            }))
            if task.error then table.insert(nodes, ui.card("需要处理", {ui.text(task.error)}, {key = "taskError", tone = "warning"})) end
            if s.section == "details" then
                table.insert(nodes, ui.kv({{"项目", s.project.linuxRoot}, {"工作方式", task.strategy == "design" and "先设计再执行" or "直接执行"},
                    {"设计模型", model(observed.design)}, {"执行模型", model(observed.execute)},
                    {"设计状态", observed.design and observed.design.state or "未启动 / 已断开"},
                    {"执行状态", observed.execute and observed.execute.state or "未启动 / 已断开"},
                    {"方案", task.designPath}, {"基线", task.designHead or task.head or "开始时读取"}}))
                table.insert(nodes, row("sessions", {button("设计会话…", "choose-design", nil, s.busy), button("执行会话…", "choose-execute", nil, s.busy)}))
                table.insert(nodes, note("实际模型以 Tern 报告为准。关联变化会清除待发送确认；不会静默切换原会话模型。"))
            elseif s.section == "plan" then
                if task.plan then
                    table.insert(nodes, ui.node("scroll", {key = "planScroll", max = {h = "10lines"}}, {ui.md(text.clip(prose(task.plan), 18000))}))
                    if #task.plan > 18000 then table.insert(nodes, note("此处显示方案节选；请打开完整方案审阅，审批不会截短正文。")) end
                    table.insert(nodes, row("document", {button("打开完整方案", "preview"), button("重新读取", "check-plan", nil, s.busy)}))
                else
                    table.insert(nodes, ui.node("empty", {key = "noPlan", variant = "inline", title = "尚未读取方案", text = "设计者会交付当前任务的方案文件，无需复制聊天回复。"}, {button("检查交付", "check-plan", nil, s.busy)}))
                end
            else
                table.insert(nodes, ui.node("scroll", {key = "goalScroll", max = {h = "6lines"}}, {ui.md(task.goal)}))
                if task.message then table.insert(nodes, note(task.message)) end
                if task.strategy == "design" then table.insert(nodes, note("设计 → 你批准 → 执行 → 验收")) end
            end
        end
        if s.confirm then
            table.insert(nodes, ui.card(s.confirm.title, {
                note(s.confirm.model),
                ui.node("scroll", {key = "confirmationBody", max = {h = "10lines"}}, {
                    ui.md(text.clip(s.confirm.kind == "execute" and prose(s.confirm.body) or s.confirm.body, 18000)),
                }),
                row("confirmActions", {button(s.confirm.label or "确认开始", "confirm", "primary", s.busy), button("取消", "cancel", "quiet", s.busy)}),
            }, {key = "confirmation", tone = "accent"}))
            if #s.confirm.body > 18000 then table.insert(nodes, note("确认区显示节选；完整方案可在文件视图审阅，发送正文不截短。")) end
        elseif not s.busy then
            local actions = {}
            if task.phase == "draft" then
                table.insert(actions, button(task.strategy == "design" and "开始设计" or "开始执行", "start", "primary"))
                table.insert(actions, button("编辑需求", "edit-task"))
            elseif task.phase == "design_ready" then
                table.insert(actions, button("批准并开始执行", "approve", "primary"))
                table.insert(actions, button("继续讨论", "focus-design"))
            elseif task.phase == "designing" or task.phase == "executing" then
                local role = task.phase == "designing" and "design" or "execute"
                table.insert(actions, button("打开工作会话", "focus-" .. role, "primary"))
                if role == "design" then table.insert(actions, button("检查方案", "check-plan")) end
            elseif task.phase == "review" then
                table.insert(actions, button("打开原生审查", "review", "primary"))
                table.insert(actions, button("查看变更", "git"))
                table.insert(actions, button("验收完成", "complete"))
            elseif task.phase == "attention" then
                table.insert(actions, button("查看原会话", "focus-" .. (task.runRole or "execute"), "primary"))
                if task.runRole == "design" or task.legacy then table.insert(actions, button("检查方案交付", "check-plan")) end
                if task.runRole == "execute" then table.insert(actions, button("进入人工验收", "complete")) end
            else table.insert(actions, button("开始新任务", "new-task", "primary")) end
            table.insert(nodes, row("primary", actions))
        end
    end
    if s.busy then
        table.insert(nodes, ui.node("shimmer", {key = "busy", text = s.busy}))
        if not s.formPane then table.insert(nodes, button("取消准备", "cancel")) end
    end
    return ui.node("col", {key = "workbench", role = "workbench.navigator", gap = "md"}, nodes)
end
return M
