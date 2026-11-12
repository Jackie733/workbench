--!strict
local ui = tern.ui
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
local function note(text) return ui.text({ui.span(text or "", "muted")}) end
local function button(label, action, variant, disabled)
    return ui.button(label, {key = action, variant = variant or "quiet", size = "sm", disabled = disabled,
        actions = {click = action}})
end
function M.build(s)
    local u, r = s.ui, s.ui.byId[s.ui.selected]
    local a, v = u.audit, u.review
    if not r then
        return ui.node("col", {key = "audit", role = "workbench.audit", gap = "sm"}, {
            ui.text({ui.span("审计", "title")}),
            note("选择一项需求以查看可追溯的应用内历史。"),
        })
    end
    if not a or not v then return note("正在读取审计记录…") end
    local writable = u.writable and not a.busy
    local query = v.fields.auditQuery.text
    local events = Audit.filter(a.events or {}, query)
    local nodes = {
        ui.card("审计 · " .. r.number .. " · " .. r.title, {
            note("需求修订 " .. tostring(r.revision) .. " · 阶段 " .. tostring(r.stage)
                .. " · 事件按时间倒序；来源是项目内需求、方案、批准、计划、代码观察、验证、审查与人工验收记录。"),
            note("本地文件仍可被用户修改；这不是防篡改日志，也不能证明操作者身份。"),
        }, {key = "auditTarget", tone = "muted"}),
    }
    if a.error then table.insert(nodes, ui.text({ui.span(a.error, "error")})) end
    if a.notice then table.insert(nodes, ui.text({ui.span(a.notice, "warning")})) end
    table.insert(nodes, ui.node("field", {key = "auditQueryField", label = "检索事件"}, {
        ui.node("input", {key = "auditQuery", text = query, cursor = units(query, v.fields.auditQuery.cursor or utf8.len(query)),
            placeholder = "按类型、摘要或引用检索当前需求", aria = "审计检索", variant = "field", icon = "search"}),
    }))
    table.insert(nodes, ui.node("row", {key = "auditActions", gap = "sm", wrap = true}, {
        button("刷新审计", "audit-refresh", "quiet", not writable),
        button("复制 Markdown", "audit-copy", "quiet", not writable or not a.markdown),
        button("写入项目导出文件", "audit-write", "primary", not writable or not a.markdown),
    }))
    table.insert(nodes, note("导出只包含应用内记录：不包含验证 stdout/stderr、聊天记录、认证信息或凭据；不宣称本地文件不可修改。"))
    local rows = {}
    for index, event in events do
        if index <= 120 then
            table.insert(rows, ui.text(tostring(event.at) .. " · " .. tostring(event.kind) .. " · " .. tostring(event.summary)
                .. (event.ref ~= "" and (" · " .. event.ref) or "")))
        end
    end
    if #rows == 0 then table.insert(rows, note("没有匹配的事件。")) end
    if #events > 120 then table.insert(rows, note("仅显示前 120 条；共 " .. tostring(#events) .. " 条。")) end
    table.insert(nodes, ui.node("scroll", {key = "auditEvents", max = {h = "28lines"}}, rows))
    if a.eventsTruncated then table.insert(nodes, ui.text({ui.span("时间线超过上限，已保留最新事件。", "warning")})) end
    if a.exportPath then table.insert(nodes, note("最近写入：" .. a.exportPath)) end
    return ui.node("col", {key = "audit", role = "workbench.audit", gap = "sm"}, nodes)
end
return M
