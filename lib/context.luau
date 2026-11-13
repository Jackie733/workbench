--!strict
-- Shared requirement context: stage vocabulary, workflow stepper and the
-- context bar that keeps the selected requirement visible on every page.
local ui = tern.ui
local Validity = require("./validity")
local Workflow = require("./workflow")
local M = {}
function M.identity(record)
    local content = record.requirementContentRevision or record.contentRevision
    return "实体修订 " .. tostring(record.requirementRevision or record.revision)
        .. (content and (" · 内容修订 " .. tostring(content)) or " · 旧记录：未标记内容身份（按实体修订核对）")
end
function M.lifecycleGuard(s)
    local u = s.ui
    local h, t, v = u.handoff, u.trace, u.review
    if not u.writable or u.storageUnsafe or u.loading then return "需要可编辑且已刷新的完整项目记录" end
    if u.busy or u.saving or u.dirty then return "先保存或放弃需求编辑草稿，并等待当前操作完成" end
    if not v or not v.safe or v.busy or u.lifecycleBusy then return "审查记录未就绪或操作正在进行" end
    if not h or not h.safe or h.workflowBusy or h.pending or h.pendingSend then return "交接操作或业务请求尚待核对" end
    if not t or not t.safe or t.busy or t.pending or (t.batch and t.batch.state == "running") then return "验证、代码检查或批量操作尚未结束" end
    if s.pending or s.problem or not s.snapshot or s.snapshot.state ~= "idle" then return "来源未就绪、omp 正忙或有桥接请求待核对" end
    for _, request in h.workflow and h.workflow.requests or {} do
        if (request.status == "pending" or request.status == "delivery_unknown")
            and (not request.resolution or request.resolution.kind ~= "user_acknowledged") then
            return "存在未完成人工对账的业务请求"
        end
    end
    return false
end

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
function M.openAction(target: {tab: string, sub: string?, activity: string?})
    if target.activity == "implement" then return "wb-open-implementation" end
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
            .. " · " .. M.identity(r), "muted")}),
    }
    local readiness = M.readiness(r, u, s)
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
    local v = u.review
    local guard = M.lifecycleGuard(s)
    local actions = {}
    local allowed = (r.stage == "done" or r.stage == "cancelled")
        and {"reopen"} or (r.stage == "blocked" and {"unblock", "cancel"} or {"block", "cancel"})
    local names = {block = "阻塞", unblock = "解除阻塞", cancel = "取消需求", reopen = "重新打开"}
    for _, action in allowed do
        table.insert(actions, ui.button(names[action] .. "…", {key = "lifecycle-open=" .. action, size = "sm",
            disabled = guard, actions = {click = "lifecycle-open=" .. action}}))
    end
    table.insert(children, ui.node("row", {key = "lifecycleActions", gap = "xs", wrap = true}, actions))
    if v and v.lifecycleAction and v.lifecycleRequirement == r.requirementId then
        local f = v.fields.lifecycleReason or {text = ""}
        table.insert(children, ui.node("card", {key = "lifecycleConfirm", head = names[v.lifecycleAction] .. " · 明确确认", tone = "warning"}, {
            ui.text("仅改变需求生命周期；不会终止外部进程，也不会撤回已发送请求。历史与旧验收保留。"),
            ui.node("editor", {key = "lifecycleReason", text = f.text, cursor = units(f.text, f.cursor or utf8.len(f.text)),
                anchor = f.anchor and units(f.text, f.anchor) or nil, maxLines = 3, readonly = guard ~= false,
                placeholder = "必填原因，最多 2000 UTF-8 字节", aria = "生命周期变更原因", variant = "field"}),
            ui.button("确认" .. names[v.lifecycleAction], {key = "lifecycle-confirm", size = "sm", variant = "danger",
                disabled = guard or (not f.text:match("%S") and "先填写原因") or false, actions = {click = "lifecycle-confirm"}}),
            ui.button("返回，不变更", {key = "lifecycle-dismiss", size = "sm", actions = {click = "lifecycle-dismiss"}}),
        }))
    end
    if u.lifecycleError then table.insert(children, ui.text({ui.span(u.lifecycleError, "error")})) end
    if u.lifecycleNotice then table.insert(children, ui.text({ui.span(u.lifecycleNotice, "muted")})) end
    table.insert(children, M.switcher(u))
    return ui.node("card", {key = "contextBar", role = "workbench.context", tone = stageTone,
        head = {ui.span((r.number or "") .. "  ", "muted"), ui.span(r.title, "strong")}}, children)
end

-- Read-only readiness for one requirement, derived at render time from the same
-- validity evaluation the Delivery list and the acceptance action use. It never
-- writes a stage or revision; unknown facts stay unknown instead of green.
function M.readiness(r, u, source)
    if not r then return nil end
    local trace = u and u.trace
    local review = u and u.review
    local h = u and u.handoff
    -- Only consume records explicitly belonging to this requirement. The
    -- selected page and the session's current tool are not ownership proofs.
    local workflow = h and h.workflow
    if workflow and workflow.requirementId ~= r.requirementId then workflow = nil end
    local connection = {state = "unknown"}
    if source then
        local snapshot = source.snapshot
        connection = {state = snapshot and snapshot.state == "disconnected" and "disconnected"
                or ((source.problem or not snapshot) and "stale" or "connected"),
            runState = snapshot and snapshot.state, observedAt = snapshot and snapshot.updatedAt,
            reason = source.problem}
    end
    local request = {state = "none"}
    for _, item in workflow and workflow.requests or {} do
        if not item.resolution and (item.status == "pending" or item.status == "delivery_unknown")
            and (not request.createdAt or (item.createdAt or 0) >= request.createdAt) then
            request = {state = item.status, id = item.requestId, requirementId = r.requirementId,
                createdAt = item.createdAt or 0}
        end
    end
    local function result(state, label, tone, reasons, next)
        if state ~= "done" and state ~= "cancelled" then
            if request.state ~= "none" then
                state, label, tone = "waiting", "请求结果待核对", "warning"
                reasons = {"先核对原请求结果；不会自动重发。"}
                next = {tab = "design", sub = "materials", label = "查看请求结果"}
            elseif source and connection.state ~= "connected" then
                state, label, tone = "unknown", "来源连接不可用", "warning"
                reasons = {connection.reason or "缺少新鲜来源；保留最后已知事实。"}
                next = {tab = "session", label = "查看连接"}
            end
        end
        if next then
            next = table.clone(next)
            next.kind, next.target = "navigate", r.requirementId
        end
        return {state = state, label = label, tone = tone, reasons = reasons, next = next,
            lifecycle = r.stage, request = request, connection = connection}
    end
    if (trace and trace.safe == false) or (review and review.safe == false) or (h and h.safe == false) then
        return result("unknown", "记录无法读取", "error",
            {"当前需求的部分记录无法安全读取；未推断任何通过状态。"},
            {tab = "requirement", label = "检查记录"})
    end
    local evaluation = Validity.evaluate({requirement = r,
        results = trace and trace.results, reviews = review and review.data,
        workflow = workflow, content = workflow and Workflow.requirementContent(r)})
    local gate, approval = evaluation.acceptance, evaluation.approval
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
            next = {tab = "design", sub = "materials", activity = "implement", label = "查看实施准备"}
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
    return result(state, label, tone, reasons, next)
end

return M