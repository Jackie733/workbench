--!strict
local ui = tern.ui
local diff = require("./diff")
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
local function row(key, children)
    return ui.node("row", {key = key, gap = "sm", wrap = true}, children)
end
local function editor(key, label, text, cursor, anchor, lines, readonly, placeholder)
    text = text or ""
    return ui.node("field", {key = "handoffField-" .. key, label = label, help = placeholder}, {
        ui.node("editor", {key = "h-" .. key, text = text,
            cursor = units(text, cursor or utf8.len(text)), anchor = anchor and units(text, anchor) or nil,
            maxLines = lines, readonly = readonly, placeholder = placeholder, aria = label, variant = "field"})})
end
local activityNames = {clarify = "澄清", design = "设计", implement = "实施"}
function M.build(s)
    local u, h, r = s.ui, s.ui.handoff, s.ui.byId[s.ui.selected]
    local writable = u.writable and h.safe and not h.workflowBusy
    local editable = writable and h.pending == nil and h.pendingSend == nil
    if not r then return ui.node("empty", {key = "handoffNoRequirement", title = "先选择需求", text = "资料、正式方案和批准记录都绑定到当前选中的需求。"}) end
    local tabs = ui.node("tabs", {key = "handoffTabs", active = h.tab or "materials", items = {
        {id = "materials", label = "资料"}, {id = "design", label = "方案"}, {id = "approval", label = "批准"}}})
    local head = ui.card(r.number .. " · " .. r.title, {
        note("需求修订 " .. tostring(r.revision) .. " · 阶段 " .. tostring(r.stage) .. " · 项目 " .. s.payload.binding.projectRoot),
        note("当前目标 omp 会话：" .. s.payload.binding.sessionId .. " · 实例 " .. s.payload.binding.instanceId),
    }, {key = "handoffTarget", tone = "muted"})
    local nodes = {head, tabs}
    if s.problem then table.insert(nodes,ui.text({ui.span(s.problem.."；请在原 omp 再次 /wb，资料已保留。","warning")})) end
    if h.error then table.insert(nodes, ui.text({ui.span(h.error, "error")})) end
    if h.notice then table.insert(nodes, ui.text({ui.span(h.notice, "warning")})) end
    if h.pending then
        table.insert(nodes, note("来源请求 " .. h.pending.requestId .. " · 等待回执；只核对同一请求，不自动重发"))
    end
    if h.pendingSend then
        table.insert(nodes, note("业务发送 " .. h.pendingSend.requestId .. " · 状态 " .. tostring(h.pendingSend.state)
            .. "；采用的方案内容已锁定，不会重复发送"))
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
    if h.sourceReceipt then table.insert(nodes, ui.card((h.sourceReceipt.localOnly and "人工对账记录 · " or "来源命令回执 · ") .. tostring(h.sourceReceipt.status), {
        note(tostring(h.sourceReceipt.reason or "") .. (h.sourceReceipt.requestId and (" · 请求 " .. h.sourceReceipt.requestId) or "")),
    }, {key = "sourceReceipt", tone = (h.sourceReceipt.status == "submitted" or h.sourceReceipt.status == "inspected" or h.sourceReceipt.status == "prefilled") and "success" or "muted"})) end
    if h.tab == "materials" then
        local readonly = not editable
        table.insert(nodes, editor("paths", "项目相对文件路径 · 每行一个", h.fields.paths.text,
            h.fields.paths.cursor, h.fields.paths.anchor, 4, readonly, "例如 src/app.ts；不接受绝对路径或 shell 片段"))
        table.insert(nodes, ui.node("field", {key = "requirementToggle", label = "把完整需求加入资料预览"}, {
            ui.node("select", {key = "includeRequirement", value = h.includeRequirement and "yes" or "no", disabled = not editable,
                options = {{value = "yes", label = "包含当前需求"}, {value = "no", label = "不包含需求"}}})}))
        table.insert(nodes, ui.node("field", {key = "activityField", label = "本次明确意图"}, {
            ui.node("select", {key = "activity", value = h.activity, disabled = not editable,
                options = {{value = "clarify", label = "澄清"}, {value = "design", label = "设计"}, {value = "implement", label = "实施"}}})}))
        table.insert(nodes, editor("excerpt", "选中的讨论摘录", h.fields.excerpt.text,
            h.fields.excerpt.cursor, h.fields.excerpt.anchor, 6, not editable, "仅发送你明确选择的讨论片段；不会读取整个聊天记录"))
        table.insert(nodes, row("previewActions", {
            button("生成完整资料预览", "handoff-preview", "primary", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
            button("检查当前 Git 基线", "handoff-baseline", "quiet", not writable or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
        }))
        local preview = h.preview
        if preview then
            table.insert(nodes, ui.card("完整预览 · " .. tostring(#preview.text) .. " UTF-8 字节", {
                note("目标 " .. s.payload.binding.projectRoot .. " · 会话 " .. s.payload.binding.sessionId
                    .. " · " .. (activityNames[preview.activity] or preview.activity) .. " · 需求修订 " .. tostring(preview.requirementRevision)
                    .. " · 正式方案版本 " .. tostring(preview.designVersion or 0)),
                note("来源：" .. (#(preview.sources or {}) > 0 and table.concat((function()
                    local paths = {}; for _, source in preview.sources do table.insert(paths, source.path .. " · " .. source.sha256) end; return paths
                end)(), "\n") or "无项目文件")),
                h.previewStale and ui.text({ui.span("此预览来自上次运行；来源令牌已失效。请显式重新生成预览。", "warning")}) or note("SHA-256：" .. tostring(preview.sha256)),
                ui.node("scroll", {key = "fullPreview", max = {h = "22lines"}}, {ui.text(preview.text)}),
                row("previewDelivery", {
                    button("只预填到 omp（不发送）", "handoff-prefill", "quiet", h.previewStale or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil),
                    button("明确发送并开始推理", "handoff-send", "primary", h.previewStale or h.pending ~= nil or h.pendingSend ~= nil or s.problem ~= nil
                        or not s.snapshot or s.snapshot.state ~= "idle" or (preview.activity == "implement" and not h.approvalValid)),
                }),
            }, {key = "previewCard", tone = h.previewStale and "warning" or "muted"}))
        end
    elseif h.tab == "design" then
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
            for _, version in versions do table.insert(diffOptions, {value = tostring(version.version), label = "与 v" .. tostring(version.version) .. " 比较"}) end
            table.insert(nodes, row("versionSelectors", {
                ui.node("field", {key = "selectedVersionField", label = "读取完整不可变版本"}, {ui.node("select", {key = "selectedVersion", value = tostring(h.selectedVersion or workflow.latestVersion), options = options})}),
                ui.node("field", {key = "compareVersionField", label = "真实逐行差异"}, {ui.node("select", {key = "compareVersion", value = tostring(h.compareVersion or 0), options = diffOptions})}),
            }))
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
    else
        local wf = h.workflow
        local state = h.approvalValid and "当前有效" or "未批准或已失效"
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
            button("明确撤销当前批准", "handoff-revoke", "quiet", not writable or not wf or not wf.approval or h.pendingSend ~= nil or #h.fields.revokeReason.text == 0),
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
    end
    return ui.node("col", {key = "handoff", role = "workbench.handoff", gap = "sm"}, nodes)
end
return M
