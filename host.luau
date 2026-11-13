--!strict
local privacy = require("./lib/privacy")
local live = require("./lib/live")
local store = require("./lib/store")
local Workflow = require("./lib/workflow")
local Results = require("./lib/results")
local Review = require("./lib/review")
local Validity = require("./lib/validity")
local auditview = require("./lib/auditview")
local Audit = require("./lib/audit")
local context = require("./lib/context")
local Batch = require("./lib/batch")
local Resources = require("./lib/resources")
local runview = require("./lib/runview")
local ui = require("./lib/ui")
local function invalidatePreview(h)
    if h.preview then h.preview.previewToken=nil;h.previewStale=true end
end
local function units(text, position)
    local n, index = 0, 0
    for _, code in utf8.codes(text) do
        if index >= position then break end
        n += if code > 0xFFFF then 2 else 1
        index += 1
    end
    return n
end
local function point(text, offset)
    local n, index = 0, 0
    for _, code in utf8.codes(text) do
        local width = if code > 0xFFFF then 2 else 1
        if n + width > offset then break end
        n += width
        index += 1
    end
    return index
end
local function byte(text, at) return utf8.offset(text, at + 1) or #text + 1 end
local function focus(cx, target) cx:frame({{"focus", target or "main.workbench.runtime.materialsField.materials"}}) end
local function draftKey(s) return "live:draft:" .. s.payload.binding.instanceId .. ":" .. s.payload.binding.sessionId end
local function persist(s)
    local data = {text = s.text, pending = s.pending, receipt = s.receipt}
    local encoded = tern.json.encode(data)
    if encoded ~= s.savedDraft then tern.kv.set(draftKey(s), data); s.savedDraft = encoded end
end
local function bind(s, payload)
    assert(type(payload) == "table" and type(payload.location) == "table", "工作台绑定缺少来源")
    local location = live.path(payload.location.marker)
    assert(location and live.marker(payload.binding, location), "工作台绑定身份无效")
    assert(type(payload.source) == "number" and type(payload.window) == "string", "来源证明无效")
    if s.payload and s.payload.source ~= payload.source then error("不能把面板交给另一个来源 pane") end
    if not s.payload or s.payload.binding.openRequestId ~= payload.binding.openRequestId then
        s.openRequestedAt = tern.now()
        if s.payload then s.lastOpenAttempt = nil end
    end
    if s.payload and s.payload.binding.instanceId == payload.binding.instanceId
        and s.payload.binding.sessionId == payload.binding.sessionId then s.payload = payload; return end
    if s.payload and (s.payload.binding.instanceId ~= payload.binding.instanceId
        or s.payload.binding.sessionId ~= payload.binding.sessionId) and s.ui and s.ui.handoff then
        local handoff = s.ui.handoff
        if handoff.preview then handoff.preview.previewToken = nil; handoff.previewStale = true end
        handoff.baseline, handoff.baselineCheckedAt = nil, nil
        if handoff.pending then handoff.pending.staleBinding = true end
    end
    if s.payload then persist(s) end
    payload.location = location
    s.payload, s.snapshot, s.problem, s.error, s.history = payload, nil, "正在核对实时来源…", nil, {}
    s.lastSequence, s.sequenceAt, s.savedDraft = nil, nil, nil
    local saved = tern.kv.get(draftKey(s))
    s.text, s.pending, s.receipt = "", nil, nil
    if type(saved) == "table" then
        if type(saved.text) == "string" and #saved.text <= live.maxText and utf8.len(saved.text) then s.text = saved.text end
        if type(saved.pending) == "table" and live.token(saved.pending.requestId) then s.pending = saved.pending end
        if type(saved.receipt) == "table" then s.receipt = saved.receipt end
    end
    s.cursor, s.anchor = utf8.len(s.text), nil
end
local function alive(cx)
    for _, pane in tern.pane.list() do if pane.pane == cx.pane then return true end end
    return false
end
local refreshHandoffReceipt
local refreshTraceReceipt
local recordBaselineReference
local function refresh(s)
    local p, now = s.payload, live.epoch()
    s.problem = nil
    local nextBinding = tern.kv.get("live:binding:" .. p.window .. ":" .. s.panel)
    if type(nextBinding) == "table" and type(nextBinding.binding) == "table"
        and nextBinding.binding.instanceId == p.binding.instanceId
        and (nextBinding.binding.sessionId ~= p.binding.sessionId
            or nextBinding.binding.openRequestId ~= p.binding.openRequestId) then
        bind(s, nextBinding)
        p = s.payload
    end
    local proof = tern.kv.get("live:source:" .. p.window .. ":" .. p.binding.instanceId)
    if type(proof) ~= "table" or proof.instanceId ~= p.binding.instanceId or proof.sessionId ~= p.binding.sessionId
        or proof.sourcePane ~= p.source or proof.panel ~= s.panel or not proof.valid
        or type(proof.updatedAt) ~= "number" or now - proof.updatedAt > live.staleMs or proof.updatedAt > now + 2000 then
        s.problem = type(proof) == "table" and proof.reason or nil
        s.problem = s.problem or "来源证明已断开／失效；请在原 omp 输入 /wb"
    end
    local data, failure = live.read(p.location.runtime .. "snapshot.json", 262144)
    if data then data, failure = live.snapshot(data, p.binding) end
    if not data then s.problem = failure or "无法读取运行快照（保留最后已知状态）"
    else
        if s.lastSequence and data.sequence < s.lastSequence then
            s.problem = "快照序号倒退；拒绝将旧数据视为实时"
        else
            if data.sequence ~= s.lastSequence then s.sequenceAt = tern.now() end
            s.lastSequence, s.snapshot = data.sequence, data
            if data.state == "disconnected" then s.problem = "omp 已断开／退出（显示最后已知状态）"
            elseif now - data.updatedAt > live.staleMs or data.updatedAt > now + 2000
                or (s.sequenceAt and tern.now() - s.sequenceAt > live.staleMs) then
                s.problem = "连接已过期；最后更新 " .. tostring(math.max(0, math.floor((now - data.updatedAt) / 1000))) .. " 秒前，禁止预填"
            end
        end
    end
    if s.pending then
        local receipt = live.read(p.location.runtime .. "receipts/" .. s.pending.requestId .. ".json", 8192)
        if type(receipt) == "table" and receipt.schemaVersion == 1 and receipt.requestId == s.pending.requestId
            and receipt.instanceId == p.binding.instanceId and receipt.sessionId == p.binding.sessionId
            and (receipt.status == "prefilled" or receipt.status == "rejected" or receipt.status == "delivery_unknown") then
            s.receipt = receipt
            if receipt.status == "prefilled" or receipt.status == "rejected" then s.pending = nil end
        elseif type(s.pending.expiresAt) == "number" and now > s.pending.expiresAt then
            s.receipt = {requestId = s.pending.requestId, status = "delivery_unknown", reason = "等待回执超时；请查看 omp 输入框，不会自动重发"}
        end
    end
    if refreshHandoffReceipt then refreshHandoffReceipt(s, s.cx) end
    if refreshTraceReceipt then refreshTraceReceipt(s, s.cx) end
end
local function prefill(s, cx)
    refresh(s)
    if s.pending then s.error = "已有待核对请求；不会重复投递"; return end
    if s.ui.handoff and s.ui.handoff.pendingSend then s.error = "业务发送尚待核对；不会预填第二条消息"; return end
    if s.problem then s.error = s.problem; return end
    if not s.snapshot or s.snapshot.state ~= "idle" then s.error = "目标正在工作／等待输入；只在空闲时接受预填"; return end
    if not s.text:match("%S") then s.error = "先填写要预填的资料"; return end
    local now = live.epoch()
    local id = string.format("wb-%.0f-%d-%d", now, math.random(1, 2147483646), s.serial)
    s.serial += 1
    local command = {schemaVersion = 1, requestId = id, instanceId = s.payload.binding.instanceId,
        sessionId = s.payload.binding.sessionId, kind = "prefill", text = s.text, createdAt = now, expiresAt = now + 30000}
    s.pending = {requestId = id, createdAt = now, expiresAt = command.expiresAt}
    s.receipt, s.error = {requestId = id, status = "pending", reason = "正在写入私有消息盒；不会按 Enter"}, nil
    -- Durable intent first. A reload or an uncertain write never reissues it.
    persist(s)
    local expected = s.payload
    live.command(s.payload.location, command, function(_, failure)
        if not alive(cx) or s.payload ~= expected then return end
        if failure then
            s.receipt = {requestId = id, status = "delivery_unknown", reason = "写入结果待核对；不自动重发：" .. failure}
        elseif s.pending and s.pending.requestId == id then
            s.receipt = {requestId = id, status = "pending", reason = "消息盒已原子写入，等待同一 omp 的回执"}
        end
        cx:render()
    end)
end
local function prefillLiteral(s, cx, text)
    refresh(s)
    if s.pending then s.error = "已有待核对预填；不会重复投递"; cx:render(); return end
    if s.ui.handoff and s.ui.handoff.pendingSend then s.error = "业务发送尚待核对；不会预填第二条消息"; cx:render(); return end
    if s.problem then s.error = s.problem; cx:render(); return end
    if not s.snapshot or s.snapshot.state ~= "idle" then s.error = "目标 omp 当前非空闲；只在空闲时预填"; cx:render(); return end
    local now = live.epoch()
    local id = string.format("wb-%.0f-%d-%d", now, math.random(1, 2147483646), s.serial)
    s.serial += 1
    local command = {schemaVersion = 1, requestId = id, instanceId = s.payload.binding.instanceId,
        sessionId = s.payload.binding.sessionId, kind = "prefill", text = text, createdAt = now, expiresAt = now + 30000}
    s.pending = {requestId = id, createdAt = now, expiresAt = command.expiresAt}
    s.receipt, s.error = {requestId = id, status = "pending", reason = "正在写入私有消息盒；不会按 Enter"}, nil
    persist(s)
    local expected = s.payload
    live.command(s.payload.location, command, function(_, failure)
        if not alive(cx) or s.payload ~= expected then return end
        if failure then
            s.receipt = {requestId = id, status = "delivery_unknown", reason = "写入结果待核对；不自动重发：" .. failure}
        elseif s.pending and s.pending.requestId == id then
            s.receipt = {requestId = id, status = "pending", reason = "消息盒已原子写入，等待同一 omp 的回执"}
        end
        cx:render()
    end)
end
local function acknowledgeOpen(s, cx)
    local p, nonce = s.payload, s.payload.binding.openRequestId
    if not s.scheduled or not nonce or s.lastOpenAttempt == nonce or s.ackWriting then return end
    if s.problem or not s.snapshot then
        if tern.now() - s.openRequestedAt > 2000 then
            s.lastOpenAttempt = nonce
            cx:toast("error", "工作台未确认打开", s.problem or "来源健康核对超时；请重新 /wb")
        end
        return
    end
    s.lastOpenAttempt, s.ackWriting = nonce, true
    cx:save()
    live.opened(p.location, {schemaVersion = 1, instanceId = p.binding.instanceId, sessionId = p.binding.sessionId,
        openRequestId = nonce, sourcePane = p.source, panel = s.panel, window = p.window, updatedAt = live.epoch()},
        function(_, failure)
            s.ackWriting = nil
            if not alive(cx) then return end
            if failure then cx:toast("error", "工作台打开回执写入失败", failure) end
            cx:render()
        end)
end
local function projectKey(s)
    return "workbench:project:" .. s.payload.location.distro .. ":" .. s.payload.binding.projectRoot
end
local storageMessage
local handoffLimits={paths=8192,excerpt=8192,proposal=16384,importPath=2048,resourcePath=2048,comment=4000,directReason=2000,revokeReason=2000,ackReason=2000}
local function snapshotFields(fields)
    local snapshot = {}
    for name, field in fields or {} do
        if type(field) == "table" and type(field.text) == "string" then
            snapshot[name] = {text = field.text, cursor = field.cursor, anchor = field.anchor}
        end
    end
    return snapshot
end
local function snapshotDrafts(h)
    local drafts = {}
    for _, id in h.draftOrder or {} do
        local draft = h.drafts and h.drafts[id]
        if type(draft) == "table" then
            drafts[id] = {fields = snapshotFields(draft.fields), includeRequirement = draft.includeRequirement,
                activity = draft.activity, proposalSource = draft.proposalSource,
                importedFile = draft.importedFile, candidate = draft.candidate}
        end
    end
    return drafts
end
local function handoffSnapshot(h)
    local fields = snapshotFields(h.fields)
    local preview
    if type(h.preview) == "table" then
        preview = {text = h.preview.text, sha256 = h.preview.sha256, requirementId = h.preview.requirementId,
            requirementRevision = h.preview.requirementRevision, activity = h.preview.activity,
            baseline = h.preview.baseline, sources = h.preview.sources, designVersion = h.preview.designVersion}
    end
    return {tab = h.tab, fields = fields, includeRequirement = h.includeRequirement, activity = h.activity,
        preview = preview, previewStale = preview ~= nil, baseline = h.baseline, baselineCheckedAt = h.baselineCheckedAt,
        candidate = h.candidate, importedFile = h.importedFile, proposalSource = h.proposalSource,
        pending = h.pending, pendingSend = h.pendingSend, sourceReceipt = h.sourceReceipt,
        selectedVersion = h.selectedVersion, compareVersion = h.compareVersion, panel = h.panel == true, resourceKind = h.resourceKind,
        draftRequirement = h.draftRequirement, draftOrder = h.draftOrder, drafts = snapshotDrafts(h)}
end
local function handoffFields(saved)
    local fields = {}
    for name, limit in handoffLimits do
        local item = type(saved) == "table" and saved[name]
        local text = type(item) == "table" and item.text or ""
        if type(text) ~= "string" or #text > limit or not utf8.len(text) then text = "" end
        local length = utf8.len(text)
        fields[name] = {text = text, cursor = type(item) == "table" and math.clamp(tonumber(item.cursor) or length, 0, length) or length,
            anchor = type(item) == "table" and type(item.anchor) == "number" and math.clamp(item.anchor, 0, length) or nil}
    end
    return fields
end
local function makeHandoff(saved)
    saved = type(saved) == "table" and saved or {}
    local preview = type(saved.preview) == "table" and table.clone(saved.preview) or nil
    if preview then preview.previewToken = nil end
    local pending = type(saved.pending) == "table" and table.clone(saved.pending) or nil
    if pending and not live.token(pending.requestId) then pending = nil end
    local pendingSend = type(saved.pendingSend) == "table" and table.clone(saved.pendingSend) or nil
    if pendingSend and not live.token(pendingSend.requestId) then pendingSend = nil end
    if pendingSend then
        pendingSend.receiptInFlight = nil
        if pendingSend.receiptApplied == true and not pendingSend.receiptAppliedStatus then
            pendingSend.receiptAppliedStatus = pendingSend.receiptStatus
        end
        if not pendingSend.receiptApplied and pendingSend.receiptStatus and not pendingSend.receiptPending then
            pendingSend.receiptPending = {requestId = pendingSend.requestId, status = pendingSend.receiptStatus,
                reason = pendingSend.receiptReason}
        end
    end
    if pendingSend and pendingSend.state == "recording_intent" then pendingSend.state = "recovered_intent" end
    local tab = (saved.tab == "approval" and "approval") or "design"
    local drafts, draftOrder = {}, {}
    if type(saved.drafts) == "table" then
        for _, id in type(saved.draftOrder) == "table" and saved.draftOrder or {} do
            local draft = saved.drafts[id]
            if live.token(id) and type(draft) == "table" and #draftOrder < 4 then
                table.insert(draftOrder, id)
                drafts[id] = {fields = handoffFields(draft.fields),
                    includeRequirement = draft.includeRequirement ~= false,
                    activity = (draft.activity == "clarify" or draft.activity == "design" or draft.activity == "implement") and draft.activity or "design",
                    proposalSource = draft.proposalSource, importedFile = draft.importedFile, candidate = draft.candidate}
            end
        end
    end
    return {tab = tab, fields = handoffFields(saved.fields), includeRequirement = saved.includeRequirement ~= false,
        activity = (saved.activity == "clarify" or saved.activity == "design" or saved.activity == "implement") and saved.activity or "design",
        preview = preview, previewStale = preview ~= nil or saved.previewStale == true, baseline = saved.baseline,
        baselineCheckedAt = saved.baselineCheckedAt, candidate = saved.candidate, importedFile = saved.importedFile,
        proposalSource = saved.proposalSource, pending = pending, pendingSend = pendingSend,
        sourceReceipt = saved.sourceReceipt, selectedVersion = saved.selectedVersion,
        compareVersion = tonumber(saved.compareVersion) or 0, panel = saved.panel == true,
        resourceKind = (saved.resourceKind == "verify" and "verify") or "context",
        drafts = drafts, draftOrder = draftOrder,
        draftRequirement = live.token(saved.draftRequirement) and saved.draftRequirement or nil,
        safe = true, workflowBusy = false}
end
local handoffDraftFields = {"paths", "excerpt", "proposal", "importPath", "comment", "directReason", "revokeReason", "ackReason"}
local function saveCurrentDraft(h)
    local id = h.draftRequirement
    if not id then return end
    local fields = {}
    for _, name in handoffDraftFields do
        local field = h.fields[name]
        fields[name] = {text = field and field.text or "", cursor = field and field.cursor or nil,
            anchor = field and field.anchor or nil}
    end
    h.drafts[id] = {fields = fields, includeRequirement = h.includeRequirement, activity = h.activity,
        proposalSource = h.proposalSource, importedFile = h.importedFile, candidate = h.candidate}
    local order = {}
    for _, existing in h.draftOrder or {} do
        if existing ~= id then table.insert(order, existing) end
    end
    table.insert(order, id)
    while #order > 4 do
        local oldest = table.remove(order, 1)
        h.drafts[oldest] = nil
    end
    h.draftOrder = order
end
local function loadDraft(h, requirementId)
    h.draftRequirement = requirementId
    h.importedFile, h.candidate = nil, nil
    local draft = requirementId and h.drafts[requirementId] or nil
    if not draft then
        for _, name in handoffDraftFields do h.fields[name] = {text = "", cursor = 0, anchor = nil} end
        h.includeRequirement, h.activity, h.proposalSource = true, "design", nil
        return
    end
    for _, name in handoffDraftFields do
        local field = draft.fields and draft.fields[name]
        h.fields[name] = {text = field and field.text or "", cursor = field and field.cursor or nil,
            anchor = field and field.anchor or nil}
    end
    h.includeRequirement = draft.includeRequirement ~= false
    h.activity = draft.activity or "design"
    h.proposalSource = draft.proposalSource
    h.importedFile, h.candidate = draft.importedFile, draft.candidate
end
local function refreshResources(s)
    local u = s.ui
    if not u then return end
    u.resources = u.resources or {safe = true}
    local state = u.resources
    state.data, state.error, state.status, state.safe = nil, nil, {}, true
    local requirement = u.selected and u.byId[u.selected]
    if not requirement or not u.paths then return end
    local data, problem = Resources.load(u.paths, requirement)
    if not data then
        state.safe = false
        state.error = "资源绑定记录损坏：" .. storageMessage(problem or "请核对 resources.json")
        return
    end
    state.data = data
    local root = store.unc(s.payload.location, s.payload.binding.projectRoot)
    for _, entry in data.resources do
        local ok, text = false, nil
        if root then ok, text = pcall(tern.fs.read, root .. "\\" .. entry.path:gsub("/", "\\"), 16385) end
        if not ok then state.status[entry.id] = "unreadable"
        elseif type(text) == "string" and #text >= 16385 then state.status[entry.id] = "large"
        else state.status[entry.id] = "ok" end
    end
end
local function refreshHandoff(s)
    local u, h = s.ui, s.ui and s.ui.handoff
    if not u or not h then return end
    local requirement = u.selected and u.byId[u.selected]
    -- Drafts belong to the requirement they were written for; switching the
    -- selection must not carry text into another requirement's preview.
    local target = requirement and requirement.requirementId or nil
    if h.draftRequirement ~= target then
        saveCurrentDraft(h)
        loadDraft(h, target)
    end
    h.workflow, h.selectedDesign, h.compareDesign = nil, nil, nil
    h.error, h.workflowError, h.safe = nil, nil, true
    if not requirement then h.approvalValid, h.approvalReason = false, "先选择一项需求"; return end
    if h.preview and (h.preview.requirementId~=requirement.requirementId or h.preview.requirementRevision~=requirement.revision) then
        h.preview.previewToken=nil;h.previewStale=true
    end
    local workflow, failure = Workflow.load(u.paths, requirement)
    if not workflow then
        h.safe, h.error = false, storageMessage(failure or "工作流记录损坏；当前只读")
        h.approvalValid, h.approvalReason = false, h.error
        return
    end
    h.workflow = workflow
    local requests, matched, newest = workflow.requests or {}, nil, nil
    for _, request in requests do
        if h.pendingSend and request.requestId == h.pendingSend.requestId then matched = request end
        if not request.resolution and (request.status == "pending" or request.status == "delivery_unknown")
            and (not newest or (request.createdAt or 0) > (newest.createdAt or 0)) then newest = request end
    end
    if not h.pendingSend and newest and live.token(newest.requestId) then
        h.pendingSend = {requestId = newest.requestId, activity = newest.activity, sessionId = newest.sessionId,
            instanceId = newest.instanceId, payloadSha256 = newest.payloadSha256, state = newest.status,
            receiptApplied = newest.status == "delivery_unknown", receiptAppliedStatus = newest.status == "delivery_unknown" and "delivery_unknown" or nil,
            receiptStatus = newest.status == "delivery_unknown" and "delivery_unknown" or nil, receiptReason = newest.reason}
        matched = newest
    end
    if matched and h.pendingSend then
        if matched.resolution or matched.status == "submitted" or matched.status == "rejected" then
            h.pendingSend = nil
            if h.pending and h.pending.requestId == matched.requestId then h.pending = nil end
        elseif matched.status == "delivery_unknown" then
            h.pendingSend.state, h.pendingSend.receiptApplied = "delivery_unknown", true
            h.pendingSend.receiptAppliedStatus, h.pendingSend.receiptStatus = "delivery_unknown", "delivery_unknown"
            h.pendingSend.receiptReason = matched.reason
            h.pendingSend.receiptPending = nil
        end
    end
    if h.pendingSend and not h.pending and h.pendingSend.state ~= "recording_intent" then
        local request = matched
        if request and (request.status == "pending" or request.status == "delivery_unknown") then
            local created = request.createdAt or live.epoch()
            h.pending = {requestId = request.requestId, purpose = "send", sessionId = request.sessionId,
                instanceId = request.instanceId, requirementId = requirement.requirementId,
                createdAt = created, expiresAt = created + 30000, recovered = true}
        end
    end
    if matched and matched.status == "submitted" and matched.activity == "implement"
        and recordBaselineReference and h.workflow and h.workflow.approval and h.workflow.approval.baseline then
        recordBaselineReference(s, matched.requestId, h.workflow.approval.baseline, s.cx)
    end
    if h.pending and (h.pending.instanceId ~= s.payload.binding.instanceId
        or h.pending.sessionId ~= s.payload.binding.sessionId) then h.pending.staleBinding = true end
    local state = Workflow.approvalState(workflow, requirement)
    h.approvalValid, h.approvalReason = state.valid, state.message or tostring(state.reason)
    local version, versionExists = tonumber(h.selectedVersion) or workflow.latestVersion, false
    for _, item in workflow.designs or {} do if item.version == version then versionExists = true; break end end
    if version > 0 and not versionExists then version = workflow.latestVersion; h.compareVersion = 0 end
    h.selectedVersion = version
    if version > 0 then
        local design, designFailure = Workflow.readDesign(u.paths, requirement, version)
        if not design then
            h.safe, h.workflowError = false, storageMessage(designFailure or "正式方案版本损坏；当前只读")
        else h.selectedDesign = design end
    end
    local compare = tonumber(h.compareVersion) or 0
    if compare > 0 and compare ~= version then
        local design, designFailure = Workflow.readDesign(u.paths, requirement, compare)
        if not design then
            h.safe, h.workflowError = false, storageMessage(designFailure or "比较用正式方案版本损坏；当前只读")
        else h.compareDesign = design end
    end
    if h.workflowError then h.error = h.workflowError end
end
local traceLimits = {verifyCommand = 4000, verifyCriteria = 200, newStep = 500, blockReason = 1000}
local reviewLimits = {reviewScope=2000, reviewFindings=8192, reviewReason=2000, reviewComment=4000, reviewReject=2000, reviewReopen=2000, auditQuery=200, activityQuery=200, findingDraft=4000}
local function traceSnapshot(t)
    if not t then return nil end
    local fields = {}
    for name, field in t.fields or {} do
        if type(field) == "table" and type(field.text) == "string" then
            fields[name] = {text = field.text:sub(1, traceLimits[name] or 500), cursor = field.cursor, anchor = field.anchor}
        end
    end
    return {fields = fields}
end
local function makeTrace(saved)
    local fields = {}
    for name, limit in traceLimits do
        local item = type(saved) == "table" and type(saved.fields) == "table" and saved.fields[name]
        fields[name] = {text = type(item) == "table" and type(item.text) == "string" and item.text:sub(1, limit) or "",
            cursor = type(item) == "table" and type(item.cursor) == "number" and item.cursor or nil,
            anchor = type(item) == "table" and type(item.anchor) == "number" and item.anchor or nil}
    end
    for name, field in fields do field.cursor = field.cursor or utf8.len(field.text) end
    return {fields = fields, safe = true, busy = false}
end
local function reviewSnapshot(v)
    if not v then return nil end
    local fields = {}
    for name, limit in reviewLimits do
        local field = v.fields and v.fields[name]
        if type(field) == "table" and type(field.text) == "string" then
            fields[name] = {text = field.text:sub(1, limit), cursor = field.cursor, anchor = field.anchor}
        end
    end
    return {fields=fields, source=v.source, finding=v.finding, action=v.action, panel=v.panel, draftSeverity=v.draftSeverity}
end
local function makeReview(saved)
    local fields = {}
    for name, limit in reviewLimits do
        local item = type(saved) == "table" and type(saved.fields) == "table" and saved.fields[name]
        fields[name] = {text = type(item) == "table" and type(item.text) == "string" and item.text:sub(1, limit) or "",
            cursor = type(item) == "table" and type(item.cursor) == "number" and item.cursor or nil,
            anchor = type(item) == "table" and type(item.anchor) == "number" and item.anchor or nil}
    end
    for name, field in fields do field.cursor = field.cursor or utf8.len(field.text) end
    local savedPanel = type(saved) == "table" and saved.panel or nil
    local savedSeverity = type(saved) == "table" and saved.draftSeverity or nil
    return {fields=fields, source=type(saved)=="table" and saved.source or "native_review",
        finding=type(saved)=="table" and type(saved.finding)=="string" and saved.finding or "",
        action=type(saved)=="table" and saved.action or "resolved",
        panel=(savedPanel == "reject" or savedPanel == "reopen" or savedPanel == "dispose") and savedPanel or "",
        draftSeverity=(savedSeverity == "blocking" or savedSeverity == "major" or savedSeverity == "minor" or savedSeverity == "note") and savedSeverity or "major",
        safe=true, busy=false}
end
local function makeAudit(saved)
    return {busy=false, events=tern.json.array(), eventsTruncated=false,
        exportPath=type(saved)=="table" and type(saved.exportPath)=="string" and saved.exportPath:sub(1,2048) or nil}
end
local function makeActivity(saved)
    saved = type(saved) == "table" and saved or {}
    return {busy=false, events=tern.json.array(), truncated=false, errors=0, scanned=0,
        error=nil, notice=nil,
        exportPath=type(saved.exportPath)=="string" and saved.exportPath:sub(1,2048) or nil}
end
local MAX_CANDIDATES = 12
local packageRunners = {npm = "npm run ", pnpm = "pnpm ", yarn = "yarn ", bun = "bun run "}
local function candidateText(value)
    return type(value) == "string" and #value > 0 and #value <= 4000 and not value:find("[%z\1-\8\11\12\14-\31\127]")
        and utf8.len(value) ~= nil
end
-- Read-only discovery: only reads bounded manifest text; no command is executed
-- and no script body is interpreted.
local function discoverCandidates(s, t)
    local function add(items, seen, source, command, note)
        if #items >= MAX_CANDIDATES or not candidateText(command) or seen[command] then return end
        seen[command] = true
        table.insert(items, {id = "candidate-" .. tostring(#items + 1), command = command, source = source, note = note})
    end
    local items, seen = {}, {}
    local root = store.unc(s.payload.location, s.payload.binding.projectRoot)
    local function read(name, limit)
        if not root then return nil end
        local path = root .. "\\" .. name
        local exists, present = pcall(tern.fs.exists, path)
        if not exists or not present then return nil end
        local ok, text = pcall(tern.fs.read, path, limit or 65536)
        if not ok or type(text) ~= "string" or #text > (limit or 65536) or not utf8.len(text) then return nil end
        return text
    end
    local package = read("package.json")
    if package then
        local decoded, manifest = pcall(tern.json.decode, package)
        if decoded and type(manifest) == "table" and type(manifest.scripts) == "table" then
            local manager = type(manifest.packageManager) == "string" and manifest.packageManager:match("^([%w]+)@") or nil
            local runner = packageRunners[manager or ""] or packageRunners.npm
            local names = {}
            for name in manifest.scripts do
                if type(name) == "string" and #name <= 64 and name:match("^[%w_.:%-]+$") then table.insert(names, name) end
            end
            table.sort(names)
            for index, name in names do
                if index > 8 then break end
                add(items, seen, "package.json", runner .. name, "来自 package.json 的脚本名；脚本正文未被解析或执行")
            end
        end
    end
    local makefile = read("Makefile", 32768)
    if makefile then
        local count = 0
        for line in (makefile .. "\n"):gmatch("(.-)\n") do
            local target = line:match("^([%w_.-]+):")
            if target and target ~= ".PHONY" and count < 6 then
                add(items, seen, "Makefile", "make " .. target, "来自 Makefile 的目标名；未执行 make")
                count += 1
            end
        end
    end
    for _, manifest in {{"Cargo.toml", "cargo test"}, {"go.mod", "go test ./..."}, {"mix.exs", "mix test"}} do
        if read(manifest[1], 4096) then
            add(items, seen, manifest[1], manifest[2], "来自项目清单的固定测试命令；未执行")
        end
    end
    for index = #t.results.verifications, 1, -1 do
        if #items >= MAX_CANDIDATES then break end
        local verification = t.results.verifications[index]
        if type(verification.command) == "string" then
            add(items, seen, "历史证据", verification.command, "历史命令仅作草稿；其旧结果不构成当前证据")
        end
    end
    return items, root ~= nil
end
local function refreshTrace(s)
    local u, t = s.ui, s.ui and s.ui.trace
    if not u or not t then return end
    local requirement = u.selected and u.byId[u.selected]
    t.error = nil
    t.candidates, t.candidatesReady = nil, false
    if not requirement then t.plan, t.results = nil, nil; return end
    local plan, planError = Results.loadPlan(u.paths, requirement)
    local results, resultsError = Results.loadResults(u.paths, requirement)
    t.safe = plan ~= nil and results ~= nil
    t.plan, t.results = plan, results
    if not plan then t.error = "计划记录损坏：" .. storageMessage(planError or "请核对 plan.json") end
    if not results then t.error = (t.error and (t.error .. "；") or "") .. "结果记录损坏：" .. storageMessage(resultsError or "请核对 results.json") end
    if t.safe and t.fields.verifyCriteria.text == "" and #requirement.acceptanceCriteria > 0 then
        local ids = {}
        for _, criterion in requirement.acceptanceCriteria do table.insert(ids, criterion.id) end
        t.fields.verifyCriteria.text = table.concat(ids, ", ")
        t.fields.verifyCriteria.cursor = utf8.len(t.fields.verifyCriteria.text)
    end
    if t.safe and t.results then
        local ok, items, ready = pcall(discoverCandidates, s, t)
        t.candidates, t.candidatesReady = ok and items or nil, ok and ready or false
    end
    t.runPreview = nil
end
local function refreshAudit(s)
    local u, a = s.ui, s.ui and s.ui.audit
    if not u or not a then return end
    local requirement = u.selected and u.byId[u.selected]
    a.error = nil
    if not requirement then a.events = tern.json.array(); a.markdown = nil; return end
    local workflow, workflowError = Workflow.load(u.paths, requirement)
    local plan, planError = Results.loadPlan(u.paths, requirement)
    local results, resultsError = Results.loadResults(u.paths, requirement)
    local reviews, reviewError = Review.load(u.paths, requirement)
    if not workflow or not plan or not results or not reviews then
        a.events = tern.json.array()
        a.markdown = nil
        a.error = "审计记录无法完整读取：" .. storageMessage(workflowError or planError or resultsError or reviewError or "未知错误")
        return
    end
    a.events, a.eventsTruncated = Audit.timeline(requirement, workflow, plan, results, reviews)
    a.markdown = Audit.markdown(requirement, workflow, plan, results, reviews)
    if #a.markdown > 131072 then
        a.markdown = nil
        a.error = "导出内容超过 128 KiB；未生成不完整的导出。请缩小记录后再试。"
    end
end
local function refreshReview(s)
    local u, v = s.ui, s.ui and s.ui.review
    if not u or not v then return end
    local requirement = u.selected and u.byId[u.selected]
    v.error = nil
    if not requirement then v.data = nil; return end
    local data, problem = Review.load(u.paths, requirement)
    if not data then
        v.safe, v.data = false, nil
        v.error = "审查记录损坏：" .. storageMessage(problem or "请核对 reviews.json")
        return
    end
    v.safe, v.data = true, data
    local valid, first = false, nil
    for _, review in data.reviews do
        for _, finding in review.findings do
            local key = review.id .. "|" .. finding.id
            if not first then first = key end
            if v.finding == key then valid = true end
        end
    end
    if not valid then v.finding = first or "" end
end
local function saveUi(s)
    if not s.ui then return end
    tern.kv.set(projectKey(s), {tab = s.ui.tab, selected = s.ui.selected, sort = s.ui.sort,
        priorityFilter = s.ui.priorityFilter, stageFilter = s.ui.stageFilter, query = s.ui.query,
        queryCursor = s.ui.queryCursor, privacyMode = s.ui.privacyMode, layout = s.ui.layout,
        detailMode = s.ui.detailMode, drafts = s.ui.drafts, formMode = s.ui.formMode,
        mode = s.ui.mode, editing = s.ui.editing, draftKey = s.ui.draftKey, handoff = handoffSnapshot(s.ui.handoff),
        trace = traceSnapshot(s.ui.trace), review = reviewSnapshot(s.ui.review),
        audit = {exportPath = s.ui.audit and s.ui.audit.exportPath or nil},
        activity = {exportPath = s.ui.activity and s.ui.activity.exportPath or nil}})
end
storageMessage = function(reason)
    local code = type(reason) == "table" and reason.code or reason
    local messages = {
        locked = "另一个工作台正在编辑此项目；当前保持只读。",
        takeover_required = "写入锁已过期；需要显式确认后接管。",
        lock_conflict = "写入锁已改变；已拒绝覆盖。",
        busy = "正在处理另一个安全写入；请稍后重试。",
        revision_conflict = "此需求已在其他地方更新；草稿保留，请刷新并重新编辑。",
        corrupt_target = "存储记录损坏；未覆盖原文件。",
        corrupt_requirements = "需求列表包含损坏记录；当前只读，未覆盖任何文件。",
        requirement_id_conflict = "需求标识冲突；草稿保留，请重试创建。",
        corrupt_lock = "写入锁记录损坏；当前只读，未覆盖任何文件。",
        timeout = "安全写入等待超时；结果待核对，草稿已保留。",
        project_id_mismatch = "项目标识与现有存储不匹配；未覆盖任何文件。",
        corrupt_project = "项目记录损坏；未覆盖原文件。",
        project_root_mismatch = "此存储属于另一个项目根目录；未覆盖。",
        invalid_json = "项目存储不是有效 JSON；未覆盖。",
        corrupt_reviews = "审查记录损坏；未覆盖原文件。",
        review_limit = "审查记录已达到上限；未丢弃任何旧记录。",
        acceptance_limit = "人工验收记录已达到上限；未丢弃旧决定。",
        reopening_limit = "重新打开记录已达到上限。",
        review_event_limit = "单次审查的处置事件已达到上限。",
        invalid_stage_transition = "当前阶段不允许此人工转换；请刷新后核对。",
        missing_acceptance = "找不到可重新打开的人工接受记录。",
    }
    if messages[code] then
        local detail = type(reason) == "table" and reason.detail
        return messages[code] .. (type(detail) == "string" and detail ~= "" and (" " .. detail) or "")
    end
    if type(reason) == "table" then
        local detail = reason.detail
        if type(detail) == "string" and detail ~= "" then return detail end
        return type(code) == "string" and ("操作失败（" .. code .. "）") or "操作失败"
    end
    return tostring(reason or "操作失败")
end
local function handoffError(h, text)
    h.error = tostring(text or "操作失败")
end
local function newRequestId(s)
    local id = store.newId("wb", live.epoch()) .. "-" .. tostring(s.serial or 1)
    s.serial = (s.serial or 1) + 1
    return id
end
local function selectedRequirement(s)
    local u = s.ui
    return u and u.selected and u.byId[u.selected] or nil
end

local MAX_SCAN, MAX_ACTIVITY_EVENTS = 40, 500
local function readRequirementRecords(u, r)
    local workflow, workflowError = Workflow.load(u.paths, r)
    local plan, planError = Results.loadPlan(u.paths, r)
    local results, resultsError = Results.loadResults(u.paths, r)
    local reviews, reviewError = Review.load(u.paths, r)
    if not workflow or not plan or not results or not reviews then
        return nil, storageMessage(workflowError or planError or resultsError or reviewError or "未知错误")
    end
    return {workflow = workflow, plan = plan, results = results, reviews = reviews}
end

-- Cross-requirement projection over the same domain records the gates use.
-- Conditions use stable reasons and deduplicate per requirement; a read failure
-- is shown as an error item instead of being hidden.
local function refreshScan(s)
    local u = s.ui
    if not u or not u.paths then return end
    local attention = {items = {}, actionable = 0, errors = 0, scanned = 0, truncated = false}
    local events = {}
    local total = #u.requirements
    local limit = math.min(total, MAX_SCAN)
    attention.truncated = total > limit
    for index = 1, limit do
        local r = u.requirements[index]
        attention.scanned += 1
        local records, problem = readRequirementRecords(u, r)
        local item = {requirementId = r.requirementId, number = r.number, title = r.title,
            reasons = {}, rank = 99, tone = "warning"}
        local function push(reason, rank)
            if #item.reasons >= 6 then return end
            table.insert(item.reasons, reason)
            if rank < item.rank then item.rank = rank end
        end
        if not records then
            attention.errors += 1
            item.rank, item.tone = 1, "error"
            table.insert(item.reasons, "记录无法完整读取：" .. tostring(problem))
        else
            for _, request in records.workflow.requests or {} do
                if request.status == "delivery_unknown" and not request.resolution then
                    push("投递结果待核对：" .. tostring(request.requestId), 1)
                end
            end
            if r.stage == "blocked" then push("已阻塞：" .. (r.blockedReason or "未记录原因"), 2) end
            local approval = Validity.approval(records.workflow, r, Workflow.requirementContent(r))
            if (r.stage == "implementing" or r.stage == "verifying") and not approval.valid then
                push("实施授权已失效：" .. tostring(approval.message), 3)
            end
            if r.stage == "awaiting_approval" and not approval.valid then push("方案待批准", 4) end
            if r.stage == "implementing" or r.stage == "verifying" or r.stage == "awaiting_acceptance" then
                local gate = Validity.acceptance(r, records.results, records.reviews)
                if not gate.snapshot then
                    push("缺少当前代码快照，验收不能通过", 4)
                else
                    if gate.findings.blockingOpen > 0 then
                        push("有 " .. tostring(gate.findings.blockingOpen) .. " 项阻断发现未处置", 4)
                    end
                    local missing = gate.criteria.required - gate.criteria.requiredCovered
                    if missing > 0 then push("必需验收条件缺少当前证据：" .. tostring(missing) .. " 项", 4) end
                    if gate.ok and r.stage == "awaiting_acceptance" then push("证据齐备，待人工验收", 5) end
                end
            end
            for _, event in Audit.timeline(r, records.workflow, records.plan, records.results, records.reviews) do
                event.requirement, event.requirementId = r.number, r.requirementId
                table.insert(events, event)
            end
        end
        if #item.reasons > 0 then
            item.tone = item.rank <= 2 and "error" or (item.rank == 5 and "success" or "warning")
            table.insert(attention.items, item)
        end
    end
    table.sort(attention.items, function(a, b)
        if a.rank ~= b.rank then return a.rank < b.rank end
        return tostring(a.number) < tostring(b.number)
    end)
    attention.actionable = #attention.items
    table.sort(events, function(a, b)
        if a.at == b.at then return tostring(a.kind) < tostring(b.kind) end
        return a.at > b.at
    end)
    local truncatedEvents = #events > MAX_ACTIVITY_EVENTS
    if truncatedEvents then
        local limited = {}
        for eventIndex = 1, MAX_ACTIVITY_EVENTS do table.insert(limited, events[eventIndex]) end
        events = limited
    end
    u.attention = attention
    u.activity.events, u.activity.truncated = events, attention.truncated or truncatedEvents
    u.activity.errors, u.activity.scanned = attention.errors, attention.scanned
end
local function applyWorkflow(s, cx, action, args, completed)
    local u, h = s.ui, s.ui and s.ui.handoff
    local requirement = selectedRequirement(s)
    if not u or not h or not requirement or not h.workflow or not h.safe or not u.writable then
        handoffError(h or {}, "工作流不可写；请启用项目编辑并确认记录完整")
        cx:render()
        return
    end
    if h.pending and action ~= "receipt" and action ~= "acknowledge_unknown" then
        handoffError(h, "已有来源请求待核对；不会修改方案或提交新操作")
        cx:render()
        return
    end
    if h.pendingSend and action ~= "receipt" and action ~= "acknowledge_unknown"
        and not (action == "request" and h.pendingSend.state == "recording_intent") then
        handoffError(h, "业务发送尚未核对；不会修改采用的方案或授权")
        cx:render()
        return
    end
    if h.workflowBusy then return end
    h.workflowBusy, h.error = true, nil
    local expected = h.workflow.revision or 0
    local payload = s.payload
    Workflow.apply(u.paths, requirement, u.token, action, args, expected, function(workflow, updated, failure, freshCx)
        local ctx = freshCx or cx
        if not alive(ctx) or s.ui ~= u or s.payload ~= payload then return end
        h.workflowBusy = false
        if failure or not workflow then
            handoffError(h, storageMessage(failure or "工作流写入失败"))
            if completed then completed(false, ctx, failure) end
        else
            h.workflow = workflow
            if action=="adopt" or action=="approve" or action=="authorize_direct" or action=="revoke" then
                if h.preview then h.preview.previewToken=nil;h.previewStale=true end
            end
            if updated then
                u.byId[updated.requirementId] = updated
                for index, row in u.requirements do
                    if row.requirementId == updated.requirementId then u.requirements[index] = updated; break end
                end
            end
            refreshHandoff(s)
            if completed then completed(true, ctx, nil, workflow, updated) end
        end
        saveUi(s)
        ctx:render()
    end)
end
local function saveHandoffAndRender(s, cx)
    saveUi(s)
    if cx then cx:render() end
end
local function issueSourceCommand(s, cx, kind, fields, purpose, suppliedId)
    local h = s.ui.handoff
    if h.pending then handoffError(h, "已有来源命令待核对；不会自动重复发送"); cx:render(); return nil end
    local now, id = live.epoch(), suppliedId or newRequestId(s)
    local command = {schemaVersion = 1, requestId = id, instanceId = s.payload.binding.instanceId,
        sessionId = s.payload.binding.sessionId, kind = kind, createdAt = now, expiresAt = now + 30000}
    for key, value in fields do command[key] = value end
    h.pending = {requestId = id, purpose = purpose, operation = fields.operation,
        requirementId = fields.requirementId or s.ui.selected, path = fields.path, activity = fields.activity,
        includeRequirement = fields.includeRequirement,
        designVersion = fields.operation == "preview" and h.workflow and h.workflow.latestVersion or nil,
        sessionId = s.payload.binding.sessionId, instanceId = s.payload.binding.instanceId,
        requirementRevision = selectedRequirement(s) and selectedRequirement(s).revision,
        createdAt = now, expiresAt = command.expiresAt}
    h.error = nil
    saveHandoffAndRender(s, cx)
    local expected, expectedPayload = s.payload.binding.sessionId, s.payload
    live.command(s.payload.location, command, function(_, failure, freshCx)
        local ctx = freshCx or cx
        if not alive(ctx) or s.payload ~= expectedPayload or s.payload.binding.sessionId ~= expected then return end
        if failure then
            h.error = "命令写入状态待核对；不会自动重试：" .. tostring(failure)
            h.sourceReceipt = {requestId = id, status = "delivery_unknown", reason = h.error}
        end
        saveUi(s)
        ctx:render()
    end)
    return id
end
local function cleanRelativePaths(text)
    local paths = tern.json.array()
    for raw in (text .. "\n"):gmatch("(.-)\n") do
        local path = raw:gsub("^%s+", ""):gsub("%s+$", "")
        if path ~= "" then
            if path:sub(1, 1) == "/" or path:find("\\", 1, true) or path:match("^%a:") then
                return nil, "仅接受项目相对路径；绝对路径不会传给来源端"
            end
            for part in path:gmatch("[^/]+") do
                if part == "." or part == ".." then return nil, "路径不能包含 . 或 .. 组件" end
            end
            table.insert(paths, path)
        end
    end
    return paths
end
local function inspect(s, cx, operation, extra)
    local u, h, requirement = s.ui, s.ui.handoff, selectedRequirement(s)
    if not u.writable or not h.safe or not requirement then handoffError(h, "请启用项目编辑并选择有效需求"); cx:render(); return end
    if s.problem then handoffError(h, s.problem); cx:render(); return end
    if h.pending or h.pendingSend then handoffError(h, "已有请求待核对；不会重复请求"); cx:render(); return end
    local fields = {operation = operation, requirementId = requirement.requirementId}
    for key, value in extra or {} do fields[key] = value end
    issueSourceCommand(s, cx, "inspect", fields, "inspect")
end
local function startPreview(s, cx)
    local u, h = s.ui, s.ui.handoff
    local paths, failure = cleanRelativePaths(h.fields.paths.text)
    if not paths then handoffError(h, failure); cx:render(); return end
    local seen = {}
    for _, path in paths do seen[path] = true end
    local bound = u.resources and u.resources.data and u.resources.data.resources or {}
    for _, entry in bound do
        if not seen[entry.path] then
            if #paths >= 16 then
                handoffError(h, "资料与绑定资源合计最多 16 个文件；未生成预览"); cx:render(); return
            end
            table.insert(paths, entry.path)
            seen[entry.path] = true
        end
    end
    if #h.fields.excerpt.text > 8192 then handoffError(h, "讨论摘录超过 8 KiB；不会截断"); cx:render(); return end
    inspect(s, cx, "preview", {activity = h.activity, includeRequirement = h.includeRequirement,
        paths = paths, excerpt = h.fields.excerpt.text})
end
local function sendPreview(s, cx, prefillOnly)
    local u, h, requirement = s.ui, s.ui.handoff, selectedRequirement(s)
    local preview = h.preview
    if not u.writable or not h.safe or not requirement then handoffError(h, "请启用项目编辑并选择有效需求"); cx:render(); return end
    if s.problem then handoffError(h, s.problem); cx:render(); return end
    if not preview or h.previewStale or type(preview.previewToken) ~= "string" or preview.previewToken == "" then
        handoffError(h, "此预览令牌已失效；请显式重新生成完整预览"); cx:render(); return
    end
    if preview.requirementId ~= requirement.requirementId then
        handoffError(h, "此预览属于另一项需求；已拒绝发送，请针对当前需求重新生成预览"); cx:render(); return
    end
    if h.pending or h.pendingSend then handoffError(h, "已有请求待核对；不会重复发送"); cx:render(); return end
    if not s.snapshot or s.snapshot.state ~= "idle" then handoffError(h, "目标 omp 当前非空闲；保留预览，不发送"); cx:render(); return end
    if not prefillOnly and preview.activity == "implement" and not h.approvalValid then
        handoffError(h, "实施未获当前有效批准；先批准正式方案，或单独记录直接实施授权"); cx:render(); return
    end
    if prefillOnly then
        issueSourceCommand(s, cx, "prefill_preview", {previewToken = preview.previewToken}, "prefill")
        return
    end
    if type(preview.sha256) ~= "string" or not preview.sha256:match("^[0-9a-f]+$") or #preview.sha256 ~= 64 then
        handoffError(h, "预览缺少完整 SHA-256；请重新生成"); cx:render(); return
    end
    local id = newRequestId(s)
    local pending = {requestId = id, activity = preview.activity, sessionId = s.payload.binding.sessionId,
        instanceId = s.payload.binding.instanceId, payloadSha256 = preview.sha256, state = "recording_intent",
        baseline = preview.activity == "implement" and preview.baseline or nil}
    h.pendingSend, h.error = pending, nil
    saveHandoffAndRender(s, cx)
    applyWorkflow(s, cx, "request", {requestId = id, activity = preview.activity, sessionId = pending.sessionId,
        instanceId = pending.instanceId, payloadSha256 = preview.sha256}, function(ok, ctx, failure)
        if not ok then
            pending.state = "intent_unknown"
            pending.reason = storageMessage(failure or "发送意图无法确认；来源命令未发送，也不会自动重试")
            saveHandoffAndRender(s, ctx)
            return
        end
        if s.payload.binding.sessionId ~= pending.sessionId or s.payload.binding.instanceId ~= pending.instanceId then
            pending.state, pending.reason = "intent_only", "来源会话已改变；不会向新会话发送旧意图"
            saveHandoffAndRender(s, ctx)
            return
        end
        pending.state = "source_command"
        issueSourceCommand(s, ctx, "send", {previewToken = preview.previewToken}, "send", id)
    end)
end
recordBaselineReference = function(s, requestId, baseline, cx)
    local u = s.ui
    if not u or not u.trace or type(baseline) ~= "table" or not requestId then return end
    if u.trace.baselineAttempt == requestId then return end
    local requirement = selectedRequirement(s)
    if not requirement or not u.writable or not u.trace.safe or not u.token then return end
    u.trace.baselineAttempt = requestId
    Results.recordBaseline(u.paths, requirement, u.token, baseline, requestId, function(saved, reason, freshCx)
        local ctx = freshCx or cx or s.cx
        if not alive(ctx) then return end
        if saved then
            refreshTrace(s)
            if s.ui.trace then
                s.ui.trace.notice = "已记录实施基线（请求 " .. requestId .. "）；基线已有改动不视为本需求产出。"
            end
        else
            s.ui.trace.error = "实施基线未能保存：" .. storageMessage(reason or "请核对结果记录")
        end
        saveUi(s)
        ctx:render()
    end)
end
local function applySendReceipt(s, cx, receipt)
    local u, h = s.ui, s.ui.handoff
    local pending = h.pendingSend
    if not pending or pending.requestId ~= receipt.requestId then return end
    local priorStatus = pending.receiptAppliedStatus
    if pending.receiptApplied == true and not priorStatus then priorStatus = pending.receiptStatus end
    if priorStatus == receipt.status or (priorStatus and (priorStatus ~= "delivery_unknown"
        or (receipt.status ~= "submitted" and receipt.status ~= "rejected"))) then return end
    if pending.receiptInFlight then return end
    if receipt.status ~= "submitted" and receipt.status ~= "rejected" and receipt.status ~= "delivery_unknown" then return end
    if not u.writable or not h.safe or not h.workflow then
        handoffError(h, "发送回执待保存；请恢复项目写入权限后核对，不会重发来源命令")
        return
    end
    local reason = type(receipt.reason) == "string" and #receipt.reason <= 1000 and receipt.reason:match("%S") and receipt.reason
        or ("来源回执状态：" .. tostring(receipt.status) .. "（未提供详细原因）")
    pending.receiptInFlight, pending.receiptStatus, pending.receiptReason = true, receipt.status, reason
    pending.receiptPending = {requestId = pending.requestId, status = receipt.status, reason = reason}
    saveUi(s)
    applyWorkflow(s, cx, "receipt", {requestId = pending.requestId, status = receipt.status, reason = reason}, function(ok, ctx, failure)
        pending.receiptInFlight = nil
        if ok then
            pending.receiptApplied, pending.receiptAppliedStatus, pending.receiptPending = true, receipt.status, nil
            pending.state = receipt.status
            if receipt.status == "submitted" or receipt.status == "rejected" then h.pendingSend = nil end
            if receipt.status == "submitted" and pending.activity == "implement" and type(pending.baseline) == "table" then
                recordBaselineReference(s, pending.requestId, pending.baseline, ctx)
            end
        else
            handoffError(h, "发送回执尚未保存：" .. storageMessage(failure or "请刷新后核对，绝不会重发来源命令"))
        end
        saveUi(s)
        ctx:render()
    end)
end
local function receiveInspected(s, cx, pending, receipt)
    local h, data = s.ui.handoff, receipt.data
    if type(data) ~= "table" then handoffError(h, "检查回执缺少受限结果数据"); return end
    if pending.operation == "preview" then
        local preview = data
        if type(preview.text) ~= "string" or #preview.text > live.maxText or not utf8.len(preview.text)
            or type(preview.previewToken) ~= "string" or #preview.previewToken == 0
            or type(preview.sha256) ~= "string" or not preview.sha256:match("^[0-9a-f]+$") or #preview.sha256 ~= 64
            or preview.requirementId ~= pending.requirementId or preview.requirementRevision ~= pending.requirementRevision
            or preview.activity ~= pending.activity or type(preview.sources) ~= "table"
            or (preview.designVersion ~= nil and preview.designVersion ~= pending.designVersion) then
            handoffError(h, "完整预览回执身份、内容或 16 KiB 边界无效；未保存预览"); return
        end
        preview.designVersion = pending.designVersion or 0
        h.preview, h.previewStale = preview, false
    elseif pending.operation == "baseline" then
        local baseline = data.baseline
        if type(baseline) ~= "table" or type(baseline.head) ~= "string" or type(baseline.fingerprint) ~= "string"
            or not baseline.fingerprint:match("^[0-9a-f]+$") or #baseline.fingerprint ~= 64 or type(baseline.dirty) ~= "boolean" then
            handoffError(h, "Git 基线回执无效；不能作出授权决定"); return
        end
        h.baseline, h.baselineCheckedAt = baseline, receipt.updatedAt
    elseif pending.operation == "candidate" then
        local candidate = data.candidate
        if type(candidate) ~= "table" or type(candidate.body) ~= "string" or #candidate.body > live.maxText or not utf8.len(candidate.body)
            or type(candidate.entryId) ~= "string" or candidate.sessionId ~= pending.sessionId
            or type(candidate.includesToolCalls) ~= "boolean" then
            handoffError(h, "回复候选无效或超限；没有导入草稿"); return
        end
        h.candidate = candidate
    elseif pending.operation == "file" then
        local file = data.file
        if type(file) ~= "table" or file.path ~= pending.path or type(file.body) ~= "string"
            or #file.body > 16384 or not utf8.len(file.body) or type(file.sha256) ~= "string"
            or not file.sha256:match("^[0-9a-f]+$") or #file.sha256 ~= 64 then
            handoffError(h, "项目文件无效或超过 16 KiB；没有导入草稿"); return
        end
        h.importedFile = {path = file.path, body = file.body, sha256 = file.sha256}
    end
    h.error = nil
end
refreshHandoffReceipt = function(s, cx)
    local u, h = s.ui, s.ui and s.ui.handoff
    if not u or not h then return end
    if not h.pending then
        local pendingReceipt = h.pendingSend and h.pendingSend.receiptPending
        if pendingReceipt and not h.pendingSend.receiptApplied then
            refreshHandoff(s)
            applySendReceipt(s, cx, pendingReceipt)
        end
        return
    end
    if h.pendingSend and h.pendingSend.receiptPending then
        local pendingReceipt = h.pendingSend.receiptPending
        refreshHandoff(s)
        applySendReceipt(s, cx, pendingReceipt)
        if not h.pending then return end
    end
    local pending = h.pending
    if pending.instanceId and pending.instanceId ~= s.payload.binding.instanceId then return end
    local receipt = live.read(s.payload.location.runtime .. "receipts/" .. pending.requestId .. ".json", 65536)
    local expectedInstance, expectedSession = pending.instanceId or s.payload.binding.instanceId,
        pending.sessionId or s.payload.binding.sessionId
    if type(receipt) == "table" and receipt.schemaVersion == 1 and receipt.requestId == pending.requestId
        and receipt.instanceId == expectedInstance and receipt.sessionId == expectedSession
        and (receipt.status == "inspected" or receipt.status == "submitted" or receipt.status == "prefilled"
            or receipt.status == "rejected" or receipt.status == "delivery_unknown") then
        local prior = h.sourceReceipt
        local changed = type(prior) ~= "table" or prior.requestId ~= receipt.requestId
            or prior.status ~= receipt.status or prior.reason ~= receipt.reason
        h.sourceReceipt = receipt
        if pending.purpose == "send" and receipt.status == "delivery_unknown" then
            if receipt.reason == "applying_request" then
                pending.applying = true
                h.error = "来源端已持久记录请求，正在调用 omp SDK；继续核对同一请求，不会重发"
                if changed then saveUi(s) end
                return
            end
            applySendReceipt(s, cx, receipt)
            if changed then saveUi(s) end
            return
        end
        h.pending = nil
        if receipt.status == "inspected" then
            receiveInspected(s, cx, pending, receipt)
            if pending.staleBinding and pending.operation == "preview" and h.preview then
                h.preview.previewToken = nil
                h.previewStale = true
                h.error = "此预览来自旧会话；令牌已清除，请在当前会话显式重新生成"
            end
        elseif pending.purpose == "send" then applySendReceipt(s, cx, receipt)
        elseif receipt.status == "rejected" or receipt.status == "delivery_unknown" then
            handoffError(h, receipt.reason or "来源端未完成请求；不会自动重试")
        end
        saveUi(s)
        return
    end
    if type(pending.expiresAt) == "number" and live.epoch() > pending.expiresAt and not pending.timeoutShown then
        local unknown = {schemaVersion = 1, requestId = pending.requestId, instanceId = expectedInstance,
            sessionId = expectedSession, status = "delivery_unknown", reason = "等待来源回执超时；请求仍可由同一 ID 核对，不会重发"}
        h.sourceReceipt, pending.timeoutShown = unknown, true
        if pending.purpose == "send" then applySendReceipt(s, cx, unknown)
        else handoffError(h, unknown.reason) end
        saveUi(s)
    end
end
local function adoptProposal(s, cx)
    local h, text = s.ui.handoff, s.ui.handoff.fields.proposal.text
    if #text == 0 or #text > 16384 or not utf8.len(text) then handoffError(h, "方案必须是完整有效 UTF-8，且不超过 16 KiB"); cx:render(); return end
    local source = h.proposalSource or {kind = "manual"}
    applyWorkflow(s, cx, "adopt", {body = text, source = source}, function(ok, ctx)
        if ok then
            h.proposalSource = nil
            h.selectedVersion = h.workflow.latestVersion
            h.compareVersion = 0
            refreshHandoff(s)
            saveUi(s)
            ctx:toast("success", "已采用为正式方案", "版本 v" .. tostring(h.selectedVersion))
        end
    end)
end
local function endHandoffWait(s,cx)
    local u,h=s.ui,s.ui.handoff
    local pending=h.pendingSend or h.pending
    local note=h.fields.ackReason.text
    if not pending or not note:match("%S") or not u.writable or not h.safe or not h.workflow or h.workflowBusy then
        handoffError(h,"请启用编辑并填写人工核对说明；此操作不会重发或取消任务");cx:render();return
    end
    local id=pending.requestId
    local function finish(ctx)
        local record
        for _,r in h.workflow.requests do if r.requestId==id then record=r;break end end
        local status=record and record.status or "delivery_unknown"
        if status=="pending" then status="delivery_unknown" end
        h.pending,h.pendingSend=nil,nil
        invalidatePreview(h)
        h.sourceReceipt={requestId=id,status=status,localOnly=true,
            reason=(record and record.reason or "投递结果未确认").."\n人工结束等待："..note,
            updatedAt=live.epoch()}
        h.fields.ackReason.text,h.fields.ackReason.cursor,h.fields.ackReason.anchor="",0,nil
        saveHandoffAndRender(s,ctx)
    end
    local recorded=false
    for _,r in h.workflow.requests do if r.requestId==id then recorded=true;break end end
    if h.pendingSend and recorded then
        applyWorkflow(s,cx,"acknowledge_unknown",{requestId=id,note=note,clicked=true},function(ok,ctx)
            if ok then finish(ctx) end
        end)
    else
        -- No SEND is dispatched until a recorded intent succeeds. Read-only checks
        -- and unconfirmed local intents can be dismissed without inventing a run.
        finish(cx)
    end
end
local function traceError(s, text)
    if s.ui and s.ui.trace then s.ui.trace.error = tostring(text or "操作失败") end
end
local function trim(text) return tostring(text or ""):gsub("^%s+", ""):gsub("%s+$", "") end
local function clipBytes(text, limit)
    text = text or ""
    if #text <= limit then return text, false end
    local cut = text:sub(1, limit)
    while #cut > 0 and not utf8.len(cut) do cut = cut:sub(1, #cut - 1) end
    return cut, true
end
local function parseCriteria(text, requirement)
    local ids, seen = tern.json.array(), {}
    for raw in (text .. ","):gmatch("(.-),") do
        local id = trim(raw)
        if id ~= "" and not seen[id] then
            if not id:match("^[%w_%-]+$") or #id > 64 then return nil, "验收条件 ID 只能包含字母、数字、下划线和连字符" end
            local found = false
            for _, criterion in requirement.acceptanceCriteria or {} do if criterion.id == id then found = true; break end end
            if not found then return nil, "验收条件 ID 不存在：" .. id end
            seen[id] = true
            table.insert(ids, id)
        end
    end
    if #ids == 0 then return nil, "至少关联一个验收条件" end
    if #ids > 32 then return nil, "验收条件数量超过 32 个上限" end
    return ids, nil
end
local function issueTraceCommand(s, cx, operation, extra, purpose)
    local u, t, requirement = s.ui, s.ui and s.ui.trace, selectedRequirement(s)
    if not u or not t or not requirement then traceError(s, "请选择有效需求"); cx:render(); return end
    if t.pending then traceError(s, "已有来源检查待核对；不会重复发送"); cx:render(); return end
    if t.busy then traceError(s, "当前操作尚未完成"); cx:render(); return end
    if not u.writable or not t.safe then traceError(s, "需要项目编辑权限和完整记录"); cx:render(); return end
    local now, id = live.epoch(), newRequestId(s)
    local command = {schemaVersion = 1, requestId = id, instanceId = s.payload.binding.instanceId,
        sessionId = s.payload.binding.sessionId, kind = "inspect", operation = operation,
        requirementId = requirement.requirementId, createdAt = now, expiresAt = now + 30000}
    for key, value in extra or {} do command[key] = value end
    t.pending = {requestId = id, purpose = purpose, operation = operation, requirementId = requirement.requirementId,
        requirementRevision = requirement.revision, sessionId = s.payload.binding.sessionId,
        instanceId = s.payload.binding.instanceId, createdAt = now, expiresAt = command.expiresAt}
    t.error, t.busy, t.busyLabel = nil, true,
        purpose == "verify_snapshot" and "正在读取验证前代码快照…" or "正在读取当前代码变化…"
    saveUi(s)
    cx:render()
    local expectedPayload = s.payload
    live.command(s.payload.location, command, function(_, failure, freshCx)
        local ctx = freshCx or cx
        if not alive(ctx) or s.payload ~= expectedPayload then return end
        if failure then
            t.pending, t.busy, t.busyLabel = nil, false, nil
            t.error = "来源检查命令写入状态待核对；未执行验证、未写入新证据。请刷新后重试。"
            saveUi(s)
            ctx:render()
        end
    end)
end
local function beginTraceVerification(s, cx, command, criterionIds)
    local t = s.ui.trace
    if not t or not t.results then
        if t then traceError(s, "结果记录尚未读取；未执行命令") end
        cx:render()
        return
    end
    t.verifyRequest = {command = command, criterionIds = criterionIds}
    local baseline = t.results.baseline
    issueTraceCommand(s, cx, "changes", {since = baseline and baseline.head or ""}, "verify_snapshot")
end
local function startTraceVerification(s, cx, snapshot)
    local u, t, requirement = s.ui, s.ui.trace, selectedRequirement(s)
    local request = t.verifyRequest
    if not request or not requirement then t.busy, t.busyLabel = false, nil; traceError(s, "验证请求上下文已丢失；未执行命令"); cx:render(); return end
    t.verifyRequest = nil
    local startedAt = live.epoch()
    local id = store.newId("verification", startedAt)
    local argv = {"wsl.exe", "-d", s.payload.location.distro, "--cd", s.payload.binding.projectRoot,
        "--", "bash", "-lc", request.command}
    local finished = false
    local function finish(result, startError)
        if finished or not alive(s.cx) then return end
        finished = true
        local endedAt = live.epoch()
        local stdout, stderr = result and result.stdout or "", result and result.stderr or startError or ""
        local timedOut = result and result.timed_out == true or false
        local status = result and type(result.status) == "number" and result.status or nil
        local exitCode = timedOut and nil or status
        local outcome = timedOut or exitCode == nil and "unknown" or (exitCode == 0 and "passed" or "failed")
        local fullOut, outTruncated = clipBytes(stdout, 16384)
        local fullErr, errTruncated = clipBytes(stderr, 16384)
        local outPreview = clipBytes(stdout, 400)
        local errPreview = clipBytes(stderr, 400)
        local verification = {id = id, command = request.command, cwd = s.payload.binding.projectRoot,
            criterionIds = request.criterionIds, requirementRevision = requirement.revision,
            codeSnapshotSha256 = snapshot.fingerprint, startedAt = startedAt, endedAt = endedAt,
            exitCode = exitCode, timedOut = timedOut, result = outcome,
            stdoutPreview = outPreview, stderrPreview = errPreview,
            stdoutBytes = #stdout, stderrBytes = #stderr,
            stdoutTruncated = outTruncated, stderrTruncated = errTruncated,
            evidencePath = "evidence/" .. id .. ".json"}
        local evidence = {stdout = fullOut, stderr = fullErr, stdoutBytes = #stdout, stderrBytes = #stderr,
            stdoutTruncated = outTruncated, stderrTruncated = errTruncated}
        Results.addVerification(u.paths, requirement, u.token, verification, evidence, t.results.revision,
            function(saved, reason, freshCx)
                local ctx = freshCx or cx
                if not alive(ctx) then return end
                t.busy, t.busyLabel = false, nil
                if saved then
                    t.results = saved
                    t.notice = "验证已保存：" .. outcome .. " · 退出码 " .. tostring(exitCode) .. "；这不是人工验收。"
                else
                    t.error = "验证证据未能保存：" .. storageMessage(reason or "请核对结果记录")
                end
                saveUi(s)
                ctx:render()
                if saved then
                    issueTraceCommand(s, ctx, "changes", {since = saved.baseline and saved.baseline.head or ""}, "after_verify")
                end
            end)
    end
    t.busy, t.busyLabel = true, "验证命令运行中（最长 180 秒）；退出码与输出将写入证据"
    saveUi(s)
    cx:render()
    local ok, failure = pcall(tern.process.run, argv, {timeout_ms = 180000}, function(result) finish(result, nil) end)
    if not ok then finish(nil, "验证命令无法启动：" .. tostring(failure)) end
end
local batchReasons = {not_passed = "首个命令未通过或结果未知", code_changed = "验证后代码已变化",
    time_limit = "总时长超过 10 分钟", cancelled = "已按请求停止", completed = "全部命令通过",
    source_error = "来源请求失败"}
local function acceptTraceChanges(s, cx, changes, purpose)
    local u, t, requirement = s.ui, s.ui.trace, selectedRequirement(s)
    local function finish(saved, failure, freshCx)
        local ctx = freshCx or cx
        if not alive(ctx) then return end
        t.busy, t.busyLabel = false, nil
        if saved then
            t.results = saved
            if purpose == "after_verify" then
                if t.verifySnapshot and saved.changes and saved.changes.fingerprint ~= t.verifySnapshot then
                    t.notice = "验证后代码已经变化；这次结果已失效，保留为历史证据。请重新验证。"
                else t.notice = "当前代码快照已更新。" end
            end
        else t.error = "代码变化未能保存：" .. storageMessage(failure or "请核对结果记录") end
        local followup
        if saved and purpose == "verify_snapshot" then
            if t.batch and t.batch.state == "running" and t.batch.stopRequested then
                Batch.advance(t.batch, {result = "unknown"})
                t.notice = "批量已停止（取消）；后续命令未运行。"
            else
                followup = "verify"
            end
        elseif saved and purpose == "after_verify" and t.batch and t.batch.state == "running" then
            local verification = saved.verifications and saved.verifications[#saved.verifications]
            local changed = t.verifySnapshot and saved.changes and saved.changes.fingerprint ~= t.verifySnapshot
            local decision = Batch.advance(t.batch, {result = verification and verification.result or "unknown",
                codeChanged = changed == true, elapsedMs = live.epoch() - t.batch.startedAt})
            if decision.action == "next" then
                t.notice = (t.notice or "") .. " 批量继续第 " .. tostring(t.batch.index) .. " / "
                    .. tostring(#t.batch.entries) .. " 条。"
                followup = decision.entry
            else
                t.notice = "批量结束：" .. (batchReasons[t.batch.stopReason] or tostring(t.batch.stopReason))
                    .. "；剩余 " .. tostring(Batch.remaining(t.batch)) .. " 条未运行。"
            end
        end
        saveUi(s)
        ctx:render()
        if followup == "verify" then
            startTraceVerification(s, ctx, saved.changes)
        elseif type(followup) == "table" then
            beginTraceVerification(s, ctx, followup.command, followup.criterionIds)
        end
    end
    if purpose == "verify_snapshot" then
        Results.putChanges(u.paths, requirement, u.token, changes, t.results.revision, finish)
    elseif u.writable then
        Results.putChanges(u.paths, requirement, u.token, changes, t.results.revision, finish)
    else
        t.results.changes = changes
        finish(t.results, nil)
    end
end
local function handleTraceInspected(s, cx, pending, receipt)
    local data = receipt.data
    local changes = type(data) == "table" and data.changes
    if type(changes) ~= "table" or not Results.validateChanges(changes) then
        s.ui.trace.pending, s.ui.trace.busy, s.ui.trace.busyLabel = nil, false, nil
        traceError(s, "代码变化回执无效；未执行验证、未写入新证据")
        saveUi(s)
        cx:render()
        return
    end
    s.ui.trace.pending = nil
    acceptTraceChanges(s, cx, changes, pending.purpose)
end
refreshTraceReceipt = function(s, cx)
    local ok, problem = pcall(function()
        local u, t = s.ui, s.ui and s.ui.trace
        if not u or not t or not t.pending then return end
        local pending = t.pending
        local receipt = live.read(s.payload.location.runtime .. "receipts/" .. pending.requestId .. ".json", 262144)
        if type(receipt) == "table" and receipt.schemaVersion == 1 and receipt.requestId == pending.requestId
            and receipt.instanceId == pending.instanceId and receipt.sessionId == pending.sessionId then
            if receipt.status == "inspected" then
                handleTraceInspected(s, cx, pending, receipt)
            elseif receipt.status == "rejected" or receipt.status == "delivery_unknown" then
                t.pending, t.busy, t.busyLabel = nil, false, nil
                t.error = "来源检查未完成：" .. tostring(receipt.reason or receipt.status) .. "；未执行验证、未写入新证据。"
                saveUi(s)
                cx:render()
            end
            return
        end
        if live.epoch() > pending.expiresAt then
            t.pending, t.busy, t.busyLabel = nil, false, nil
            t.error = "来源检查回执超时；未执行验证，也未写入新证据。"
            saveUi(s)
            cx:render()
        end
    end)
    if not ok then
        local t = s.ui and s.ui.trace
        if t then
            t.pending, t.busy, t.busyLabel = nil, false, nil
            t.error = "处理代码变化回执失败：" .. tostring(problem)
            saveUi(s)
            cx:render()
        end
    end
end
local function applyTracePlan(s, cx, action, args)
    local u, t, requirement = s.ui, s.ui.trace, selectedRequirement(s)
    if not u or not t or not requirement then return end
    if t.busy or t.pending then traceError(s, "当前操作尚未完成"); cx:render(); return end
    t.error = nil
    Results.applyPlan(u.paths, requirement, u.token, action, args, t.plan.revision, function(saved, reason, freshCx)
        local ctx = freshCx or cx
        if not alive(ctx) then return end
        if saved then
            t.plan = saved
            if action == "add" then
                t.fields.newStep.text, t.fields.newStep.cursor, t.fields.newStep.anchor = "", 0, nil
            end
            t.notice = action == "generate" and "已从验收条件生成稳定步骤。" or "计划已更新。"
        else t.error = "计划未能保存：" .. storageMessage(reason or "请核对 plan.json") end
        saveUi(s)
        ctx:render()
    end)
end
local function setTraceStepStatus(s, cx, index, status)
    local t = s.ui.trace
    local step = t.plan and t.plan.steps[tonumber(index)]
    if not step or step.status == status then return end
    if status == "blocked" and not trim(t.fields.blockReason.text):match("%S") then
        traceError(s, "把步骤设为阻塞时必须在“阻塞说明”中填写原因")
        cx:render()
        return
    end
    applyTracePlan(s, cx, "status", {stepId = step.id, status = status, reason = trim(t.fields.blockReason.text)})
end
local function traceAction(s, act, cx)
    local u, t = s.ui, s.ui and s.ui.trace
    if not t then return end
    if act == "results-refresh-changes" then
        local baseline = t.results and t.results.baseline
        issueTraceCommand(s, cx, "changes", {since = baseline and baseline.head or ""}, "refresh")
    elseif act == "results-preview-verification" then
        local command = trim(t.fields.verifyCommand.text)
        if command == "" then traceError(s, "请填写要执行的验证命令"); cx:render(); return end
        if #command > 4000 or not utf8.len(command) or command:find("[%z\1-\8\11\12\14-\31\127]") then
            traceError(s, "验证命令必须是有效 UTF-8，且不超过 4000 字节"); cx:render(); return
        end
        local criteria, failure = parseCriteria(t.fields.verifyCriteria.text, selectedRequirement(s))
        if not criteria then traceError(s, failure); cx:render(); return end
        if not t.results then traceError(s, "结果记录尚未读取"); cx:render(); return end
        t.runPreview = {command = command, criteriaText = t.fields.verifyCriteria.text, criterionIds = criteria}
        t.notice = "已生成验证预览；只有点击“确认并运行验证”才会执行。"
        saveUi(s); cx:render()
    elseif type(act) == "string" and act:match("^results%-use%-candidate=") then
        local index = tonumber(act:match("=([%d]+)$"))
        local item = index and t.candidates and t.candidates[index]
        if not item or not candidateText(item.command) then
            traceError(s, "命令候选已变化；请刷新后重试"); cx:render(); return
        end
        t.fields.verifyCommand.text, t.fields.verifyCommand.cursor, t.fields.verifyCommand.anchor = item.command, utf8.len(item.command), nil
        t.runPreview = nil
        t.notice = "已填入命令候选；这只是草稿，仍需预览并确认。"
        saveUi(s); cx:render()
    elseif act == "results-run-verification" then
        local command = trim(t.fields.verifyCommand.text)
        if command == "" then traceError(s, "请填写要执行的验证命令"); cx:render(); return end
        if #command > 4000 or not utf8.len(command) or command:find("[%z\1-\8\11\12\14-\31\127]") then
            traceError(s, "验证命令必须是有效 UTF-8，且不超过 4000 字节"); cx:render(); return
        end
        local criteria, failure = parseCriteria(t.fields.verifyCriteria.text, selectedRequirement(s))
        if not criteria then traceError(s, failure); cx:render(); return end
        if not t.results then traceError(s, "结果记录尚未读取"); cx:render(); return end
        if not t.runPreview then traceError(s, "请先预览确切的命令、目录、超时与条件，再确认运行"); cx:render(); return end
        if t.runPreview.command ~= command or t.runPreview.criteriaText ~= t.fields.verifyCriteria.text then
            traceError(s, "命令或条件在预览后已变化；请重新预览后再运行"); cx:render(); return
        end
        t.runPreview = nil
        beginTraceVerification(s, cx, command, criteria)
    elseif act == "results-batch-add" then
        local command = trim(t.fields.verifyCommand.text)
        local preview = t.runPreview
        if not preview or preview.command ~= command or preview.criteriaText ~= t.fields.verifyCriteria.text then
            traceError(s, "加入批量前先生成匹配当前命令与条件的预览"); cx:render(); return
        end
        if t.batch and t.batch.state == "running" then
            traceError(s, "批量正在运行；不能修改队列"); cx:render(); return
        end
        t.batchEntries = t.batchEntries or {}
        local entry, failure = Batch.add(t.batchEntries, command, preview.criterionIds, live.epoch())
        if not entry then
            traceError(s, failure == "batch_limit" and "批量最多 5 条" or "命令无效，无法加入批量"); cx:render(); return
        end
        t.notice = "已加入批量队列（第 " .. tostring(#t.batchEntries) .. " 条）；尚未运行。"
        saveUi(s); cx:render()
    elseif type(act) == "string" and act:match("^results%-batch%-remove=") then
        if t.batch and t.batch.state == "running" then
            traceError(s, "批量正在运行；不能修改队列"); cx:render(); return
        end
        local index = tonumber(act:match("=([%d]+)$"))
        if Batch.remove(t.batchEntries or {}, index) then
            t.notice = "已从批量队列移除第 " .. tostring(index) .. " 条。"
        else
            traceError(s, "找不到要移除的队列条目"); 
        end
        saveUi(s); cx:render()
    elseif act == "results-batch-start" then
        if t.batch and t.batch.state == "running" then
            traceError(s, "已有批量在运行；不会并行或重复启动"); cx:render(); return
        end
        local frozen, failure = Batch.freeze(t.batchEntries or {}, live.epoch())
        if not frozen then
            traceError(s, failure == "empty_batch" and "批量队列为空" or "批量队列无效"); cx:render(); return
        end
        if not u.writable or not t.safe or t.pending then
            traceError(s, "需要项目编辑权限且没有待核对来源请求"); cx:render(); return
        end
        t.batch = frozen
        local entry = Batch.current(frozen)
        t.notice = "批量开始：共 " .. tostring(#frozen.entries) .. " 条；首个非通过或代码变化即停止，不自动重试。"
        saveUi(s); cx:render()
        beginTraceVerification(s, cx, entry.command, entry.criterionIds)
    elseif act == "results-batch-stop" then
        if not t.batch or t.batch.state ~= "running" then
            traceError(s, "没有正在运行的批量"); cx:render(); return
        end
        Batch.requestStop(t.batch)
        t.notice = "已请求停止调度：当前命令可能仍在运行，其真实结果会保留；剩余命令不会执行。"
        saveUi(s); cx:render()
    elseif act == "results-plan-add" then
        applyTracePlan(s, cx, "add", {title = trim(t.fields.newStep.text)})
    elseif act == "results-plan-generate" then
        applyTracePlan(s, cx, "generate", {})
    end
end
local function resourcesAction(s, act, cx)
    local u, h = s.ui, s.ui and s.ui.handoff
    local requirement = selectedRequirement(s)
    if not u or not h or not requirement then return end
    if not u.writable or not u.token then
        handoffError(h, "需要项目编辑权限才能修改资源绑定"); cx:render(); return
    end
    if not h.safe then handoffError(h, "当前记录只读；不能修改资源绑定"); cx:render(); return end
    local state = u.resources or {}
    if not state.safe then handoffError(h, "资源绑定记录不可用；先核对 resources.json"); cx:render(); return end
    local expected = state.data and state.data.revision or 0
    local function done(nextData, _, problem)
        if nextData then
            refreshResources(s)
            h.fields.resourcePath.text, h.fields.resourcePath.cursor, h.fields.resourcePath.anchor = "", 0, nil
            invalidatePreview(h)
            h.error, h.notice = nil, "资源绑定已更新；现有预览已失效，需要重新生成。"
        else
            handoffError(h, "资源绑定未能保存：" .. storageMessage(problem or "请核对 resources.json"))
        end
        saveUi(s)
        cx:render()
    end
    if act == "resources-add" then
        local path, failure = Resources.cleanPath(trim(h.fields.resourcePath.text))
        if not path then
            handoffError(h, failure == "invalid_path" and "资源路径必须是项目内相对路径" or "资源路径无效")
            cx:render(); return
        end
        Resources.apply(u.paths, requirement, u.token, "add",
            {path = path, kind = h.resourceKind or "context"}, expected, done)
    elseif type(act) == "string" and act:match("^resources%-remove=") then
        local id = act:match("=([%w_%-]+)$")
        if not id then handoffError(h, "资源标识无效"); cx:render(); return end
        Resources.apply(u.paths, requirement, u.token, "remove", {id = id}, expected, done)
    end
end
local function handoffAction(s, act, cx)
    local u, h, requirement = s.ui, s.ui.handoff, selectedRequirement(s)
    if act == "handoff-end-wait" then endHandoffWait(s,cx)
    elseif act == "handoff-preview" then startPreview(s, cx)
    elseif act == "handoff-baseline" then inspect(s, cx, "baseline", {})
    elseif act == "handoff-candidate" then inspect(s, cx, "candidate", {})
    elseif act == "handoff-import-file" then
        local path = h.fields.importPath.text:gsub("^%s+", ""):gsub("%s+$", "")
        local paths, failure = cleanRelativePaths(path)
        if not paths or #paths ~= 1 then handoffError(h, failure or "请输入恰好一个项目相对文件路径"); cx:render()
        else inspect(s, cx, "file", {path = paths[1]}) end
    elseif act == "handoff-import-file-content" then
        local file = h.importedFile
        if not h.safe or not u.writable or h.pending or h.pendingSend or not file
            or type(file.body) ~= "string" or #file.body > 16384 or not utf8.len(file.body) then
            handoffError(h, "项目文件不可导入；请核对记录、来源回执与文件内容"); cx:render()
        elseif (h.fields.proposal.text or ""):match("%S") then
            handoffError(h, "方案草稿已有内容；请先保存或清空草稿，再明确导入，现有内容已保留"); cx:render()
        else
            h.fields.proposal.text, h.fields.proposal.cursor, h.fields.proposal.anchor = file.body, utf8.len(file.body), nil
            h.proposalSource, h.importedFile = {kind = "file", path = file.path}, nil
            h.tab, h.error = "design", nil
            saveHandoffAndRender(s, cx)
        end
    elseif act == "handoff-import-candidate" then
        local candidate = h.candidate
        if not h.safe or not u.writable or h.pending or h.pendingSend or not candidate
            or type(candidate.body) ~= "string" or #candidate.body > 16384 or not utf8.len(candidate.body) then
            handoffError(h, "回复候选不可导入；请核对记录、来源回执与内容上限"); cx:render()
        elseif (h.fields.proposal.text or ""):match("%S") then
            handoffError(h, "方案草稿已有内容；请先保存或清空草稿，再明确导入，现有内容已保留"); cx:render()
        else
            h.fields.proposal.text, h.fields.proposal.cursor, h.fields.proposal.anchor = candidate.body, utf8.len(candidate.body), nil
            h.proposalSource = {kind = "assistant", entryId = candidate.entryId, sessionId = candidate.sessionId}
            h.tab, h.error = "design", nil
            saveHandoffAndRender(s, cx)
        end
    elseif act == "handoff-adopt" then adoptProposal(s, cx)
    elseif act == "handoff-prefill" then sendPreview(s, cx, true)
    elseif act == "handoff-send" then sendPreview(s, cx, false)
    elseif act == "handoff-comment" and h.selectedDesign then
        local text = h.fields.comment.text
        if text:match("%S") then
            applyWorkflow(s, cx, "comment", {designVersion = h.selectedDesign.version, text = text}, function(ok, ctx)
                if ok then h.fields.comment.text, h.fields.comment.cursor = "", 0; saveUi(s); ctx:render() end
            end)
        end
    elseif act == "handoff-approve" and h.selectedDesign then
        if not h.baseline or not h.baselineCheckedAt then handoffError(h, "批准前必须通过来源命令检查当前 Git 基线"); cx:render()
        else applyWorkflow(s, cx, "approve", {designVersion = h.selectedDesign.version, baseline = h.baseline, clicked = true}) end
    elseif act == "handoff-revoke" and h.workflow and h.workflow.approval then
        local reason = h.fields.revokeReason.text
        if not reason:match("%S") then handoffError(h, "请填写撤销理由后再确认"); cx:render()
        else applyWorkflow(s, cx, "revoke", {reason = reason}) end
    elseif act == "handoff-authorize-direct" then
        local reason = h.fields.directReason.text
        if not h.baseline or not h.baselineCheckedAt then handoffError(h, "直接授权前必须通过来源命令检查当前 Git 基线"); cx:render()
        elseif not reason:match("%S") or type(requirement.scope) ~= "string" or not requirement.scope:match("%S")
            then handoffError(h, "直接实施必须明确填写授权理由，并在需求中提供范围"); cx:render()
        else applyWorkflow(s, cx, "authorize_direct", {baseline = h.baseline, reason = reason, clicked = true}) end
    elseif act == "handoff-prepare" then
        h.panel = not h.panel
        refreshHandoff(s)
        saveHandoffAndRender(s, cx)
    elseif act == "open-handoff" then
        u.tab, u.detailMode, h.tab, h.panel = "design", true, "design", true
        refreshHandoff(s)
        saveUi(s)
    end
end
local priorityRank = {urgent = 1, high = 2, normal = 3, low = 4}
local function requirementOrder(u)
    return function(a, b)
        if u.sort == "number" then return a.number < b.number end
        if u.sort == "priority" then
            if priorityRank[a.priority] ~= priorityRank[b.priority] then
                return priorityRank[a.priority] < priorityRank[b.priority]
            end
        end
        return a.updatedAt > b.updatedAt
    end
end
local function refreshProject(s)
    local u = s.ui
    if not u or not u.paths then return end
    u.loading = false
    local project, failure = store.readProject(u.paths)
    if not project then
        if failure == "missing" then
            u.project, u.requirements, u.byId, u.error, u.storageUnsafe = nil, {}, {}, nil, false
        else
            u.project, u.error, u.storageUnsafe = nil, storageMessage(failure), true
        end
        return
    end
    if project.root ~= s.payload.binding.projectRoot then
        u.project, u.requirements, u.byId = nil, {}, {}
        u.error, u.storageUnsafe, u.writable = "项目存储根目录与当前绑定不匹配；未修改任何文件。", true, false
        return
    end
    u.storageUnsafe = false
    u.project, u.error, u.requirements, u.byId = project, nil, {}, {}
    local rows, failures = store.readRequirements(u.paths)
    for _, r in rows do table.insert(u.requirements, r); u.byId[r.requirementId] = r end
    if #failures > 0 then
        u.error, u.storageUnsafe, u.writable = "有 " .. tostring(#failures) .. " 项需求无法安全读取；当前只读，未覆盖任何文件。", true, false
    end
    table.sort(u.requirements, requirementOrder(u))
    if u.selected and not u.byId[u.selected] then u.selected = nil end
    refreshHandoff(s)
    refreshResources(s)
    refreshTrace(s)
    refreshReview(s)
    if u.tab == "history" then refreshAudit(s) end
    refreshScan(s)
end
local function parseFindings(text)
    local findings = tern.json.array()
    for raw in (text .. "\n"):gmatch("(.-)\n") do
        local line = trim(raw)
        if line ~= "" then
            local level, description = line:match("^([%a_]+)%s*|%s*(.+)$")
            if not level or not description then return nil, "发现格式无效：每行必须是“严重度|描述”" end
            level = level:lower()
            if level ~= "blocking" and level ~= "major" and level ~= "minor" and level ~= "note" then
                return nil, "发现严重度无效：" .. level
            end
            if #description > 4000 or not utf8.len(description) then return nil, "发现描述无效或超过 4000 字节" end
            table.insert(findings, {severity=level, description=description})
        end
    end
    if #findings > 50 then return nil, "单次审查最多 50 项发现" end
    return findings, nil
end
local function currentVerificationIds(results, requirement, snapshot, passedOnly)
    local ids = tern.json.array()
    for _, id in Validity.currentVerificationIds(results, requirement, snapshot, passedOnly) do
        table.insert(ids, id)
    end
    return ids
end
local function reviewNotice(s, text)
    s.ui.review.notice = text
end
local function reviewFail(s, cx, text)
    s.ui.review.busy = false
    s.ui.review.error = tostring(text or "操作失败")
    saveUi(s)
    cx:render()
end
local function requireReviewWrite(s, cx)
    if not s.ui or not s.ui.review or not s.ui.review.safe then reviewFail(s, cx, "审查记录不可用；当前只读"); return false end
    if not s.ui.writable then reviewFail(s, cx, "需要项目编辑锁"); return false end
    if s.ui.review.busy then return false end
    return true
end
local function reviewAction(s, act, cx)
    local u, v, requirement = s.ui, s.ui and s.ui.review, selectedRequirement(s)
    if not u or not v or not requirement then return end
    if act == "review-open-native" then prefillLiteral(s, cx, "/review"); return end
    if type(act) == "string" and act:match("^review%-pick=") then
        local picked = act:match("^review%-pick=(.+)$")
        for _, review in v.data and v.data.reviews or {} do
            for _, finding in review.findings or {} do
                if picked == review.id .. "|" .. finding.id then
                    v.finding = picked
                    saveUi(s); cx:render()
                    return
                end
            end
        end
        return
    end
    if act == "review-cancel" then
        v.panel = ""
        saveUi(s); cx:render()
        return
    end
    if type(act) == "string" and act:match("^review%-toggle=") then
        local name = act:match("^review%-toggle=(%w+)$")
        if name == "reject" or name == "reopen" or name == "dispose" then
            v.panel = if v.panel == name then "" else name
            saveUi(s); cx:render()
        end
        return
    end
    if type(act) == "string" and act:match("^review%-inline=") then
        local picked = act:match("^review%-inline=(.+)$")
        for _, review in v.data and v.data.reviews or {} do
            for _, finding in review.findings or {} do
                if picked == review.id .. "|" .. finding.id then
                    v.finding, v.panel = picked, "dispose"
                    saveUi(s); cx:render()
                    return
                end
            end
        end
        return
    end
    if act == "review-add-finding" or (type(act) == "string" and act:match("^review%-remove%-finding=")) then
        if not u.writable or not v.safe or v.busy then reviewFail(s, cx, "只读或记录未就绪；不能修改发现草稿"); return end
        v.error = nil
        if act == "review-add-finding" then
            local description = trim(v.fields.findingDraft.text)
            if description == "" then reviewFail(s, cx, "先填写发现描述"); return end
            if description:find("\n") or description:find("[%z\1-\8\11\12\14-\31\127]")
                or not utf8.len(description) or #description > 4000 then
                reviewFail(s, cx, "发现描述必须是单行有效 UTF-8，且不超过 4000 字节"); return
            end
            local count = 0
            for raw in (v.fields.reviewFindings.text .. "\n"):gmatch("(.-)\n") do
                if trim(raw) ~= "" then count += 1 end
            end
            if count >= 50 then reviewFail(s, cx, "单次审查最多 50 项发现"); return end
            local line = v.draftSeverity .. "|" .. description
            if #v.fields.reviewFindings.text + #line + 1 > reviewLimits.reviewFindings then
                reviewFail(s, cx, "发现草稿超过 8 KiB 上限；未添加"); return
            end
            local prefix = v.fields.reviewFindings.text
            if prefix ~= "" and prefix:sub(-1) ~= "\n" then prefix ..= "\n" end
            v.fields.reviewFindings.text = prefix .. line .. "\n"
            v.fields.reviewFindings.cursor, v.fields.reviewFindings.anchor = utf8.len(v.fields.reviewFindings.text), nil
            v.fields.findingDraft.text, v.fields.findingDraft.cursor, v.fields.findingDraft.anchor = "", 0, nil
        else
            local index = tonumber(act:match("^review%-remove%-finding=(%d+)$"))
            if not index then return end
            local kept, n = {}, 0
            for raw in (v.fields.reviewFindings.text .. "\n"):gmatch("(.-)\n") do
                if trim(raw) ~= "" then
                    n += 1
                    if n ~= index then table.insert(kept, raw) end
                end
            end
            v.fields.reviewFindings.text = if #kept > 0 then table.concat(kept, "\n") .. "\n" else ""
            v.fields.reviewFindings.cursor, v.fields.reviewFindings.anchor = utf8.len(v.fields.reviewFindings.text), nil
        end
        saveUi(s); cx:render()
        return
    end
    if not requireReviewWrite(s, cx) then return end
    v.error, v.notice = nil, nil
    if act == "review-create" then
        local findings, failure = parseFindings(v.fields.reviewFindings.text)
        if not findings then reviewFail(s, cx, failure); return end
        local snapshot = u.trace and u.trace.results and u.trace.results.changes and u.trace.results.changes.fingerprint
        if not snapshot then reviewFail(s, cx, "请先在结果页读取当前代码变化；审查必须绑定代码快照"); return end
        v.busy = true
        saveUi(s); cx:render()
        Review.createReview(u.paths, requirement, u.token, {source=v.source, scope=trim(v.fields.reviewScope.text),
            codeSnapshotSha256=snapshot, findings=findings}, v.data.revision, function(saved, reason, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) then return end
            v.busy = false
            if saved then
                v.data = saved
                local created = saved.reviews[#saved.reviews]
                if created and created.findings[1] then v.finding = created.id .. "|" .. created.findings[1].id end
                v.fields.reviewFindings.text, v.fields.reviewFindings.cursor, v.fields.reviewFindings.anchor = "", 0, nil
                v.notice = "审查已记录并绑定当前代码快照。"
                refreshAudit(s)
            else v.error = "审查未能保存：" .. storageMessage(reason or "请核对 reviews.json") end
            saveUi(s); ctx:render()
        end)
    elseif act == "review-dispose" then
        local reviewId, findingId = v.finding:match("^([^|]+)|([^|]+)$")
        if not reviewId or not findingId then reviewFail(s, cx, "请选择一个发现"); return end
        local reason = trim(v.fields.reviewReason.text)
        if reason == "" then reviewFail(s, cx, "请填写处置理由"); return end
        v.busy = true
        saveUi(s); cx:render()
        Review.disposeFinding(u.paths, requirement, u.token, {reviewId=reviewId, findingId=findingId,
            action=v.action, reason=reason}, v.data.revision, function(saved, problem, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) then return end
            v.busy = false
            if saved then
                v.data = saved
                v.fields.reviewReason.text, v.fields.reviewReason.cursor, v.fields.reviewReason.anchor = "", 0, nil
                v.panel = ""
                v.notice = "发现处置已追加；旧事件保留。"
                refreshAudit(s)
            else v.error = "发现处置未能保存：" .. storageMessage(problem or "请核对 reviews.json") end
            saveUi(s); ctx:render()
        end)
    elseif act == "review-accept" then
        if requirement.stage ~= "implementing" and requirement.stage ~= "verifying" and requirement.stage ~= "awaiting_acceptance" then
            reviewFail(s, cx, "当前阶段不允许接受；请先重新实施或刷新需求"); return
        end
        local gate = Review.acceptanceGate(requirement, u.trace and u.trace.results, v.data)
        if not gate.ok then reviewFail(s, cx, table.concat(gate.problems, "；")); return end
        local reviewIds = tern.json.array()
        for _, review in v.data.reviews do table.insert(reviewIds, review.id) end
        v.busy = true
        saveUi(s); cx:render()
        Review.recordAcceptance(u.paths, requirement, u.token, {decision="accepted", codeSnapshotSha256=gate.snapshot,
            verificationIds=currentVerificationIds(u.trace.results, requirement, gate.snapshot, true),
            reviewIds=reviewIds, comment=trim(v.fields.reviewComment.text)}, v.data.revision, function(saved, problem, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) then return end
            if not saved then reviewFail(s, ctx, "人工接受未能保存：" .. storageMessage(problem or "请核对 reviews.json")); return end
            v.data = saved
            store.advanceStage(u.paths, requirement, "done", requirement.revision, u.token, function(updated, stageReason, stageCx)
                local final = stageCx or ctx
                if not alive(final) then return end
                v.busy = false
                if updated then
                    refreshProject(s)
                    reviewNotice(s, "人工接受已记录；需求完成。审查与验收历史保留。")
                else
                    refreshProject(s)
                    s.ui.review.error = "验收记录已保存，但阶段更新失败：" .. storageMessage(stageReason or "请核对需求记录")
                end
                saveUi(s); final:render()
            end)
        end)
    elseif act == "review-reject" then
        if requirement.stage ~= "implementing" and requirement.stage ~= "verifying" and requirement.stage ~= "awaiting_acceptance" then
            reviewFail(s, cx, "当前阶段不允许驳回；已完成需求请使用重新打开"); return
        end
        local reason = trim(v.fields.reviewReject.text)
        if reason == "" then reviewFail(s, cx, "请填写驳回原因"); return end
        local snapshot = u.trace and u.trace.results and u.trace.results.changes and u.trace.results.changes.fingerprint
        if not snapshot then reviewFail(s, cx, "缺少当前代码快照；无法记录驳回"); return end
        local reviewIds = tern.json.array()
        for _, review in v.data.reviews do table.insert(reviewIds, review.id) end
        v.busy = true
        saveUi(s); cx:render()
        Review.recordAcceptance(u.paths, requirement, u.token, {decision="rejected", codeSnapshotSha256=snapshot,
            verificationIds=currentVerificationIds(u.trace.results, requirement, snapshot, false),
            reviewIds=reviewIds, comment=reason}, v.data.revision, function(saved, problem, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) then return end
            if not saved then reviewFail(s, ctx, "驳回未能保存：" .. storageMessage(problem or "请核对 reviews.json")); return end
            v.data = saved
            local function finishStage(updated, stageReason, stageCx)
                local final = stageCx or ctx
                if not alive(final) then return end
                v.busy = false
                if updated then refreshProject(s); reviewNotice(s, "人工驳回已记录；需求退回实施中。")
                else s.ui.review.error = "驳回已记录，但阶段更新失败：" .. storageMessage(stageReason or "请核对需求记录") end
                saveUi(s); final:render()
            end
            if requirement.stage == "implementing" then finishStage(requirement, nil, ctx)
            else store.advanceStage(u.paths, requirement, "implementing", requirement.revision, u.token, finishStage) end
        end)
    elseif act == "review-reopen" then
        local reason = trim(v.fields.reviewReopen.text)
        if reason == "" then reviewFail(s, cx, "请填写重新打开原因"); return end
        local latest = Review.latestAcceptance(v.data)
        if not latest or latest.decision ~= "accepted" then reviewFail(s, cx, "没有可重新打开的人工接受记录"); return end
        v.busy = true
        saveUi(s); cx:render()
        Review.recordReopen(u.paths, requirement, u.token, {acceptanceId=latest.id, reason=reason}, v.data.revision,
            function(saved, problem, freshCx)
                local ctx = freshCx or cx
                if not alive(ctx) then return end
                if not saved then reviewFail(s, ctx, "重新打开未能保存：" .. storageMessage(problem or "请核对 reviews.json")); return end
                v.data = saved
                store.advanceStage(u.paths, requirement, "clarifying", requirement.revision, u.token, function(updated, stageReason, stageCx)
                    local final = stageCx or ctx
                    if not alive(final) then return end
                    v.busy = false
                    if updated then refreshProject(s); reviewNotice(s, "需求已重新打开；旧验收历史保留。")
                    else s.ui.review.error = "重新打开已记录，但阶段更新失败：" .. storageMessage(stageReason or "请核对需求记录") end
                    saveUi(s); final:render()
                end)
            end)
    else
        reviewFail(s, cx, "未知审查操作")
    end
end
local function auditAction(s, act, cx)
    local u, a, requirement = s.ui, s.ui and s.ui.audit, selectedRequirement(s)
    if not u or not a or not requirement then return end
    if act == "audit-refresh" then
        refreshAudit(s)
        saveUi(s); cx:render()
        return
    end
    if not a.markdown then a.error = "没有可导出的审计内容"; cx:render(); return end
    if act == "audit-copy" then
        local ok, failure = pcall(function() cx:copy(a.markdown) end)
        if ok then a.notice = "Markdown 已复制到剪贴板。" else a.error = "复制失败：" .. tostring(failure) end
    elseif act == "audit-write" then
        local directory = u.paths.store .. "\\exports"
        local file = directory .. "\\" .. requirement.number .. "-audit-" .. tostring(live.epoch()) .. ".md"
        local made, mkdirError = pcall(tern.fs.mkdir, directory)
        if not made then a.error = "导出目录创建失败：" .. tostring(mkdirError); cx:render(); return end
        local wrote, writeError = pcall(tern.fs.write, file, a.markdown)
        if wrote then
            a.exportPath = file
            a.notice = "审计 Markdown 已写入项目导出目录。"
        else a.error = "导出写入失败：" .. tostring(writeError) end
    end
    saveUi(s); cx:render()
end
local function activityAction(s, act, cx)
    local u, a = s.ui, s.ui and s.ui.activity
    if not u or not a then return end
    if act == "activity-refresh" then
        refreshScan(s); saveUi(s); cx:render(); return
    end
    if act ~= "activity-write" then return end
    if not u.writable then a.error = "需要项目编辑锁才能写入导出"; cx:render(); return end
    local events = Audit.filter(a.events or {}, s.ui.review and s.ui.review.fields and s.ui.review.fields.activityQuery and s.ui.review.fields.activityQuery.text or "")
    if #events == 0 then a.error = "没有可导出的事件"; cx:render(); return end
    local lines = {"# 工作台活动导出", "",
        "项目：" .. tostring(u.project and u.project.root or ""),
        "范围：跨需求事件索引；不含验证输出、聊天、认证信息或凭据。", ""}
    for _, event in events do
        table.insert(lines, "- " .. tostring(event.at) .. " · " .. tostring(event.requirement or "")
            .. " · " .. tostring(event.kind) .. " · " .. tostring(event.summary)
            .. (event.ref ~= "" and (" · " .. event.ref) or ""))
    end
    local markdown = table.concat(lines, "\n")
    if #markdown > 131072 then
        a.error = "导出内容超过 128 KiB；未生成不完整的导出。"
        cx:render(); return
    end
    local directory = u.paths.store .. "\\exports"
    local file = directory .. "\\activity-" .. tostring(live.epoch()) .. ".md"
    local made, mkdirError = pcall(tern.fs.mkdir, directory)
    if not made then a.error = "导出目录创建失败：" .. tostring(mkdirError); cx:render(); return end
    local wrote, writeError = pcall(tern.fs.write, file, markdown)
    if wrote then
        a.exportPath = file
        a.notice = "活动事件索引已写入项目导出目录。"
    else a.error = "导出写入失败：" .. tostring(writeError) end
    saveUi(s); cx:render()
end
local function scheduleProjectRefresh(s, cx)
    local u = s.ui
    if not u or not u.paths then return end
    u.loading = true
    tern.timer(30, function()
        if not alive(cx) or s.ui ~= u then return end
        local ok, problem = pcall(refreshProject, s)
        if not ok then
            u.loading, u.storageUnsafe = false, true
            u.error = "读取项目记录失败：" .. tostring(problem)
        end
        cx:render()
    end)
end
local function draftFields(fields)
    local clean = {}
    for name, field in fields or {} do
        if type(field) == "table" and type(field.text) == "string" then
            clean[name] = {text = field.text, cursor = field.cursor, anchor = field.anchor}
        end
    end
    return clean
end
local function loadWorkbench(s, cx)
    local binding = s.payload.binding
    local location = live.path(s.payload.location.marker)
    local paths, failure = store.paths(location, binding.projectRoot)
    local saved = tern.kv.get(projectKey(s))
    -- Old UI persisted flat tabs. Map them to the object-centered shell; unknown
    -- values fall back to the requirements dataset instead of an unreachable page.
    local savedTab = type(saved) == "table" and saved.tab or nil
    local tabAliases = {board = "requirements", handoff = "design", results = "delivery",
        review = "acceptance", audit = "history", runtime = "session", diagnostics = "session"}
    local tab = tabAliases[savedTab] or savedTab
    local detailMode = type(saved) == "table" and saved.detailMode == true or false
    if savedTab == "requirements" and detailMode then tab = "requirement" end
    if savedTab == "handoff" then detailMode = true end
    if savedTab == "results" or savedTab == "review" or savedTab == "audit" then detailMode = true end
    if savedTab == "runtime" or savedTab == "diagnostics" then detailMode = false end
    if not (context.destination[tab] or context.workspaceTab[tab]) then tab, detailMode = "requirements", false end
    if context.workspaceTab[tab] then detailMode = true end
    local layout = "list"
    if type(saved) == "table" and saved.layout == "board" then layout = "board"
    elseif savedTab == "board" then layout = "board" end
    local u = {paths = paths, requirements = {}, byId = {}, tab = tab,
        selected = type(saved) == "table" and saved.selected or nil,
        sort = type(saved) == "table" and saved.sort or "recent",
        priorityFilter = type(saved) == "table" and saved.priorityFilter or "all",
        stageFilter = type(saved) == "table" and saved.stageFilter or "all",
        query = type(saved) == "table" and saved.query or "",
        queryCursor = type(saved) == "table" and saved.queryCursor or nil,
        privacyMode = type(saved) == "table" and saved.privacyMode or "local",
        layout = layout,
        detailMode = detailMode,
        drafts = type(saved) == "table" and saved.drafts or {}, fields = {}, type = "feature",
        priority = "normal", writable = false, busy = false, token = s.token,
        formMode = type(saved) == "table" and saved.formMode == true or false,
        mode = type(saved) == "table" and saved.mode or nil,
        editing = type(saved) == "table" and saved.editing or nil,
        draftKey = type(saved) == "table" and saved.draftKey or nil,
        handoff = makeHandoff(type(saved) == "table" and saved.handoff or nil),
        trace = makeTrace(type(saved) == "table" and saved.trace or nil),
        review = makeReview(type(saved) == "table" and saved.review or nil),
        audit = makeAudit(type(saved) == "table" and saved.audit or nil),
        activity = makeActivity(type(saved) == "table" and saved.activity or nil),
        resources = {safe = true}}
    s.ui = u
    -- Snapshots from before per-requirement drafts kept one unnamed draft; adopt
    -- it for the requirement that was selected when it was saved.
    if u.handoff and not u.handoff.draftRequirement and u.selected and u.byId[u.selected] then
        u.handoff.draftRequirement = u.selected
    end
    for key, draft in u.drafts do
        if type(draft) == "table" then
            u.drafts[key] = {fields = draftFields(draft.fields), type = draft.type,
                priority = draft.priority, baseRevision = draft.baseRevision, createId = draft.createId}
        else u.drafts[key] = nil end
    end
    if u.formMode and u.draftKey then
        local draft = u.drafts[u.draftKey]
        if type(draft) == "table" then
            u.fields, u.type, u.priority = draftFields(draft.fields), draft.type or "feature", draft.priority or "normal"
            u.baseRevision, u.createId, u.dirty = draft.baseRevision, draft.createId, true
        else u.formMode = false end
    end
    if not paths then u.error, u.storageUnsafe = "无法定位本机 WSL 项目存储：" .. tostring(failure), true; return end
    u.queryCursor = u.queryCursor or utf8.len(u.query)
    local ok, problem = pcall(refreshProject, s)
    if not ok then
        u.loading, u.storageUnsafe = false, true
        u.error = "读取项目记录失败：" .. tostring(problem)
    end
end
local function formFields(record)
    local criteria = {}
    for _, item in record and record.acceptanceCriteria or {} do table.insert(criteria, item.description) end
    local values = {title = record and record.title or "", goal = record and record.goal or "",
        scope = record and record.scope or "", criteria = table.concat(criteria, "\n"),
        labels = record and table.concat(record.labels or {}, ", ") or ""}
    local fields = {}
    for name, value in values do fields[name] = {text = value, cursor = utf8.len(value), anchor = nil} end
    return fields
end
local function openForm(s, mode, record)
    local u = s.ui
    u.mode, u.formMode, u.editing = mode, true, record and record.requirementId or nil
    u.draftKey = record and record.requirementId or "new"
    local saved = u.drafts[u.draftKey]
    u.fields = type(saved) == "table" and draftFields(saved.fields) or formFields(record)
    u.type = type(saved) == "table" and saved.type or (record and record.type or "feature")
    u.priority = type(saved) == "table" and saved.priority or (record and record.priority or "normal")
    u.baseRevision = type(saved) == "table" and saved.baseRevision or (record and record.revision or nil)
    u.conflict = false
    u.createId = mode == "new" and (type(saved) == "table" and saved.createId or store.newId("req", live.epoch())) or nil
    u.dirty, u.formError, u.saving = type(saved) == "table" and saved.dirty or false, nil, false
    u.drafts[u.draftKey] = {fields = draftFields(u.fields), type = u.type, priority = u.priority,
        baseRevision = u.baseRevision, createId = u.createId}
    saveUi(s)
end
local function persistForm(s)
    local u = s.ui
    local fields = {}
    for name, field in u.fields do fields[name] = {text = field.text, cursor = field.cursor, anchor = field.anchor} end
    u.drafts[u.draftKey] = {fields = fields, type = u.type, priority = u.priority,
        baseRevision = u.baseRevision, createId = u.createId}
    saveUi(s)
end
local function setWritable(s, writable)
    s.ui.writable = writable
    if writable then s.ui.lockRenewAt = live.epoch() + 5000 end
end
local function finishInit(s, cx, u, takeover)
    local binding = s.payload.binding
    local token = u.token or s.token or store.newId("wb", live.epoch())
    u.token, s.token = token, token
    cx:save()
    store.init(u.paths, {token = token, owner = {window = s.payload.window, panel = s.panel},
        projectId = u.project and u.project.projectId or store.newId("project", live.epoch()), root = binding.projectRoot,
        name = binding.projectRoot:match("[^/]+$") or "项目", now = live.epoch(), takeover = takeover == true},
        function(project, failure, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) or s.ui ~= u then return end
            u.busy = false
            if project then
                u.project, u.error, u.takeoverAvailable = project, nil, false
                setWritable(s, true)
                refreshProject(s)
                ctx:toast("success", "项目已准备", "需求只会在你明确保存后写入")
            else
                setWritable(s, false)
                local code = type(failure) == "table" and failure.code or failure
                u.error = storageMessage(failure or code or "初始化失败")
                if code == "takeover_required" then
                    u.takeoverAvailable = true
                    u.notice = nil
                elseif code == "locked" then
                    u.takeoverAvailable = false
                    u.notice = nil
                end
                if code == "corrupt_project" or code == "project_root_mismatch" then u.storageUnsafe = true end
            end
            ctx:render()
        end)
end
local function initProject(s, cx, takeover, applyPrivacy)
    local u = s.ui
    if u.busy then return end
    if not u.paths then u.error = "项目存储路径无效"; return end
    u.busy, u.notice = true, nil
    if applyPrivacy and not u.project then
        privacy.apply(s.payload.location, s.payload.binding.projectRoot, u.privacyMode or "local", function(ok, failure, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) or s.ui ~= u then return end
            if not ok then
                u.busy = false
                u.error = tostring(failure or "无法应用所选的本地隐私设置；尚未创建需求存储")
                ctx:render()
                return
            end
            finishInit(s, ctx, u, false)
        end)
    else finishInit(s, cx, u, takeover) end
end
local function formValue(s, name)
    return s.ui.fields[name] and s.ui.fields[name].text or ""
end
local function splitLines(text)
    local values = {}
    for line in (text .. "\n"):gmatch("(.-)\n") do
        line = line:gsub("^%s+", ""):gsub("%s+$", "")
        if line ~= "" then table.insert(values, line) end
    end
    return values
end
local function splitLabels(text)
    local values, seen = {}, {}
    for label in (text .. ","):gmatch("(.-),") do
        label = label:gsub("^%s+", ""):gsub("%s+$", "")
        if label ~= "" and not seen[label] then seen[label] = true; table.insert(values, label) end
    end
    return values
end
local function saveRequirement(s, cx)
    local u = s.ui
    if u.saving or not u.writable then return end
    if u.handoff and u.handoff.pendingSend then
        u.formError = "业务发送回执尚待核对；当前不可修改需求"
        cx:render()
        return
    end
    local fields = {title = formValue(s, "title"), goal = formValue(s, "goal"), scope = formValue(s, "scope"),
        criteria = splitLines(formValue(s, "criteria")), labels = splitLabels(formValue(s, "labels")),
        type = u.type, priority = u.priority, now = live.epoch()}
    if fields.title:match("%S") == nil or fields.goal:match("%S") == nil then
        u.formError = "标题和目标为必填项"
        cx:render()
        return
    end
    u.saving, u.formError, u.dirty = true, nil, true
    persistForm(s)
    if u.mode == "new" then
        fields.id = u.createId
        store.create(u.paths, u.project, fields, u.token, function(requirement, updatedProject, failure, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) or s.ui ~= u then return end
            u.saving = false
            if failure or not requirement then
                u.formError = storageMessage(failure or "创建失败")
            else
                u.project = updatedProject or u.project
                u.drafts[u.draftKey] = nil
                u.formMode, u.dirty, u.formError = false, false, nil
                refreshProject(s)
                u.selected, u.detailMode = requirement.requirementId, true
                ctx:toast("success", "需求已创建", requirement.number or "")
                saveUi(s)
            end
            ctx:render()
        end)
    else
        local original = u.byId[u.editing]
        if not original then
            u.saving, u.formError = false, "此需求已从磁盘移除；草稿仍已保留。请刷新后重新检查。"
            cx:render()
            return
        end
        local next = table.clone(original)
        next.title, next.goal, next.scope = fields.title, fields.goal, fields.scope
        next.type, next.priority, next.updatedAt = fields.type, fields.priority, fields.now
        next.labels, next.acceptanceCriteria = fields.labels, {}
        for i, value in fields.criteria do table.insert(next.acceptanceCriteria, {id = "C" .. i, description = value, required = true}) end
        store.update(u.paths, next, u.baseRevision or original.revision, u.token, function(updated, failure, freshCx)
            local ctx = freshCx or cx
            if not alive(ctx) or s.ui ~= u then return end
            u.saving = false
            if failure or not updated then
                local code = type(failure) == "table" and failure.code or failure
                u.conflict = code == "revision_conflict"
                u.formError = storageMessage(failure or "保存失败；草稿已保留")
                if u.conflict then refreshProject(s) end
                persistForm(s)
            else
                u.drafts[u.draftKey] = nil
                u.formMode, u.dirty, u.formError, u.conflict = false, false, nil, false
                refreshProject(s)
                u.selected, u.detailMode = updated.requirementId, true
                ctx:toast("success", "需求已保存", updated.number or "")
                saveUi(s)
            end
            ctx:render()
        end)
    end
    cx:render()
end
local function fieldName(id)
    local form = id:match("%.f%-([%w]+)$") or id:match("%.h%-([%w]+)$")
    if form then return form end
    if id:match("%.materials$") then return "materials" end
    if id:match("%.search$") then return "search" end
    local last = id:match("%.([%w]+)$")
    if last and (traceLimits[last] or reviewLimits[last]) then return last end
    return nil
end
local function isHandoffField(s, name)
    return s.ui.handoff.fields[name] ~= nil
end
local function isTraceField(s, name)
    return s.ui.trace and s.ui.trace.fields[name] ~= nil
end
local function isReviewField(s, name)
    return s.ui.review and s.ui.review.fields[name] ~= nil
end
local function traceEditorLocked(s)
    local t = s.ui.trace
    return not s.ui.writable or not t or not t.safe or t.busy
end
local reviewReadOnlyFields = {auditQuery = true, activityQuery = true}
local function reviewEditorLocked(s, name)
    -- Audit and activity search only filter already-loaded events; they must stay
    -- usable in read-only projects and while review records are unavailable.
    if name and reviewReadOnlyFields[name] then return false end
    local v = s.ui.review
    return not s.ui.writable or not v or not v.safe or v.busy
end
local function handoffEditorLocked(s, name)
    local h = s.ui.handoff
    return not s.ui.writable or not h.safe or h.workflowBusy or (name~="ackReason" and h.pendingSend ~= nil)
end
local function bufferFor(s, name)
    if name == "materials" then return s end
    if isTraceField(s, name) then return s.ui.trace.fields[name] end
    if isReviewField(s, name) then return s.ui.review.fields[name] end
    if name == "search" then
        local u = s.ui
        u.searchBuffer = u.searchBuffer or {text = u.query or "", cursor = u.queryCursor or utf8.len(u.query or ""), history = {}}
        return u.searchBuffer
    end
    if isHandoffField(s, name) then return s.ui.handoff.fields[name] end
    return s.ui.fields[name]
end
local function persistBuffer(s, name)
    if name == "materials" then persist(s)
    elseif isTraceField(s, name) then saveUi(s)
    elseif isReviewField(s, name) then saveUi(s)
    elseif name == "search" then
        s.ui.query, s.ui.queryCursor = s.ui.searchBuffer.text, s.ui.searchBuffer.cursor
        saveUi(s)
    elseif isHandoffField(s, name) then saveUi(s)
    elseif s.ui.formMode then
        s.ui.dirty = true
        persistForm(s)
    end
end
local function replaceBuffer(buffer, first, last, text, bound)
    text = text:gsub("\r\n", "\n"):gsub("\r", "\n")
    if not utf8.len(text) or text:find("[%z\1-\8\11\12\14-\31\127]") then return false, "请输入有效文本，不含控制字符" end
    local changed = buffer.text:sub(1, byte(buffer.text, first) - 1) .. text .. buffer.text:sub(byte(buffer.text, last))
    if #changed > (bound or 262144) then return false, "内容超过安全存储上限；不会截短" end
    if changed ~= buffer.text then buffer.history = {{text = buffer.text, cursor = buffer.cursor, anchor = buffer.anchor}} end
    buffer.text, buffer.cursor, buffer.anchor = changed, first + utf8.len(text), nil
    return true
end
local function insertBuffer(s, target, buffer, first, last, text)
    local bound = target == "materials" and live.maxText or handoffLimits[target] or traceLimits[target] or reviewLimits[target]
    local ok, failure = replaceBuffer(buffer, first, last, text, bound)
    if target == "materials" then s.error = if ok then nil else failure
    elseif isHandoffField(s, target) then s.ui.handoff.error = if ok then nil else failure
    elseif isTraceField(s, target) then s.ui.trace.error = if ok then nil else failure
    elseif isReviewField(s, target) then s.ui.review.error = if ok then nil else failure end
    if ok and (target=="paths" or target=="excerpt") then invalidatePreview(s.ui.handoff) end
    return ok
end
-- One handler for popup selects and visible choice chips: both carry the same
-- field name, so the UI can drop a clipping dropdown without changing state code.
local function applyChange(s, cx, name, value)
    local stepIndex = type(name) == "string" and name:match("^status%-(%d+)$")
    if stepIndex then setTraceStepStatus(s, cx, stepIndex, value); return end
    if s.ui.saving and (name == "type" or name == "priority") then return end
    if name == "privacyMode" then s.ui.privacyMode = value; saveUi(s)
    elseif name == "rvSource" then s.ui.review.source = value; saveUi(s)
    elseif name == "rvFinding" then s.ui.review.finding = value; saveUi(s)
    elseif name == "rvAction" then s.ui.review.action = value; saveUi(s)
    elseif name == "draftSeverity" then
        if value == "blocking" or value == "major" or value == "minor" or value == "note" then
            s.ui.review.draftSeverity = value; saveUi(s)
        end
    elseif name == "type" then s.ui.type = value; s.ui.dirty = true; persistForm(s)
    elseif name == "priority" then s.ui.priority = value; s.ui.dirty = true; persistForm(s)
    elseif name == "sort" then
        s.ui.sort = value
        table.sort(s.ui.requirements, requirementOrder(s.ui))
        saveUi(s)
    elseif name == "layout" then
        if value == "list" or value == "board" then s.ui.layout = value; saveUi(s) end
    elseif name == "resourceKind" then
        if value == "context" or value == "verify" then s.ui.handoff.resourceKind = value; saveUi(s) end
    elseif name == "priorityFilter" then s.ui.priorityFilter = value; saveUi(s)
    elseif name == "stageFilter" then s.ui.stageFilter = value; saveUi(s)
    elseif name == "activity" then
        if value == "clarify" or value == "design" or value == "implement" then
            s.ui.handoff.activity = value; invalidatePreview(s.ui.handoff); saveUi(s)
        end
    elseif name == "includeRequirement" then
        s.ui.handoff.includeRequirement = value == "yes"; invalidatePreview(s.ui.handoff); saveUi(s)
    elseif name == "selectedVersion" then
        s.ui.handoff.selectedVersion, s.ui.handoff.compareVersion = tonumber(value), 0
        refreshHandoff(s)
        saveUi(s)
    elseif name == "compareVersion" then
        s.ui.handoff.compareVersion = tonumber(value) or 0
        refreshHandoff(s)
        saveUi(s)
    end
end
local function openPage(s, tab, sub)
    if context.workspaceTab[tab] then
        if not s.ui.selected or not s.ui.byId[s.ui.selected] then tab = "requirements" end
        s.ui.tab, s.ui.detailMode = tab, tab ~= "requirements"
        if tab == "design" then
            if sub == "materials" then
                s.ui.handoff.panel = true
            elseif sub == "design" or sub == "approval" then
                s.ui.handoff.tab, s.ui.handoff.panel = sub, false
            end
            refreshHandoff(s)
        elseif tab == "delivery" then refreshTrace(s)
        elseif tab == "acceptance" then refreshReview(s)
        elseif tab == "history" then refreshReview(s); refreshAudit(s) end
    elseif context.destination[tab] then
        s.ui.tab, s.ui.detailMode = tab, false
        if tab == "activity" then refreshScan(s) end
    else return end
    saveUi(s)
end
tern.block.define("live", {
    font = "sans", features = {"edit", "undo"},
    init = function(cx, args, saved)
        local s = {panel = cx.pane, history = {}, serial = 1, scheduled = false,
            lastOpenAttempt = type(saved) == "table" and saved.lastOpenAttempt or nil,
            token = type(saved) == "table" and saved.token or nil}
        s.cx = cx
        local payload = tern.json.decode(args[1] or "")
        if type(saved) == "table" and type(saved.payload) == "table"
            and saved.payload.binding and payload.binding
            and saved.payload.binding.instanceId == payload.binding.instanceId then payload = saved.payload end
        bind(s, payload)
        local loaded, loadError = pcall(loadWorkbench, s, cx)
        if not loaded then s.initError = tostring(loadError) end
        local function tick()
            if not alive(cx) then return end
            local priorPayload = s.payload
            local priorRoot, priorDistro = priorPayload.binding.projectRoot, priorPayload.location.distro
            local ok, failure = pcall(refresh, s)
            if not ok then s.problem = "桥接读取失败：" .. tostring(failure) end
            if priorPayload ~= s.payload and (priorRoot ~= s.payload.binding.projectRoot
                or priorDistro ~= s.payload.location.distro) then
                local old = s.ui
                if old and old.writable then store.releaseLock(old.paths, old.token) end
                s.token = nil
                loadWorkbench(s, cx)
            end
            local u = s.ui
            if u and u.writable and not u.renewing and live.epoch() >= (u.lockRenewAt or 0) then
                u.renewing = true
                store.renewLock(u.paths, u.token, {window = s.payload.window, panel = s.panel}, live.epoch(),
                    function(renewed, reason, freshCx)
                        local ctx = freshCx or cx
                        if not alive(ctx) or s.ui ~= u then return end
                        u.renewing = false
                        if renewed then u.lockRenewAt = live.epoch() + 5000
                        else
                            setWritable(s, false)
                            u.notice = nil
                            u.error = storageMessage(reason or "续租失败")
                        end
                        ctx:render()
                    end)
            end
            acknowledgeOpen(s, cx)
            cx:render()
            tern.timer(500, tick)
        end
        tern.timer(100, tick)
        return s
    end,
    title = function(s) return "工作台 · " .. (s.payload.binding.projectRoot:match("[^/]+$") or "项目") end,
    view = function(s, cx)
        if s.initError then
            return {main = ui.node("col", {key = "workbench", role = "workbench.live", gap = "sm"}, {
                ui.text({ui.span("工作台未能初始化", "title")}),
                ui.text({ui.span(s.initError, "error")}),
            })}
        end
        s.ui.cols = cx.cols
        local view = ui.build(s)
        s.scheduled = true
        return {main = view}
    end,
    key = function(s, key, cx)
        local name, modified = key.name, key.ctrl or key.meta
        local target = s.focusTarget
        local buffer = target and bufferFor(s, target)
        if not buffer then return false end
        if isHandoffField(s, target) and handoffEditorLocked(s, target) then return true end
        if isTraceField(s, target) and traceEditorLocked(s) then return true end
        if isReviewField(s, target) and reviewEditorLocked(s, target) then return true end
        if target ~= "materials" and target ~= "search" and s.ui.saving then return true end
        local length = utf8.len(buffer.text)
        local first, last = math.min(buffer.anchor or buffer.cursor, buffer.cursor), math.max(buffer.anchor or buffer.cursor, buffer.cursor)
        if modified and name:lower() == "z" then
            local old = table.remove(buffer.history or {})
            if old then buffer.text, buffer.cursor, buffer.anchor = old.text, old.cursor, old.anchor end
        elseif modified and name:lower() == "a" then buffer.anchor, buffer.cursor = 0, length
        elseif modified and (name:lower() == "c" or name:lower() == "x") then
            if first == last then return false end
            cx:copy(buffer.text:sub(byte(buffer.text, first), byte(buffer.text, last) - 1))
            if name:lower() == "x" then insertBuffer(s, target, buffer, first, last, "") end
        elseif name == "left" or name == "right" or name == "home" or name == "end" then
            local cursorBefore = buffer.cursor
            if name == "home" then buffer.cursor = 0
            elseif name == "end" then buffer.cursor = length
            elseif not key.shift and first ~= last then buffer.cursor = name == "left" and first or last
            else buffer.cursor = math.clamp(buffer.cursor + (name == "left" and -1 or 1), 0, length) end
            buffer.anchor = key.shift and (buffer.anchor or cursorBefore) or nil
        elseif name == "backspace" or name == "delete" then
            if first == last then
                if name == "backspace" then first = math.max(0, first - 1) else last = math.min(length, last + 1) end
            end
            insertBuffer(s, target, buffer, first, last, "")
        elseif name == "enter" and not modified then
            if target == "title" or target == "labels" or target == "search" then return false end
            if target == "findingDraft" then reviewAction(s, "review-add-finding", cx); return true end
            insertBuffer(s, target, buffer, first, last, "\n")
        elseif key.text and (name == "paste" or not modified) then
            insertBuffer(s, target, buffer, first, last, key.text)
        else return false end
        persistBuffer(s, target)
        focus(cx, s.focusId)
        return true
    end,
    event = function(s, ev, cx)
        if ev.ev == "focus" then
            s.focusId = ev.id
            s.focusTarget = fieldName(ev.id)
            focus(cx, ev.id)
        elseif ev.ev == "edit" then
            local target = fieldName(ev.id)
            if isHandoffField(s, target) and handoffEditorLocked(s, target) then return end
            if isTraceField(s, target) and traceEditorLocked(s) then return end
            if isReviewField(s, target) and reviewEditorLocked(s, target) then return end
            if target ~= "materials" and target ~= "search" and s.ui.saving then return end
            local buffer = target and bufferFor(s, target)
            if buffer and ev.len == units(buffer.text, utf8.len(buffer.text)) then
                local ok = insertBuffer(s, target, buffer, point(buffer.text, ev.from), point(buffer.text, ev.to), ev.text)
                if ok then
                    buffer.cursor = point(buffer.text, ev.cursor)
                    s.focusId, s.focusTarget = ev.id, target
                    if target == "materials" then persist(s)
                    elseif target == "search" then
                        s.ui.query, s.ui.queryCursor = buffer.text, buffer.cursor
                        saveUi(s)
                    elseif isHandoffField(s, target) then saveUi(s)
                    elseif isTraceField(s, target) then saveUi(s)
                    elseif isReviewField(s, target) then saveUi(s)
                    else
                        s.ui.dirty, s.ui.formError = true, nil
                        persistForm(s)
                    end
                end
            end
        elseif ev.ev == "undo" then
            local target = fieldName(ev.id)
            if isHandoffField(s, target) and handoffEditorLocked(s, target) then return end
            if isTraceField(s, target) and traceEditorLocked(s) then return end
            if isReviewField(s, target) and reviewEditorLocked(s, target) then return end
            if target ~= "materials" and target ~= "search" and s.ui.saving then return end
            local buffer = target and bufferFor(s, target)
            local old = buffer and buffer.history and table.remove(buffer.history)
            if old then
                buffer.text, buffer.cursor, buffer.anchor = old.text, old.cursor, old.anchor
                persistBuffer(s, target)
            end
        elseif ev.ev == "select" and ev.id:match("%.handoffTabs$") then
            if ev.item == "design" or ev.item == "approval" then
                s.ui.handoff.tab = ev.item
                saveUi(s)
            end
        elseif ev.ev == "select" and ev.id:match("%.tabs$") then
            local item = tostring(ev.item)
            if context.workspaceTab[item] then
                if not s.ui.selected or not s.ui.byId[s.ui.selected] then
                    s.ui.tab, s.ui.detailMode = "requirements", false
                else
                    s.ui.tab, s.ui.detailMode = item, true
                    if item == "design" then refreshHandoff(s) end
                    if item == "delivery" then refreshTrace(s) end
                    if item == "acceptance" then refreshReview(s) end
                    if item == "history" then refreshReview(s); refreshAudit(s) end
                end
            elseif context.destination[item] then
                s.ui.tab, s.ui.detailMode = item, false
                if item == "activity" then refreshScan(s) end
            end
            saveUi(s)
        elseif ev.ev == "select" and ev.id:match("%.requirements$") then
            local id = tostring(ev.item):match("([^%.]+)$")
            local h = s.ui.handoff
            if (h.pending or h.pendingSend) and id ~= s.ui.selected then
                handoffError(h, "已有请求待核对；先完成同一需求的回执核对，不能切换工作依据")
            elseif s.ui.byId[id] then
                s.ui.selected, s.ui.tab, s.ui.detailMode = id, "requirement", true
                refreshHandoff(s)
                refreshResources(s)
                refreshTrace(s)
                refreshReview(s)
                saveUi(s)
            end
        elseif ev.ev == "select" and type(ev.item) == "string" and ev.item:match("^review%-[%w_-]+|finding%-[%w_-]+$") then
            local v = s.ui.review
            for _, review in v and v.data and v.data.reviews or {} do
                for _, finding in review.findings or {} do
                    if ev.item == review.id .. "|" .. finding.id then
                        v.finding = ev.item
                        saveUi(s)
                    end
                end
            end
        elseif ev.ev == "change" then
            local name = ev.id and ev.id:match("%.([%w%-]+)$")
            local stepName = ev.id and ev.id:match("%.status%-(%d+)$")
            if stepName then applyChange(s, cx, "status-" .. stepName, ev.value)
            elseif name then applyChange(s, cx, name, ev.value) end
        elseif ev.ev == "action" then
            -- Tern splits a custom action name at its first `=` into act/value for
            -- plain nodes (cards, text, table cells), while button nodes keep the
            -- whole name. The workbench vocabulary is the joined form; restore it
            -- only for the actions that use it, so other value-carrying events
            -- (table bars and the like) are not rewritten.
            local act = ev.act
            if type(act) == "string" and not act:find("=", 1, true)
                and (type(ev.value) == "string" or type(ev.value) == "number")
                and (act == "requirement" or act:match("^change:") or act:match("^review%-")) then
                act = act .. "=" .. tostring(ev.value)
            end
            -- Luau `and` truncates to one value; match separately so the value survives.
            local changeName, changeValue
            if type(act) == "string" then changeName, changeValue = act:match("^change:([%w%-_]+)=(.*)$") end
            if changeName then applyChange(s, cx, changeName, changeValue); return end
            local route = type(act) == "string" and act:match("^wb%-open%-([%w%-_]+)$")
            if route then
                local sub = route:match("^design%-(%w+)$")
                if sub and sub ~= "materials" and sub ~= "design" and sub ~= "approval" then sub = nil end
                openPage(s, sub and "design" or route, sub)
                return
            end
            local req = type(act) == "string" and act:match("^requirement=(.+)$")
            if req and s.ui.byId[req] then
                local h = s.ui.handoff
                if (h.pending or h.pendingSend) and req ~= s.ui.selected then
                    handoffError(h, "已有请求待核对；不能切换到另一项需求")
                else
                    s.ui.selected, s.ui.tab, s.ui.detailMode = req, "requirement", true
                    refreshHandoff(s)
                    refreshResources(s)
                    refreshTrace(s)
                    refreshReview(s)
                    saveUi(s)
                end
            elseif act == "open-handoff" or (type(act) == "string" and act:match("^handoff%-")) then handoffAction(s, act, cx)
            elseif type(act) == "string" and act:match("^results%-") then traceAction(s, act, cx)
            elseif type(act) == "string" and act:match("^review%-") then reviewAction(s, act, cx)
            elseif type(act) == "string" and act:match("^audit%-") then auditAction(s, act, cx)
            elseif type(act) == "string" and act:match("^activity%-") then activityAction(s, act, cx)
            elseif type(act) == "string" and act:match("^resources%-") then resourcesAction(s, act, cx)
            elseif act == "prefill" then prefill(s, cx)
            elseif act == "acknowledge-unknown" then
                if s.pending and s.receipt and s.receipt.status == "delivery_unknown"
                    and type(s.pending.expiresAt) == "number" and live.epoch() > s.pending.expiresAt then
                    local acknowledgedAt = live.epoch()
                    tern.kv.set("live:acknowledged:" .. s.payload.binding.instanceId .. ":" .. s.pending.requestId,
                        {schemaVersion = 1, instanceId = s.payload.binding.instanceId, sessionId = s.payload.binding.sessionId,
                            receipt = s.receipt, acknowledgedAt = acknowledgedAt})
                    s.receipt.acknowledgedAt, s.pending, s.error = acknowledgedAt, nil, nil
                end
            elseif act == "rebase" and s.ui.conflict and s.ui.editing and s.ui.byId[s.ui.editing] then
                s.ui.baseRevision = s.ui.byId[s.ui.editing].revision
                s.ui.conflict, s.ui.formError = false, nil
                persistForm(s)
            elseif act == "initialize" then initProject(s, cx, false, true)
            elseif act == "enable-edit" then initProject(s, cx, false, false)
            elseif act == "takeover" and s.ui.takeoverAvailable then initProject(s, cx, true, false)
            elseif act == "takeover-initialize" and s.ui.takeoverAvailable then initProject(s, cx, true, true)
            elseif act == "reload" then s.ui.notice = nil; scheduleProjectRefresh(s, cx); saveUi(s)
            elseif act == "new-requirement" and s.ui.writable then openForm(s, "new")
            elseif act == "edit-requirement" and s.ui.writable and s.ui.selected then openForm(s, "edit", s.ui.byId[s.ui.selected])
            elseif act == "save-requirement" then saveRequirement(s, cx)
            elseif act == "back" then s.ui.formMode = false; s.ui.formError = nil; saveUi(s)
            elseif act == "back-workspace" then s.ui.tab, s.ui.detailMode = "requirements", false; saveUi(s)
            elseif act == "prefill-selected" and s.ui.selected then
                local r = s.ui.byId[s.ui.selected]
                if r then
                    local parts = {r.title, r.goal}
                    if r.scope ~= "" then table.insert(parts, "范围：" .. r.scope) end
                    for _, c in r.acceptanceCriteria do table.insert(parts, "验收：" .. c.description) end
                    local selectedText = table.concat(parts, "\n")
                    if s.pending then
                        s.error = "已有待核对预填请求；不会替换资料草稿或重复投递。请先核对运行状态。"
                        s.ui.tab = "runtime"
                        saveUi(s)
                    elseif s.text:match("%S") then
                        s.error = "资料草稿已有内容；不会覆盖。请先在运行页明确清空草稿，再选用需求资料。"
                        s.ui.tab = "runtime"
                        saveUi(s)
                    elseif #selectedText > live.maxText then
                        s.error = "此需求资料超过 16 KiB；请在运行页选择要预填的内容。现有草稿未改变。"
                    else
                        s.text = selectedText
                        s.cursor, s.anchor, s.error = utf8.len(s.text), nil, nil
                        persist(s)
                        s.ui.tab = "runtime"
                        saveUi(s)
                    end
                end
            end
        end
    end,
    save = function(s)
        persist(s)
        saveUi(s)
        return {payload = s.payload, lastOpenAttempt = s.lastOpenAttempt, token = s.token}
    end,
})
