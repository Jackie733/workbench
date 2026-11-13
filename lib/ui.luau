--!strict
local ui = tern.ui
local context = require("./context")
local handoff = require("./handoff")
local runview = require("./runview")
local reviewview = require("./reviewview")
local auditview = require("./auditview")
local Audit = require("./audit")
local function units(text, position)
    local n, index = 0, 0
    for _, code in utf8.codes(text) do
        if index >= position then break end
        n += if code > 0xFFFF then 2 else 1
        index += 1
    end
    return n
end
local M = {}
local stages, stageNames = context.stages, context.stageNames
local priorities, types, tones = context.priorities, context.types, context.tones
local function note(s) return ui.text({ui.span(s or "", "muted")}) end
-- Secondary actions stay visible: a bare "quiet" button is a discoverability trap.
local function button(label, act, variant, disabled)
    return ui.button(label, {key = act, variant = variant or "default", size = "sm", disabled = disabled,
        actions = {click = act}})
end
local function row(key, children, props)
    props = props or {}; props.key = key; props.gap = props.gap or "sm"; props.wrap = true
    return ui.node("row", props, children)
end
-- A visible set of choices instead of a popup: no menu can be clipped by a split,
-- and the selected state is readable at a glance. Actions replay the same change
-- names the select controls used, through `change:<name>=<value>`.
local function choices(name, label, value, options, disabled)
    local chips = {}
    for _, option in options do
        local selected = tostring(value) == tostring(option.value)
        table.insert(chips, ui.button(option.label, {key = name .. "-" .. tostring(option.value),
            variant = selected and "primary" or "default", size = "sm", on = selected, disabled = disabled,
            actions = {click = "change:" .. name .. "=" .. tostring(option.value)}}))
    end
    return ui.node("field", {key = name .. "Field", label = label, role = "workbench.choices"},
        {row(name, chips, {gap = "xs"})})
end
local function excerpt(text, bound)
    text = tostring(text or "")
    if #text <= bound then return text end
    local n = bound
    while n > 0 and not utf8.len(text:sub(1, n)) do n -= 1 end
    return text:sub(1, n) .. "…"
end
local function requirements(s)
    local visible = {}
    local q = (s.query or ""):lower()
    for _, r in s.requirements or {} do
        local priorityOk = s.priorityFilter == "all" or r.priority == s.priorityFilter
        local stageOk = s.stageFilter == "all" or r.stage == s.stageFilter
        local text = table.concat({r.title or "", r.goal or "", table.concat(r.labels or {}, " "), r.number or ""}, " "):lower()
        if priorityOk and stageOk and (q == "" or text:find(q, 1, true)) then table.insert(visible, r) end
    end
    return visible
end
local function rowItem(r)
    return ui.node("item", {key = r.requirementId, label = r.title, icon = "chevron",
        detail = (r.number or "") .. " · " .. (stageNames[r.stage] or r.stage),
        value = priorities[r.priority] or r.priority, tone = tones[r.stage]})
end
local function fieldEditor(s, key, label, placeholder, multiline)
    local f = s.fields[key] or {text = "", cursor = 0}
    local lines = if key == "goal" or key == "scope" then 5 else 8
    local editor = ui.node(multiline and "editor" or "input", {key = "f-" .. key, text = f.text,
        cursor = units(f.text, f.cursor or utf8.len(f.text)), anchor = f.anchor and units(f.text, f.anchor) or nil,
        maxLines = multiline and lines or nil, readonly = not s.writable or s.saving == true,
        placeholder = placeholder, aria = label, variant = "field"})
    return ui.node("field", {key = "wrap-" .. key, label = label, required = key == "title" or key == "goal"}, {editor})
end
local function form(s)
    local locked = not s.writable and "只读模式：先在页首取得编辑权" or (s.saving == true and "正在保存，暂不能修改" or false)
    local nodes = {ui.text({ui.span(s.mode == "new" and "新建需求" or "编辑需求", "title")}),
        note(s.mode == "new" and "先写清目标与验收条件；创建后按“资料 → 方案 → 批准 → 实施 → 验收”推进。"
            or "保存会生成新的修订；正在进行的批准和证据会按内容摘要失效。")}
    table.insert(nodes, fieldEditor(s, "title", "标题 · 必填", "一句话描述要解决的问题", false))
    table.insert(nodes, choices("type", "类型", s.type, {
        {value = "feature", label = "功能"}, {value = "bug", label = "缺陷"}, {value = "chore", label = "维护"}}, locked))
    table.insert(nodes, choices("priority", "优先级", s.priority, {
        {value = "low", label = "低"}, {value = "normal", label = "普通"}, {value = "high", label = "高"}, {value = "urgent", label = "紧急"}}, locked))
    table.insert(nodes, fieldEditor(s, "goal", "目标 · 必填", "希望达成的结果", true))
    table.insert(nodes, fieldEditor(s, "scope", "范围", "包含与不包含的内容；直接授权实施时必须填写", true))
    table.insert(nodes, fieldEditor(s, "criteria", "验收条件 · 每行一条", "可验证的结果，每行一条", true))
    table.insert(nodes, fieldEditor(s, "labels", "标签 · 逗号分隔", "例如：界面, 存储", false))
    if s.formError then table.insert(nodes, ui.text({ui.span(s.formError, "error")})) end
    if s.conflict and s.editing and s.byId[s.editing] then
        local latest = s.byId[s.editing]
        table.insert(nodes, ui.card("磁盘上的完整最新版本", {
            note("当前修订 " .. tostring(latest.revision)
                .. " · 下方列出保存会覆盖的全部需求字段；保留整份草稿并继续后，下一次保存会以草稿字段替换该版本。"),
            ui.node("scroll", {key = "latestFields", max = {h = "14lines"}}, {
                ui.text("标题：" .. tostring(latest.title or "")),
                ui.text("目标：" .. tostring(latest.goal or "")),
                ui.text("范围：" .. tostring(latest.scope or "")),
                ui.text("类型：" .. tostring(types[latest.type] or latest.type) .. " · 优先级：" .. tostring(priorities[latest.priority] or latest.priority)),
                ui.text("验收条件：\n" .. (#(latest.acceptanceCriteria or {}) > 0 and table.concat((function()
                    local values = {}; for _, item in latest.acceptanceCriteria do table.insert(values, item.description) end; return values
                end)(), "\n") or "无")),
                ui.text("标签：" .. table.concat(latest.labels or {}, ", ")),
            }),
        }, {key = "conflict", tone = "warning"}))
    end
    local saving = s.saving == true
    local saveReason = if not s.writable then "只读模式：先在页首取得编辑权"
        elseif saving then "正在保存"
        elseif s.conflict then "磁盘上已有更新版本；先选择保留草稿或返回核对"
        else false
    local formActions = {button(s.mode == "new" and "创建需求" or "保存修改", "save-requirement", "primary", saveReason)}
    if s.conflict then table.insert(formActions, button("保留整份草稿，基于此版本继续", "rebase", "default", saving)) end
    table.insert(formActions, button("取消并返回", "back", "quiet", saving))
    table.insert(nodes, row("formActions", formActions))
    if s.dirty then table.insert(nodes, note(s.saving and "正在保存…" or "草稿已保留在此项目；尚未写入需求文件。")) end
    return ui.node("col", {key = "form", role = "workbench.form", gap = "sm"}, nodes)
end
local openAction = context.openAction
local function detail(s, r)
    if not r then return ui.node("empty", {key = "noSelection", variant = "inline", title = "选择一项需求", text = "从列表或看板选择需求以查看详情。"}) end
    local editingReason = not s.writable and "只读模式：先在页首取得编辑权"
        or (s.handoff.pendingSend ~= nil and "已有业务请求待核对；完成核对前不能修改需求" or false)
    local children = {}
    if r.stage == "blocked" and r.blockedReason then
        table.insert(children, ui.card("当前被阻塞", {ui.text(r.blockedReason),
            button("去方案页补充澄清", openAction({tab = "design", sub = "materials"}), "default")}, {key = "blockedReason", tone = "warning"}))
    end
    table.insert(children, ui.text({ui.span("目标", "strong")})); table.insert(children, ui.md(r.goal or ""))
    if r.scope and r.scope ~= "" then table.insert(children, ui.text({ui.span("范围", "strong")})); table.insert(children, ui.md(r.scope)) end
    if #(r.acceptanceCriteria or {}) > 0 then
        table.insert(children, ui.text({ui.span("验收条件", "strong")}))
        for _, c in r.acceptanceCriteria do
            table.insert(children, ui.text("• " .. c.description .. (c.required and "（必需）" or "（信息性）")))
        end
    else
        table.insert(children, ui.text({ui.span("尚无验收条件；批准与验收会因缺少可验证结果而受阻。", "warning")}))
    end
    if #(r.labels or {}) > 0 then table.insert(children, note("标签：" .. table.concat(r.labels, " · "))) end
    if s.formError then table.insert(children, ui.text({ui.span(s.formError, "error")})) end
    table.insert(children, row("detailActions", {
        button("编辑需求", "edit-requirement", "default", editingReason),
        button("用作资料草稿", "prefill-selected", "default"),
    }))
    return ui.node("col", {key = "detail", role = "workbench.detail", gap = "sm"}, children)
end
local function listView(s)
    local visible = requirements(s)
    local listChildren = {}
    for _, r in visible do table.insert(listChildren, rowItem(r)) end
    local items = ui.node("list", {key = "requirements", selected = s.selected, max = {lines = 12},
        empty = "没有匹配的需求；调整筛选或新建一项"}, listChildren)
    local stageOptions = {{value = "all", label = "全部阶段"}}
    for _, stage in stages do table.insert(stageOptions, {value = stage[1], label = stage[2]}) end
    local listHead = {ui.text({ui.span("列表 · " .. tostring(#visible) .. " 项", "strong")})}
    local list = ui.node("col", {key = "listView", role = "workbench.list", gap = "sm"}, {
        row("listHead", listHead),
        note("点击需求进入工作区；工作区顶部的主按钮是当前建议动作。"),
        ui.node("input", {key = "search", text = s.query or "", cursor = units(s.query or "", s.queryCursor or utf8.len(s.query or "")),
            placeholder = "搜索标题、目标、标签", aria = "搜索需求", variant = "field", icon = "search"}),
        choices("priorityFilter", "按优先级筛选", s.priorityFilter or "all", {
            {value = "all", label = "全部"}, {value = "urgent", label = "紧急"}, {value = "high", label = "高"},
            {value = "normal", label = "普通"}, {value = "low", label = "低"}}),
        choices("stageFilter", "按阶段筛选", s.stageFilter or "all", stageOptions),
        choices("sort", "排序", s.sort or "recent", {
            {value = "recent", label = "最近更新"}, {value = "number", label = "编号"}, {value = "priority", label = "优先级"}}),
        items,
    })
    return list
end
local function attentionSection(s)
    local attention = s.attention
    local items = attention and attention.items or {}
    local children = {}
    if not attention then
        table.insert(children, note("正在读取各需求的门禁条件…"))
    elseif #items == 0 then
        table.insert(children, note("没有未解决的可执行条件。" .. (attention.errors > 0 and (" 有 " .. tostring(attention.errors) .. " 项记录无法读取，未计入。") or "")))
    else
        for _, item in items do
            local meta = {}
            for index, reason in item.reasons do
                if index > 3 then break end
                table.insert(meta, ui.text({ui.span("• " .. reason, "muted")}))
            end
            table.insert(children, ui.node("card", {key = "attention-" .. item.requirementId, head = item.number .. " · " .. item.title,
                meta = #item.reasons > 3 and ("另有 " .. tostring(#item.reasons - 3) .. " 项") or nil,
                tone = item.tone or "warning", actions = {click = "requirement=" .. item.requirementId}}, meta))
        end
        local sources = {"由当前项目记录派生；读取或处理不会改变门禁"}
        if attention.errors > 0 then table.insert(sources, tostring(attention.errors) .. " 项记录无法读取，已单独列出") end
        if attention.truncated then table.insert(sources, "需求过多，仅扫描前 " .. tostring(attention.scanned or 40) .. " 项") end
        table.insert(children, note(table.concat(sources, " · ")))
    end
    return ui.node("section", {key = "attention", role = "workbench.attention",
        head = "需要处理 · " .. tostring(attention and attention.actionable or #items), collapsible = true,
        collapsed = #items == 0}, children)
end
local function layoutButton(s, value, label)
    local selected = (s.layout or "list") == value
    return ui.button(label, {key = "layout-" .. value, variant = selected and "primary" or "default", size = "sm",
        on = selected, actions = {click = "change:layout=" .. value}})
end
local board
local function requirementsDestination(s)
    local head = {ui.node("row", {key = "requirementsTitle", gap = "sm", wrap = true}, {
        ui.text({ui.span("需求", "title")}),
        ui.node("row", {key = "layoutChoices", gap = "xs"}, {
            layoutButton(s, "list", "列表"), layoutButton(s, "board", "看板")}),
    })}
    if s.writable then
        table.insert(head, button("新建需求", "new-requirement", "primary"))
    end
    local nodes = {ui.node("row", {key = "requirementsHead", gap = "sm", wrap = true, align = "center"}, head),
        attentionSection(s)}
    if (s.layout or "list") == "board" then table.insert(nodes, board(s)) else table.insert(nodes, listView(s)) end
    return ui.node("col", {key = "requirementsDestination", role = "workbench.requirements", gap = "sm"}, nodes)
end
board = function(s)
    local visible, cols, secondary = requirements(s), {}, {}
    local function card(r)
        return ui.node("card", {key = r.requirementId, head = r.title,
            meta = (r.number or "") .. " · " .. (priorities[r.priority] or r.priority), tone = tones[r.stage],
            actions = {click = "requirement=" .. r.requirementId}}, {note(excerpt(r.goal, 220))})
    end
    for index = 1, 8 do
        local stage = stages[index]
        local cards = {}
        for _, r in visible do if r.stage == stage[1] then table.insert(cards, card(r)) end end
        table.insert(cols, ui.node("col", {key = "stage-" .. stage[1], min = {w = "22ch"}, role = "workbench.board.column"}, {
            row("stageHead-" .. stage[1], {ui.text({ui.span(stage[2], "strong")}), ui.badge(tostring(#cards), tones[stage[1]] or "muted")}),
            #cards == 0 and note("暂无需求") or ui.node("col", {gap = "xs"}, cards),
        }))
    end
    for _, r in visible do
        if r.stage == "blocked" or r.stage == "cancelled" then table.insert(secondary, card(r)) end
    end
    local stageOptions = {{value = "all", label = "全部阶段"}}
    for _, stage in stages do table.insert(stageOptions, {value = stage[1], label = stage[2]}) end
    local filters = {
        ui.node("input", {key = "search", text = s.query or "", cursor = units(s.query or "", s.queryCursor or utf8.len(s.query or "")),
            placeholder = "搜索标题、目标、标签", aria = "搜索需求", variant = "field", icon = "search"}),
        choices("priorityFilter", "按优先级筛选", s.priorityFilter or "all", {
            {value = "all", label = "全部"}, {value = "urgent", label = "紧急"}, {value = "high", label = "高"},
            {value = "normal", label = "普通"}, {value = "low", label = "低"}}),
        choices("stageFilter", "按阶段筛选", s.stageFilter or "all", stageOptions),
    }
    local content = {note("看板只展示前 8 个阶段；点击卡片进入详情。已阻塞与已取消放在下方折叠区。"),
        ui.node("row", {key = "boardFilters", gap = "sm", wrap = true, align = "end"}, filters),
        ui.node("scroll", {key = "boardScroll", max = {h = "70lines"}}, {
        ui.node("row", {key = "board", gap = "md", align = "start", wrap = true}, cols),
    })}
    if #secondary > 0 then table.insert(content, ui.node("section", {key = "exceptions", head = "已阻塞 / 已取消 · " .. tostring(#secondary), collapsible = true, collapsed = true}, secondary)) end
    return ui.node("col", {key = "boardView", role = "workbench.board", gap = "sm"}, content)
end
local function activity(s)
    local u = s.ui
    local a = u.activity or {}
    local queryField = u.review and u.review.fields and u.review.fields.activityQuery
    local query = queryField and queryField.text or ""
    local events = Audit.filter(a.events or {}, query)
    local children = {
        ui.node("row", {key = "activityHead", gap = "sm", wrap = true, align = "center"}, {
            ui.text({ui.span("活动", "title")}),
            note("跨需求的只追加事件索引；与某项需求的“历史”是同一事件流。"),
        }),
    }
    if a.error then table.insert(children, ui.text({ui.span(a.error, "error")})) end
    if a.notice then table.insert(children, ui.text({ui.span(a.notice, "warning")})) end
    table.insert(children, ui.node("field", {key = "activityQueryField", label = "检索事件"}, {
        ui.node("input", {key = "activityQuery", text = query, cursor = units(query, queryField and queryField.cursor or utf8.len(query)),
            placeholder = "按需求编号、类型、摘要或引用检索", aria = "活动检索", variant = "field", icon = "search"}),
    }))
    table.insert(children, ui.node("row", {key = "activityActions", gap = "sm", wrap = true}, {
        button("刷新", "activity-refresh", "default"),
        button("写入活动导出", "activity-write", "primary", not u.writable or #events == 0 or a.busy),
    }))
    local rows = {}
    for index, event in events do
        if index > 120 then break end
        table.insert(rows, ui.text(tostring(event.at) .. " · " .. tostring(event.requirement or "") .. " · "
            .. tostring(event.kind) .. " · " .. tostring(event.summary) .. (event.ref ~= "" and (" · " .. event.ref) or "")))
    end
    if #rows == 0 then table.insert(rows, note(query == "" and "尚未读取到事件。" or "没有匹配的事件。")) end
    if #events > 120 then table.insert(rows, note("仅显示前 120 条；共 " .. tostring(#events) .. " 条。")) end
    table.insert(children, ui.node("scroll", {key = "activityEvents", max = {h = "28lines"}}, rows))
    local caveats = {"导出只含事件索引（时间、需求、类型、摘要、引用），不含验证输出、聊天或凭据；不是防篡改日志。"}
    if a.truncated then table.insert(caveats, "事件超过上限，已保留最新部分。") end
    if a.exportPath then table.insert(caveats, "最近写入：" .. a.exportPath) end
    table.insert(children, note(table.concat(caveats, " ")))
    return ui.node("col", {key = "activity", role = "workbench.activity", gap = "sm"}, children)
end
local runtime
local function session(s)
    local u = s.ui
    local diagnostics = {
        note("项目路径：" .. s.payload.binding.projectRoot .. " · 来源 pane：" .. tostring(s.payload.source)
            .. " · 会话：" .. s.payload.binding.sessionId .. " · 实例：" .. s.payload.binding.instanceId),
    }
    if s.receipt then table.insert(diagnostics, note("原始预填回执：" .. tostring(s.receipt.status) .. " · " .. tostring(s.receipt.reason or ""))) end
    if s.snapshot then
        for i = math.max(1, #s.snapshot.recentEvents - 11), #s.snapshot.recentEvents do
            local ev = s.snapshot.recentEvents[i]
            if ev then table.insert(diagnostics, ui.text(tostring(ev.type or "事件") .. " · " .. tostring(ev.summary or ""))) end
        end
    end
    table.insert(diagnostics, note("运行快照与原始事件仅供排障；不会用于推断需求阶段或归属。"))
    return ui.node("col", {key = "session", role = "workbench.session", gap = "sm"}, {
        runtime(s),
        ui.node("section", {key = "diagnostics", head = "绑定与原始事件", collapsible = true, collapsed = true}, diagnostics),
    })
end
runtime = function(s)
    local data = s.snapshot
    local status = s.problem and "连接异常" or (data and ({idle="空闲",working="工作中",waiting_user="等待输入",disconnected="已断开"})[data.state] or "正在连接")
    local children = {row("runtimeStatus", {ui.text({ui.span("运行会话", "title")}), ui.badge(status, s.problem and "warning" or (data and data.state == "idle" and "success" or "muted"))})}
    if s.problem then table.insert(children, ui.text({ui.span(s.problem, "warning")})) end
    if data then
        table.insert(children, note("模型：" .. (data.model or "由 omp 配置决定") .. " · 活动工具：" .. (data.currentTool and (data.currentTool.toolName or data.currentTool.name) or "无")))
        table.insert(children, note("会话状态只反映连接，不代表需求进度。预填不会发送或按 Enter。"))
    else table.insert(children, note("正在读取此 omp 会话；需求列表不依赖运行时连接。")) end
    if data and type(data.plan) == "table" then
        local plan, lines, total, completed = data.plan, {}, 0, 0
        if type(plan.phases) == "table" then
            for _, phase in plan.phases do
                if type(phase) == "table" and type(phase.tasks) == "table" then
                    for _, task in phase.tasks do
                        total += 1
                        if task.status == "completed" or task.status == "done" then completed += 1 end
                        if #lines < 24 then
                            local status = tostring(task.status or "unknown")
                            local id = task.id and (" · " .. tostring(task.id)) or ""
                            local phaseName = phase.name and (tostring(phase.name) .. " · ") or ""
                            table.insert(lines, phaseName .. "[" .. status .. "]" .. id .. " " .. tostring(task.content or ""))
                        end
                    end
                end
            end
        end
        table.insert(children, ui.card("会话观测 · 不代表需求阶段", {
            note("计划项 " .. tostring(plan.completed or completed) .. " / " .. tostring(plan.total or total)
                .. (total > #lines and (" · 仅显示前 " .. tostring(#lines) .. " 项") or "")),
            ui.node("scroll", {key = "observedPlan", max = {h = "8lines"}}, {ui.text(#lines > 0 and table.concat(lines, "\n") or "尚无结构化计划")}),
        }, {key = "observedPlanCard", tone = "muted"}))
    end
    if data and type(data.lastDelivery) == "table" then
        table.insert(children, note("最近回复候选 · " .. tostring(data.lastDelivery.textBytes or "?") .. " 字节；不等于交付或验收。"))
    end
    table.insert(children, ui.node("field", {key = "materialsField", label = "资料草稿", help = "只在明确点击预填后写入当前 omp 输入框；不会发送。", error = s.error}, {
        ui.node("editor", {key = "materials", text = s.text, cursor = units(s.text, s.cursor or utf8.len(s.text)), anchor = s.anchor and units(s.text, s.anchor) or nil,
            maxLines = 7, placeholder = "填写需求资料或约束；也可从选中需求带入", aria = "资料草稿"})
    }))
    table.insert(children, button("预填到此会话（不发送）", "prefill", "primary", s.pending ~= nil or s.problem ~= nil or not data or data.state ~= "idle"))
    if s.receipt then
        local reason = s.receipt.reason == "draft_conflict" and "omp 输入框已有草稿，未覆盖，也未发送。" or s.receipt.reason or ""
        table.insert(children, ui.card(({pending="等待回执",prefilled="已预填（未发送）",rejected="已拒绝",delivery_unknown="投递状态待核对"})[s.receipt.status] or "预填状态", {note(reason)}, {key = "receipt", tone = s.receipt.status == "prefilled" and "success" or "muted"}))
    end
    return ui.node("col", {key = "runtime", role = "workbench.runtime", gap = "sm"}, children)
end
local function tabItems(list)
    local items = {}
    for _, tab in list do table.insert(items, {id = tab.id, label = tab.label}) end
    return items
end
function M.build(s)
    local u = s.ui
    local data = s.snapshot
    local status = s.problem and "omp 连接异常" or (data and ({idle = "omp 空闲", working = "omp 工作中", waiting_user = "omp 等待输入", disconnected = "omp 已断开"})[data.state] or "omp 连接中")
    local statusTone = s.problem and "warning" or (data and data.state == "idle" and "success" or "pending")
    local headerActions = {}
    if not u.writable and u.project and not u.takeoverAvailable then
        table.insert(headerActions, button("启用编辑", "enable-edit", "primary",
            u.storageUnsafe and "项目存储异常；先核对文件" or (u.busy and "正在处理上一步" or false)))
    end
    table.insert(headerActions, button("刷新", "reload", "default"))
    local sessionBadges = {ui.badge(status, statusTone), note(data and data.model and data.model:match("[^/]+$") or "模型未知")}
    if data and data.currentTool then
        table.insert(sessionBadges, note("正在使用 " .. tostring(data.currentTool.toolName or data.currentTool.name or "工具")))
    end
    local tab = u.tab
    if not (context.destination[tab] or context.workspaceTab[tab]) then tab = "requirements" end
    local inWorkspace = context.workspaceTab[tab] == true
    local nodes = {
        row("pageHeader", {ui.node("col", {gap = "xs"}, {
            ui.text({ui.span("Tern 工作台", "title")}),
            ui.text({ui.span(u.project and (u.project.name or u.project.root:match("[^/]+$")) or (s.payload.binding.projectRoot:match("[^/]+$") or "项目"), "muted")}),
        }), ui.badge(u.loading and "读取中" or (u.writable and "可编辑" or (u.project and "只读" or "未初始化")),
            u.loading and "pending" or (u.writable and "success" or "muted")),
        ui.node("row", {key = "headerActions", gap = "xs", wrap = true}, headerActions)}),
        row("sessionSummary", sessionBadges),
    }
    if inWorkspace then
        table.insert(nodes, row("workspaceBack", {
            button("← 返回需求", "back-workspace", "quiet"),
            note("工作区标签只切换本节内容；返回恢复列表/看板与筛选。"),
        }))
    else
        table.insert(nodes, ui.node("tabs", {key = "tabs", active = tab, items = tabItems(context.destinations)}))
    end
    if u.error then
        local actions = {}
        if u.takeoverAvailable then
            table.insert(actions, ui.button(u.project and "接管编辑权" or "接管并初始化",
                {key = u.project and "error-takeover" or "error-takeover-initialize", variant = "primary", size = "sm",
                    actions = {click = u.project and "takeover" or "takeover-initialize"}}))
        end
        table.insert(actions, ui.button("重新加载", {key = "error-reload", variant = "default", size = "sm", actions = {click = "reload"}}))
        local errorChildren = {ui.text(u.error)}
        if u.takeoverAvailable then
            table.insert(errorChildren, note("接管只更换写入者，不删除、不覆盖任何需求文件；原锁过期后才可用。"))
        end
        table.insert(errorChildren, ui.node("row", {key = "errorActions", gap = "xs", wrap = true}, actions))
        table.insert(nodes, ui.node("card", {key = "loadError", head = u.storageUnsafe and "项目存储异常" or "操作未完成", tone = "error"}, errorChildren))
    end
    if u.notice then table.insert(nodes, ui.text({ui.span(u.notice, "warning")})) end
    if inWorkspace then
        table.insert(nodes, context.bar(s, {current = {tab = tab, sub = tab == "design" and u.handoff.tab or nil}}))
        local r = u.selected and u.byId[u.selected]
        if r then table.insert(nodes, row("workspaceActions", {
            ui.button(u.handoff.panel and "收起准备交接" or "准备交接", {key = "handoff-prepare", variant = "default",
                size = "sm", actions = {click = "handoff-prepare"}}),
            note("次动作：打开面板不发送；目标 " .. tostring(r.number or "")),
        })) end
        if r and u.handoff.panel then table.insert(nodes, handoff.preparePanel(s)) end
        table.insert(nodes, ui.node("tabs", {key = "tabs", active = tab, items = tabItems(context.workspaceTabs)}))
        if u.loading then table.insert(nodes, note("正在读取当前需求…"))
        elseif not u.project then table.insert(nodes, note("先初始化项目存储并选择一项需求。"))
        elseif not r then table.insert(nodes, ui.node("empty", {key = "noSelection", variant = "inline",
            title = "选择一项需求", text = "工作区绑定到一项需求；返回列表选择后继续。"}))
        elseif tab == "requirement" then
            table.insert(nodes, u.formMode and form(u) or detail(u, r))
        elseif tab == "design" then table.insert(nodes, handoff.build(s))
        elseif tab == "delivery" then table.insert(nodes, runview.build(s))
        elseif tab == "acceptance" then table.insert(nodes, reviewview.build(s))
        elseif tab == "history" then table.insert(nodes, auditview.build(s)) end
    elseif tab == "requirements" then
        if u.loading then table.insert(nodes, note("正在只读读取项目需求…"))
        elseif u.formMode then table.insert(nodes, form(u))
        elseif not u.project then
            local takeover = u.takeoverAvailable == true
            table.insert(nodes, ui.node("empty", {key = "initialize", title = "初始化需求存储",
                text = "在项目 .omp/workbench 下创建需求文件。只在你点击后写入，不读取聊天记录或旧数据。"}, {
                choices("privacyMode", "存储与隐私", u.privacyMode or "local", {
                    {value = "local", label = "仅本机（推荐）"}, {value = "tracked", label = "遵循项目 Git 规则"}}),
                note("仅本机会把 /.omp/workbench/ 加入本机 .git/info/exclude；不是加密。遵循项目规则则不修改忽略配置。"),
                takeover and ui.text({ui.span("上次的工作台实例留下了过期写锁。接管后继续初始化，不会删除任何需求。", "warning")}) or note("初始化只创建缺失的项目文件；已有需求不会被覆盖。"),
                ui.button(takeover and "接管并初始化" or "初始化项目",
                    {key = takeover and "takeover-initialize" or "initialize-action", variant = "primary", size = "sm",
                        disabled = u.busy and "正在处理上一步" or (u.storageUnsafe and "存储异常；先核对 .omp/workbench 文件" or false),
                        actions = {click = takeover and "takeover-initialize" or "initialize"}}),
            }))
        elseif #u.requirements == 0 then
            table.insert(nodes, ui.node("empty", {key = "empty", title = "还没有需求",
                text = "创建第一项需求；之后按“资料 → 方案 → 批准 → 交付 → 验收”推进。"}, {
                u.writable and button("创建第一项需求", "new-requirement", "primary")
                    or ui.button("启用编辑", {key = "empty-enable-edit", variant = "primary", size = "sm",
                        disabled = "只读模式：先取得编辑权才能创建需求", actions = {click = "enable-edit"}}),
            }))
        else table.insert(nodes, requirementsDestination(u)) end
    elseif tab == "activity" then
        if u.loading then table.insert(nodes, note("正在读取各需求的事件…"))
        else table.insert(nodes, activity(s)) end
    elseif tab == "session" then
        table.insert(nodes, session(s))
    end
    return ui.node("col", {key = "workbench", role = "workbench.live", gap = "sm"}, nodes)
end
return M
