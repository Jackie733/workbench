--!strict
-- Real production views + synthetic memory-only state. No production host/dispatcher.
-- Args: output, gallery, Windows repo path, page, AF fixture (default approved).
-- Install the repository styles.css with `tern ctl css workbench <path>` before capture.
local driver = require("./context")
local M = {}
local function copy(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for k, v in value do out[copy(k)] = copy(v) end
    return out
end
local PAGES = {"foundation", "requirements", "requirement", "form", "design", "approval", "delivery", "acceptance", "history", "activity", "session"}
local function fields(names)
    local out = {}
    for _, name in names do out[name] = {text = "", cursor = 0} end
    return out
end
function M.new(native, repo, page, fixture)
    local loaded = driver(native, repo, (fixture == "multi" or fixture == "long") and "approved" or (fixture or "approved"))
    local Context, View, ui = loaded.module, loaded.load("ui"), native.ui
    local state, current = loaded.state, page or "foundation"
    assert(table.find(PAGES, current), "unknown gallery page")
    local u = state.ui
    local r = u.requirements[1]
    local SHA = string.rep("ab12", 16)
    local prose = "# 隔离方案 · 可读内容\n\n这里加载真实生产视图与工作台样式；所有需求和证据均为合成夹具，未运行命令。\n\n## 修改范围\n\n只调整视觉基础，不改变授权、执行与验收规则。长中文段落应自然换行，正文不会横向撑开整个工作区。\n\n- 阅读不是批准\n- 批准不是执行\n- 历史通过不是当前证据\n\n```text\nproject/非常长的目录/说明文件.luau\n```\n\n"
    u.tab, u.writable, u.loading = "requirement", true, false
    u.project = {projectId = "af-project", name = "AF-04 隔离视觉项目", root = "/tmp/af-synthetic"}
    u.query, u.queryCursor, u.sort, u.priorityFilter, u.stageFilter = "", 0, "recent", "all", "all"
    u.layout, u.fields, u.type, u.priority = "list", fields({"title", "goal", "scope", "criteria", "labels"}), "chore", "normal"
    u.attention = {items = {}, actionable = 0, errors = 0}
    u.resources = {safe = true, data = {resources = {}}, status = {}}
    local h, t, v = u.handoff, u.trace, u.review
    h.fields = fields({"paths", "excerpt", "proposal", "importPath", "resourcePath", "comment", "directReason", "revokeReason", "ackReason"})
    h.tab, h.activity, h.includeRequirement, h.resourceKind = "design", "design", true, "context"
    h.compareVersion, h.drafts, h.draftOrder = 0, {}, {}
    h.fields.proposal.text = prose
    t.fields = fields({"verifyCommand", "verifyCriteria", "newStep", "blockReason", "planImportPath", "stepCriteria", "stepFiles"})
    t.fields.verifyCommand.text, t.fields.verifyCriteria.text = "synthetic-never-executed", "C1"
    t.plan = {revision = 1, steps = {{id = "S1", title = "核对真实生产组件的长中文标签与换行", status = "pending", updatedAt = 1700000000000}}}
    v.fields = fields({"reviewScope", "reviewFindings", "reviewReason", "reviewComment", "reviewReject", "reviewReopen", "lifecycleReason", "auditQuery", "activityQuery", "findingDraft", "reviewImportPath"})
    v.source, v.action, v.panel, v.finding, v.draftSeverity = "manual", "resolved", "", "", "major"
    v.fields.reviewScope.text = "合成视觉夹具（未执行审查）"
    u.audit = {events = {{at = 1700000000000, kind = "fixture", summary = "合成记录：没有读取或改写业务存储", ref = "af-visual"}}, markdown = "# 合成审计"}
    u.activity = {events = {}, errors = 0, scanned = #u.requirements}
    state.payload.location = {distro = "Ubuntu"}
    state.snapshot.recentEvents = {}
    state.text, state.cursor = "", 0
    if r then
        r.title = "长中文需求：把清晰的目标、真实状态与明确授权边界放在一起"
        r.goal = prose .. string.rep("正文长内容：读取、批准、执行、验收是不同事实。", 12)
        for name, text in {title = r.title, goal = r.goal, scope = r.scope, criteria = "示例版本为 1.3.2", labels = "视觉, 隔离"} do
            u.fields[name] = {text = text, cursor = utf8.len(text)}
        end
        if h.workflow.latestVersion > 0 then
            h.selectedVersion = h.workflow.latestVersion
            h.selectedDesign = {version = h.selectedVersion, body = prose .. string.rep("\n长方案阅读行，不能冒充执行证据。", 30), sha256 = SHA,
                requirementRevision = r.revision, requirementContentRevision = r.contentRevision, source = {kind = "manual"}}
        end
        if t.results.changes then
            t.results.changes.diff = "--- a/example.luau\n+++ b/example.luau\n- local previous = true\n+ local current = true\n+ -- " .. string.rep("long_path_segment/", 24)
            t.results.changes.files = {{status = "M", path = "src/" .. string.rep("long-path/", 20) .. "example.luau"}}
        end
        v.data.reviews = {{id = "af-gallery-review", source = "manual", scope = "合成审查：用于真实表格呈现", codeSnapshotSha256 = SHA,
            requirementRevision = r.revision, requirementContentRevision = r.contentRevision, createdAt = 1700000000000,
            findings = {{id = "af-gallery-finding", severity = "major", description = "长中文发现说明：证据已过期时，不应该继续显示为当前有效的绿色成功。", createdAt = 1700000000000}}, events = {}}}
    end
    if fixture == "multi" then
        local stages = {{"backlog", "待整理"}, {"designing", "设计中"}, {"verifying", "验证中"}, {"done", "已完成"}, {"blocked", "已阻塞"}}
        local extra = {}
        for index, item in stages do
            local row = copy(r)
            row.requirementId, row.number, row.stage = "af-multi-" .. tostring(index), "REQ-10" .. tostring(index), item[1]
            row.title = "合成需求 " .. item[2] .. "：用于验证首页筛选与分组"
            row.blockedReason = item[1] == "blocked" and "等待外部输入" or nil
            row.updatedAt = r.updatedAt - index * 86400000
            table.insert(extra, row)
        end
        for _, row in extra do
            table.insert(u.requirements, row)
            u.byId[row.requirementId] = row
        end
        u.selected = r.requirementId
    end
    if fixture == "long" then
        local extra = {}
        for index = 1, 24 do
            local row = copy(r)
            row.requirementId, row.number, row.stage = "af-long-" .. tostring(index), string.format("REQ-%03d", 200 + index), "backlog"
            row.title = "合成需求 长列表 " .. tostring(index) .. "：用于验证首页滚动位置保持"
            row.updatedAt = r.updatedAt - index * 3600000
            table.insert(extra, row)
        end
        for _, row in extra do
            table.insert(u.requirements, row)
            u.byId[row.requirementId] = row
        end
        u.selected = r.requirementId
    end
    local g = {state = state, page = current, fixture = fixture or "approved", notice = "", input = "中文输入与焦点", editor = "输入换行，不触发批准或执行。", focusId = "", demoTab = "overview", demoSeg = "list"}
    local inputCursor, editorCursor = utf8.len(g.input), utf8.len(g.editor)
    local controls = {}
    local focusOrder = {"main.galleryInput", "main.galleryEditor", "main.galleryPrimary", "main.gallerySecondary", "main.galleryQuiet", "main.galleryDanger", "main.galleryMenu", "main.galleryOverlay"}
    local function selectPage(value)
        assert(table.find(PAGES, value), "unknown gallery page")
        g.page = value
        u.formMode = value == "form"
        u.mode = u.formMode and "edit" or nil
        u.tab = (value == "approval" or value == "design") and "design" or (value == "form" and "requirement" or value)
        h.tab = value == "approval" and "approval" or "design"
    end
    selectPage(current)
    local function foundation()
        local nodes = {
            ui.text({ui.span("AF-04 组件契约", "title")}),
            ui.text("页面导航、局部切换、状态、分类与操作必须是不同的形状与行为；灰度下也应可辨。"),
            ui.text({ui.span("页面导航 · 原生 underline tabs（只切内容）", "muted")}),
            ui.node("tabs", {key = "demoTabs", active = g.demoTab, items = {
                {id = "overview", label = "概览"}, {id = "changes", label = "变更 3"}, {id = "record", label = "记录"}}}),
            ui.text({ui.span("局部视图切换 · 一体式 segmented", "muted")}),
            ui.node("tabs", {key = "demoSeg", variant = "segmented", active = g.demoSeg, items = {
                {id = "list", label = "列表"}, {id = "board", label = "分组视图"}}}),
            ui.text({ui.span("状态 · 只读文字，无外框、hover 或焦点", "muted")}),
            Context.row("galleryStatuses", {
                Context.status("执行中", "muted"), Context.status("待批准", "pending"),
                Context.status("当前证据通过", "success"), Context.status("证据过期", "warning"), Context.status("验证失败", "error"),
            }),
            Context.row("galleryTags", {ui.text({ui.span("分类 · 轻量 tag", "muted")}), Context.tag("维护"), Context.tag("界面"), Context.tag("隔离")}),
            ui.text({ui.span("输入", "muted")}),
            ui.node("input", {key = "galleryInput", text = g.input, cursor = inputCursor, variant = "field", aria = "视觉输入"}),
            ui.node("editor", {key = "galleryEditor", text = g.editor, cursor = editorCursor, variant = "field", maxLines = 4, aria = "视觉多行输入"}),
            ui.text({ui.span("操作层级 · 至多一个 filled primary", "muted")}),
            Context.row("galleryButtons", {
                ui.button("开始执行", {key = "galleryPrimary", variant = "primary", actions = {click = "gallery-sample"}}),
                ui.button("保存修改", {key = "gallerySecondary", variant = "default", actions = {click = "gallery-sample"}}),
                ui.button("查看方案", {key = "galleryQuiet", variant = "quiet", actions = {click = "gallery-sample"}}),
                ui.button("取消需求", {key = "galleryDanger", variant = "danger", actions = {click = "gallery-sample"}}),
                ui.button("正在保存", {key = "galleryBusy", variant = "default", busy = true, actions = {click = "gallery-sample"}}),
            }),
            Context.row("galleryButtonsState", {
                ui.button("不可执行", {key = "galleryDisabled", variant = "primary", disabled = "尚未获得当前范围的执行授权", actions = {click = "gallery-forbidden"}}),
                ui.text("不可执行的原因：尚未获得当前范围的执行授权。"),
            }),
            ui.node("select", {key = "galleryMenu", value = "list", aria = "视觉菜单", options = {{value = "list", label = "列表"}, {value = "board", label = "分组视图"}}}),
            ui.button("查看轻量弹层", {key = "galleryOverlay", variant = "quiet", actions = {click = "gallery-overlay"}}),
            ui.node("field", {key = "galleryInvalid", label = "输入异常", error = "× 写入冲突：草稿已保留，请先核对最新内容。"}, {
                ui.node("input", {key = "galleryInvalidInput", text = "保留的草稿", readonly = true, variant = "field", aria = "冲突草稿"}),
            }),
            ui.card("× 连接异常 · 保留最后观测", {ui.text("来源已断开。可以阅读历史；不能依赖旧绑定执行。")}, {key = "galleryError", tone = "error"}),
            ui.node("col", {key = "galleryConfirm", role = "workbench.confirmPanel"}, {
                ui.text({ui.span("! 取消需求 · 明确确认", "strong")}),
                ui.text("仅改变需求生命周期；不会终止外部进程，也不会撤回已发送请求。"),
                Context.row("galleryConfirmActions", {
                    ui.button("确认取消需求", {key = "galleryConfirmDanger", variant = "danger", actions = {click = "gallery-sample"}}),
                    ui.button("返回，不变更", {key = "galleryConfirmCancel", variant = "default", actions = {click = "gallery-sample"}}),
                }),
            }),
            ui.table({{id = "state", head = "状态"}, {id = "description", head = "证据说明", grow = 1}, {id = "action", head = "查看"}}, {
                {id = "failed", cells = {{text = Context.badgeText("失败", "error"), tone = "error"}, {text = "准确命令与退出码 1"}, {button = {text = "详情", act = "gallery-sample", variant = "quiet"}}}},
                {id = "stale", cells = {{text = Context.badgeText("已过期", "warning"), tone = "warning"}, {text = "内容身份已变化：" .. string.rep("long_path/", 15)}, {button = {text = "详情", act = "gallery-sample", variant = "quiet"}}}},
            }, {key = "galleryTable"}),
            ui.node("section", {key = "gallerySection", head = "可展开的真实 section", collapsible = true, collapsed = false}, {ui.md(prose)}),
            ui.node("editor", {key = "galleryDiff", text = "+ " .. string.rep("very_long_code_path/", 28), readonly = true, nowrap = true, lang = "diff", maxLines = 3, aria = "局部横向滚动差异"}),
            ui.node("scroll", {key = "galleryLong", max = {h = "8lines"}}, {ui.text(string.rep("长内容滚动：保留当前阅读位置，不抢走输入焦点。\n", 30))}),
        }
        if g.open then table.insert(nodes, ui.node("overlay", {key = "galleryDialog", head = "只读轻量弹层", modal = false}, {
            ui.text("非关键视觉示例；不宣称背景已 inert。Escape 关闭并回到触发按钮。"),
            ui.button("关闭弹层", {key = "galleryClose", variant = "quiet", actions = {click = "gallery-close"}}),
        })) end
        return ui.node("col", {key = "foundation", role = "workbench.live"}, nodes)
    end
    local function decorate(node)
        if type(node) ~= "table" then return end
        local p = node.p or {}
        if p.key then
            controls[p.key] = node
            if g.focusId:match("([^%.]+)$") == p.key and (node.k == "button" or node.k == "select") then p.role = "workbench.keyboardFocus" end
        end
        for _, child in node.c or {} do decorate(child) end
    end
    function g.view()
        controls = {}
        local root = g.page == "foundation" and foundation() or View.build(state)
        local items = {}
        for _, value in PAGES do table.insert(items, {value = value, label = value}) end
        table.insert(root.c, 1, ui.node("select", {key = "galleryNav", value = g.page, options = items, aria = "gallery page"}))
        table.insert(root.c, 2, ui.text("隔离 gallery · " .. g.fixture .. " · 生产写入/执行动作不会被派发。"))
        if g.notice ~= "" then table.insert(root.c, 3, ui.text({ui.span(g.notice, "warning")})) end
        decorate(root)
        return {main = root}
    end
    function g.event(ev, cx)
        if ev.ev == "focus" then g.focusId = ev.id; cx:frame({{"focus", ev.id}})
        elseif ev.ev == "action" then
            local act, value = ev.act, ev.value
            if act == "gallery-page" then selectPage(value)
            elseif act == "gallery-overlay" then g.open = true
            elseif act == "gallery-close" then g.open = false; g.focusId = "main.galleryOverlay"; cx:frame({{"focus", g.focusId}})
            elseif act == "back-workspace" then selectPage("requirements")
            elseif act == "wb-open-implementation" then selectPage("design"); h.activity = "implement"
            elseif act and act:match("^wb%-open%-") then
                local tab, sub = act:match("^wb%-open%-([^-]+)%-?(.*)$")
                if tab == "results" then tab = "delivery" end
                if table.find(PAGES, tab) then selectPage(tab); if sub ~= "" then h.tab = sub end end
            elseif act == "handoff-prepare" then h.panel = not h.panel
            elseif act == "home-filter" then u.filterOpen = not u.filterOpen
            elseif act == "more-toggle" then u.more = not u.more
            elseif act == "clear-filters" then
                u.query, u.queryCursor, u.priorityFilter, u.stageFilter, u.scope = "", 0, "all", "all", "active"
            elseif act == "new-requirement" or act == "edit-requirement" then selectPage("form")
            elseif act == "change:layout" then u.layout = value
            else g.notice = "隔离动作已拦截：" .. tostring(act) .. "；没有写入业务数据或启动执行。" end
        elseif ev.ev == "change" then
            local key = (ev.id or ""):match("([^%.]+)$")
            if key == "galleryNav" and table.find(PAGES, ev.value) then selectPage(ev.value)
            elseif key == "priorityFilter" then u.priorityFilter = ev.value
            elseif key == "stageFilter" then u.stageFilter = ev.value end
        elseif ev.ev == "select" then
            local key = (ev.id or ""):match("([^%.]+)$")
            if key == "galleryNav" and table.find(PAGES, ev.item) then selectPage(ev.item)
            elseif key == "scopeSeg" then u.scope = ev.item
            elseif key == "layoutSeg" then u.layout = ev.item
            elseif key == "sortSeg" then u.sort = ev.item
            elseif key == "demoTabs" then g.demoTab = ev.item
            elseif key == "demoSeg" then g.demoSeg = ev.item
            elseif key == "handoffTabs" then h.tab = ev.item
            elseif key == "requirements" then
                local id = tostring(ev.item):match("([^%.]+)$")
                if u.byId[id] then u.selected = id; selectPage("requirement") end
            end
        end
    end
    function g.key(key, cx)
        if key.name == "escape" and g.open then g.event({ev = "action", act = "gallery-close"}, cx); return true end
        if g.page ~= "foundation" then return false end
        if key.name == "tab" then
            local at = table.find(focusOrder, g.focusId) or 0
            local nextAt = ((at - 1 + (key.shift and -1 or 1)) % #focusOrder) + 1
            g.focusId = focusOrder[nextAt]
            if g.focusId == "main.galleryInput" or g.focusId == "main.galleryEditor" then
                cx:frame({{"focus", g.focusId}})
            else
                cx:frame({{"focus", tern.json.null}})
            end
            return true
        end
        local name = g.focusId:match("([^%.]+)$")
        if (key.name == "enter" or key.text == " ") and controls[name] and controls[name].k == "button" then
            g.event({ev = "action", act = controls[name].p.actions.click}, cx); return true
        end
        if not key.ctrl and not key.meta and key.text and (name == "galleryInput" or name == "galleryEditor") then
            if name == "galleryInput" then g.input ..= key.text; inputCursor = utf8.len(g.input)
            else g.editor ..= key.text; editorCursor = utf8.len(g.editor) end
            return true
        elseif key.name == "enter" and name == "galleryEditor" then
            g.editor ..= "\n"; editorCursor = utf8.len(g.editor); return true
        end
        return false
    end
    return g
end
return M
