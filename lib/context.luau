--!strict
-- Shared requirement context: stage vocabulary, workflow stepper and the
-- context bar that keeps the selected requirement visible on every page.
local ui = tern.ui
local M = {}

M.stages = {
    {"backlog", "待整理"}, {"clarifying", "澄清中"}, {"designing", "设计中"},
    {"awaiting_approval", "待批准"}, {"implementing", "实施中"}, {"verifying", "验证中"},
    {"awaiting_acceptance", "待验收"}, {"done", "已完成"}, {"blocked", "已阻塞"}, {"cancelled", "已取消"},
}
M.stageNames = {}
for _, stage in M.stages do M.stageNames[stage[1]] = stage[2] end
M.priorities = {low = "低", normal = "普通", high = "高", urgent = "紧急"}
M.types = {feature = "功能", bug = "缺陷", chore = "维护"}
M.tones = {backlog = "muted", clarifying = "accent", designing = "accent", awaiting_approval = "pending",
    implementing = "accent", verifying = "accent", awaiting_acceptance = "pending", done = "success", blocked = "warning", cancelled = "muted"}

M.stepOrder = {backlog = 1, clarifying = 2, designing = 3, awaiting_approval = 4, implementing = 5,
    verifying = 5, awaiting_acceptance = 6, done = 6, blocked = 2, cancelled = 1}
type Step = {tab: string, sub: string?, label: string, help: string}
M.steps = {
    {tab = "requirements", label = "需求", help = "澄清目标、范围与验收条件"},
    {tab = "handoff", sub = "materials", label = "资料", help = "带入文件与讨论，生成完整预览"},
    {tab = "handoff", sub = "design", label = "方案", help = "编写并采用正式版本"},
    {tab = "handoff", sub = "approval", label = "批准", help = "检查 Git 基线并批准方案"},
    {tab = "results", label = "实施与验证", help = "计划、代码变化与验证证据"},
    {tab = "review", label = "审查与验收", help = "处置发现并人工验收"},
} :: {Step}
M.nextActions = {
    backlog = {label = "开始澄清", tab = "handoff", sub = "materials"},
    clarifying = {label = "准备资料并生成预览", tab = "handoff", sub = "materials"},
    designing = {label = "编写并采用方案", tab = "handoff", sub = "design"},
    awaiting_approval = {label = "检查并批准方案", tab = "handoff", sub = "approval"},
    implementing = {label = "查看实施计划与代码变化", tab = "results"},
    verifying = {label = "查看验证证据", tab = "results"},
    awaiting_acceptance = {label = "去审查并人工验收", tab = "review"},
    done = {label = "查看审计记录", tab = "audit"},
    blocked = {label = "查看阻塞原因", tab = "requirements"},
    cancelled = {label = "查看审计记录", tab = "audit"},
}
function M.openAction(target: {tab: string, sub: string?})
    return "wb-open-" .. target.tab .. (target.sub and ("-" .. target.sub) or "")
end

-- The stepper is navigation, not a gate: every step is clickable, the current one
-- is primary, and completed ones carry a check so the path already taken is visible.
function M.stepper(r)
    local current = M.stepOrder[r.stage] or 1
    local chips = {}
    for index, item in M.steps do
        table.insert(chips, ui.button((index < current and "✓ " or "") .. item.label, {
            key = "workflow-step-" .. tostring(index), size = "sm", title = item.help,
            variant = (if index == current then "primary" else "default") :: "primary" | "default", on = index == current,
            actions = {click = M.openAction(item)}}))
    end
    return ui.node("row", {key = "workflowStepRow", role = "workbench.stepper", gap = "xs", wrap = true}, chips)
end

local function units(text, position)
    local n, index = 0, 0
    for _, code in utf8.codes(text) do
        if index >= position then break end
        n += if code > 0xFFFF then 2 else 1
        index += 1
    end
    return n
end

-- Selecting here reuses the global requirement list identity, so the host's
-- existing selection guards (pending handoff requests) apply unchanged.
function M.switcher(u, count)
    local items = {}
    for _, r in u.requirements or {} do
        table.insert(items, ui.node("item", {key = r.requirementId, label = r.title, icon = "chevron",
            detail = (r.number or "") .. " · " .. (M.stageNames[r.stage] or r.stage),
            value = M.priorities[r.priority] or r.priority, tone = M.tones[r.stage]}))
    end
    local query = u.query or ""
    return ui.node("section", {key = "contextSwitcher", head = "切换需求 · " .. tostring(count or #items),
        collapsible = true, collapsed = true}, {
        ui.node("input", {key = "search", text = query, cursor = units(query, u.queryCursor or utf8.len(query)),
            placeholder = "搜索标题、目标、标签", aria = "搜索需求", variant = "field", icon = "search"}),
        ui.node("list", {key = "requirements", selected = u.selected, max = {lines = 6},
            empty = "没有匹配的需求；调整搜索或到需求页新建"}, items),
    })
end

-- opts.current = {tab, sub}: the page being rendered; its own next-step button is
-- suppressed because the page already carries that action.
function M.bar(s, opts)
    local u = s.ui
    local r = u.selected and u.byId[u.selected]
    if not r then
        return ui.node("card", {key = "contextBar", role = "workbench.context", tone = "muted"}, {
            ui.text({ui.span("尚未选择需求", "strong")}),
            ui.text({ui.span("审查、处置与验收都绑定到一项需求；在下面选择后继续。", "muted")}),
            M.switcher(u),
        })
    end
    local stageTone = M.tones[r.stage] or "muted"
    local metaRow = {
        ui.badge(M.stageNames[r.stage] or r.stage, stageTone),
        ui.text({ui.span((M.types[r.type] or r.type) .. " · 优先级 " .. (M.priorities[r.priority] or r.priority)
            .. " · 修订 " .. tostring(r.revision), "muted")}),
    }
    local nextStep = M.nextActions[r.stage]
    local current = opts and opts.current
    local onPage = current and nextStep and nextStep.tab == current.tab
        and (nextStep.sub or "") == (current.sub or "")
    if nextStep and not onPage then
        table.insert(metaRow, ui.button(nextStep.label, {key = "next-step", variant = "primary", size = "sm",
            actions = {click = M.openAction(nextStep)}}))
    end
    local children = {
        ui.node("row", {key = "contextMeta", role = "workbench.contextMeta", gap = "sm", wrap = true}, metaRow),
        M.stepper(r),
    }
    if r.stage == "blocked" and r.blockedReason then
        table.insert(children, ui.text({ui.span("阻塞：" .. r.blockedReason, "warning")}))
    end
    table.insert(children, M.switcher(u))
    return ui.node("card", {key = "contextBar", role = "workbench.context", tone = stageTone,
        head = {ui.span((r.number or "") .. "  ", "muted"), ui.span(r.title, "strong")}}, children)
end

return M