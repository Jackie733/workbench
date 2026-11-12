--!strict
local ui = tern.ui
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
local stages = {
    {"backlog", "待整理"}, {"clarifying", "澄清中"}, {"designing", "设计中"},
    {"awaiting_approval", "待批准"}, {"implementing", "实施中"}, {"verifying", "验证中"},
    {"awaiting_acceptance", "待验收"}, {"done", "已完成"}, {"blocked", "已阻塞"}, {"cancelled", "已取消"},
}
local stageNames = {}
for _, stage in stages do stageNames[stage[1]] = stage[2] end
local priorities = {low = "低", normal = "普通", high = "高", urgent = "紧急"}
local types = {feature = "功能", bug = "缺陷", chore = "维护"}
local tones = {backlog = "muted", clarifying = "accent", designing = "accent", awaiting_approval = "pending",
    implementing = "accent", verifying = "accent", awaiting_acceptance = "pending", done = "success", blocked = "warning", cancelled = "muted"}
local function note(s) return ui.text({ui.span(s or "", "muted")}) end
local function button(label, act, variant, disabled)
    return ui.button(label, {key = act, variant = variant or "quiet", size = "sm", disabled = disabled, actions = {click = act}})
end
local function row(key, children, props)
    props = props or {}; props.key = key; props.gap = props.gap or "sm"; props.wrap = true
    return ui.node("row", props, children)
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
    local n = ui.node("item", {key = r.requirementId, label = r.title, detail = (r.number or "") .. " · " .. (stageNames[r.stage] or r.stage),
        value = priorities[r.priority] or r.priority, tone = tones[r.stage]})
    return n
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
    local nodes = {ui.text({ui.span(s.mode == "new" and "新建需求" or "编辑需求", "title")})}
    table.insert(nodes, fieldEditor(s, "title", "标题", "一句话描述要解决的问题", false))
    table.insert(nodes, row("classification", {
        ui.node("field", {key = "typeField", label = "类型"}, {ui.node("select", {key = "type", value = s.type, disabled = not s.writable or s.saving, options = {
            {value = "feature", label = "功能"}, {value = "bug", label = "缺陷"}, {value = "chore", label = "维护"}}})}),
        ui.node("field", {key = "priorityField", label = "优先级"}, {ui.node("select", {key = "priority", value = s.priority, disabled = not s.writable or s.saving, options = {
            {value = "low", label = "低"}, {value = "normal", label = "普通"}, {value = "high", label = "高"}, {value = "urgent", label = "紧急"}}})}),
    }))
    table.insert(nodes, fieldEditor(s, "goal", "目标", "希望达成的结果", true))
    table.insert(nodes, fieldEditor(s, "scope", "范围", "包含与不包含的内容", true))
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
    local formActions = {button(s.mode == "new" and "创建需求" or "保存修改", "save-requirement", "primary", not s.writable or saving or s.conflict)}
    if s.conflict then table.insert(formActions, button("保留整份草稿，基于此版本继续", "rebase", "quiet", saving)) end
    table.insert(formActions, button("返回", "back", "quiet", saving))
    table.insert(nodes, row("formActions", formActions))
    if s.dirty then table.insert(nodes, note(s.saving and "正在保存…" or "草稿已保留在此项目；尚未写入需求文件。")) end
    return ui.node("col", {key = "form", role = "workbench.form", gap = "sm"}, nodes)
end
local function detail(s, r)
    if not r then return ui.node("empty", {key = "noSelection", variant = "inline", title = "选择一项需求", text = "从列表或看板选择需求以查看详情。"}) end
    local children = {
        row("detailTitle", {ui.text({ui.span(r.title, "title")}), ui.badge(stageNames[r.stage] or r.stage, tones[r.stage] or "muted")} ),
        note((r.number or "") .. " · " .. (types[r.type] or r.type) .. " · 优先级 " .. (priorities[r.priority] or r.priority)),
        ui.node("rule", {}),
        ui.text({ui.span("目标", "strong")}), ui.md(r.goal or ""),
    }
    if r.scope and r.scope ~= "" then table.insert(children, ui.text({ui.span("范围", "strong")})); table.insert(children, ui.md(r.scope)) end
    if #(r.acceptanceCriteria or {}) > 0 then
        table.insert(children, ui.text({ui.span("验收条件", "strong")}))
        for _, c in r.acceptanceCriteria do table.insert(children, ui.text("• " .. c.description)) end
    end
    if #(r.labels or {}) > 0 then table.insert(children, note("标签：" .. table.concat(r.labels, " · "))) end
    if s.formError then table.insert(children, ui.text({ui.span(s.formError, "error")})) end
    local acts = {button("编辑", "edit-requirement", "primary", not s.writable), button("返回列表", "back-list")}
    table.insert(acts, button("用作资料草稿", "prefill-selected"))
    table.insert(children, row("detailActions", acts))
    return ui.node("col", {key = "detail", role = "workbench.detail", gap = "sm"}, children)
end
local function listView(s)
    local visible = requirements(s)
    local listChildren = {}
    for _, r in visible do table.insert(listChildren, rowItem(r)) end
    local listPath = s.detailMode and (s.cols or 0) >= 100 and "main.masterDetail.listView.requirements." or "main.listView.requirements."
    local selectedKey = s.selected and listPath .. s.selected or nil
    local items = ui.node("list", {key = "requirements", selected = selectedKey, max = {lines = 12}, empty = "没有匹配的需求"}, listChildren)
    local controls = row("filters", {
        ui.node("input", {key = "search", text = s.query or "", cursor = units(s.query or "", s.queryCursor or utf8.len(s.query or "")), placeholder = "搜索标题、目标、标签", aria = "搜索需求", variant = "field", icon = "search"}),
        ui.node("select", {key = "priorityFilter", value = s.priorityFilter or "all", label = "优先级", size = "sm", options = {
            {value = "all", label = "全部优先级"}, {value = "urgent", label = "紧急"}, {value = "high", label = "高"}, {value = "normal", label = "普通"}, {value = "low", label = "低"}}}),
        ui.node("select", {key = "stageFilter", value = s.stageFilter or "all", label = "阶段", size = "sm", options = (function() local o = {{value="all",label="全部阶段"}}; for _, st in stages do table.insert(o,{value=st[1],label=st[2]}) end; return o end)()}),
    })
    if s.cols and s.cols < 100 and s.detailMode and s.selected then return detail(s, s.byId[s.selected]) end
    local list = ui.node("col", {key = "listView", role = "workbench.list", gap = "sm"}, {
        row("listHead", {ui.text({ui.span("需求", "title"), ui.span("  " .. tostring(#visible), "muted")}),
            s.writable and button("新建需求", "new-requirement", "primary") or note("只读模式；可从页首启用编辑")}),
        row("sort", {note("排序"), ui.node("select", {key = "sort", value = s.sort or "recent", size = "sm", options = {
            {value = "recent", label = "最近更新"}, {value = "number", label = "编号"}, {value = "priority", label = "优先级"}}})}),
        controls, items,
    })
    if s.detailMode and s.selected and s.byId[s.selected] then
        return ui.node("split", {key = "masterDetail", sizes = {0.42, 0.58}, min = {w = "34ch"}}, {list, detail(s, s.byId[s.selected])})
    end
    return list
end
local function board(s)
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
            row("stageHead", {ui.text({ui.span(stage[2], "strong")}), ui.badge(tostring(#cards), tones[stage[1]] or "muted")}),
            #cards == 0 and note("暂无需求") or ui.node("col", {gap = "xs"}, cards),
        }))
    end
    for _, r in visible do
        if r.stage == "blocked" or r.stage == "cancelled" then table.insert(secondary, card(r)) end
    end
    local filters = row("boardFilters", {
        ui.node("input", {key = "search", text = s.query or "", cursor = units(s.query or "", s.queryCursor or utf8.len(s.query or "")), placeholder = "搜索标题、目标、标签", aria = "搜索需求", variant = "field", icon = "search"}),
        ui.node("select", {key = "priorityFilter", value = s.priorityFilter or "all", label = "优先级", size = "sm", options = {
            {value = "all", label = "全部优先级"}, {value = "urgent", label = "紧急"}, {value = "high", label = "高"}, {value = "normal", label = "普通"}, {value = "low", label = "低"}}}),
        ui.node("select", {key = "stageFilter", value = s.stageFilter or "all", label = "阶段", size = "sm", options = (function() local o = {{value="all",label="全部阶段"}}; for _, st in stages do table.insert(o,{value=st[1],label=st[2]}) end; return o end)()}),
    })
    local content = {filters, ui.node("scroll", {key = "boardScroll", max = {h = "70lines"}}, {
        ui.node("row", {key = "board", gap = "md", align = "start", wrap = true}, cols),
    })}
    if #secondary > 0 then table.insert(content, ui.node("section", {key = "exceptions", head = "已阻塞 / 已取消 · " .. tostring(#secondary), collapsible = true, collapsed = true}, secondary)) end
    return ui.node("col", {key = "boardView", role = "workbench.board", gap = "sm"}, content)
end
local function runtime(s)
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
function M.build(s)
    local u = s.ui
    local data = s.snapshot
    local status = s.problem and "omp 连接异常" or (data and ({idle = "omp 空闲", working = "omp 工作中", waiting_user = "omp 等待输入", disconnected = "omp 已断开"})[data.state] or "omp 连接中")
    local statusTone = s.problem and "warning" or (data and data.state == "idle" and "success" or "pending")
    local nodes = {
        row("pageHeader", {ui.node("col", {gap = "xs"}, {
            ui.text({ui.span("Tern 工作台", "title")}),
            ui.text({ui.span(u.project and (u.project.name or u.project.root:match("[^/]+$")) or (s.payload.binding.projectRoot:match("[^/]+$") or "项目"), "muted")}),
        }), ui.badge(u.loading and "读取中" or (u.writable and "可编辑" or (u.project and "只读" or "未初始化")), u.loading and "pending" or (u.writable and "success" or "muted")),
        not u.writable and u.project and button("启用编辑", "enable-edit", "quiet", u.storageUnsafe) or note(""),
        button("刷新", "reload"), u.takeoverAvailable and button("接管写入锁", "takeover", "quiet") or note("")}),
        row("sessionSummary", {
            ui.badge(status, statusTone),
            note(data and data.model and data.model:match("[^/]+$") or "模型未知"),
            data and data.currentTool and note("正在使用 " .. tostring(data.currentTool.toolName or data.currentTool.name or "工具")) or note(""),
        }),
        ui.node("tabs", {key = "tabs", active = u.tab or "requirements", items = {{id="requirements",label="需求"},{id="board",label="看板"},{id="runtime",label="运行"},{id="diagnostics",label="诊断"}}}),
    }
    if u.error then table.insert(nodes, ui.node("card", {key = "loadError", head = u.storageUnsafe and "项目存储异常" or "操作未完成", tone = "error"}, {ui.text(u.error), button("重新加载", "reload")})) end
    if u.notice then table.insert(nodes, ui.text({ui.span(u.notice, "warning")})) end
    if u.tab == "requirements" then
        if u.loading then table.insert(nodes, note("正在只读读取项目需求…"))
        elseif u.formMode then table.insert(nodes, form(u))
        elseif not u.project then
            table.insert(nodes, ui.node("empty", {key = "initialize", title = "此项目尚未初始化", text = "初始化会在项目 .omp/workbench 下创建需求存储。选择“仅本机”会更新本机 .git/info/exclude；选择遵循项目规则则不修改忽略配置。"}, {
                ui.node("field", {key = "privacyField", label = "存储与隐私"}, {ui.node("select", {key = "privacyMode", value = u.privacyMode or "local", options = {
                    {value = "local", label = "仅本机：加入 .git/info/exclude"},
                    {value = "tracked", label = "遵循项目 Git 规则（不修改）"}}})}),
                note("本机排除不是加密。你可选遵循项目规则以便按既有配置共享需求数据。"),
                button("我已了解，初始化项目", "initialize", "primary", u.busy or u.storageUnsafe),
            }))
        elseif #u.requirements == 0 then
            table.insert(nodes, ui.node("empty", {key = "empty", title = "还没有需求", text = "创建第一项需求，之后可在列表与看板中查看。"}, {
                u.writable and button("新建需求", "new-requirement", "primary") or note("只读模式；可从页首启用编辑"),
            }))
        else table.insert(nodes, listView(u)) end
    elseif u.tab == "board" then
        if u.loading then table.insert(nodes, note("正在只读读取项目需求…"))
        elseif not u.project then table.insert(nodes, note("先初始化项目后，需求才会出现在看板。"))
        else table.insert(nodes, board(u)) end
    elseif u.tab == "runtime" then
        table.insert(nodes, runtime(s))
    else
        table.insert(nodes, note("运行快照与原始事件仅供排障；不会用于推断需求阶段。"))
        table.insert(nodes, note("项目路径：" .. s.payload.binding.projectRoot .. " · 来源 pane：" .. tostring(s.payload.source) .. " · 会话：" .. s.payload.binding.sessionId))
        if s.receipt then table.insert(nodes, note("原始预填回执：" .. tostring(s.receipt.status) .. " · " .. tostring(s.receipt.reason or ""))) end
        if s.snapshot then
            for i = math.max(1, #s.snapshot.recentEvents - 11), #s.snapshot.recentEvents do
                local ev = s.snapshot.recentEvents[i]
                if ev then table.insert(nodes, ui.text(tostring(ev.type or "事件") .. " · " .. tostring(ev.summary or ""))) end
            end
        end
    end
    return ui.node("col", {key = "workbench", role = "workbench.live", gap = "sm"}, nodes)
end
return M
