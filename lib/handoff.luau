--!strict
local ui = tern.ui
local diff = require("./diff")
local Workflow = require("./workflow")
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
    return ui.button(label, {key = action, variant = variant or "default", size = "sm", disabled = disabled,
        actions = {click = action}})
end
local function row(key, children)
    return ui.node("row", {key = key, gap = "sm", wrap = true}, children)
end
local function choices(name, label, value, options, disabled)
    local chips = {}
    for _, option in options do
        local selected = value == option.value
        table.insert(chips, ui.button(option.label, {key = name .. "-" .. option.value,
            variant = selected and "primary" or "default", size = "sm", on = selected, disabled = disabled,
            actions = {click = "change:" .. name .. "=" .. option.value}}))
    end
    return ui.node("field", {key = name .. "Field", label = label, role = "workbench.choices"},
        {row(name, chips)})
end
local function editor(key, label, text, cursor, anchor, lines, readonly, placeholder)
    text = text or ""
    return ui.node("field", {key = "handoffField-" .. key, label = label, help = placeholder}, {
        ui.node("editor", {key = "h-" .. key, text = text,
            cursor = units(text, cursor or utf8.len(text)), anchor = anchor and units(text, anchor) or nil,
            maxLines = lines, readonly = readonly, placeholder = placeholder, aria = label, variant = "field"})})
end
local activityNames = {clarify = "澄清", design = "设计", implement = "实施"}

-- One presentation vocabulary for receipts. A submitted prompt is not proof that
-- the session consumed it, and none of these stages means delivery or acceptance.
local receiptStates = {
    prefilled = {label = "已预填到 omp 输入框（未提交）", tone = "muted"},
    inspected = {label = "来源检查完成（未发送）", tone = "muted"},
    submitted = {label = "已提交到会话（未确认开始执行）", tone = "info"},
    rejected = {label = "来源拒绝执行", tone = "warning"},
    delivery_unknown = {label = "投递结果未知：需人工核对", tone = "warning"},
    accepted = {label = "来源已接收（未确认消费）", tone = "muted"},
    consumed = {label = "来源已消费（不等于交付）", tone = "muted"},
    ended = {label = "本轮已结束（不等于交付）", tone = "muted"},
}
function M.receipt(status)
    return receiptStates[tostring(status)] or {label = "回执状态：" .. tostring(status), tone = "muted"}
end

local sendStates = {
    recording_intent = "正在记录发送意图（尚无来源命令）",
    recovered_intent = "已恢复的发送意图；发送结果待核对",
    intent_unknown = "发送意图无法确认；不会自动重试",
    intent_only = "只记录了意图；未向来源发送",
    source_command = "已交给来源命令，等待回执",
}
function M.sendState(pending)
    if type(pending) ~= "table" then return nil end
    if pending.receiptAppliedStatus then return M.receipt(pending.receiptAppliedStatus).label end
    if pending.receiptStatus then return M.receipt(pending.receiptStatus).label end
    return sendStates[pending.state] or (pending.state and ("发送状态：" .. tostring(pending.state)) or nil)
end

local function shorten(text, bound)
    text = tostring(text or "")
    if #text <= bound then return text end
    local n = bound
    while n > 0 and not utf8.len(text:sub(1, n)) do n -= 1 end
    return text:sub(1, n) .. "…"
end
local function valueText(value, bound)
    local kind = type(value)
    if kind == "string" then return bound and shorten(value, bound) or value end
    if kind == "boolean" then return value and "是" or "否" end
    if kind == "table" then
        local parts = {}
        for _, item in value do
            if type(item) == "table" then
                table.insert(parts, tostring(item[1]) .. " · " .. tostring(item[2])
                    .. (item[3] == true and "（必需）" or (item[3] == false and "（信息性）" or "")))
            else
                table.insert(parts, tostring(item))
            end
        end
        local text = #parts > 0 and table.concat(parts, "；") or "（空）"
        return bound and shorten(text, bound) or text
    end
    return tostring(value)
end
local fieldNames = {title = "标题", type = "类型", priority = "优先级", goal = "目标", scope = "范围",
    criteria = "验收条件", labels = "标签"}

-- Comparison against the stored approval snapshot, plus the design version the
-- approval names. An unreadable snapshot is reported as unavailable.
function M.approvalDiffCard(requirement, workflow)
    if not workflow or not workflow.approval then return nil end
    local approval = workflow.approval
    local comparison = Workflow.approvalDiff(approval, requirement)
    local children = {}
    local tone = "muted"
    if not comparison.available then
        tone = "warning"
        table.insert(children, ui.text({ui.span(
            "历史批准快照缺失或损坏，无法逐项比较；这不等于“没有变化”。", "warning")}))
    elseif comparison.identical then
        table.insert(children, ui.text({ui.span("需求内容与上次批准完全一致。", "muted")}))
    else
        tone = "warning"
        table.insert(children, note("相比上次批准，以下 " .. tostring(#comparison.changes) .. " 项内容已变化："))
        for _, change in comparison.changes do
            table.insert(children, ui.text({
                ui.span((fieldNames[change.field] or change.field) .. "：", "strong"),
                ui.span(valueText(change.before, 140), "muted"), ui.span(" → ", "muted"),
                ui.span(valueText(change.after, 240)),
            }))
        end
    end
    if comparison.available then
        local full = {}
        local ok, before = pcall(tern.json.decode, approval.requirementContent)
        if ok and type(before) == "table" then
            for index, name in Workflow.contentFields do
                local value = before[index]
                if value ~= nil then
                    table.insert(full, ui.text({ui.span((fieldNames[name] or name) .. "：", "strong"),
                        ui.span(valueText(value), "muted")}))
                end
            end
        end
        if #full > 0 then
            table.insert(children, ui.node("section", {key = "approvalSnapshot", head = "批准时的完整需求内容",
                collapsible = true, collapsed = true}, full))
        end
    end
    if approval.mode == "design" then
        local version = workflow.designs and workflow.designs[approval.designVersion]
        local lines = {"批准方案 v" .. tostring(approval.designVersion) .. " · 最新正式方案 v" .. tostring(workflow.latestVersion)}
        if approval.designVersion ~= workflow.latestVersion then
            table.insert(lines, "方案版本已变化；批准不再对应最新方案。")
        elseif not version or version.sha256 ~= approval.designSha256 then
            table.insert(lines, "批准记录的方案指纹与当前版本不匹配。")
        else
            table.insert(lines, "批准仍对应当前最新方案版本。")
        end
        table.insert(children, note(table.concat(lines, " · ")))
    end
    if approval.baseline then
        table.insert(children, note("批准时的 Git 基线：HEAD " .. tostring(approval.baseline.head ~= "" and approval.baseline.head or "（尚无提交）")
            .. " · 指纹 " .. tostring(approval.baseline.fingerprint):sub(1, 16)
            .. (approval.baseline.dirty and " · 当时工作区有改动" or " · 当时工作区干净")))
    end
    table.insert(children, note("只比较批准记录中保存的完整内容；缺失字段不会被当作相同。"))
    return ui.card("与上次批准的差异", children, {key = "approvalDiff", tone = tone})
end

-- Preparation panel: materials, full preview and the two distinct delivery
-- actions. Opening it never sends; only the explicit buttons below do.
function M.preparePanel(s)
    local u, h, r = s.ui, s.ui.handoff, s.ui.byId[s.ui.selected]
    if not r then
        return ui.node("empty", {key = "prepareNoRequirement", variant = "inline", title = "先选择需求",
            text = "资料预览只针对一项需求。"})
    end
    local writable = u.writable and h.safe and not h.workflowBusy
    local editable = writable and h.pending == nil and h.pendingSend == nil
    local nodes = {
        row("prepareHead", {
            ui.text({ui.span("准备交接 · " .. r.number .. " · " .. r.title, "strong")}),
            ui.button("收起", {key = "handoff-prepare-close", variant = "quiet", size = "sm",
                actions = {click = "handoff-prepare"}}),
        }),
        note("目标 " .. s.payload.binding.projectRoot .. " · 会话 " .. s.payload.binding.sessionId
            .. " · 需求修订 " .. tostring(r.revision) .. "。打开面板不会发送，也不会覆盖 omp 已有草稿。"),
    }
    table.insert(nodes, editor("paths", "项目相对文件路径 · 每行一个", h.fields.paths.text,
        h.fields.paths.cursor, h.fields.paths.anchor, 4, not editable, "例如 src/app.ts；不接受绝对路径或 shell 片段"))
    table.insert(nodes, choices("includeRequirement", "把完整需求加入资料预览", h.includeRequirement and "yes" or "no",
        {{value = "yes", label = "包含当前需求"}, {value = "no", label = "不包含需求"}}, not editable))
    table.insert(nodes, choices("activity", "本次明确意图", h.activity,
        {{value = "clarify", label = "澄清"}, {value = "design", label = "设计"}, {value = "implement", label = "实施"}}, not editable))
    table.insert(nodes, editor("excerpt", "选中的讨论摘录", h.fields.excerpt.text,
        h.fields.excerpt.cursor, h.fields.excerpt.anchor, 6, not editable, "仅发送你明确选择的讨论片段；不会读取整个聊天记录"))
    local resourceState = u.resources
    local bound = resourceState and resourceState.data and resourceState.data.resources or {}
    local resourceChildren = {}
    if resourceState and resourceState.error then
        table.insert(resourceChildren, ui.text({ui.span(resourceState.error, "error")}))
    elseif #bound == 0 then
        table.insert(resourceChildren, note("尚未绑定资源。绑定只记录项目内相对路径；文件变化会使预览失效。"))
    else
        for index, entry in bound do
            local status = resourceState.status and resourceState.status[entry.id]
            local statusText = status == "ok" and "可读取"
                or (status == "large" and "超过 16 KiB；预览会拒绝" or "无法读取（缺失或不可读）")
            table.insert(resourceChildren, row("resourceEntry-" .. tostring(index), {
                ui.text({ui.span(entry.path, "code")}),
                ui.badge(entry.kind == "verify" and "验证说明" or "上下文", entry.kind == "verify" and "info" or "muted"),
                note(statusText),
                button("移除", "resources-remove=" .. entry.id, "quiet", not editable or resourceState.safe == false),
            }))
        end
    end
    table.insert(resourceChildren, editor("resourcePath", "绑定资源路径 · 项目相对路径", h.fields.resourcePath.text,
        h.fields.resourcePath.cursor, h.fields.resourcePath.anchor, 2, not editable, "例如 AGENTS.md 或 docs/checklist.md"))
    table.insert(resourceChildren, choices("resourceKind", "绑定用途", h.resourceKind or "context",
        {{value = "context", label = "上下文资料"}, {value = "verify", label = "验证说明"}}, not editable))
    table.insert(resourceChildren, button("绑定此资源", "resources-add", "default",
        not editable or not (h.fields.resourcePath.text or ""):match("%S")
            or (resourceState ~= nil and resourceState.safe == false)))
    table.insert(nodes, ui.card("绑定资源 · 仅本需求", {
        ui.node("col", {key = "resourceBody", gap = "sm"}, resourceChildren),
    }, {key = "resourcesCard", tone = (resourceState and resourceState.safe == false) and "warning" or "muted"}))
    table.insert(nodes, row("previewActions", {
        button(h.preview and "重新生成完整预览" or "生成完整资料预览", "handoff-preview",
            h.preview and "default" or "primary", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
        button("检查当前 Git 基线", "handoff-baseline", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
    }))
    local preview = h.preview
    if preview and preview.requirementId ~= r.requirementId then preview = nil end
    if preview then
        table.insert(nodes, ui.card("完整预览 · " .. tostring(#preview.text) .. " UTF-8 字节", {
            note("目标 " .. s.payload.binding.projectRoot .. " · 会话 " .. s.payload.binding.sessionId
                .. " · 需求 " .. tostring(preview.requirementId or r.requirementId)
                .. " · " .. (activityNames[preview.activity] or preview.activity)
                .. " · 需求修订 " .. tostring(preview.requirementRevision)
                .. " · 正式方案版本 " .. tostring(preview.designVersion or 0)),
            note("来源：" .. (#(preview.sources or {}) > 0 and table.concat((function()
                local paths = {}; for _, source in preview.sources do table.insert(paths, source.path .. " · " .. source.sha256) end; return paths
            end)(), "\n") or "无项目文件")),
            h.previewStale and ui.text({ui.span("此预览来自上次运行；来源令牌已失效。请显式重新生成预览。", "warning")}) or note("SHA-256：" .. tostring(preview.sha256)),
            ui.node("scroll", {key = "fullPreview", max = {h = "22lines"}}, {ui.text(preview.text)}),
            row("previewDelivery", {
                button("只预填到 omp（不发送）", "handoff-prefill", "default", h.previewStale or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
                button("明确发送并开始推理", "handoff-send", "primary", h.previewStale or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil
                    or not s.snapshot or s.snapshot.state ~= "idle" or (preview.activity == "implement" and not h.approvalValid)),
            }),
        }, {key = "previewCard", tone = h.previewStale and "warning" or "muted"}))
    end
    return ui.node("card", {key = "preparePanel", role = "workbench.prepare", tone = "accent"}, nodes)
end

function M.build(s)
    local u, h, r = s.ui, s.ui.handoff, s.ui.byId[s.ui.selected]
    local writable = u.writable and h.safe and not h.workflowBusy
    local editable = writable and h.pending == nil and h.pendingSend == nil
    if not r then return ui.node("empty", {key = "handoffNoRequirement", title = "先选择需求", text = "资料、正式方案和批准记录都绑定到当前选中的需求。"}) end
    local tabs = ui.node("tabs", {key = "handoffTabs", active = h.tab or "design", items = {
        {id = "design", label = "方案"}, {id = "approval", label = "批准"}}})
    local guides = {
        design = "方案：写草稿或导入项目文件 → 明确采用为正式版本；回复候选不会自动采用。资料在“准备交接”面板。",
        approval = "批准：先检查 Git 基线 → 批准最新方案，或使用独立的直接实施授权。",
    }
    local head = ui.card(r.number .. " · " .. r.title, {
        note(guides[h.tab == "approval" and "approval" or "design"]),
        note("需求修订 " .. tostring(r.revision) .. " · 阶段 " .. tostring(r.stage) .. " · 项目 " .. s.payload.binding.projectRoot),
        note("当前目标 omp 会话：" .. s.payload.binding.sessionId .. " · 实例 " .. s.payload.binding.instanceId),
    }, {key = "handoffTarget", tone = "muted"})
    local nodes = {head, tabs}
    if s.problem then table.insert(nodes,ui.text({ui.span(s.problem.."；资料已保留，不会自动重发。","warning")})) end
    if h.error then table.insert(nodes, ui.text({ui.span(h.error, "error")})) end
    if h.notice then table.insert(nodes, ui.text({ui.span(h.notice, "warning")})) end
    if h.pending then
        table.insert(nodes, note("来源请求 " .. h.pending.requestId .. " · 等待回执；只核对同一请求，不自动重发"))
    end
    if h.pendingSend then
        table.insert(nodes, note("业务发送 " .. h.pendingSend.requestId .. " · "
            .. (M.sendState(h.pendingSend) or "状态未知") .. "；采用的方案内容已锁定，不会重复发送"))
    end
    local pending=h.pendingSend or h.pending
    local canEnd=pending and (s.problem or (h.pending and (h.pending.staleBinding
        or (type(h.pending.expiresAt)=="number" and os.time()*1000>h.pending.expiresAt)))
        or (h.pendingSend and (h.pendingSend.state=="intent_unknown" or h.pendingSend.state=="intent_only"))
        or (h.sourceReceipt and h.sourceReceipt.status=="delivery_unknown" and h.sourceReceipt.reason~="applying_request"))
    if canEnd then
        table.insert(nodes,ui.card("投递结果待人工核对",{
            note("未知请求可能已执行。这里只结束等待，不重发、不取消、不判定成败；请先在 omp 核对。后续发送必须重新预览，仍可能重复已有工作。"),
            editor("ackReason","人工核对说明",h.fields.ackReason.text,h.fields.ackReason.cursor,h.fields.ackReason.anchor,3,not writable,"记录你已核对的情况及仍不能确定的结果"),
            button("记录说明并结束等待（不重发）","handoff-end-wait","quiet",not writable or not h.fields.ackReason.text:match("%S")),
        },{key="unknownResolution",tone="warning"}))
    end
    if h.sourceReceipt then
        local receipt = M.receipt(h.sourceReceipt.status)
        table.insert(nodes, ui.card((h.sourceReceipt.localOnly and "人工对账记录 · " or "来源命令回执 · ") .. receipt.label, {
            note(tostring(h.sourceReceipt.reason or "") .. (h.sourceReceipt.requestId and (" · 请求 " .. h.sourceReceipt.requestId) or "")),
            note("回执只证明该阶段；预填、提交、消费、结束和验收是不同事实。"),
        }, {key = "sourceReceipt", tone = receipt.tone}))
    end
    if h.tab == "approval" then
        local wf = h.workflow
        local state = h.approvalValid and "当前有效" or "未批准或已失效"
        local diffCard = M.approvalDiffCard(r, wf)
        if diffCard then table.insert(nodes, diffCard) end
        table.insert(nodes, ui.card("正式方案批准 · " .. state, {
            note(h.approvalReason or "批准绑定需求内容摘要、需求修订、最新方案版本与 Git 基线；源端执行时会再次核验。"),
            wf and wf.approval and note("模式 " .. tostring(wf.approval.mode) .. " · 需求修订 " .. tostring(wf.approval.requirementRevision)
                .. " · 方案版本 " .. tostring(wf.approval.designVersion) .. " · 批准 " .. tostring(wf.approval.approvedAt)
                .. (wf.approval.reason and (" · 直接授权理由：" .. wf.approval.reason) or "")
                .. (wf.approval.revocationReason and (" · 撤销理由：" .. wf.approval.revocationReason) or "")
                .. (wf.approval.revokedAt and (" · 撤销 " .. tostring(wf.approval.revokedAt)) or "")) or note("尚无有效批准记录。"),
        }, {key = "approvalState", tone = h.approvalValid and "success" or "warning"}))
        table.insert(nodes, row("baselineActions", {
            button("检查最新 Git 基线", "handoff-baseline", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
            h.baseline and note("HEAD " .. (h.baseline.head ~= "" and h.baseline.head or "（尚无提交）") .. " · 指纹 " .. h.baseline.fingerprint .. " · 工作区 " .. (h.baseline.dirty and "有改动" or "干净")) or note("请先检查基线，再明确作出授权决定。"),
        }))
        if h.selectedDesign then table.insert(nodes, ui.card("将被批准的完整版本 v" .. tostring(h.selectedDesign.version), {
            note("SHA-256 " .. h.selectedDesign.sha256), ui.node("scroll", {key = "approvalDesign", max = {h = "16lines"}}, {ui.text(h.selectedDesign.body)}),
        }, {key = "approvalDesignCard", tone = "muted"})) end
        table.insert(nodes, editor("revokeReason", "撤销理由", h.fields.revokeReason.text, h.fields.revokeReason.cursor, h.fields.revokeReason.anchor,
            3, not editable, "撤销保留历史，并立即使当前授权失效"))
        table.insert(nodes, row("approveActions", {
            button("明确批准当前最新方案", "handoff-approve", "primary", not writable or not h.baseline or not h.baselineCheckedAt or not h.selectedDesign
                or h.selectedDesign.version ~= (wf and wf.latestVersion) or h.pendingSend ~= nil),
            button("明确撤销当前批准", "handoff-revoke", "danger", not writable or not wf or not wf.approval or h.pendingSend ~= nil or #h.fields.revokeReason.text == 0),
        }))
        local criteria, scope = {}, type(r.scope) == "string" and r.scope or ""
        for _, item in r.acceptanceCriteria or {} do table.insert(criteria, "• " .. item.description) end
        table.insert(nodes, ui.card("直接实施授权所依据的需求范围", {
            ui.text("目标：" .. tostring(r.goal or "")),
            ui.text("范围：" .. (scope ~= "" and scope or "未单独填写范围")),
            ui.text("验收条件：\n" .. (#criteria > 0 and table.concat(criteria, "\n") or "无")),
        }, {key = "directScope", tone = "muted"}))
        table.insert(nodes, ui.card("独立的直接实施授权", {
            note("不批准方案版本。授权仅针对当前需求范围与验收条件，保存后仍必须生成实施预览并明确发送；源端会重新核对基线和需求摘要。"),
            editor("directReason", "授权理由与实施范围", h.fields.directReason.text, h.fields.directReason.cursor, h.fields.directReason.anchor,
                5, not editable, "说明为何可以直接实施及边界；需求本身必须已有范围与至少一项验收条件"),
            button("检查基线后明确授权直接实施", "handoff-authorize-direct", "quiet", not writable or not h.baseline or not h.baselineCheckedAt or h.pendingSend ~= nil
                or #h.fields.directReason.text == 0 or not scope:match("%S") or #criteria == 0),
        }, {key = "directAuthorization", tone = "warning"}))
        if h.workflow then
            table.insert(nodes, ui.node("section", {key = "approvalHistory", head = "授权与撤销历史", collapsible = true, collapsed = true}, (function()
                local history = {}
                for index, approval in h.workflow.approvals or {} do
                    table.insert(history, ui.text("#" .. tostring(index) .. " · " .. tostring(approval.mode) .. " · 需求修订 " .. tostring(approval.requirementRevision)
                        .. " · 方案 v" .. tostring(approval.designVersion) .. " · " .. tostring(approval.approvedAt)
                        .. (approval.reason and (" · 理由 " .. approval.reason) or "")
                        .. (approval.revokedAt and (" · 已撤销 " .. tostring(approval.revokedAt)
                            .. (approval.revocationReason and (" · " .. approval.revocationReason) or "")) or "")))
                end
                if #history == 0 then table.insert(history, note("没有历史授权。")) end
                return history
            end)()))
        end
    else
        table.insert(nodes, note("正式版本只在明确采用时创建；候选回复不会自动成为方案。当前设计阶段：" .. tostring(r.stage)))
        table.insert(nodes, editor("proposal", "方案草稿", h.fields.proposal.text, h.fields.proposal.cursor, h.fields.proposal.anchor,
            14, not editable, "手写完整方案；UTF-8 上限 16 KiB，不会静默截断"))
        table.insert(nodes, editor("importPath", "导入项目文件 · 一个相对路径", h.fields.importPath.text,
            h.fields.importPath.cursor, h.fields.importPath.anchor, 2, not editable, "填写路径并检查；内容将先单独展示"))
        table.insert(nodes, row("designImportActions", {
            button("检查项目文件", "handoff-import-file", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
            button("明确获取最新回复候选", "handoff-candidate", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
            button("把草稿采用为正式新版本", "handoff-adopt", "primary", not writable or h.pending ~= nil or h.pendingSend ~= nil or #h.fields.proposal.text == 0),
        }))
        if type(h.importedFile) == "table" and type(h.importedFile.body) == "string" then
            table.insert(nodes, ui.card("已检查项目文件 · " .. tostring(h.importedFile.path), {
                note("SHA-256 " .. tostring(h.importedFile.sha256) .. " · " .. tostring(#h.importedFile.body) .. " UTF-8 字节；尚未导入或采用"),
                ui.node("scroll", {key = "importedFileBody", max = {h = "12lines"}}, {ui.text(h.importedFile.body)}),
                button("明确导入到空白方案草稿", "handoff-import-file-content", "quiet",
                    not editable or (h.fields.proposal.text or ""):match("%S") ~= nil),
            }, {key = "importedFile", tone = "warning"}))
        end
        if h.candidate then table.insert(nodes, ui.card("最新回复候选 · 尚未采用", {
            note("会话 " .. tostring(h.candidate.sessionId) .. " · 观察时间 " .. tostring(h.candidate.observedAt)
                .. (h.candidate.includesToolCalls and " · 含工具调用（请谨慎检查）" or "")),
            ui.node("scroll", {key = "candidateBody", max = {h = "12lines"}}, {ui.text(h.candidate.body)}),
            button("明确导入到空白方案草稿", "handoff-import-candidate", "quiet",
                not editable or #h.candidate.body > 16384 or (h.fields.proposal.text or ""):match("%S") ~= nil),
        }, {key = "candidateCard", tone = "warning"})) end
        local workflow = h.workflow
        local versions = workflow and workflow.designs or {}
        if #versions > 0 then
            local options, current = {}, false
            for _, version in versions do
                table.insert(options, {value = tostring(version.version), label = "v" .. tostring(version.version) .. " · " .. tostring(version.sha256):sub(1, 12)})
                if version.version == h.selectedVersion then current = true end
            end
            if not current then h.selectedVersion = workflow.latestVersion end
            local diffOptions = {{value = "0", label = "不比较"}}
            for _, version in versions do table.insert(diffOptions, {value = tostring(version.version), label = "对比 v" .. tostring(version.version)}) end
            table.insert(nodes, choices("selectedVersion", "读取完整不可变版本", tostring(h.selectedVersion or workflow.latestVersion), options, false))
            table.insert(nodes, choices("compareVersion", "真实逐行差异", tostring(h.compareVersion or 0), diffOptions, false))
            if h.selectedDesign then
                table.insert(nodes, ui.card("正式方案 v" .. tostring(h.selectedDesign.version) .. " · SHA-256 " .. tostring(h.selectedDesign.sha256), {
                    note("需求修订 " .. tostring(h.selectedDesign.requirementRevision) .. " · 来源 " .. tostring(h.selectedDesign.source and h.selectedDesign.source.kind or "unknown")
                        .. (h.selectedDesign.source and h.selectedDesign.source.path and (" · " .. h.selectedDesign.source.path) or "")),
                    ui.node("scroll", {key = "selectedDesignBody", max = {h = "20lines"}}, {ui.text(h.selectedDesign.body)}),
                    h.compareDesign and ui.node("scroll", {key = "versionDiff", max = {h = "20lines"}}, {ui.text("逐行差异（空格=相同，-=删除，+=新增）\n" .. diff.render(h.compareDesign.body, h.selectedDesign.body))}) or note("选择一个比较版本以查看真实逐行差异。"),
                }, {key = "selectedDesignCard", tone = "muted"}))
                table.insert(nodes, editor("comment", "对此版本的评论", h.fields.comment.text, h.fields.comment.cursor, h.fields.comment.anchor,
                    4, not editable, "评论会绑定到所选版本并保留在历史中"))
                table.insert(nodes, button("添加此版本评论", "handoff-comment", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or #h.fields.comment.text == 0))
                for index, comment in workflow.comments or {} do
                    if comment.designVersion == h.selectedDesign.version then
                        table.insert(nodes, ui.card("v" .. tostring(comment.designVersion) .. " · " .. tostring(comment.createdAt), {ui.md(comment.text)},
                            {key = "comment-v" .. tostring(comment.designVersion) .. "-" .. tostring(index), tone = "muted"}))
                    end
                end
            end
        else table.insert(nodes, ui.node("empty", {key = "noDesigns", variant = "inline", title = "尚无正式方案版本", text = "编辑上方草稿并明确采用后，工作台会保存不可变版本。"})) end
    end
    return ui.node("col", {key = "handoff", role = "workbench.handoff", gap = "sm"}, nodes)
end
return M
