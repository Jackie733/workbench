--!strict
local ui = tern.ui
local live = require("./lib/live")
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
local function clip(text, bound)
    text = tostring(text or "未知")
    if #text <= bound then return text end
    local n = bound
    while n > 0 and not utf8.len(text:sub(1, n)) do n -= 1 end
    return text:sub(1, n) .. "…（节选）"
end
local function focus(cx) cx:frame({{"focus", "main.materials.text"}}) end
local function draftKey(s) return "live:draft:" .. s.payload.binding.instanceId .. ":" .. s.payload.binding.sessionId end
local function remember(s)
    table.insert(s.history, {text = s.text, cursor = s.cursor, anchor = s.anchor})
    if #s.history > 32 then table.remove(s.history, 1) end
end
local function replace(s, first, last, text, cursor)
    text = text:gsub("\r\n", "\n"):gsub("\r", "\n")
    if not utf8.len(text) or text:find("[%z\1-\8\11\12\14-\31\127]") then s.error = "请输入有效文本，不含控制字符"; return end
    local changed = s.text:sub(1, byte(s.text, first) - 1) .. text .. s.text:sub(byte(s.text, last))
    if #changed > live.maxText then s.error = "资料最多 16 KiB（UTF-8）；不会截短后投递"; return end
    if changed ~= s.text then remember(s) end
    s.text, s.cursor, s.anchor, s.error = changed, cursor or first + utf8.len(text), nil, nil
end
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
                s.problem = "连接已过期；最后更新 " .. tostring(data.updatedAt) .. " ms，禁止预填"
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
local stateNames = {idle = "空闲", working = "工作中", waiting_user = "等待用户", disconnected = "已断开"}
local receiptNames = {pending = "等待回执", prefilled = "已预填（未发送）", rejected = "已拒绝", delivery_unknown = "投递状态待核对"}
local function note(text) return ui.text({ui.span(text, "muted")}) end
tern.block.define("live", {
    font = "sans", features = {"edit", "undo"},
    init = function(cx, args, saved)
        local s = {panel = cx.pane, history = {}, serial = 1, scheduled = false,
            lastOpenAttempt = type(saved) == "table" and saved.lastOpenAttempt or nil}
        local payload = tern.json.decode(args[1] or "")
        if type(saved) == "table" and type(saved.payload) == "table"
            and saved.payload.binding and payload.binding
            and saved.payload.binding.instanceId == payload.binding.instanceId then payload = saved.payload end
        bind(s, payload)
        local function tick()
            if not alive(cx) then return end
            local ok, failure = pcall(refresh, s)
            if not ok then s.problem = "桥接读取失败：" .. tostring(failure) end
            acknowledgeOpen(s, cx)
            cx:render()
            tern.timer(500, tick)
        end
        tern.timer(100, tick)
        return s
    end,
    title = function(s) return "工作台 · " .. (s.payload.binding.projectRoot:match("[^/]+$") or "项目") end,
    view = function(s, cx)
        if not s.scheduled then s.scheduled = true; tern.timer(50, function() if alive(cx) then focus(cx) end end) end
        local data, binding = s.snapshot, s.payload.binding
        local nodes = {
            ui.text({ui.span("实时需求交付工作台", "title")}),
            note(binding.projectRoot),
            ui.kv({{"会话", binding.sessionId}, {"来源", "pane " .. tostring(s.payload.source)},
                {"状态", s.problem and "断开／失效" or (data and stateNames[data.state] or "正在连接")},
                {"模型", data and data.model or "未知（不切换模型）"}}),
        }
        if s.problem then table.insert(nodes, ui.card("连接需要处理", {ui.text(clip(s.problem, 1000))}, {key = "problem", tone = "warning"})) end
        if data then
            local tool = data.currentTool
            table.insert(nodes, note("当前工具：" .. (tool and clip(tool.toolName or tool.name, 160) or "无")))
            if tool and tool.summary then table.insert(nodes, note(clip(tool.summary, 500))) end
        end
        table.insert(nodes, ui.node("field", {key = "materials", label = "资料草稿 · 完整内容将放入左侧 omp 输入框", error = s.error}, {
            ui.node("editor", {key = "text", text = s.text, cursor = units(s.text, s.cursor),
                anchor = s.anchor and units(s.text, s.anchor) or nil, maxLines = 7,
                placeholder = "在这里记录中文需求、约束或验收条件。只有点击下方按钮才会预填；不会自动发送。", aria = "工作台资料草稿"}),
        }))
        table.insert(nodes, ui.button("预填到此会话（不发送）", {key = "prefill", variant = "primary",
            disabled = s.pending ~= nil or s.problem ~= nil or not data or data.state ~= "idle", actions = {click = "prefill"}}))
        table.insert(nodes, note("目标：" .. binding.sessionId .. " · " .. binding.projectRoot .. "\n保留现有 omp 草稿；冲突会拒绝。此处编辑、关闭、重载都不会自动投递。"))
        if s.receipt then
            table.insert(nodes, ui.card(receiptNames[s.receipt.status] or "回执", {
                note(clip(s.receipt.reason, 1000)), note("请求 " .. tostring(s.receipt.requestId)),
            }, {key = "receipt", tone = s.receipt.status == "prefilled" and "success" or "muted"}))
            if s.pending and s.receipt.status == "delivery_unknown" then
                local expired = type(s.pending.expiresAt) == "number" and live.epoch() > s.pending.expiresAt
                table.insert(nodes, note("请先检查左侧 omp 输入框，确认是否已预填。解除只清除待确认锁，保留原回执，不发送或重试资料。请求有效期结束前不能解除。"))
                table.insert(nodes, ui.button("已核对，解除待确认", {key = "acknowledge", variant = "quiet",
                    disabled = not expired, actions = {click = "acknowledge-unknown"}}))
            elseif s.receipt.acknowledgedAt then
                table.insert(nodes, note("你已核对并解除待确认；原回执已保留。没有重发资料。"))
            end
        end
        if data then
            local plan = data.plan
            if type(plan) == "table" then
                local lines = {"已观测计划（不代表需求归属）：" .. tostring(plan.completed or "?") .. "/" .. tostring(plan.total or "?")}
                if type(plan.phases) == "table" then
                    for _, phase in plan.phases do
                        if type(phase) == "table" then
                            table.insert(lines, clip(phase.name, 160))
                            if type(phase.tasks) == "table" then
                                for _, task in phase.tasks do
                                    if type(task) == "table" and #lines < 18 then table.insert(lines, "  " .. tostring(task.status or "未知") .. " · " .. clip(task.content, 300)) end
                                end
                            end
                        end
                        if #lines >= 18 then break end
                    end
                end
                if plan.truncated then table.insert(lines, "桥接计划已截短；完整计划请查看 omp。") end
                table.insert(nodes, ui.node("scroll", {key = "plan", max = {h = "5lines"}}, {ui.text(table.concat(lines, "\n"))}))
            else table.insert(nodes, note("计划：尚无可观测的结构化计划（不猜测进度）")) end
            if type(data.lastDelivery) == "table" then
                table.insert(nodes, note("最后回复：assistant 候选，" .. tostring(data.lastDelivery.textBytes or "?") .. " 字节；未关联需求，不等于交付／验证／验收。"))
            else table.insert(nodes, note("交付：尚无可观测候选")) end
            local events = {}
            for i = math.max(1, #data.recentEvents - 11), #data.recentEvents do
                local ev = data.recentEvents[i]
                if type(ev) == "table" then table.insert(events, "#" .. tostring(ev.sequence or "?") .. " " .. clip(ev.type, 100) .. " · " .. clip(ev.summary, 350)) end
            end
            table.insert(nodes, ui.node("scroll", {key = "events", max = {h = "6lines"}}, {
                ui.text(#events > 0 and table.concat(events, "\n") or "尚无运行事件"),
            }))
            table.insert(nodes, note("快照 #" .. tostring(data.sequence) .. " · 更新 " .. tostring(data.updatedAt) .. " ms · pid " .. tostring(data.pid)))
        end
        return {main = ui.node("col", {role = "workbench.live", gap = "sm"}, nodes)}
    end,
    key = function(s, key, cx)
        local name, modified = key.name, key.ctrl or key.meta
        local length = utf8.len(s.text)
        local first, last = math.min(s.anchor or s.cursor, s.cursor), math.max(s.anchor or s.cursor, s.cursor)
        if modified and name:lower() == "z" then
            local old = table.remove(s.history)
            if old then s.text, s.cursor, s.anchor = old.text, old.cursor, old.anchor end
        elseif modified and name:lower() == "a" then s.anchor, s.cursor = 0, length
        elseif modified and (name:lower() == "c" or name:lower() == "x") then
            if first == last then return false end
            cx:copy(s.text:sub(byte(s.text, first), byte(s.text, last) - 1))
            if name:lower() == "x" then replace(s, first, last, "") end
        elseif name == "left" or name == "right" or name == "home" or name == "end" then
            local pos
            if name == "home" then pos = 0 elseif name == "end" then pos = length
            elseif not key.shift and first ~= last then pos = name == "left" and first or last
            else pos = math.clamp(s.cursor + (name == "left" and -1 or 1), 0, length) end
            s.anchor = key.shift and (s.anchor or s.cursor) or nil
            s.cursor = pos
        elseif name == "backspace" or name == "delete" then
            if first == last then if name == "backspace" then first = math.max(0, first - 1) else last = math.min(length, last + 1) end end
            replace(s, first, last, "")
        elseif name == "enter" and not modified then replace(s, first, last, "\n")
        elseif key.text and (name == "paste" or not modified) then replace(s, first, last, key.text)
        else return false end
        focus(cx)
        return true
    end,
    event = function(s, ev, cx)
        if ev.ev == "edit" and ev.id == "main.materials.text" and ev.len == units(s.text, utf8.len(s.text)) then
            replace(s, point(s.text, ev.from), point(s.text, ev.to), ev.text)
            if not s.error then s.cursor = point(s.text, ev.cursor) end
        elseif ev.ev == "undo" then
            local old = table.remove(s.history)
            if old then s.text, s.cursor, s.anchor = old.text, old.cursor, old.anchor end
        elseif ev.ev == "action" and ev.act == "prefill" then prefill(s, cx)
        elseif ev.ev == "action" and ev.act == "acknowledge-unknown" then
            if s.pending and s.receipt and s.receipt.status == "delivery_unknown"
                and type(s.pending.expiresAt) == "number" and live.epoch() > s.pending.expiresAt then
                local acknowledgedAt = live.epoch()
                tern.kv.set("live:acknowledged:" .. s.payload.binding.instanceId .. ":" .. s.pending.requestId,
                    {schemaVersion = 1, instanceId = s.payload.binding.instanceId, sessionId = s.payload.binding.sessionId,
                        receipt = s.receipt, acknowledgedAt = acknowledgedAt})
                s.receipt.acknowledgedAt, s.pending, s.error = acknowledgedAt, nil, nil
            end
        end
    end,
    save = function(s)
        persist(s)
        return {payload = s.payload, lastOpenAttempt = s.lastOpenAttempt}
    end,
})
