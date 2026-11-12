--!strict
local ui = tern.ui
local Review = require("./review")
local context = require("./context")
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
local severityTones = {blocking = "error", major = "warning", minor = "pending", note = "muted"}
local severityOrder = {"blocking", "major", "minor", "note"}
local stateNames = {open = "未处置", resolved = "已解决", waived = "已豁免"}
local stateTones = {open = "warning", resolved = "success", waived = "muted"}
local decisionNames = {accepted = "已接受", rejected = "已驳回"}
local function note(text) return ui.text({ui.span(text or "", "muted")}) end
local function button(label, action, variant, disabled)
    return ui.button(label, {key = action, variant = variant or "default", size = "sm", disabled = disabled,
        actions = {click = action}})
end
local function row(key, children, props)
    props = props or {}
    props.key = key
    props.gap = props.gap or "sm"
    props.wrap = true
    return ui.node("row", props, children)
end
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
-- Mirrors the host's parseFindings, but keeps invalid lines visible instead of
-- failing the whole draft: the builder and the raw editor share one text buffer.
type DraftRow = {severity: string?, description: string?, raw: string?}
local function draftRows(text)
    local rows: {DraftRow}, invalid = {}, false
    for raw in ((text or "") .. "\n"):gmatch("(.-)\n") do
        local line = raw:gsub("^%s+", ""):gsub("%s+$", "")
        if line ~= "" then
            local level, description = line:match("^([%a_]+)%s*|%s*(.+)$")
            level = level and level:lower()
            if level and severityNames[level] and description then
                table.insert(rows, {severity = level, description = description})
            else
                invalid = true
                table.insert(rows, {raw = line})
            end
        end
    end
    return rows, invalid
end
local function findingCounts(data)
    local total, open, openBlocking = 0, 0, 0
    for _, review in data and data.reviews or {} do
        for _, finding in review.findings or {} do
            total += 1
            if Review.findingState(review, finding.id) == "open" then
                open += 1
                if finding.severity == "blocking" then openBlocking += 1 end
            end
        end
    end
    return total, open, openBlocking
end
local function criterionCoverage(r, results, snapshot)
    local required, covered = 0, 0
    for _, criterion in r.acceptanceCriteria or {} do
        if criterion.required then
            required += 1
            local has = false
            for _, verification in results and results.verifications or {} do
                if snapshot and verification.result == "passed" and verification.requirementRevision == r.revision
                    and verification.codeSnapshotSha256 == snapshot then
                    for _, id in verification.criterionIds do if id == criterion.id then has = true; break end end
                end
                if has then break end
            end
            if has then covered += 1 end
        end
    end
    return required, covered
end
local function shortTime(value)
    local text = tostring(value or "")
    return text:sub(1, 16):gsub("T", " ")
end
local function statusStrip(s, v, writable): any
    local badges = {}
    if s.problem then table.insert(badges, ui.badge("连接异常", "warning")) end
    if s.receipt then
        local names = {pending = "预填等待回执", prefilled = "已预填（未发送）", rejected = "预填被拒绝", delivery_unknown = "投递待核对"}
        table.insert(badges, ui.badge(names[s.receipt.status] or "预填状态", s.receipt.status == "prefilled" and "success" or "muted"))
    end
    if v.busy then table.insert(badges, ui.badge("正在记录…", "pending")) end
    if not writable then table.insert(badges, ui.badge("只读", "muted")) end
    if #badges == 0 then return nil end
    return ui.node("row", {key = "reviewStatus", role = "workbench.status", gap = "xs", wrap = true}, badges)
end
local function snapshotLine(snapshot, writable)
    if snapshot then
        return row("reviewSnapshot", {
            ui.badge("快照 " .. snapshot:sub(1, 12), "muted"),
            ui.text({ui.span("审查与验收绑定此快照", "muted")}),
        }, {gap = "xs"})
    end
    return row("reviewSnapshot", {
        ui.text({ui.span("尚未读取代码快照", "warning")}),
        button("去实施与验证读取", "wb-open-results", "quiet", not writable),
    }, {gap = "xs"})
end
-- Composite control: explicit col + rows. A `field` wrapper would lay these
-- out as one inline control row and collapse the structure.
local function findingsBuilder(v, writable, invalid)
    local rows = draftRows(v.fields.reviewFindings.text)
    local blocking = 0
    for _, item in rows do if item.severity == "blocking" then blocking += 1 end end
    local severityChips = {}
    for _, level in severityOrder do
        local selected = v.draftSeverity == level
        table.insert(severityChips, ui.button(severityNames[level], {key = "draftSeverity-" .. level,
            variant = selected and "primary" or "default", size = "sm", on = selected, disabled = not writable,
            actions = {click = "change:draftSeverity=" .. level}}))
    end
    local nodes = {
        ui.text({ui.span("发现 · 逐条添加", "strong")}),
        row("draftSeverityRow", severityChips, {gap = "xs"}),
        row("draftAddRow", {
            ui.node("input", {key = "findingDraft", text = v.fields.findingDraft.text,
                cursor = units(v.fields.findingDraft.text, v.fields.findingDraft.cursor or utf8.len(v.fields.findingDraft.text)),
                placeholder = "描述一个问题；回车或点击添加", aria = "发现描述", variant = "field"}),
            button("添加", "review-add-finding", "default",
                (not writable and "只读或记录未就绪") or (not v.fields.findingDraft.text:match("%S") and "先填写描述") or false),
        }, {gap = "xs", align = "end"}),
    }
    if #rows > 0 then
        local tableRows = {}
        for index, item in rows do
            table.insert(tableRows, {id = tostring(index), cells = {
                {badge = {text = item.severity and severityNames[item.severity] or "无效", tone = item.severity and severityTones[item.severity] or "error"}},
                {text = item.description or item.raw},
                {button = {text = "移除", act = "review-remove-finding=" .. tostring(index), variant = "quiet", disabled = not writable}},
            }})
        end
        table.insert(nodes, ui.table({
            {id = "severity", head = "严重度", priority = 2},
            {id = "description", head = "描述", grow = 1, truncate = "end"},
            {id = "remove", head = "", align = "end", priority = 1},
        }, tableRows, {key = "draftFindings", role = "workbench.findings"}))
    end
    local metaChildren = {
        note(#rows > 0 and ("已添加 " .. tostring(#rows) .. " 项" .. (blocking > 0 and (" · 阻断 " .. tostring(blocking)) or ""))
            or "没有发现也可以记录一次干净审查"),
    }
    if invalid then table.insert(metaChildren, ui.text({ui.span("有无效行，请在手动编辑中修正", "warning")})) end
    table.insert(nodes, row("draftMeta", metaChildren, {gap = "sm"}))
    table.insert(nodes, ui.node("section", {key = "manualFindings", head = "手动编辑原始文本",
        collapsible = true, collapsed = not invalid}, {
        field("reviewFindings", "每行“严重度|描述”", v.fields.reviewFindings.text, v.fields.reviewFindings.cursor,
            v.fields.reviewFindings.anchor, 6, not writable, "blocking|登录过期时没有入口"),
    }))
    return ui.node("col", {key = "findingsBuilder", role = "workbench.findingsBuilder", gap = "sm"}, nodes)
end
local function recordCard(s, v, writable, snapshot)
    local data = v.data
    local count = data and #data.reviews or 0
    local _, invalid = draftRows(v.fields.reviewFindings.text)
    local nativeDisabled = (not writable and "只读或记录未就绪") or (s.problem ~= nil and "连接异常")
        or (not s.snapshot and "尚未读取运行状态") or (s.snapshot and s.snapshot.state ~= "idle" and "omp 非空闲")
        or (s.pending ~= nil and "已有预填待核对") or (s.ui.handoff and s.ui.handoff.pendingSend ~= nil and "业务发送待核对") or false
    local left = ui.node("col", {key = "recordLeft", role = "workbench.recordLeft", gap = "sm"}, {
        choices("rvSource", "来源", v.source, {
            {value = "native_review", label = "omp 原生审查"}, {value = "manual", label = "人工审查"},
            {value = "external", label = "外部审查"}}, not writable),
        field("reviewScope", "审查范围", v.fields.reviewScope.text, v.fields.reviewScope.cursor, v.fields.reviewScope.anchor,
            2, not writable, "例如：未提交改动 / 分支 main...HEAD"),
        snapshotLine(snapshot, writable),
        row("recordActions", {
            button(v.busy and "正在记录…" or "记录审查（绑定当前快照）", "review-create", "primary",
                (not writable and "只读或记录未就绪") or (not snapshot and "先读取代码快照")
                or (not v.fields.reviewScope.text:match("%S") and "先填写审查范围") or false),
        }),
    })
    local right = ui.node("col", {key = "recordRight", role = "workbench.recordRight", gap = "sm"}, {
        findingsBuilder(v, writable, invalid),
    })
    return ui.node("card", {key = "recordCard", role = "workbench.record", head = "① 记录审查",
        meta = count > 0 and ("已记录 " .. tostring(count) .. " 次") or "来源、范围与发现",
        collapsible = true, collapsed = count > 0, tone = "muted"}, {
        row("recordTools", {
            ui.button("预填 /review 到 omp", {key = "review-open-native", variant = "quiet", size = "sm",
                title = "只把 omp 原生 /review 放入输入框；不发送，范围与提交方式由 omp 选择。",
                disabled = nativeDisabled, actions = {click = "review-open-native"}}),
        }, {gap = "xs", role = "workbench.panelTools"}),
        row("recordGrid", {left, right}, {gap = "md", align = "start"}),
    })
end
local function findingsTable(v, review, writable)
    if #review.findings == 0 then return note("无发现（干净审查）") end
    local rows = {}
    for _, finding in review.findings do
        local state, reason = Review.findingState(review, finding.id)
        local key = review.id .. "|" .. finding.id
        table.insert(rows, {id = key, title = reason, cells = {
            {badge = {text = severityNames[finding.severity] or finding.severity, tone = severityTones[finding.severity] or "muted"}},
            {text = finding.description},
            {text = stateNames[state] or state, dot = stateTones[state] or "muted", title = reason},
            {button = {text = "处置", act = "review-inline=" .. key, variant = "default",
                disabled = not writable and "只读或记录未就绪" or false}},
        }})
    end
    return ui.table({
        {id = "severity", head = "严重度", priority = 3},
        {id = "description", head = "发现", grow = 1, truncate = "end"},
        {id = "state", head = "状态", priority = 2},
        {id = "act", head = "", align = "end", priority = 1},
    }, rows, {key = "findingsTable" .. review.id, role = "workbench.findings", selectable = true, selected = v.finding})
end
local function dispositionPanel(v, writable)
    local selected
    for _, review in v.data and v.data.reviews or {} do
        for _, finding in review.findings or {} do
            if v.finding == review.id .. "|" .. finding.id then selected = finding end
        end
    end
    if not selected then return nil end
    return ui.node("card", {key = "dispositionPanel", role = "workbench.disposition", tone = "accent",
        head = "处置发现", meta = severityNames[selected.severity] or selected.severity}, {
        row("dispositionGrid", {
            ui.node("col", {key = "dispositionWhat", role = "workbench.dispositionWhat", gap = "xs"}, {
                ui.text(selected.description),
            }),
            ui.node("col", {key = "dispositionHow", role = "workbench.dispositionHow", gap = "sm"}, {
                choices("rvAction", "处置方式", v.action, {
                    {value = "resolved", label = "已解决"}, {value = "waived", label = "明确豁免"},
                    {value = "reopened", label = "重新打开"}}, not writable),
                field("reviewReason", "处置理由", v.fields.reviewReason.text, v.fields.reviewReason.cursor,
                    v.fields.reviewReason.anchor, 2, not writable, "必须记录理由；豁免也保留在这里"),
                row("dispositionActions", {
                    button("追加处置事件", "review-dispose", "primary",
                        (not writable and "只读或记录未就绪") or (not v.fields.reviewReason.text:match("%S") and "先填写处置理由") or false),
                    button("取消", "review-cancel", "quiet"),
                }),
            }),
        }, {gap = "md", align = "start"}),
    })
end
local function findingsCard(v, writable)
    local items = v.data and v.data.reviews or {}
    local total, open, openBlocking = findingCounts(v.data)
    local children = {}
    if #items == 0 then
        table.insert(children, note("尚无审查记录。没有审查也可以由你明确验收；阻断规则只适用于已记录的发现。"))
    else
        for index = #items, math.max(1, #items - 9), -1 do
            local review = items[index]
            local reviewOpen = 0
            for _, finding in review.findings do
                if Review.findingState(review, finding.id) == "open" then reviewOpen += 1 end
            end
            table.insert(children, ui.node("card", {key = "review-" .. tostring(index), role = "workbench.reviewRecord",
                head = (sourceNames[review.source] or review.source) .. " · " .. shortTime(review.createdAt),
                meta = review.scope:sub(1, 40) .. " · " .. tostring(#review.findings) .. " 发现"
                    .. (reviewOpen > 0 and (" · " .. tostring(reviewOpen) .. " 未处置") or ""),
                collapsible = true, collapsed = index ~= #items, tone = reviewOpen > 0 and "warning" or "muted"}, {
                findingsTable(v, review, writable),
                note("快照 " .. review.codeSnapshotSha256:sub(1, 12) .. " · 需求修订 " .. tostring(review.requirementRevision)),
            }))
        end
        if #items > 10 then table.insert(children, note("仅显示最近 10 次审查；共 " .. tostring(#items) .. " 次。")) end
    end
    local panel = v.panel == "dispose" and dispositionPanel(v, writable) or nil
    if panel then table.insert(children, panel) end
    return ui.node("card", {key = "findingsCard", role = "workbench.findingsCard", head = "② 发现处置",
        meta = total > 0 and (tostring(open) .. " / " .. tostring(total) .. " 未处置") or "记录后在这里处置",
        tone = openBlocking > 0 and "warning" or "muted"}, children)
end
local function acceptanceCard(s, v, r, writable, snapshot)
    local data = v.data
    local trace = s.ui.trace
    local gate = Review.acceptanceGate(r, trace and trace.results, data)
    local latest = Review.latestAcceptance(data)
    local canDecide = r.stage == "implementing" or r.stage == "verifying" or r.stage == "awaiting_acceptance"
    local required, covered = criterionCoverage(r, trace and trace.results, snapshot)
    local _, open, openBlocking = findingCounts(data)
    local gateReason = (not writable and "只读或记录未就绪") or (not canDecide and "当前阶段不能验收")
        or (not gate.ok and "门禁未通过：先满足条件") or false
    local evidenceChildren = {}
    if gate.ok then
        table.insert(evidenceChildren, ui.text({ui.span("门禁通过：必需条件有当前快照上的通过证据，且没有未处置的阻断发现。", "success")}))
    else
        for _, problem in gate.problems do
            table.insert(evidenceChildren, ui.text({ui.span("• ", "warning"), ui.span(problem, "warning")}))
        end
    end
    if latest then
        table.insert(evidenceChildren, row("latestDecision", {
            ui.badge(decisionNames[latest.decision] or latest.decision, latest.decision == "accepted" and "success" or "warning"),
            ui.text({ui.span(shortTime(latest.createdAt) .. (latest.comment ~= "" and (" · " .. latest.comment:sub(1, 80)) or ""), "muted")}),
        }, {gap = "xs"}))
    end
    table.insert(evidenceChildren, note("验收只能由你触发；退出码 0 或模型声称完成都不构成验收。"))
    local evidence = ui.node("col", {key = "gateEvidence", role = "workbench.gateEvidence", gap = "sm"}, evidenceChildren)
    local decideChildren = {}
    if gate.ok and canDecide and writable then
        table.insert(decideChildren, field("reviewComment", "验收说明（可留空）", v.fields.reviewComment.text, v.fields.reviewComment.cursor,
            v.fields.reviewComment.anchor, 2, not writable, "说明会写入验收历史"))
    end
    table.insert(decideChildren, ui.node("row", {key = "acceptActions", gap = "sm", wrap = true}, {
        ui.button("人工接受并完成", {key = "review-accept", variant = "primary", size = "md",
            disabled = gateReason, actions = {click = "review-accept"}}),
    }))
    table.insert(decideChildren, row("decideSecondary", {
        button("驳回…", "review-toggle=reject", "default",
            (not writable and "只读或记录未就绪") or (not canDecide and "当前阶段不能驳回") or false),
        button("重新打开…", "review-toggle=reopen", "default",
            (not writable and "只读或记录未就绪") or (r.stage ~= "done" and "只有已完成需求可以重新打开") or false),
    }))
    if v.panel == "reject" then
        table.insert(decideChildren, ui.node("col", {key = "rejectPanel", role = "workbench.disposition", gap = "sm"}, {
            field("reviewReject", "驳回原因", v.fields.reviewReject.text, v.fields.reviewReject.cursor,
                v.fields.reviewReject.anchor, 2, not writable, "驳回会记录人工决定，并把需求退回实施中"),
            row("rejectActions", {
                button("确认驳回", "review-reject", "danger",
                    (not writable and "只读或记录未就绪") or (not canDecide and "当前阶段不能驳回")
                    or (not snapshot and "先读取代码快照") or (not v.fields.reviewReject.text:match("%S") and "先填写驳回原因") or false),
                button("取消", "review-cancel", "quiet"),
            }),
        }))
    end
    if v.panel == "reopen" then
        table.insert(decideChildren, ui.node("col", {key = "reopenPanel", role = "workbench.disposition", gap = "sm"}, {
            field("reviewReopen", "重新打开原因", v.fields.reviewReopen.text, v.fields.reviewReopen.cursor,
                v.fields.reviewReopen.anchor, 2, not writable, "保留已完成历史；重新打开后回到澄清中"),
            row("reopenActions", {
                button("确认重新打开", "review-reopen", "default",
                    (not writable and "只读或记录未就绪") or (r.stage ~= "done" and "只有已完成需求可以重新打开")
                    or (not v.fields.reviewReopen.text:match("%S") and "先填写重新打开原因") or false),
                button("取消", "review-cancel", "quiet"),
            }),
        }))
    end
    local decide = ui.node("col", {key = "gateDecide", role = "workbench.gateDecide", gap = "sm"}, decideChildren)
    return ui.node("card", {key = "acceptance", role = "workbench.acceptance", head = "③ 人工验收",
        meta = gate.ok and "可以接受" or "先满足门禁条件", tone = gate.ok and "success" or "warning"}, {
        ui.stats({
            {label = "门禁", value = gate.ok and "通过" or "未通过", tone = gate.ok and "success" or "warning"},
            {label = "必需条件证据", value = tostring(covered) .. " / " .. tostring(required),
                tone = required == covered and "success" or "warning", title = "必需验收条件在当前快照上的通过证据"},
            {label = "未处置发现", value = tostring(open), tone = open == 0 and "success" or "warning",
                title = "其中阻断 " .. tostring(openBlocking) .. " 项；阻断必须处置"},
            {label = "代码快照", value = snapshot and "已绑定" or "缺失", tone = snapshot and "success" or "error"},
            {label = "审查记录", value = tostring(data and #data.reviews or 0), tone = "muted"},
        }),
        row("acceptGrid", {evidence, decide}, {gap = "md", align = "start"}),
    })
end
local function historyCard(v)
    local data = v.data
    local acceptances = data and data.acceptances or {}
    local reopenings = data and data.reopenings or {}
    if #acceptances == 0 and #reopenings == 0 then return nil end
    local rows = {}
    for index = #acceptances, 1, -1 do
        local item = acceptances[index]
        table.insert(rows, row("acceptance-" .. tostring(index), {
            ui.badge(decisionNames[item.decision] or item.decision, item.decision == "accepted" and "success" or "warning"),
            ui.text({ui.span(shortTime(item.createdAt) .. " · 修订 " .. tostring(item.requirementRevision)
                .. " · 快照 " .. item.codeSnapshotSha256:sub(1, 12)
                .. (item.comment ~= "" and (" · " .. item.comment:sub(1, 100)) or ""), "muted")}),
        }, {gap = "xs"}))
    end
    for index = #reopenings, 1, -1 do
        local item = reopenings[index]
        table.insert(rows, row("reopening-" .. tostring(index), {
            ui.badge("重新打开", "pending"),
            ui.text({ui.span(shortTime(item.at) .. " · " .. item.reason:sub(1, 100), "muted")}),
        }, {gap = "xs"}))
    end
    return ui.node("card", {key = "historyCard", role = "workbench.history", head = "验收与重开历史",
        meta = tostring(#acceptances + #reopenings) .. " 条", collapsible = true, collapsed = true, tone = "muted"}, rows)
end
function M.build(s)
    local u, r = s.ui, s.ui.byId[s.ui.selected]
    local v = u.review
    local nodes = {context.bar(s, {current = {tab = "review"}})}
    if not r then
        return ui.node("col", {key = "review", role = "workbench.review", gap = "sm"}, nodes)
    end
    if not v then
        table.insert(nodes, note("正在读取审查记录…"))
        return ui.node("col", {key = "review", role = "workbench.review", gap = "sm"}, nodes)
    end
    local writable = u.writable and v.safe and not v.busy
    local trace = u.trace
    local snapshot = trace and trace.results and trace.results.changes and trace.results.changes.fingerprint
    local strip = statusStrip(s, v, writable)
    if strip then table.insert(nodes, strip) end
    if s.problem then table.insert(nodes, ui.text({ui.span(s.problem, "warning")})) end
    if v.error then table.insert(nodes, ui.text({ui.span(v.error, "error")})) end
    if v.notice then table.insert(nodes, ui.text({ui.span(v.notice, "warning")})) end
    table.insert(nodes, recordCard(s, v, writable, snapshot))
    table.insert(nodes, findingsCard(v, writable))
    table.insert(nodes, acceptanceCard(s, v, r, writable, snapshot))
    local history = historyCard(v)
    if history then table.insert(nodes, history) end
    return ui.node("col", {key = "review", role = "workbench.review", gap = "sm"}, nodes)
end
return M