--!strict
local privacy = require("./lib/privacy")
local live = require("./lib/live")
local store = require("./lib/store")
local ui = require("./lib/ui")
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
end
local function prefill(s, cx)
    refresh(s)
    if s.pending then s.error = "已有待核对请求；不会重复投递"; return end
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
local function saveUi(s)
    if not s.ui then return end
    tern.kv.set(projectKey(s), {tab = s.ui.tab, selected = s.ui.selected, sort = s.ui.sort,
        priorityFilter = s.ui.priorityFilter, stageFilter = s.ui.stageFilter, query = s.ui.query,
        queryCursor = s.ui.queryCursor, privacyMode = s.ui.privacyMode,
        detailMode = s.ui.detailMode, drafts = s.ui.drafts, formMode = s.ui.formMode,
        mode = s.ui.mode, editing = s.ui.editing, draftKey = s.ui.draftKey})
end
local function storageMessage(reason)
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
    table.sort(u.requirements, function(a, b)
        if u.sort == "number" then return a.number < b.number end
        if u.sort == "priority" then
            local rank = {urgent = 1, high = 2, normal = 3, low = 4}
            if rank[a.priority] ~= rank[b.priority] then return rank[a.priority] < rank[b.priority] end
        end
        return a.updatedAt > b.updatedAt
    end)
    if u.selected and not u.byId[u.selected] then u.selected = nil end
end
local function scheduleProjectRefresh(s, cx)
    local u = s.ui
    if not u or not u.paths then return end
    u.loading = true
    tern.timer(30, function()
        if not alive(cx) or s.ui ~= u then return end
        refreshProject(s)
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
    local u = {paths = paths, requirements = {}, byId = {}, tab = type(saved) == "table" and saved.tab or "requirements",
        selected = type(saved) == "table" and saved.selected or nil,
        sort = type(saved) == "table" and saved.sort or "recent",
        priorityFilter = type(saved) == "table" and saved.priorityFilter or "all",
        stageFilter = type(saved) == "table" and saved.stageFilter or "all",
        query = type(saved) == "table" and saved.query or "",
        queryCursor = type(saved) == "table" and saved.queryCursor or nil,
        privacyMode = type(saved) == "table" and saved.privacyMode or "local",
        detailMode = type(saved) == "table" and saved.detailMode or false,
        drafts = type(saved) == "table" and saved.drafts or {}, fields = {}, type = "feature",
        priority = "normal", writable = false, busy = false, token = s.token,
        formMode = type(saved) == "table" and saved.formMode == true or false,
        mode = type(saved) == "table" and saved.mode or nil,
        editing = type(saved) == "table" and saved.editing or nil,
        draftKey = type(saved) == "table" and saved.draftKey or nil}
    s.ui = u
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
    scheduleProjectRefresh(s, cx)
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
    return id:match("%.f%-([%w]+)$") or (id:match("%.materials$") and "materials") or (id:match("%.search$") and "search")
end
local function bufferFor(s, name)
    if name == "materials" then return s end
    if name == "search" then
        local u = s.ui
        u.searchBuffer = u.searchBuffer or {text = u.query or "", cursor = u.queryCursor or utf8.len(u.query or ""), history = {}}
        return u.searchBuffer
    end
    return s.ui.fields[name]
end
local function persistBuffer(s, name)
    if name == "materials" then persist(s)
    elseif name == "search" then
        s.ui.query, s.ui.queryCursor = s.ui.searchBuffer.text, s.ui.searchBuffer.cursor
        saveUi(s)
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
    if changed ~= buffer.text then
        buffer.history = buffer.history or {}
        table.insert(buffer.history, {text = buffer.text, cursor = buffer.cursor, anchor = buffer.anchor})
        if #buffer.history > 32 then table.remove(buffer.history, 1) end
    end
    buffer.text, buffer.cursor, buffer.anchor = changed, first + utf8.len(text), nil
    return true
end
local function insertBuffer(s, target, buffer, first, last, text)
    local ok, failure = replaceBuffer(buffer, first, last, text, target == "materials" and live.maxText or nil)
    if target == "materials" then s.error = if ok then nil else failure end
    return ok
end
tern.block.define("live", {
    font = "sans", features = {"edit", "undo"},
    init = function(cx, args, saved)
        local s = {panel = cx.pane, history = {}, serial = 1, scheduled = false,
            lastOpenAttempt = type(saved) == "table" and saved.lastOpenAttempt or nil,
            token = type(saved) == "table" and saved.token or nil}
        local payload = tern.json.decode(args[1] or "")
        if type(saved) == "table" and type(saved.payload) == "table"
            and saved.payload.binding and payload.binding
            and saved.payload.binding.instanceId == payload.binding.instanceId then payload = saved.payload end
        bind(s, payload)
        loadWorkbench(s, cx)
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
                    else
                        s.ui.dirty, s.ui.formError = true, nil
                        persistForm(s)
                    end
                end
            end
        elseif ev.ev == "undo" then
            local target = fieldName(ev.id)
            if target ~= "materials" and target ~= "search" and s.ui.saving then return end
            local buffer = target and bufferFor(s, target)
            local old = buffer and buffer.history and table.remove(buffer.history)
            if old then
                buffer.text, buffer.cursor, buffer.anchor = old.text, old.cursor, old.anchor
                persistBuffer(s, target)
            end
        elseif ev.ev == "select" and ev.id:match("%.tabs$") then
            s.ui.tab, s.ui.detailMode = ev.item, false
            saveUi(s)
        elseif ev.ev == "select" and ev.id:match("%.requirements$") then
            local id = tostring(ev.item):match("([^%.]+)$")
            if s.ui.byId[id] then s.ui.selected, s.ui.detailMode = id, true; saveUi(s) end
        elseif ev.ev == "change" then
            local name = ev.id:match("%.([%w]+)$")
            local value = ev.value
            if s.ui.saving and (name == "type" or name == "priority") then return end
            if name == "privacyMode" then s.ui.privacyMode = value; saveUi(s)
            elseif name == "type" then s.ui.type = value; s.ui.dirty = true; persistForm(s)
            elseif name == "priority" then s.ui.priority = value; s.ui.dirty = true; persistForm(s)
            elseif name == "sort" then s.ui.sort = value; refreshProject(s); saveUi(s)
            elseif name == "priorityFilter" then s.ui.priorityFilter = value; saveUi(s)
            elseif name == "stageFilter" then s.ui.stageFilter = value; saveUi(s) end
        elseif ev.ev == "action" then
            local act = ev.act
            local req = type(act) == "string" and act:match("^requirement=(.+)$")
            if req and s.ui.byId[req] then
                s.ui.selected, s.ui.tab, s.ui.detailMode = req, "requirements", true
                saveUi(s)
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
            elseif act == "reload" then s.ui.notice = nil; scheduleProjectRefresh(s, cx); saveUi(s)
            elseif act == "new-requirement" and s.ui.writable then openForm(s, "new")
            elseif act == "edit-requirement" and s.ui.writable and s.ui.selected then openForm(s, "edit", s.ui.byId[s.ui.selected])
            elseif act == "save-requirement" then saveRequirement(s, cx)
            elseif act == "back" then s.ui.formMode = false; s.ui.formError = nil; saveUi(s)
            elseif act == "back-list" then s.ui.detailMode = false; saveUi(s)
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
