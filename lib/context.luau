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
function M.lifecycleGuard(s, r)
    local u = s.ui
    local h, t, v = u.handoff, u.trace, u.review
    local req = r or (u.selected and u.byId and u.byId[u.selected]) or nil
    if not u.writable or u.storageUnsafe or u.loading then return "需要可编辑且已刷新的完整项目记录" end
    if u.busy or u.saving or u.dirty then return "先保存或放弃需求编辑草稿，并等待当前操作完成" end
    if not v or not v.safe or v.busy or u.lifecycleBusy then return "审查记录未就绪或操作正在进行" end
    if not h or not h.safe or h.workflowBusy or h.pending or h.pendingSend then return "交接操作或业务请求尚待核对" end
    if not t or not t.safe or t.busy or t.pending or (t.batch and t.batch.state == "running") then return "验证、代码检查或批量操作尚未结束" end
    if s.pending or s.problem or not s.snapshot or s.snapshot.state ~= "idle" then return "来源未就绪、omp 正忙或有桥接请求待核对" end
    local workflow = h.workflow
    if workflow and workflow.requirementId and req and workflow.requirementId ~= req.requirementId then workflow = nil end
    for _, request in workflow and workflow.requests or {} do
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
M.tones = {backlog = "muted", clarifying = "muted", designing = "muted", awaiting_approval = "pending",
    implementing = "muted", verifying = "muted", awaiting_acceptance = "pending", done = "muted", blocked = "warning", cancelled = "muted"}

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

local toneSymbols = {
    success = "✓",
    warning = "!",
    error = "×",
    bad = "×",
    info = "•",
    accent = "•",
    pending = "…",
    muted = "",
}
local function hasToneCue(text: string): boolean
    return text:sub(1, 3) == "✓" or text:sub(1, 2) == "! " or text:sub(1, 2) == "×"
        or text:sub(1, 3) == "•" or text:sub(1, 3) == "…"
end
function M.badgeText(label: string, tone: string?, countOnly: boolean?): string
    local text = tostring(label or "")
    if countOnly or text == "" then return text end
    local cue = toneSymbols[tone or "muted"] or ""
    if cue == "" or hasToneCue(text) then return text end
    return cue .. " " .. text
end
-- Status is information, not a control: a tone-coloured word with its cue, no
-- pill, border, hover or focus target. Tags are the neutral classification chip.
function M.status(label: string, tone: string?, countOnly: boolean?)
    local text = M.badgeText(label, tone, countOnly)
    local token = tone == "pending" and "pending" or (toneSymbols[tone or "muted"] ~= "" and (tone or "muted") or "muted")
    if token == "muted" or token == "bad" then return ui.text({ui.span(text, token == "bad" and "error" or "muted")}) end
    return ui.text({ui.span(text, token)})
end
function M.tag(label: string)
    return ui.badge(tostring(label or ""), "muted")
end
function M.note(s: string?)
    return ui.text({ui.span(s or "", "muted")})
end
-- Render-scoped page contract. A synchronous build sets the one page primary;
-- call sites cannot promote a second action to primary during that build.
M.risk = {
    ["lifecycle-confirm"] = "destructive",
    ["review-reject"] = "destructive",
    ["handoff-revoke"] = "destructive",
}

local function pageOf(s)
    local u = s and s.ui or {}
    if u.formMode then return "form" end
    if u.tab == "design" and u.handoff and u.handoff.tab == "approval" then return "approval" end
    return u.tab or "requirements"
end

local function primaryFor(s)
    local u = s and s.ui or {}
    local page = pageOf(s)
    local r = u.selected and u.byId and u.byId[u.selected] or nil
    if page == "requirements" then return u.writable and "new-requirement" or nil end
    if page == "form" then return "save-requirement" end
    if not r then return nil end
    if page == "design" then
        local proposal = u.handoff and u.handoff.fields and u.handoff.fields.proposal
        return proposal and proposal.text:match("%S") and "handoff-adopt" or "handoff-preview"
    end
    if page == "approval" then
        return M.approvalState(r, u.handoff).valid and "handoff-send" or "handoff-approve"
    end
    if page == "delivery" then
        local preview = u.trace and u.trace.runPreview
        return preview and "results-run-verification" or "results-preview-verification"
    end
    if page == "acceptance" then return "review-accept" end
    if page == "history" then return "audit-write" end
    if page == "activity" then return "activity-write" end
    if page == "session" then return "prefill" end
    return nil
end

function M.beginRender(s)
    M.renderState, M.renderPage, M.renderPrimary = s, pageOf(s), primaryFor(s)
end

function M.button(label: string, act: string, variant: ("default" | "primary" | "quiet" | "danger")?, disabled: (boolean | string)?)
    local kind = M.describeAction(act).kind
    local visual = variant
    if visual == nil or visual == "primary" then
        local isPrimary = M.renderState ~= nil and act == M.renderPrimary
        visual = isPrimary and "primary" or (kind == "navigate" and "quiet" or "default")
    elseif visual == "primary" and M.renderState ~= nil and act ~= M.renderPrimary then
        visual = "default"
    end
    if kind == "navigate" and visual ~= "primary" then visual = "quiet" end
    if kind == "read" and visual == "primary" then visual = "default" end
    if M.risk[act] == "destructive" and visual == "primary" then visual = "danger" end
    return ui.button(label, {key = act, role = "workbench.action." .. kind,
        variant = visual, size = "md", disabled = disabled, actions = {click = act}})
end
function M.row(key: string, children: {any}, props: {[string]: any}?)
    local out = props or {}
    out.key = key
    out.gap = out.gap or "sm"
    if out.wrap == nil then out.wrap = true end
    return ui.node("row", out, children)
end
-- A choice is not a row of buttons. Up to four short options use one native
-- segmented control; more use a native select. Disabled choices render text.
function M.choices(name: string, label: string, value: any, options: {{value: any, label: string}}, disabled: (boolean | string)?)
    local current = tostring(value)
    local currentLabel = current
    for _, option in options do
        if tostring(option.value) == current then currentLabel = option.label end
    end
    if disabled then
        return ui.node("field", {key = name .. "Field", label = label, role = "workbench.choices"},
            {ui.text({ui.span(currentLabel, "muted")})})
    end
    if #options <= 4 then
        local items = {}
        for _, option in options do
            table.insert(items, {id = tostring(option.value), label = option.label})
        end
        return ui.node("field", {key = name .. "Field", label = label, role = "workbench.choices"},
            {ui.node("tabs", {key = name .. "Seg", variant = "segmented", active = current, items = items})})
    end
    local nativeOptions = {}
    for _, option in options do
        table.insert(nativeOptions, {value = tostring(option.value), label = tostring(option.label)})
    end
    return ui.node("field", {key = name .. "Field", label = label, role = "workbench.choices"},
        {ui.node("select", {key = name, value = current, options = nativeOptions, aria = label})})
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
        M.status(M.stageNames[r.stage] or r.stage, stageTone),
        ui.text({ui.span((M.types[r.type] or r.type) .. " · 优先级 " .. (M.priorities[r.priority] or r.priority)
            .. " · " .. M.identity(r), "muted")}),
    }
    local readiness = M.readiness(r, u, s)
    local nextStep = (readiness and readiness.next) or M.nextActions[r.stage]
    local current = opts and opts.current
    local onPage = current and nextStep and nextStep.tab == current.tab
        and ((nextStep.sub or "") == (current.sub or "") or nextStep.sub == nil)
    if nextStep and not onPage then
        table.insert(metaRow, ui.button(nextStep.label, {key = "next-step", variant = "quiet", size = "md",
            role = "workbench.action." .. M.describeAction(M.openAction(nextStep)).kind,
            actions = {click = M.openAction(nextStep)}}))
    end
    local children = {
        ui.node("row", {key = "contextMeta", role = "workbench.contextMeta", gap = "sm", wrap = true}, metaRow),
    }
    if readiness then
        local row = {M.status(readiness.label or "状态未知", readiness.tone or "muted")}
        local reasons = readiness.reasons or {}
        if reasons[1] then
            local extra = #reasons > 1 and ("；另有 " .. tostring(#reasons - 1) .. " 项") or ""
            table.insert(row, ui.text({ui.span(reasons[1] .. extra, "muted")}))
        end
        table.insert(children, ui.node("row", {key = "readinessRow", role = "workbench.readiness", gap = "xs", wrap = true}, row))
    end
    if r.stage == "blocked" and r.blockedReason then
        table.insert(children, ui.text({ui.span("! 阻塞：" .. r.blockedReason, "warning")}))
    end
    local v = u.review
    local guard = M.lifecycleGuard(s)
    local actions = {}
    local allowed = (r.stage == "done" or r.stage == "cancelled")
        and {"reopen"} or (r.stage == "blocked" and {"unblock", "cancel"} or {"block", "cancel"})
    local names = {block = "阻塞", unblock = "解除阻塞", cancel = "取消需求", reopen = "重新打开"}
    for _, action in allowed do
        table.insert(actions, ui.button(names[action] .. "…", {key = "lifecycle-open=" .. action, size = "md",
            disabled = guard, actions = {click = "lifecycle-open=" .. action}}))
    end
    table.insert(children, ui.node("row", {key = "lifecycleActions", gap = "xs", wrap = true}, actions))
    if v and v.lifecycleAction and v.lifecycleRequirement == r.requirementId then
        local f = v.fields.lifecycleReason or {text = ""}
        table.insert(children, ui.node("col", {key = "lifecycleConfirm", role = "workbench.confirmPanel", tone = "warning", gap = "sm"}, {
            ui.text({ui.span("! " .. names[v.lifecycleAction] .. " · 明确确认", "strong")}),
            ui.text("仅改变需求生命周期；不会终止外部进程，也不会撤回已发送请求。历史与旧验收保留。"),
            ui.node("editor", {key = "lifecycleReason", text = f.text, cursor = units(f.text, f.cursor or utf8.len(f.text)),
                anchor = f.anchor and units(f.text, f.anchor) or nil, maxLines = 3, readonly = guard ~= false,
                placeholder = "必填原因，最多 2000 UTF-8 字节", aria = "生命周期变更原因", variant = "field"}),
            M.row("lifecycleConfirmActions", {
                ui.button("确认" .. names[v.lifecycleAction], {key = "lifecycle-confirm", size = "md", variant = "danger",
                    disabled = guard or (not f.text:match("%S") and "先填写原因") or false, actions = {click = "lifecycle-confirm"}}),
                ui.button("返回，不变更", {key = "lifecycle-dismiss", size = "md", actions = {click = "lifecycle-dismiss"}}),
            }, {gap = "xs"}),
        }))
    end
    if u.lifecycleError then table.insert(children, ui.text({ui.span(u.lifecycleError, "error")})) end
    if u.lifecycleNotice then table.insert(children, ui.text({ui.span(u.lifecycleNotice, "muted")})) end
    table.insert(children, M.switcher(u))
    return ui.node("card", {key = "contextBar", role = "workbench.context", tone = stageTone,
        head = {ui.span((r.number or "") .. "  ", "muted"), ui.span(r.title, "strong")}}, children)
end

local function ownedRecord(record, requirementId)
    if type(record) ~= "table" then return nil end
    if record.requirementId ~= requirementId then return nil end
    return record
end

-- Helper for legacy synthetic view fixtures that omit requirementId; rejects mismatched ids.
local function compatibleRecord(record, requirementId)
    if type(record) ~= "table" then return nil end
    if record.requirementId and requirementId and record.requirementId ~= requirementId then return nil end
    return record
end

local function trimmedField(container, name)
    local f = container and container.fields and container.fields[name]
    local text = type(f) == "table" and type(f.text) == "string" and f.text or ""
    return (text:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function currentVerifyMatches(t, req, s, results, cmd, criteriaText)
    local preview = t and t.runPreview
    if type(preview) ~= "table" or preview.command ~= cmd then return false end
    if preview.requirementId and req and preview.requirementId ~= req.requirementId then return false end
    if preview.requirementRevision and req and preview.requirementRevision ~= req.revision then return false end
    local snapshot = results and results.changes and results.changes.fingerprint
    if preview.fingerprint and snapshot and preview.fingerprint ~= snapshot then return false end
    local binding = s and s.payload and s.payload.binding
    if preview.sessionId and binding and binding.sessionId and preview.sessionId ~= binding.sessionId then return false end
    local ids = {}
    for token in criteriaText:gmatch("[^,%s]+") do table.insert(ids, token) end
    local got = preview.criterionIds or {}
    if #ids ~= #got then return false end
    for i = 1, #ids do if ids[i] ~= got[i] then return false end end
    return true
end

function M.pendingBaselineSync(r, h, trace)
    if not r or not h or type(h.workflow) ~= "table" or r.stage == "done" or r.stage == "cancelled" then return nil end
    local wf = ownedRecord(h.workflow, r.requirementId)
    if not wf or type(wf.approval) ~= "table" or type(wf.approval.baseline) ~= "table" then return nil end
    local latest = nil
    for _, req in wf.requests or {} do
        if not latest or (req.createdAt or 0) >= (latest.createdAt or 0) then latest = req end
    end
    if not latest or latest.status ~= "submitted" or latest.activity ~= "implement" then return nil end
    if trace and trace.safe == false then return nil end
    local results = ownedRecord(trace and trace.results, r.requirementId)
    if not results then return nil end
    if results.baseline and results.baseline.requestId == latest.requestId then return nil end
    return {requestId = latest.requestId, baseline = wf.approval.baseline, clearsChanges = results.changes ~= nil}
end

function M.approvalState(r, h)
    if not r or not h then return {valid = false, reason = "not_approved", message = "尚未批准"} end
    local wf = h.workflow
    if wf and wf.requirementId and wf.requirementId ~= r.requirementId then
        return {valid = false, reason = "wrong_requirement", message = "交接记录属于另一项需求"}
    end
    if wf and wf.approval and (wf.requirementId == r.requirementId or wf.approval.baseline ~= nil) then
        return Validity.approval(wf, r, Workflow.requirementContent(r))
    end
    if h.approvalValid ~= nil then
        return {valid = h.approvalValid == true, reason = h.approvalValid and "valid" or "not_approved",
            message = h.approvalReason or (h.approvalValid and "有效批准" or "尚未批准")}
    end
    return Validity.approval(wf, r, Workflow.requirementContent(r))
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
    local workflow = ownedRecord(h and h.workflow, r.requirementId)
    local results = ownedRecord(trace and trace.results, r.requirementId)
    local reviewsData = ownedRecord(review and review.data, r.requirementId)
    local pendingSend = h and h.pendingSend
    if pendingSend and pendingSend.requirementId and pendingSend.requirementId ~= r.requirementId then
        pendingSend = nil
    end
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
    if request.state == "none" and pendingSend and pendingSend.requirementId == r.requirementId
        and (pendingSend.state == "recording_intent" or pendingSend.state == "recovered_intent"
            or pendingSend.state == "intent_unknown" or pendingSend.state == "intent_only"
            or pendingSend.state == "dispatching" or pendingSend.state == "delivery_unknown") then
        request = {state = pendingSend.state, id = pendingSend.requestId, requirementId = r.requirementId,
            createdAt = pendingSend.createdAt or 0}
    end
    local evaluation = Validity.evaluate({requirement = r,
        results = results, reviews = reviewsData,
        workflow = workflow, content = workflow and Workflow.requirementContent(r)})
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
            lifecycle = r.stage, request = request, connection = connection, evaluation = evaluation}
    end
    if (trace and trace.safe == false) or (review and review.safe == false) or (h and h.safe == false) then
        return result("unknown", "记录无法读取", "error",
            {"当前需求的部分记录无法安全读取；未推断任何通过状态。"},
            {tab = "requirement", label = "检查记录"})
    end
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

M.actionKinds = {navigate = true, read = true, edit = true, decide = true, execute = true}

type ActionSpec = {
    kind: string, target: string, mutatesRevision: boolean, writesFiles: boolean,
    requiresLock: boolean, requiresSource: boolean, idempotency: string, impact: string,
}

local function makeSpec(kind: string, target: string, mutatesRevision: boolean, writesFiles: boolean,
    requiresLock: boolean, requiresSource: boolean, idempotency: string, impact: string): ActionSpec
    return {kind = kind, target = target, mutatesRevision = mutatesRevision, writesFiles = writesFiles,
        requiresLock = requiresLock, requiresSource = requiresSource, idempotency = idempotency, impact = impact}
end

local exactSpecs: {[string]: ActionSpec} = {
    requirement = makeSpec("navigate", "requirement", false, false, false, false, "ui_only", "切换所选需求视图，不修改业务修订"),
    back = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "返回工作区，不保存草稿修改"),
    ["back-workspace"] = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "返回需求列表并保留筛选位置"),
    ["home-filter"] = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "展开或收起首页筛选面板，不修改需求"),
    ["more-toggle"] = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "展开或收起项目菜单，不修改需求"),
    ["clear-filters"] = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "清除本地搜索与筛选，不修改需求"),
    ["new-requirement"] = makeSpec("navigate", "requirement", false, false, false, false, "ui_only", "打开新建需求表单，暂未写入实体"),
    ["edit-requirement"] = makeSpec("navigate", "requirement", false, false, false, false, "ui_only", "打开需求编辑表单，暂未写入实体"),
    ["handoff-prepare"] = makeSpec("navigate", "workflow", false, false, false, false, "ui_only", "打开交接准备面板，不生成意图或发送"),
    ["open-handoff"] = makeSpec("navigate", "workflow", false, false, false, false, "ui_only", "展开交接准备面板，不修改业务状态"),
    ["lifecycle-dismiss"] = makeSpec("navigate", "requirement", false, false, false, false, "ui_only", "取消生命周期确认弹层，不变更阶段"),
    ["review-cancel"] = makeSpec("navigate", "reviews", false, false, false, false, "ui_only", "关闭当前处置或确认面板，不写入决定"),
    reload = makeSpec("read", "project", false, false, false, false, "readonly", "重读项目存储与会话快照，不增加实体修订"),
    ["audit-refresh"] = makeSpec("read", "project", false, false, false, false, "readonly", "重新扫描当前需求的审计事件，不写入文件"),
    ["audit-copy"] = makeSpec("read", "export", false, false, false, false, "readonly", "复制审计摘要到剪贴板，不写入项目文件"),
    ["activity-refresh"] = makeSpec("read", "project", false, false, false, false, "readonly", "重新扫描项目活动记录，不写入文件"),
    ["handoff-preview"] = makeSpec("read", "workflow", false, false, true, true, "volatile_read", "请求来源生成只读交接预览，不增加修订也不发送"),
    ["handoff-baseline"] = makeSpec("read", "workflow", false, false, true, true, "volatile_read", "请求来源只读检查 Git 基线，不写入修订"),
    ["handoff-candidate"] = makeSpec("read", "workflow", false, false, true, true, "volatile_read", "从来源只读获取最新回复候选，不自动采用"),
    ["handoff-import-file"] = makeSpec("read", "workflow", false, false, true, true, "volatile_read", "从来源只读检查项目文件预览，不修改正式方案"),
    ["results-preview-verification"] = makeSpec("read", "results", false, false, true, false, "volatile_read", "绑定当前快照生成验证命令预览，不运行命令也不写入修订"),
    ["results-import-preview"] = makeSpec("read", "results", false, false, true, true, "volatile_read", "只读检查外部计划候选 JSON，不写入计划修订"),
    ["review-import-preview"] = makeSpec("read", "reviews", false, false, true, true, "volatile_read", "只读检查外部审查候选 JSON，不写入审查修订"),
    ["prefill-selected"] = makeSpec("edit", "ui", false, false, false, false, "ui_only", "填充本地会话输入草稿，不投递也不写业务记录"),
    ["handoff-import-file-content"] = makeSpec("edit", "workflow", false, false, true, false, "draft_only", "将文件预览填入方案草稿框，不自动采用为正式版本"),
    ["handoff-import-candidate"] = makeSpec("edit", "workflow", false, false, true, false, "draft_only", "将回复候选填入方案草稿框，不自动采用为正式版本"),
    ["results-batch-add"] = makeSpec("edit", "results", false, false, true, false, "draft_only", "将验证项加入本地批量队列草稿，尚未运行"),
    ["review-add-finding"] = makeSpec("edit", "reviews", false, false, true, false, "draft_only", "添加本地审查发现草稿条目，尚未正式提交"),
    rebase = makeSpec("edit", "requirement", false, false, true, false, "draft_only", "用当前持久化修订重设本地表单基线"),
    ["enable-edit"] = makeSpec("edit", "project", false, true, false, false, "lock_acquire", "申请项目编辑锁；不授权实施或命令执行"),
    ["save-requirement"] = makeSpec("edit", "requirement", true, true, true, false, "cas_revision", "保存需求并递增实体与内容修订（CAS 校验）"),
    ["resources-add"] = makeSpec("edit", "resources", true, true, true, false, "cas_revision", "追加项目/需求绑定资源并使旧预览失效"),
    ["handoff-comment"] = makeSpec("edit", "workflow", true, true, true, false, "cas_revision", "追加当前正式方案版本的批注并写入工作流"),
    ["results-plan-add"] = makeSpec("edit", "results", true, true, true, false, "cas_revision", "向运行计划追加稳定步骤并递增计划修订"),
    ["results-plan-generate"] = makeSpec("edit", "results", true, true, true, false, "cas_revision", "由当前需求结构化生成计划步骤并递增计划修订"),
    ["results-plan-links"] = makeSpec("edit", "results", true, true, true, false, "cas_revision", "保存所选步骤的验收条件与文件关联并递增计划修订"),
    initialize = makeSpec("decide", "project", false, true, false, false, "guard_lock", "初始化项目工作台目录与项目锁文件"),
    takeover = makeSpec("decide", "project", false, true, false, false, "guard_lock", "明确接管已有编辑锁"),
    ["takeover-initialize"] = makeSpec("decide", "project", false, true, false, false, "guard_lock", "接管过期锁并初始化项目存储"),
    ["handoff-adopt"] = makeSpec("decide", "workflow", true, true, true, false, "cas_revision", "将草稿采用为不可变正式方案版本，可能推动阶段与工作流"),
    ["handoff-approve"] = makeSpec("decide", "workflow", true, true, true, false, "cas_revision", "记录针对最新正式方案与 Git 基线的有效实施授权，不启动模型"),
    ["handoff-authorize-direct"] = makeSpec("decide", "workflow", true, true, true, false, "cas_revision", "记录显式直接实施授权事实，不自动发送或执行"),
    ["handoff-revoke"] = makeSpec("decide", "workflow", true, true, true, false, "cas_revision", "追加撤销授权记录并使既有实施批准失效"),
    ["handoff-end-wait"] = makeSpec("decide", "workflow", true, true, true, false, "request_id", "仅在本地结束等待并记录对账状态，不终止外部进程"),
    ["acknowledge-unknown"] = makeSpec("decide", "workflow", true, true, true, false, "request_id", "记录人工对未知投递结果的对账确认，不会重发原请求"),
    ["results-import-adopt"] = makeSpec("decide", "results", true, true, true, false, "content_fingerprint", "按冻结身份与快照校验采用外部计划候选（同 ID 同指纹返回既有）"),
    ["review-create"] = makeSpec("decide", "reviews", true, true, true, false, "cas_revision", "针对当前代码快照写入正式审查记录（递增审查修订）"),
    ["review-dispose"] = makeSpec("decide", "reviews", true, true, true, false, "cas_revision", "追加审查发现的处置决定事件"),
    ["review-accept"] = makeSpec("decide", "reviews", true, true, true, false, "cas_revision", "门禁通过后记录人工接受决定，并将需求阶段更新为已完成"),
    ["review-reject"] = makeSpec("decide", "reviews", true, true, true, false, "cas_revision", "记录人工驳回决定并要求补充实施或验证"),
    ["review-reopen"] = makeSpec("decide", "reviews", true, true, true, false, "cas_revision", "重新打开已完成需求，保留旧验收但不复活有效性"),
    ["review-import-adopt"] = makeSpec("decide", "reviews", true, true, true, false, "content_fingerprint", "按冻结身份与快照校验采用外部审查候选"),
    ["lifecycle-confirm"] = makeSpec("decide", "requirement", true, true, true, false, "cas_revision", "记录需求生命周期变更（阻塞/解阻/取消/重开），不终止外部进程"),
    prefill = makeSpec("execute", "runtime", false, false, false, true, "request_id", "通过 IPC 将草稿写入绑定会话输入框，不按 Enter 推理"),
    ["handoff-prefill"] = makeSpec("execute", "runtime", false, false, true, true, "request_id", "通过 IPC 将交接预览预填到绑定会话输入框，不触发推理"),
    ["review-open-native"] = makeSpec("execute", "runtime", false, false, false, true, "request_id", "通过 IPC 预填 /review 命令到绑定会话，不自动发送"),
    ["handoff-send"] = makeSpec("execute", "runtime", true, true, true, true, "request_id", "先持久化业务发送意图，再通过 IPC 投递并触发绑定会话推理"),
    ["results-refresh-changes"] = makeSpec("execute", "results", true, true, true, true, "snapshot_command", "显式通过来源观测 Git 变更并写入 results 快照（递增结果修订）"),
    ["handoff-reconcile-baseline"] = makeSpec("execute", "results", true, true, true, false, "request_id", "显式补记已提交实施的 Git 基线到 results（递增结果修订并清空旧变更缓存）"),
    ["results-run-verification"] = makeSpec("execute", "results", true, true, true, true, "preview_bound", "真实执行预览绑定的验证命令，将退出码与输出写入证据并递增结果修订"),
    ["results-batch-start"] = makeSpec("execute", "results", true, true, true, true, "serial_queue", "按预览队列串行启动多条验证命令，写入证据与结果修订"),
    ["results-batch-stop"] = makeSpec("execute", "results", false, false, false, false, "ui_only", "仅停止继续调度下一条队列命令，不终止已运行进程"),
    ["audit-write"] = makeSpec("execute", "export", false, true, false, false, "export_file", "将当前需求脱敏审计摘要导出到项目本地文件"),
    ["activity-write"] = makeSpec("execute", "export", false, true, false, false, "export_file", "将项目脱敏活动记录导出到项目本地文件"),
}

function M.describeAction(act: string)
    if exactSpecs[act] then
        local spec = table.clone(exactSpecs[act])
        spec.action = act
        return spec
    end
    local spec: ActionSpec
    if act:match("^wb%-open%-") or act:match("^requirement=") or act:match("^lifecycle%-open=")
        or act:match("^review%-pick=") or act:match("^review%-inline=") or act:match("^review%-toggle=") then
        spec = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "仅页面或条目导航，不修改业务实体或文件")
    elseif act:match("^change:status%-") then
        spec = makeSpec("edit", "results", true, true, true, false, "cas_revision", "更新运行计划步骤状态并递增计划修订")
    elseif act:match("^change:") then
        spec = makeSpec("navigate", "ui", false, false, false, false, "ui_only", "调整本地视图筛选、排序或选择，不写业务记录")
    elseif act:match("^resources%-remove=") then
        spec = makeSpec("edit", "resources", true, true, true, false, "cas_revision", "解绑资源记录并递增资源修订")
    elseif act:match("^results%-use%-candidate=") or act:match("^results%-batch%-remove=")
        or act:match("^review%-fix%-draft=") or act:match("^review%-remove%-finding=") then
        spec = makeSpec("edit", "ui", false, false, true, false, "draft_only", "修改本地表单或队列草稿，尚未持久化或发送")
    else
        spec = makeSpec("edit", "ui", false, false, true, false, "unknown", "工作台操作")
    end
    local result = table.clone(spec)
    result.action = act
    return result
end

function M.formatFailure(gate)
    if not gate or gate.allowed then return "" end
    local failure = gate.failure
    if failure and failure.recovery and failure.recovery ~= "" then
        return (failure.message or gate.reason or "操作不可用") .. "（" .. failure.recovery .. "）"
    end
    return (failure and failure.message) or gate.reason or "当前状态不允许执行此操作"
end

function M.evaluateAction(act: string, s, r, opts)
    local spec = M.describeAction(act)
    local u = s and s.ui or {}
    local req = r or (u.selected and u.byId and u.byId[u.selected]) or nil
    local h, t, v = u.handoff, u.trace, u.review
    local wf = req and compatibleRecord(h and h.workflow, req.requirementId) or nil
    local results = req and compatibleRecord(t and t.results, req.requirementId) or nil
    local reviewsData = req and compatibleRecord(v and v.data, req.requirementId) or nil
    local projectId = (req and req.projectId) or (s and s.payload and s.payload.binding and s.payload.binding.projectId)
    local target = {scope = spec.target, projectId = projectId, requirementId = req and req.requirementId}
    if act == "wb-open-implementation" then
        target.scope = "workflow"
    end

    local gate = {action = act, spec = spec, kind = spec.kind, target = target,
        allowed = true, reason = nil :: string?, failure = nil :: {code: string, message: string, recovery: string?}?,
        readiness = nil :: any, approval = nil :: any, acceptance = nil :: any, sync = nil :: any}

    local function deny(code: string, message: string, recovery: string?)
        gate.allowed = false
        gate.reason = message
        gate.failure = {code = code, message = message, recovery = recovery}
        return gate
    end

    if act == "wb-open-implementation" then
        if not req then return deny("missing_requirement", "先选择一项需求", "从工作首页选择需求") end
        local readiness = M.readiness(req, u, s)
        gate.readiness = readiness
        if h and (h.pending or h.pendingSend) then
            return deny("pending_request", "已有交接或发送请求待核对", "先完成或对账当前请求")
        end
        if readiness and readiness.request and readiness.request.state ~= "none" then
            return deny("unresolved_request", readiness.reasons[1] or "存在待核对原请求", "先到资料页核对原请求结果")
        end
        if readiness and readiness.connection and readiness.connection.state ~= "connected" then
            return deny("source_unavailable", readiness.reasons[1] or "来源连接不可用", "在会话页检查或重新连接来源")
        end
        if not readiness or not readiness.next or readiness.next.activity ~= "implement" then
            return deny("approval_required", "尚未具备当前有效的实施授权", "先在批准页完成基线检查与批准")
        end
        return gate
    end

    if act == "handoff-baseline" or act == "handoff-preview" or act == "handoff-candidate" or act == "handoff-import-file" then
        if not u.writable or not h or not h.safe or not req then
            return deny("readonly_or_unsafe", "请启用项目编辑并选择有效需求", "在顶栏启用编辑模式")
        end
        if s and s.problem then return deny("source_problem", s.problem, "恢复来源连接后再试") end
        if h.pending or h.pendingSend then
            return deny("pending_request", "已有请求待核对；不会重复请求", "先等待回执或到交接状态卡对账")
        end
        return gate
    end

    if act == "handoff-prefill" or act == "handoff-send" then
        if not u.writable or not h or not h.safe or not req then
            return deny("readonly_or_unsafe", "请启用项目编辑并选择有效需求", "在顶栏启用编辑模式")
        end
        if s and s.problem then return deny("source_problem", s.problem, "恢复来源连接后再试") end
        if h.pending or h.pendingSend then
            return deny("pending_request", "已有请求待核对；不会重复发送", "先核对当前在途或未知投递请求")
        end
        local preview = h.preview
        if not preview or h.previewStale then
            return deny("preview_stale", "当前预览已过期或尚未生成，请重新生成完整预览", "点击“重新生成完整预览”")
        end
        if preview.requirementId and preview.requirementId ~= req.requirementId then
            return deny("preview_wrong_requirement", "此预览属于另一项需求；已拒绝发送，请针对当前需求重新生成预览", "为当前需求重新生成完整预览")
        end
        if opts and opts.requireToken then
            if type(preview.previewToken) ~= "string" or #preview.previewToken == 0 then
                return deny("preview_token_missing", "此预览令牌已失效；请显式重新生成完整预览", "重新生成预览以获取新令牌")
            end
            if type(preview.sha256) ~= "string" or #preview.sha256 ~= 64 then
                return deny("preview_sha_missing", "预览缺少完整 SHA-256；请重新生成", "重新生成预览")
            end
        end
        if not s or not s.snapshot or s.snapshot.state ~= "idle" then
            return deny("session_not_idle", "目标 omp 当前非空闲；保留预览，不发送", "等待目标会话空闲后再发送")
        end
        if act == "handoff-send" and preview.activity == "implement" then
            local approval = M.approvalState(req, h)
            gate.approval = approval
            if not approval.valid then
                local suffix = approval.message and ("（" .. approval.message .. "）") or ""
                return deny("approval_invalid", "实施未获当前有效批准；先批准正式方案，或单独记录直接实施授权" .. suffix, "前往批准页检查基线并授权")
            end
        end
        return gate
    end

    if act == "handoff-approve" then
        if not u.writable or not h or not h.safe or not req then
            return deny("readonly_or_unsafe", "工作流不可写；请启用项目编辑并确认记录完整", "启用项目编辑并刷新记录")
        end
        if h.workflowBusy then return deny("workflow_busy", "工作流写入正在进行，请稍候", nil) end
        if h.pending or h.pendingSend then
            return deny("pending_request", "已有来源请求或业务发送尚待核对；不会修改方案或提交新操作", "先完成当前请求对账")
        end
        if not h.selectedDesign then return deny("no_selected_design", "请先选择正式方案版本", "在方案区采用并选择最新版本") end
        if not wf or h.selectedDesign.version ~= wf.latestVersion then
            return deny("not_latest_design", "只能批准当前最新采用的正式方案版本", "切换到最新方案版本")
        end
        if not h.baseline or not h.baselineCheckedAt then
            return deny("baseline_unchecked", "批准前必须通过来源命令检查当前 Git 基线", "点击“检查最新 Git 基线”")
        end
        gate.approval = M.approvalState(req, h)
        return gate
    end

    if act == "handoff-revoke" then
        if not u.writable or not h or not h.safe or not req then
            return deny("readonly_or_unsafe", "工作流不可写；请启用项目编辑并确认记录完整", nil)
        end
        if h.workflowBusy then return deny("workflow_busy", "工作流写入正在进行，请稍候", nil) end
        if h.pending or h.pendingSend then
            return deny("pending_request", "已有来源请求或业务发送尚待核对；不会修改方案或提交新操作", nil)
        end
        if not wf or not wf.approval then return deny("no_approval", "当前没有可撤销的批准记录", nil) end
        if not trimmedField(h, "revokeReason"):match("%S") then
            return deny("reason_required", "请填写撤销理由后再确认", "在撤销理由输入框写明原因")
        end
        return gate
    end

    if act == "handoff-authorize-direct" then
        if not u.writable or not h or not h.safe or not req then
            return deny("readonly_or_unsafe", "工作流不可写；请启用项目编辑并确认记录完整", nil)
        end
        if h.workflowBusy then return deny("workflow_busy", "工作流写入正在进行，请稍候", nil) end
        if h.pending or h.pendingSend then
            return deny("pending_request", "已有来源请求或业务发送尚待核对；不会修改方案或提交新操作", nil)
        end
        if not h.baseline or not h.baselineCheckedAt then
            return deny("baseline_unchecked", "直接授权前必须通过来源命令检查当前 Git 基线", "点击“检查最新 Git 基线”")
        end
        if not trimmedField(h, "directReason"):match("%S") then
            return deny("reason_required", "直接实施必须明确填写授权理由", "输入非空直接授权理由")
        end
        if type(req.scope) ~= "string" or not req.scope:match("%S")
            or type(req.acceptanceCriteria) ~= "table" or #req.acceptanceCriteria == 0 then
            return deny("scope_or_criteria_missing", "直接实施必须在需求中提供范围与至少一条验收条件", "补充需求范围与验收条件后再授权")
        end
        return gate
    end

    if act == "handoff-reconcile-baseline" then
        if not req or not u.writable or not t or not t.safe or (opts and opts.requireToken and not u.token) then
            return deny("readonly_or_unsafe", "只读或结果记录未就绪，无法补记基线", "启用编辑并确认结果记录可读")
        end
        if t.busy or t.pending then return deny("trace_busy", "已有代码或来源检查正在进行，请稍候", nil) end
        local sync = M.pendingBaselineSync(req, h, t)
        if not sync then return deny("nothing_to_reconcile", "没有待补记的已提交实施基线", nil) end
        gate.sync = sync
        target.requestId = sync.requestId
        return gate
    end

    if act == "results-refresh-changes" then
        if not req or not u.writable or not t or not t.safe then
            return deny("readonly_or_unsafe", "只读或记录未就绪", "启用编辑并选择需求")
        end
        if s and s.problem then return deny("source_problem", s.problem, "恢复来源连接后再刷新快照") end
        if t.pending then return deny("pending_request", "已有来源检查待核对；不会重复发送", "等待当前检查回执") end
        if t.busy then return deny("trace_busy", "当前操作尚未完成", nil) end
        return gate
    end

    if act == "results-preview-verification" or act == "results-run-verification" then
        if not req or not u.writable or not t or not t.safe then
            return deny("readonly_or_unsafe", "只读或记录未就绪", "启用编辑并选择需求")
        end
        if t.pending then return deny("pending_request", "已有来源请求待核对", "等待当前检查回执") end
        if t.busy then return deny("trace_busy", "当前操作尚未完成", nil) end
        local cmd = trimmedField(t, "verifyCommand")
        if not cmd:match("%S") then return deny("command_required", "先填写验证命令", "输入白名单允许的验证命令") end
        if not results then return deny("results_unloaded", "先读取代码变化，取得快照", "点击刷新代码变化取得快照") end
        if act == "results-run-verification" then
            if s and s.problem then return deny("source_problem", s.problem, "恢复来源连接后再运行") end
            if not t.runPreview then return deny("preview_required", "先预览确切命令", "点击“预览验证命令”") end
            local criteriaText = trimmedField(t, "verifyCriteria")
            if not currentVerifyMatches(t, req, s, results, cmd, criteriaText) then
                return deny("preview_mismatch", "预览上下文已变化，请重新预览", "命令或关联条件已改，请重新预览")
            end
        end
        return gate
    end

    if act == "review-accept" then
        if not req or not u.writable or not v or not v.safe then
            return deny("readonly_or_unsafe", "只读或记录未就绪", "启用编辑并确认审查记录可读")
        end
        if v.busy then return deny("review_busy", "审查记录操作正在进行，请稍候", nil) end
        if t and t.safe == false then return deny("results_unsafe", "结果记录损坏或未就绪，禁止验收", "修复或重新读取结果记录") end
        if req.stage ~= "implementing" and req.stage ~= "verifying" and req.stage ~= "awaiting_acceptance" then
            return deny("invalid_stage", "当前阶段不允许接受；请先重新实施或刷新需求", nil)
        end
        local acceptance = Validity.acceptance(req, results, reviewsData)
        gate.acceptance = acceptance
        if not acceptance.ok then
            return deny("gate_blocked", table.concat(acceptance.problems, "；"), "补齐快照/验证证据并处置全部阻断发现")
        end
        return gate
    end

    if act == "review-reject" then
        if not req or not u.writable or not v or not v.safe then
            return deny("readonly_or_unsafe", "只读或记录未就绪", nil)
        end
        if v.busy then return deny("review_busy", "审查记录操作正在进行，请稍候", nil) end
        if t and t.safe == false then return deny("results_unsafe", "结果记录损坏或未就绪", nil) end
        if req.stage ~= "implementing" and req.stage ~= "verifying" and req.stage ~= "awaiting_acceptance" then
            return deny("invalid_stage", "当前阶段不能驳回", nil)
        end
        if not results or not results.changes or type(results.changes.fingerprint) ~= "string" then
            return deny("snapshot_missing", "先读取代码快照", "到交付页读取当前代码变化")
        end
        if not trimmedField(v, "reviewReject"):match("%S") then
            return deny("reason_required", "先填写驳回原因", "填写具体驳回理由与退回阶段说明")
        end
        return gate
    end

    if act == "review-reopen" then
        local guard = M.lifecycleGuard(s, req)
        if guard then return deny("lifecycle_guard", guard, "先保存草稿或处理未决请求") end
        if not req or req.stage ~= "done" then
            return deny("invalid_stage", "只有已完成需求可以重新打开", nil)
        end
        if not trimmedField(v, "lifecycleReason"):match("%S") then
            return deny("reason_required", "先填写重新打开原因", "写明重新打开原因")
        end
        return gate
    end

    if spec.requiresLock and not u.writable then
        return deny("lock_required", "当前处于只读模式；请先启用项目编辑", "点击启用编辑获取项目锁")
    end
    if spec.requiresSource and s and s.problem then
        return deny("source_problem", s.problem, "等待或恢复来源连接")
    end
    return gate
end

return M