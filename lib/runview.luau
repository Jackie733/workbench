--!strict
local ui = tern.ui
local Results = require("./results")
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
local stepNames = {pending = "待开始", active = "进行中", done = "完成", blocked = "阻塞", skipped = "跳过"}
local stateTones = {passed = "success", failed = "error", unknown = "warning", stale = "warning"}
local function note(text) return ui.text({ui.span(text or "", "muted")}) end
local function button(label, action, variant, disabled)
    return ui.button(label, {key = action, variant = variant or "quiet", size = "sm", disabled = disabled,
        actions = {click = action}})
end
local function row(key, children)
    return ui.node("row", {key = key, gap = "sm", wrap = true}, children)
end
local function field(key, label, text, cursor, anchor, lines, readonly, placeholder)
    text = text or ""
    return ui.node("field", {key = "traceField-" .. key, label = label, help = placeholder}, {
        ui.node("editor", {key = key, text = text, cursor = units(text, cursor or utf8.len(text)),
            anchor = anchor and units(text, anchor) or nil, maxLines = lines, readonly = readonly,
            placeholder = placeholder, aria = label, variant = "field"})})
end
local function baselineMap(baseline)
    local map = {}
    for _, file in baseline and baseline.files or {} do map[file.path] = file end
    return map
end
local function fileAttribution(baseline, file)
    local prior = baselineMap(baseline)[file.path]
    if not prior then return "基线后新增" end
    if prior.sha256 ~= nil and file.sha256 ~= nil and prior.sha256 == file.sha256 then return "基线时已存在，内容未变" end
    return "与基线改动混合"
end
function M.build(s)
    local u, r = s.ui, s.ui.byId[s.ui.selected]
    local t = u.trace
    if not r then return ui.node("empty", {key = "traceNoRequirement", title = "先选择需求", text = "计划、代码变化和验证证据都绑定到当前需求。"}) end
    if not t then return note("正在读取计划与结果记录…") end
    local writable = u.writable and t.safe and not t.busy
    local nodes = {
        ui.card(r.number .. " · " .. r.title, {
            note("需求修订 " .. tostring(r.revision) .. " · 阶段 " .. tostring(r.stage)),
            note("计划、差异和验证只记录观察结果；Git 与命令退出码不证明某项改动一定由本需求产生，也不等于人工验收。"),
        }, {key = "traceTarget", tone = "muted"}),
    }
    if t.error then table.insert(nodes, ui.text({ui.span(t.error, "error")})) end
    if t.notice then table.insert(nodes, ui.text({ui.span(t.notice, "warning")})) end
    if s.problem then table.insert(nodes, note(s.problem .. "；保留最后读取的计划与结果。")) end
    if t.pending then table.insert(nodes, note("来源检查 " .. tostring(t.pending.requestId) .. " · 等待同一 ID 回执；不自动重发")) end
    if t.busy and t.busyLabel then table.insert(nodes, note(t.busyLabel)) end

    local plan = t.plan
    if plan then
        local done, blocked, active = 0, 0, 0
        for _, step in plan.steps do
            if step.status == "done" then done += 1 end
            if step.status == "blocked" then blocked += 1 end
            if step.status == "active" then active += 1 end
        end
        local items = {}
        for index, step in plan.steps do
            local statusOptions = {}
            for _, name in {"pending", "active", "done", "blocked", "skipped"} do
                table.insert(statusOptions, {value = name, label = stepNames[name]})
            end
            table.insert(items, ui.card(step.title, {
                note("步骤 " .. tostring(step.id) .. " · 更新 " .. tostring(step.updatedAt)),
                row("stepState-" .. tostring(index), {
                    ui.node("select", {key = "status-" .. tostring(index), value = step.status, size = "sm",
                        disabled = not writable, options = statusOptions}),
                    step.reason and note("阻塞原因：" .. step.reason) or note(""),
                }),
            }, {key = "step-" .. tostring(index), tone = step.status == "blocked" and "warning" or (step.status == "done" and "success" or "muted")}))
        end
        table.insert(nodes, ui.card("实施计划 · 已完成 " .. tostring(done) .. " / 共 " .. tostring(#plan.steps),
            {(function()
                local content = {note("计划修订 " .. tostring(plan.revision) .. " · 步骤 ID 稳定；调整只增加步骤或改变状态，不伪造固定总数百分比。")}
                if blocked > 0 then table.insert(content, ui.text({ui.span("有 " .. tostring(blocked) .. " 个阻塞步骤", "warning")})) end
                if active > 0 then table.insert(content, note("进行中 " .. tostring(active) .. " 个")) end
                for _, item in items do table.insert(content, item) end
                if #plan.steps == 0 then table.insert(content, note("尚无步骤。可从验收条件生成，或手动添加。")) end
                return ui.node("col", {key = "planBody", gap = "xs"}, content)
            end)()}, {key = "planCard", tone = blocked > 0 and "warning" or "muted"}))
        table.insert(nodes, field("newStep", "新增步骤", t.fields.newStep.text, t.fields.newStep.cursor, t.fields.newStep.anchor,
            2, not writable, "稳定的新步骤；不会修改已有步骤 ID"))
        table.insert(nodes, row("planActions", {
            button("添加步骤", "results-plan-add", "quiet", not writable or not t.fields.newStep.text:match("%S") or #plan.steps >= 40),
            button("从验收条件生成步骤", "results-plan-generate", "quiet", not writable or #plan.steps > 0),
        }))
        table.insert(nodes, field("blockReason", "阻塞说明", t.fields.blockReason.text, t.fields.blockReason.cursor, t.fields.blockReason.anchor,
            3, not writable, "把某步骤设为阻塞时必填；会保存在该步骤"))
    end

    local baseline = t.results and t.results.baseline
    if baseline then
        local files = {}
        for index, file in baseline.files do
            if index <= 12 then table.insert(files, ui.text(tostring(file.status) .. "  " .. file.path .. (file.sha256 and (" · " .. file.sha256:sub(1, 12)) or " · 未哈希"))) end
        end
        table.insert(nodes, ui.card("实施基线 · HEAD " .. (baseline.head ~= "" and baseline.head:sub(1, 12) or "无提交"), {
            note("请求 " .. tostring(baseline.requestId) .. " · 捕获 " .. tostring(baseline.capturedAt)
                .. " · 工作区 " .. (baseline.dirty and "已有改动" or "干净") .. " · 基线文件 " .. tostring(#baseline.files)),
            note("基线已有改动属于实施前状态，不视为本需求产出。"),
            (function()
                local content = {}
                if #files > 0 then table.insert(content, ui.node("scroll", {key = "baselineFiles", max = {h = "10lines"}}, files))
                else table.insert(content, note("基线时没有未提交或未跟踪文件。")) end
                if baseline.filesTruncated then table.insert(content, ui.text({ui.span("基线文件清单已截断；归属无法完整核对。", "warning")})) end
                return ui.node("col", {key = "baselineBody", gap = "xs"}, content)
            end)(),
        }, {key = "baselineCard", tone = "muted"}))
    else
        table.insert(nodes, note("尚未记录实施基线；实施请求被来源接受后才写入，成功与否不以模型回复推断。"))
    end

    local changes = t.results and t.results.changes
    if changes then
        local fileRows = {}
        for index, file in changes.files do
            if index <= 24 then
                table.insert(fileRows, ui.text(tostring(file.status) .. "  " .. file.path .. " · " .. fileAttribution(baseline, file)))
            end
        end
        local commits = {}
        for index, commit in changes.commits do
            if index <= 10 then table.insert(commits, ui.text(commit.hash:sub(1, 10) .. " · " .. commit.subject .. " · " .. tostring(commit.at))) end
        end
        table.insert(nodes, ui.card("当前代码变化 · 观察于 " .. tostring(changes.capturedAt), {
            note("HEAD " .. (changes.head ~= "" and changes.head:sub(1, 12) or "无提交") .. " · 指纹 " .. changes.fingerprint:sub(1, 16)
                .. " · 文件 " .. tostring(#changes.files) .. " · 差异 " .. tostring(#changes.diff) .. " 字节"),
            note("归属说明：Git 只能观察自基线的变化，不能证明某处修改一定由本需求产生；同文件混合编辑尤其如此。"),
            (function()
                local content = {}
                if #commits > 0 then
                    table.insert(content, ui.text({ui.span("基线后提交", "strong")}))
                    for _, item in commits do table.insert(content, item) end
                    if changes.commitsTruncated then table.insert(content, note("提交列表已截断。")) end
                end
                if #fileRows > 0 then
                    table.insert(content, ui.text({ui.span("自基线观察到的文件", "strong")}))
                    for _, item in fileRows do table.insert(content, item) end
                    if #changes.files > 24 then table.insert(content, note("仅显示前 24 个文件；共 " .. tostring(#changes.files) .. " 个。")) end
                    if changes.filesTruncated then table.insert(content, ui.text({ui.span("文件清单已截断；归属无法完整核对。", "warning")})) end
                else table.insert(content, note("当前工作区与基线一致或没有可显示的文件变化。")) end
                return ui.node("col", {key = "changesBody", gap = "xs"}, content)
            end)(),
            ui.node("editor", {key = "diff", text = changes.diff ~= "" and changes.diff or "（没有可显示的差异文本）",
                readonly = true, lang = "diff", nowrap = true, maxLines = 18, aria = "代码差异"}),
            changes.diffTruncated and ui.text({ui.span("差异已按 48 KiB 截断；不能把此预览当作完整差异。", "warning")}) or note("完整差异上限 48 KiB。"),
        }, {key = "changesCard", tone = "muted"}))
    end
    table.insert(nodes, row("changesActions", {
        button(changes and "刷新当前代码变化" or "读取当前代码变化", "results-refresh-changes", "quiet",
            not writable or t.pending ~= nil or s.problem ~= nil),
    }))

    table.insert(nodes, field("verifyCommand", "验证命令", t.fields.verifyCommand.text, t.fields.verifyCommand.cursor, t.fields.verifyCommand.anchor,
        2, not writable, "在项目根目录由当前用户执行；只在你明确点击后运行"))
    table.insert(nodes, field("verifyCriteria", "关联验收条件 · 逗号分隔 ID", t.fields.verifyCriteria.text,
        t.fields.verifyCriteria.cursor, t.fields.verifyCriteria.anchor, 2, not writable,
        (function()
            local values = {}
            for _, criterion in r.acceptanceCriteria or {} do table.insert(values, criterion.id) end
            return #values > 0 and ("可用：" .. table.concat(values, ", ")) or "此需求尚无验收条件"
        end)()))
    table.insert(nodes, note("命令通过 wsl.exe 在项目根目录交给 bash 执行；退出码与输出会保存为证据。退出码 0 不等于验收通过。"))
    table.insert(nodes, button(t.busy and "正在记录…" or "先取代码快照，再运行验证", "results-run-verification", "primary",
        not writable or t.pending ~= nil or not t.fields.verifyCommand.text:match("%S") or not t.results))

    local verifications = t.results and t.results.verifications or {}
    if #verifications > 0 then
        local cards = {}
        for index = #verifications, math.max(1, #verifications - 7), -1 do
            local verification = verifications[index]
            local state, reason = Results.effectiveState(t.results, r, verification)
            local preview = verification.stdoutPreview ~= "" and verification.stdoutPreview or verification.stderrPreview
            table.insert(cards, ui.card(tostring(verification.id) .. " · " .. tostring(verification.command), {
                note("退出码 " .. tostring(verification.exitCode) .. (verification.timedOut and " · 超时" or "")
                    .. " · " .. tostring(verification.startedAt) .. "–" .. tostring(verification.endedAt)
                    .. " · 快照 " .. verification.codeSnapshotSha256:sub(1, 16)
                    .. " · 验收条件 " .. (#verification.criterionIds > 0 and table.concat(verification.criterionIds, ", ") or "未关联")),
                reason and ui.text({ui.span("失效原因：" .. reason, "warning")}) or note("证据文件：" .. verification.evidencePath),
                preview ~= "" and ui.node("scroll", {key = "verificationOutput-" .. tostring(index), max = {h = "6lines"}}, {ui.text(preview)}) or note("命令没有输出。"),
                (verification.stdoutTruncated or verification.stderrTruncated) and note("证据输出已按上限截断。") or note(""),
            }, {key = "verification-" .. tostring(index), tone = stateTones[state] or "muted"}))
        end
        table.insert(nodes, ui.node("section", {key = "verifications", head = "验证证据 · " .. tostring(#verifications), collapsible = true, collapsed = false}, cards))
    else
        table.insert(nodes, note("尚无验证证据。工具调用成功或模型声称完成都不构成验证。"))
    end
    return ui.node("col", {key = "trace", role = "workbench.trace", gap = "sm"}, nodes)
end
return M
