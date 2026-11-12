--!strict
-- Read-only audit timeline and deliberately narrow Markdown export.
local M = {}
local MAX_EVENTS = 500
local function push(events, at, kind, summary, ref)
    if type(at) ~= "number" or at < 0 then return end
    table.insert(events, {at=at, kind=kind, summary=summary, ref=ref or ""})
end
function M.timeline(req, workflow, plan, results, reviews)
    local events = {}
    push(events, req.createdAt, "需求", "创建 " .. tostring(req.number) .. " · " .. tostring(req.title), req.requirementId)
    push(events, req.updatedAt, "需求", "当前修订 " .. tostring(req.revision) .. " · 阶段 " .. tostring(req.stage), req.requirementId)
    for _, design in workflow and workflow.designs or {} do
        push(events, design.createdAt, "方案", "采用正式方案 v" .. tostring(design.version) .. " · " .. tostring(design.sha256):sub(1, 16), "v" .. tostring(design.version))
    end
    for _, approval in workflow and workflow.approvals or {} do
        push(events, approval.approvedAt, "批准", tostring(approval.mode) .. " · 需求修订 " .. tostring(approval.requirementRevision)
            .. " · 方案 v" .. tostring(approval.designVersion), tostring(approval.id))
        if approval.revokedAt then push(events, approval.revokedAt, "批准撤销", tostring(approval.revocationReason or "未记录原因"), tostring(approval.id)) end
    end
    for _, request in workflow and workflow.requests or {} do
        push(events, request.createdAt, "请求", tostring(request.activity) .. " · " .. tostring(request.requestId), tostring(request.requestId))
        if request.receivedAt then push(events, request.receivedAt, "回执", tostring(request.status) .. " · " .. tostring(request.reason or ""), tostring(request.requestId)) end
        if request.resolution then push(events, request.resolution.at, "人工对账", tostring(request.resolution.note), tostring(request.requestId)) end
    end
    if plan and (plan.revision or 0) > 0 then
        push(events, plan.updatedAt, "计划", "修订 " .. tostring(plan.revision) .. " · " .. tostring(plan.changeReason), "plan")
        for _, step in plan.steps do
            push(events, step.updatedAt, "计划步骤", tostring(step.id) .. " · " .. tostring(step.status) .. " · " .. tostring(step.title)
                .. (step.reason and (" · " .. step.reason) or ""), tostring(step.id))
        end
    end
    if results then
        if results.baseline then push(events, results.baseline.capturedAt, "实施基线", "请求 " .. tostring(results.baseline.requestId)
            .. " · HEAD " .. tostring(results.baseline.head):sub(1, 12), tostring(results.baseline.requestId)) end
        if results.changes then push(events, results.changes.capturedAt, "代码观察", tostring(#results.changes.files) .. " 个文件 · 指纹 "
            .. tostring(results.changes.fingerprint):sub(1, 16), "changes") end
        for _, verification in results.verifications do
            push(events, verification.startedAt, "验证", tostring(verification.command) .. " · 退出码 " .. tostring(verification.exitCode)
                .. " · " .. tostring(verification.result), tostring(verification.id))
        end
    end
    for _, review in reviews and reviews.reviews or {} do
        push(events, review.createdAt, "审查", tostring(review.source) .. " · " .. tostring(review.scope)
            .. " · " .. tostring(#review.findings) .. " 项发现", tostring(review.id))
        for _, event in review.events do
            push(events, event.at, "发现处置", tostring(event.action) .. " · " .. tostring(event.findingId) .. " · " .. tostring(event.reason), tostring(event.findingId))
        end
    end
    for _, acceptance in reviews and reviews.acceptances or {} do
        push(events, acceptance.createdAt, "人工验收", tostring(acceptance.decision) .. " · 需求修订 "
            .. tostring(acceptance.requirementRevision) .. (acceptance.comment ~= "" and (" · " .. acceptance.comment) or ""), tostring(acceptance.id))
    end
    for _, reopening in reviews and reviews.reopenings or {} do
        push(events, reopening.at, "重新打开", tostring(reopening.reason), tostring(reopening.acceptanceId))
    end
    table.sort(events, function(a, b) if a.at == b.at then return a.kind > b.kind end; return a.at > b.at end)
    if #events > MAX_EVENTS then
        local limited = {}
        for index = 1, MAX_EVENTS do limited[index] = events[index] end
        return limited, true
    end
    return events, false
end
function M.filter(events, query)
    local q = tostring(query or ""):lower()
    if q == "" then return events end
    local out = {}
    for _, event in events do
        if (event.kind .. " " .. event.summary .. " " .. event.ref):lower():find(q, 1, true) then table.insert(out, event) end
    end
    return out
end
local function line(out, value) table.insert(out, tostring(value == nil and "" or value)) end
local function blank(out) table.insert(out, "") end
function M.markdown(req, workflow, plan, results, reviews)
    local out = {}
    line(out, "# " .. tostring(req.number) .. " · " .. tostring(req.title))
    blank(out)
    line(out, "- 需求标识：" .. tostring(req.requirementId))
    line(out, "- 当前修订：" .. tostring(req.revision))
    line(out, "- 当前阶段：" .. tostring(req.stage))
    line(out, "- 类型／优先级：" .. tostring(req.type) .. " / " .. tostring(req.priority))
    blank(out)
    line(out, "## 目标与范围"); blank(out); line(out, tostring(req.goal)); blank(out)
    line(out, "### 范围"); blank(out); line(out, tostring(req.scope)); blank(out)
    line(out, "### 验收条件"); blank(out)
    for _, criterion in req.acceptanceCriteria or {} do
        line(out, "- " .. tostring(criterion.id) .. (criterion.required and "（必需）" or "") .. "：" .. tostring(criterion.description))
    end
    blank(out)
    line(out, "## 采用的方案与批准"); blank(out)
    for _, design in workflow and workflow.designs or {} do
        line(out, "- v" .. tostring(design.version) .. " · SHA-256 " .. tostring(design.sha256)
            .. " · 需求修订 " .. tostring(design.requirementRevision) .. " · " .. tostring(design.createdAt))
    end
    if workflow and workflow.approval then
        local a = workflow.approval
        line(out, "- 批准 " .. tostring(a.id) .. " · " .. tostring(a.mode) .. " · 需求修订 " .. tostring(a.requirementRevision)
            .. " · 方案 v" .. tostring(a.designVersion) .. " · 基线 " .. tostring(a.baseline and a.baseline.head or ""))
        if a.revokedAt then line(out, "- 已撤销 " .. tostring(a.revokedAt) .. " · " .. tostring(a.revocationReason or "")) end
    else line(out, "- 无批准记录") end
    blank(out)
    line(out, "## 计划"); blank(out)
    for _, step in plan and plan.steps or {} do
        line(out, "- " .. tostring(step.id) .. " · " .. tostring(step.status) .. " · " .. tostring(step.title)
            .. (step.reason and (" · 原因：" .. step.reason) or ""))
    end
    blank(out)
    line(out, "## 代码观察（不含差异正文）"); blank(out)
    if results and results.baseline then
        line(out, "- 基线请求 " .. tostring(results.baseline.requestId) .. " · HEAD " .. tostring(results.baseline.head)
            .. " · 指纹 " .. tostring(results.baseline.fingerprint))
        for _, file in results.baseline.files do line(out, "  - 基线文件 " .. tostring(file.status) .. " " .. tostring(file.path)) end
    else line(out, "- 无实施基线") end
    if results and results.changes then
        line(out, "- 当前观察 · HEAD " .. tostring(results.changes.head) .. " · 指纹 " .. tostring(results.changes.fingerprint))
        for _, commit in results.changes.commits do line(out, "  - 提交 " .. tostring(commit.hash) .. " · " .. tostring(commit.subject)) end
        for _, file in results.changes.files do line(out, "  - 文件 " .. tostring(file.status) .. " " .. tostring(file.path)) end
    end
    blank(out)
    line(out, "## 验证（不含 stdout/stderr）"); blank(out)
    for _, v in results and results.verifications or {} do
        line(out, "- " .. tostring(v.id) .. " · `" .. tostring(v.command) .. "` · 退出码 " .. tostring(v.exitCode)
            .. " · " .. tostring(v.result) .. " · 快照 " .. tostring(v.codeSnapshotSha256)
            .. " · 验收条件 " .. table.concat(v.criterionIds, ", "))
    end
    blank(out)
    line(out, "## 审查"); blank(out)
    for _, review in reviews and reviews.reviews or {} do
        line(out, "### " .. tostring(review.id) .. " · " .. tostring(review.source))
        line(out, "- 范围：" .. tostring(review.scope))
        line(out, "- 代码快照：" .. tostring(review.codeSnapshotSha256) .. " · 需求修订 " .. tostring(review.requirementRevision))
        for _, finding in review.findings do
            local state, reason = "open", nil
            for _, event in review.events do if event.findingId == finding.id then state, reason = event.action, event.reason end end
            if state == "reopened" then state = "open" end
            line(out, "- [" .. tostring(finding.severity) .. "] " .. tostring(finding.description)
                .. " · 状态 " .. tostring(state) .. (reason and (" · " .. reason) or ""))
        end
        blank(out)
    end
    line(out, "## 人工验收"); blank(out)
    for _, acceptance in reviews and reviews.acceptances or {} do
        line(out, "- " .. tostring(acceptance.createdAt) .. " · " .. tostring(acceptance.decision) .. " · 需求修订 "
            .. tostring(acceptance.requirementRevision) .. " · 快照 " .. tostring(acceptance.codeSnapshotSha256)
            .. (acceptance.comment ~= "" and (" · " .. acceptance.comment) or ""))
    end
    for _, reopening in reviews and reviews.reopenings or {} do
        line(out, "- 重新打开 " .. tostring(reopening.at) .. " · " .. tostring(reopening.reason))
    end
    blank(out)
    line(out, "---")
    line(out, "本导出由项目工作台记录生成；不包含验证命令的 stdout/stderr、聊天记录、认证信息或凭据。")
    line(out, "本地文件仍可被用户修改；工作台不宣称此记录不可篡改。")
    return table.concat(out, "\n") .. "\n"
end
return M
