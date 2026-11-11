--!strict
local ui = tern.ui

-- State uses code points; TSP editor offsets use UTF-16 code units.
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
local function focus(cx) cx:frame({{"focus", "main.goalField.goal"}}) end
local function remember(s)
    table.insert(s.history, {text = s.text, cursor = s.cursor, anchor = s.anchor})
    if #s.history > 32 then table.remove(s.history, 1) end
end
local function replace(s, first, last, text, cursor)
    text = text:gsub("\r\n", "\n"):gsub("\r", "\n")
    if not utf8.len(text) or text:find("[%z\1-\8\11\12\14-\31\127]") then s.error = "请输入有效文本，不含控制字符"; return end
    local changed = s.text:sub(1, byte(s.text, first) - 1) .. text .. s.text:sub(byte(s.text, last))
    if #changed > 4000 then s.error = "任务最多 4000 字节；请精简后再输入"; return end
    if changed ~= s.text then remember(s) end
    s.text, s.cursor, s.anchor, s.error = changed, cursor or first + utf8.len(text), nil, nil
end
local function finish(s, cancelled)
    if s.submitted then return end
    if not cancelled and not s.text:match("%S") then s.error = "先描述你要完成的任务"; return end
    local ok, err = pcall(tern.kv.set, "form:" .. s.token, if cancelled then {cancelled = true} else {goal = s.text, strategy = s.strategy})
    if not ok then s.error = "任务未保存：" .. tostring(err); return end
    s.submitted = true
end

tern.block.define("task-form", {
    font = "sans", features = {"edit", "undo"},
    init = function(_cx, args, saved)
        local s = {token = args[1] or "", project = args[2] or "", text = args[3] or "",
            strategy = args[4] == "direct" and "direct" or "design", history = {}, scheduled = false}
        if type(saved) == "table" and saved.token == s.token then
            s.text = type(saved.text) == "string" and saved.text or s.text
            s.strategy = saved.strategy == "direct" and "direct" or "design"
            s.cursor, s.anchor = saved.cursor, saved.anchor
        end
        s.cursor = math.clamp(tonumber(s.cursor) or utf8.len(s.text), 0, utf8.len(s.text))
        s.submitted = s.token == "" or tern.kv.get("form:" .. s.token) ~= nil
        return s
    end,
    title = function() return "新建任务" end,
    view = function(s, cx)
        if not s.scheduled then
            s.scheduled = true
            tern.timer(30, function() if not s.submitted then focus(cx) end end)
        end
        local nodes = {
            ui.node("row", {key = "head", justify = "between"}, {
                ui.text({ui.span("描述任务", "title")}),
                ui.button("返回", {key = "cancel", variant = "quiet", actions = {click = "cancel"}}),
            }),
            ui.text({ui.span(s.project, "muted")}),
        }
        if s.submitted then
            table.insert(nodes, ui.node("shimmer", {key = "returning", text = "返回任务…"}))
        else
            table.insert(nodes, ui.node("field", {key = "goalField", label = "要完成什么？", error = s.error}, {
                ui.node("editor", {key = "goal", text = s.text, cursor = units(s.text, s.cursor),
                    anchor = s.anchor and units(s.text, s.anchor) or nil, maxLines = 9,
                    placeholder = "例如：修复登录过期，保留现有刷新流程，并验证并发请求。", aria = "任务描述"}),
            }))
            table.insert(nodes, ui.node("field", {key = "strategyField", label = "工作方式"}, {
                ui.node("tabs", {key = "strategy", variant = "segmented", active = s.strategy,
                    items = {{id = "design", label = "先设计再执行"}, {id = "direct", label = "直接执行"}}}),
            }))
            table.insert(nodes, ui.text({ui.span(if s.strategy == "design" then "先生成方案，经过你批准后才实施。" else "适合边界明确的小修改，跳过方案交接。", "muted")}))
            table.insert(nodes, ui.button("下一步", {key = "submit", variant = "primary", keys = {"ctrl", "enter"}, actions = {click = "submit"}}))
            table.insert(nodes, ui.text({ui.span("Ctrl+Enter", "key"), ui.span(" 下一步 · ", "muted"), ui.span("Esc", "key"), ui.span(" 返回；此处不会发送模型请求。", "muted")}))
        end
        return {main = ui.node("col", {role = "workbench.form", gap = "lg"}, nodes)}
    end,
    key = function(s, key, cx)
        if s.submitted then return false end
        local name, modified = key.name, key.ctrl or key.meta
        local length = utf8.len(s.text)
        local first, last = math.min(s.anchor or s.cursor, s.cursor), math.max(s.anchor or s.cursor, s.cursor)
        if name == "escape" or name == "esc" then finish(s, true)
        elseif name == "enter" and modified then finish(s, false)
        elseif modified and name:lower() == "z" then
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
        elseif name == "enter" then replace(s, first, last, "\n")
        elseif key.text and (name == "paste" or not modified) then replace(s, first, last, key.text)
        else return false end
        if not s.submitted then focus(cx) end
        return true
    end,
    event = function(s, ev, cx)
        if s.submitted then return end
        if ev.ev == "edit" and ev.id == "main.goalField.goal" and ev.len == units(s.text, utf8.len(s.text)) then
            replace(s, point(s.text, ev.from), point(s.text, ev.to), ev.text)
            if not s.error then s.cursor = point(s.text, ev.cursor) end
        elseif ev.ev == "undo" then
            local old = table.remove(s.history)
            if old then s.text, s.cursor, s.anchor = old.text, old.cursor, old.anchor end
        elseif ev.ev == "select" and ev.id == "main.strategyField.strategy" then
            if ev.item == "design" or ev.item == "direct" then s.strategy = ev.item end
        elseif ev.ev == "action" then
            if ev.act == "submit" then finish(s, false) elseif ev.act == "cancel" then finish(s, true) end
        end
        if not s.submitted then focus(cx) end
    end,
    save = function(s) return {token = s.token, text = s.text, strategy = s.strategy, cursor = s.cursor, anchor = s.anchor} end,
})
