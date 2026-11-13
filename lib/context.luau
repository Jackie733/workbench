--!strict
-- Shared requirement context: stage vocabulary, workflow stepper and the
-- context bar that keeps the selected requirement visible on every page.
local ui = tern.ui
local Validity = require("./validity")
local Workflow = require("./workflow")
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
    {tab = "requirement", label = "需求", help = "澄清目标、范围与验收条件"},
    {tab = "design", sub = "materials", label = "资料", help = "带入文件与讨论，生成完整预览"},
    {tab = "design", sub = "design", label = "方案", help = "编写并采用正式版本"},
    {tab = "design", sub = "approval", label = "批准", help = "检查 Git 基线并批准方案"},
    {tab = "delivery", label = "交付", help = "计划、代码变化与验证证据"},
    {tab = "acceptance", label = "验收", help = "处置发现并人工验收"},
} :: {Step}
M.nextActions = {
    backlog = {label = "开始澄清", tab = "design", sub = "materials"},
    clarifying = {label = "准备资料并生成预览", tab = "design", sub = "materials"},
    designing = {label = "编写并采用方案", tab = "design", sub = "design"},
    awaiting_approval = {label = "检查并批准方案", tab = "design", sub = "approval"},
    implementing = {label = "查看实施计划与代码变化", tab = "delivery"},
    verifying = {label = "查看验证证据", tab = "delivery"},
    awaiting_acceptance = {label = "去验收并人工接受", tab = "acceptance"},
    done = {label = "查看历史", tab = "history"},
    blocked = {label = "查看阻塞原因", tab = "requirement"},
    cancelled = {label = "查看历史", tab = "history"},
}
-- Global destinations and requirement-workspace tabs are different levels: the
-- workspace is entered from a requirement and Back returns to the same dataset.
M.destinations = {
    {id = "requirements", label = "需求"},
    {id = "activity", label = "活动"},
    {id = "session", label = "会话"},
}
M.workspaceTabs = {
    {id = "requirement", label = "需求"},
    {id = "design", label = "方案"},
    {id = "delivery", label = "交付"},
    {id = "acceptance", label = "验收"},
    {id = "history", label = "历史"},
}
M.workspaceTab = {}
for _, tab in M.workspaceTabs do M.workspaceTab[tab.id] = true end
M.destination = {}
for _, tab in M.destinations do M.destination[tab.id] = true end
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
    local readiness = M.readiness(r, u)
    local nextStep = (readiness and readiness.next) or M.nextActions[r.stage]
    local current = opts and opts.current
    local onPage = current and nextStep and nextStep.tab == current.tab
        and ((nextStep.sub or "") == (current.sub or "") or nextStep.sub == nil)
    if nextStep and not onPage then
        table.insert(metaRow, ui.button(nextStep.label, {key = "next-step", variant = "primary", size = "sm",
            actions = {click = M.openAction(nextStep)}}))
    end
    local children = {
        ui.node("row", {key = "contextMeta", role = "workbench.contextMeta", gap = "sm", wrap = true}, metaRow),
        M.stepper(r),
    }
    if readiness then
        local row = {ui.badge(readiness.label or "状态未知", readiness.tone or "muted")}
        local reasons = readiness.reasons or {}
        if reasons[1] then
            local extra = #reasons > 1 and ("；另有 " .. tostring(#reasons - 1) .. " 项") or ""
            table.insert(row, ui.text({ui.span(reasons[1] .. extra, "muted")}))
        end
        table.insert(children, ui.node("row", {key = "readinessRow", role = "workbench.readiness", gap = "xs", wrap = true}, row))
    end
    if r.stage == "blocked" and r.blockedReason then
        table.insert(children, ui.text({ui.span("阻塞：" .. r.blockedReason, "warning")}))
    end
    table.insert(children, M.switcher(u))
    return ui.node("card", {key = "contextBar", role = "workbench.context", tone = stageTone,
        head = {ui.span((r.number or "") .. "  ", "muted"), ui.span(r.title, "strong")}}, children)
end

-- Read-only readiness for one requirement, derived at render time from the same
-- validity evaluation the Delivery list and the acceptance action use. It never
-- writes a stage or revision; unknown facts stay unknown instead of green.
function M.readiness(r, u)
    if not r then return nil end
    local trace = u and u.trace
    local review = u and u.review
    local h = u and u.handoff
    if (trace and trace.safe == false) or (review and review.safe == false) or (h and h.safe == false) then
        return {state = "unknown", label = "记录无法读取", tone = "error",
            reasons = {"当前需求的部分记录无法安全读取；未推断任何通过状态。"},
            next = {tab = "requirement", label = "检查记录"}}
    end
    local gate = Validity.acceptance(r, trace and trace.results, review and review.data)
    local approval = nil
    if h and h.workflow then
        approval = Validity.approval(h.workflow, r, Workflow.requirementContent(r))
    end
    local reasons = {}
    local function addReasons(items)
        for index, item in items do
            if index > 3 then break end
            table.insert(reasons, item.message)
        end
    end
    local state, label, tone, next
    if r.stage == "blocked" then
        state, label, tone = "blocked", "已阻塞", "warning"
        if r.blockedReason then table.insert(reasons, "阻塞原因：" .. r.blockedReason) end
        next = M.nextActions.blocked
    elseif r.stage == "done" then
        state, label, tone, next = "done", "已由人工验收", "success", M.nextActions.done
    elseif r.stage == "cancelled" then
        state, label, tone, next = "cancelled", "已取消", "muted", M.nextActions.cancelled
    elseif r.stage == "awaiting_approval" then
        next = M.nextActions.awaiting_approval
        if approval and approval.valid then
            state, label, tone = "ready", "授权有效，等待明确开始实施", "success"
        else
            state, label, tone = "waiting", "待批准", "pending"
            if approval then table.insert(reasons, approval.message) end
        end
    elseif r.stage == "implementing" or r.stage == "verifying" then
        if approval and not approval.valid then
            state, label, tone = "blocked", "实施授权已失效", "error"
            table.insert(reasons, approval.message)
            next = {tab = "design", sub = "approval", label = "重新检查并批准"}
        elseif not gate.snapshot then
            state, label, tone = "unknown", "代码快照未知", "warning"
            table.insert(reasons, "尚未读取当前代码快照；通过证据不能被当作仍然有效。")
            next = {tab = "delivery", label = "读取代码快照"}
        elseif not gate.ok then
            state, label, tone = "waiting", "交付证据未齐", "pending"
            addReasons(gate.reasons)
            next = M.nextActions[r.stage]
        else
            state, label, tone = "ready", "证据齐备，可以验收", "success"
            next = {tab = "acceptance", label = "去验收"}
        end
    elseif r.stage == "awaiting_acceptance" then
        if not gate.snapshot then
            state, label, tone = "unknown", "代码快照未知", "warning"
            table.insert(reasons, "尚未读取当前代码快照。")
            next = {tab = "delivery", label = "读取代码快照"}
        elseif not gate.ok then
            state, label, tone = "blocked", "验收门禁未通过", "warning"
            addReasons(gate.reasons)
            local first = gate.reasons[1]
            next = first and first.code == "blocking_finding_open"
                and {tab = "acceptance", label = "处置阻断发现"} or {tab = "delivery", label = "补齐验证证据"}
        else
            state, label, tone = "ready", "可以人工验收", "success"
            next = {tab = "acceptance", label = "人工验收"}
        end
    else
        state, label, tone, next = "waiting", "待准备交接", "muted", M.nextActions[r.stage]
    end
    return {state = state, label = label, tone = tone, reasons = reasons, next = next}
end

return M