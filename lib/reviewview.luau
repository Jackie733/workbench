--!strict
local ui = tern.ui
local Review = require("./review")
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
local sourceNames = {native_review = "omp 原生审查", manual = "人工审查", external = "外部审查"}
local severityNames = {blocking = "阻断", major = "重要", minor = "次要", note = "备注"}
local stateNames = {open = "未处置", resolved = "已解决", waived = "已豁免"}
local function note(text) return ui.text({ui.span(text or "", "muted")}) end
local function button(label, action, variant, disabled)
    return ui.button(label, {key = action, variant = variant or "default", size = "sm", disabled = disabled,
        actions = {click = action}})
end
local function row(key, children) return ui.node("row", {key = key, gap = "sm", wrap = true}, children) end
local function choices(name, label, value, options, disabled)
    local chips = {}
    for _, option in options do
        local selected = value == option.value
        table.insert(chips, ui.button(option.label, {key = name .. "-" .. option.value,
            variant = selected and "primary" or "default", size = "sm", on = selected, disabled = disabled,
            actions = {click = "change:" .. name .. "=" .. option.value}}))
    end
    return ui.node("field", {key = name .. "Field", label = label}, {row(name, chips)})
end
local function field(key, label, text, cursor, anchor, lines, readonly, placeholder)
    text = text or ""
    return ui.node("field", {key = "reviewField-" .. key, label = label, help = placeholder}, {
        ui.node("editor", {key = key, text = text, cursor = units(text, cursor or utf8.len(text)),
            anchor = anchor and units(text, anchor) or nil, maxLines = lines, readonly = readonly,
            placeholder = placeholder, aria = label, variant = "field"})})
end
local function latestAcceptance(data) return data and data.acceptances and data.acceptances[#data.acceptances] end
local function optionsForFindings(items)
    local list = {}
    for _, review in items or {} do
        for _, finding in review.findings or {} do table.insert(list, review.id .. "|" .. finding.id) end
    end
    return list
end
function M.build(s)
    local u, r = s.ui, s.ui.byId[s.ui.selected]
    local v = u.review
    if not r then return ui.node("empty", {key = "reviewNoRequirement", title = "先选择需求", text = "审查、发现处置和人工验收都绑定到当前需求。"}) end
    if not v then return note("正在读取审查记录…") end
    local data = v.data
    local trace = u.trace
    local writable = u.writable and v.safe and not v.busy
    local snapshot = trace and trace.results and trace.results.changes and trace.results.changes.fingerprint
    local nodes = {
        ui.card(r.number .. " · " .. r.title, {
            note("顺序：记录审查 → 处置发现 → 人工验收。没有发现也可以验收；阻断发现必须处置。"),
            note("需求修订 " .. tostring(r.revision) .. " · 阶段 " .. tostring(r.stage) .. " · 项目 " .. s.payload.binding.projectRoot),
        }, {key = "reviewTarget", tone = "muted"}),
    }
    if v.error then table.insert(nodes, ui.text({ui.span(v.error, "error")})) end
    if v.notice then table.insert(nodes, ui.text({ui.span(v.notice, "warning")})) end
    if s.receipt then
        table.insert(nodes, note("原生预填回执 " .. tostring(s.receipt.status) .. " · " .. tostring(s.receipt.reason or "")))
    end
    table.insert(nodes, ui.node("section", {key = "nativeReview", head = "原生审查入口", collapsible = true, collapsed = false}, {
        note("这里只把 omp 原生 `/review` 放入当前会话输入框；范围和提交方式由 omp 自己选择。工作台不实现审查引擎，也不会自动发送。"),
        button("把 /review 预填到 omp 输入框", "review-open-native", "primary",
            not writable or s.problem ~= nil or not s.snapshot or s.snapshot.state ~= "idle"
            or s.pending ~= nil or (u.handoff and u.handoff.pendingSend ~= nil)),
    }))
    table.insert(nodes, ui.card("记录一次审查", {
        note("来源和范围由你填写；发现每行使用“严重度|描述”，严重度可选 blocking/major/minor/note。没有发现时留空。"),
        choices("rvSource", "来源", v.source, {
            {value = "native_review", label = "omp 原生审查"}, {value = "manual", label = "人工审查"},
            {value = "external", label = "外部审查"}}, not writable),
        note(snapshot and ("审查将绑定当前代码快照 " .. snapshot:sub(1, 16)) or "尚未读取代码变化；先到“实施与验证”读取。"),
        field("reviewScope", "审查范围", v.fields.reviewScope.text, v.fields.reviewScope.cursor, v.fields.reviewScope.anchor, 3, not writable,
            "例如：未提交改动 / 分支 main...HEAD / 指定文件与验收条件"),
        field("reviewFindings", "发现 · 每行“严重度|描述”", v.fields.reviewFindings.text, v.fields.reviewFindings.cursor, v.fields.reviewFindings.anchor,
            8, not writable, "blocking|登录过期时没有入口"),
        button("记录审查（绑定当前代码快照）", "review-create", "primary",
            not writable or not snapshot or not v.fields.reviewScope.text:match("%S")),
    }, {key = "reviewCreate", tone = "muted"}))

    local items = data and data.reviews or {}
    if #items == 0 then
        table.insert(nodes, note("尚无审查记录。没有审查也可以由你明确验收；阻断规则只适用于已记录的发现。"))
    else
        local cards = {}
        for index = #items, math.max(1, #items - 9), -1 do
            local review = items[index]
            local findingRows = {}
            for _, finding in review.findings do
                local state, reason = Review.findingState(review, finding.id)
                local key = review.id .. "|" .. finding.id
                local selected = v.finding == key
                table.insert(findingRows, row("finding-" .. finding.id, {
                    ui.text("[" .. severityNames[finding.severity] .. "] " .. finding.description
                        .. " · " .. stateNames[state] .. (reason and (" · " .. reason) or "")),
                    ui.button(selected and "已选中" or "选中处置", {key = "pick-" .. finding.id, size = "sm",
                        variant = selected and "primary" or "default", on = selected,
                        actions = {click = "review-pick=" .. key}}),
                }))
            end
            if #findingRows == 0 then table.insert(findingRows, note("无发现（干净审查）")) end
            table.insert(cards, ui.card((sourceNames[review.source] or review.source) .. " · " .. review.id, {
                note("范围：" .. review.scope .. " · 快照 " .. review.codeSnapshotSha256:sub(1, 16)
                    .. " · 需求修订 " .. tostring(review.requirementRevision) .. " · " .. tostring(review.createdAt)),
                (function() return ui.node("col", {key = "findings-" .. tostring(index), gap = "xs"}, findingRows) end)(),
            }, {key = "review-" .. tostring(index), tone = "muted"}))
        end
        table.insert(nodes, ui.node("section", {key = "reviewHistory", head = "审查记录 · " .. tostring(#items), collapsible = true, collapsed = false}, cards))
    end
    local hasFindings = #optionsForFindings(items) > 0
    local selectedFinding = nil
    for _, review in items do
        for _, finding in review.findings do
            if v.finding == review.id .. "|" .. finding.id then
                selectedFinding = "[" .. severityNames[finding.severity] .. "] " .. finding.description
            end
        end
    end
    table.insert(nodes, ui.card("追加发现处置", {
        note(selectedFinding and ("已选发现：" .. selectedFinding) or (hasFindings and "先在上方“审查记录”里选择一条发现。" or "没有可处置的发现。")),
        choices("rvAction", "处置", v.action, {
            {value = "resolved", label = "已解决"}, {value = "waived", label = "明确豁免"}, {value = "reopened", label = "重新打开"}}, not writable),
        field("reviewReason", "处置理由", v.fields.reviewReason.text, v.fields.reviewReason.cursor, v.fields.reviewReason.anchor, 3, not writable,
            "必须记录理由；豁免也保留在这里"),
        button("追加处置事件", "review-dispose", "primary",
            (not writable and "只读或记录未就绪") or (not hasFindings and "没有可处置的发现")
            or (not selectedFinding and "先在上方选择一条发现")
            or (not v.fields.reviewReason.text:match("%S") and "先填写处置理由") or false),
    }, {key = "reviewDisposition", tone = "muted"}))

    local gate = Review.acceptanceGate(r, trace and trace.results, data)
    local latest = latestAcceptance(data)
    local canDecide = r.stage == "implementing" or r.stage == "verifying" or r.stage == "awaiting_acceptance"
    local gateNodes = {}
    if gate.ok then table.insert(gateNodes, ui.text({ui.span("当前门禁通过：必需验收条件有当前快照上的通过证据，且没有未处置的阻断发现。", "success")}))
    else
        table.insert(gateNodes, ui.text({ui.span("当前不能验收：", "warning")}))
        for _, problem in gate.problems do table.insert(gateNodes, ui.text("• " .. problem)) end
    end
    if latest then
        table.insert(gateNodes, note("最近人工决定：" .. latest.decision .. " · 需求修订 " .. tostring(latest.requirementRevision)
            .. " · 快照 " .. latest.codeSnapshotSha256:sub(1, 16) .. (latest.comment ~= "" and (" · " .. latest.comment) or "")))
    else table.insert(gateNodes, note("尚无人工验收记录。")) end
    table.insert(gateNodes, field("reviewComment", "验收说明", v.fields.reviewComment.text, v.fields.reviewComment.cursor, v.fields.reviewComment.anchor,
        3, not writable, "接受时可留空；说明会写入验收历史"))
    table.insert(gateNodes, row("acceptActions", {
        button("人工接受并完成", "review-accept", "primary",
            (not writable and "只读或记录未就绪") or (not canDecide and "当前阶段不能验收") or (not gate.ok and "门禁未通过：先满足上方条件") or false),
    }))
    table.insert(gateNodes, field("reviewReject", "驳回原因", v.fields.reviewReject.text, v.fields.reviewReject.cursor,
        v.fields.reviewReject.anchor, 3, not writable, "驳回会记录人工决定，并把需求退回实施中"))
    table.insert(gateNodes, row("rejectActions", {
        button("人工驳回", "review-reject", "danger", (not writable and "只读或记录未就绪")
            or (not canDecide and "当前阶段不能驳回") or (not snapshot and "先读取代码快照")
            or (not v.fields.reviewReject.text:match("%S") and "先填写驳回原因") or false),
        button("重新打开已完成需求", "review-reopen", "default", (not writable and "只读或记录未就绪")
            or (r.stage ~= "done" and "只有已完成需求可以重新打开")
            or (not v.fields.reviewReopen.text:match("%S") and "先填写重新打开原因") or false),
    }))
    table.insert(gateNodes, field("reviewReopen", "重新打开原因", v.fields.reviewReopen.text, v.fields.reviewReopen.cursor,
        v.fields.reviewReopen.anchor, 3, not writable, "保留已完成历史；重新打开后回到澄清中"))
    table.insert(nodes, ui.card("人工验收 · 只能由你触发", gateNodes, {key = "acceptance", tone = gate.ok and "success" or "warning"}))
    return ui.node("col", {key = "review", role = "workbench.review", gap = "sm"}, nodes)
end
return M
