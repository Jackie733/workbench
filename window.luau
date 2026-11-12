--!strict
-- The only default path is an existing omp plus its persistent native block.
local live = require("./lib/live")
local registry, pending = {}, {}
local function key(cx) return "live:window:" .. cx:window_key() end
local function save(cx) tern.kv.set(key(cx), registry) end
local function fail(cx, message) cx:toast("error", "工作台未打开", tostring(message)) end

local function dockMarker(dock, marker)
    local visited = 0
    local function find(node, depth)
        if type(node) ~= "table" or depth > 32 or visited >= 1000 then return false end
        visited += 1
        local props = node.p
        if type(props) == "table" then
            if props.text == marker then return true end
            if type(props.spans) == "table" then
                local spans = {}
                for _, span in props.spans do
                    if type(span) == "table" and type(span.t) == "string" then table.insert(spans, span.t) end
                end
                if table.concat(spans) == marker then return true end
            end
        end
        if type(node.c) == "table" then
            for _, child in node.c do
                if find(child, depth + 1) then return true end
            end
        end
        return false
    end
    return find(dock, 0)
end
local function source(cx, binding, expectedPane)
    local matches = {}
    local panes = if expectedPane then {cx.session:pane(expectedPane)} else cx.session:panes()
    for _, pane in panes do
        -- Title narrows initial discovery only; a bound pane may later be renamed.
        -- Health checks read that exact pane's dock, never unrelated/remote panes.
        if (pane.kind == "terminal" or pane.kind == "agent") and not pane.exited and (expectedPane or pane.title == binding.sourceMarker) then
            local ok, surface = pcall(function() return cx.session:surface(pane.pane, {nodes = 200, max_chars = 10000, depth = 32}) end)
            if ok and type(surface) == "table" and dockMarker(surface.dock, binding.sourceMarker) then table.insert(matches, pane) end
        end
    end
    if #matches ~= 1 then
        return nil, if #matches == 0 then "当前窗口找不到唯一来源标记；请在原 omp 窗口输入 /wb（不会猜测目标）"
            else "来源标记出现在多个窗格；拒绝绑定，请关闭重复来源后 /wb"
    end
    local pane = matches[1]
    if not pane.tab or pane.parked then return nil, "来源 omp 不在可见标签页中；请先恢复来源窗格" end
    if binding.sourcePaneId ~= nil and binding.sourcePaneId ~= pane.pane then return nil, "来源 pane 与打开标记不一致" end
    return pane
end
local function isPanel(cx, entry)
    if type(entry) ~= "table" or type(entry.panel) ~= "number" then return false end
    local pane = cx.session:pane(entry.panel)
    -- Registry pane ids are not reused. Avoid an RPC rendering read on every heartbeat.
    return pane ~= nil and not pane.exited and pane.kind == "plugin"
end
local function setHealth(cx, entry, pane, problem)
    -- Native plugin blocks are not external TSP programs, so window-to-block
    -- signals use the documented shared map instead of session:event.
    tern.kv.set("live:source:" .. cx:window_key() .. ":" .. entry.binding.instanceId, {
        schemaVersion = 1, instanceId = entry.binding.instanceId, sessionId = entry.binding.sessionId,
        sourcePane = pane and pane.pane or nil, panel = entry.panel, window = cx:window_key(),
        valid = pane ~= nil and pane.pane == entry.source, reason = problem, updatedAt = live.epoch(),
    })
end
local function width(cx, entry)
    local pane = cx.session:pane(entry.panel)
    local layout = pane and pane.tab and cx.session:layout(pane.tab)
    local function find(node)
        if not node or not node.split then return nil end
        if node.split == "right" and node[2] and node[2].pane == entry.panel then return 1 - node.ratio end
        return find(node[1]) or find(node[2])
    end
    local ratio = layout and find(layout.root)
    if ratio and ratio >= 0.2 and ratio <= 0.65 then tern.kv.set("live:width:" .. cx:window_key(), ratio) end
end
local function panelSource(cx, panel)
    local payload = tern.kv.get("live:binding:" .. cx:window_key() .. ":" .. panel)
    if type(payload) == "table" and type(payload.source) == "number" then return payload.source end
    for _, entry in registry do
        if entry.panel == panel then return entry.source end
    end
    return nil
end
local tickHandle
local tick
local function rearm(cx)
    if tickHandle then pcall(function() tickHandle.cancel() end) end
    if not cx then return end
    tickHandle = tern.timer(1000, function(fresh) tick(fresh or cx) end)
end
local function open(cx, opened)
    local binding, location = opened.binding, opened.location
    local origin, problem = source(cx, binding)
    if not origin then fail(cx, problem); return end
    local instance = binding.instanceId
    local entry = registry[instance]
    if not entry or not isPanel(cx, entry) then
        local candidates = {}
        for previous, other in registry do
            if previous ~= instance and other.source == origin.pane and isPanel(cx, other) then
                table.insert(candidates, {instance = previous, entry = other})
            end
        end
        if #candidates > 1 then fail(cx, "此来源已有多个工作台；拒绝再开副本，请关闭重复面板"); return end
        if #candidates == 1 then
            entry = candidates[1].entry
            registry[candidates[1].instance], registry[instance] = nil, entry
        end
    end
    if entry and isPanel(cx, entry) and entry.source == origin.pane then
        local panel = cx.session:pane(entry.panel)
        local ok, surface = pcall(function() return cx.session:surface(entry.panel, {nodes = 3, max_chars = 1000}) end)
        -- A failed plugin load can leave a shell of the old block with no
        -- surface. Recreate only this proven source's block, never a live view.
        if panel.block == live.kind and ok and surface == nil then
            cx.layout:close(entry.panel)
            registry[instance], entry = nil, nil
        end
    end
    local payload = {binding = binding, location = location, source = origin.pane, window = cx:window_key()}
    -- Reconcile only panels whose source identity is known. A block kind or
    -- shared tab alone is not permission to adopt or close another panel.
    local livePanels, unclaimed = {}, false
    for _, pane in cx.session:panes() do
        if pane.tab == origin.tab and pane.kind == "plugin" and pane.block == live.kind and not pane.exited then
            local owner = panelSource(cx, pane.pane)
            if owner == origin.pane then table.insert(livePanels, pane.pane)
            elseif not owner then unclaimed = true end
        end
    end
    if #livePanels > 1 then
        fail(cx, "此来源已有多个工作台；请保留一个后重试，不会自动关闭含草稿的面板")
        return
    end
    if #livePanels == 0 and unclaimed and (not entry or not isPanel(cx, entry)) then
        fail(cx, "发现来源未确认的旧工作台；请关闭旧面板后 /wb，不会猜测绑定或新建副本")
        return
    end
    if #livePanels == 1 and (not entry or not isPanel(cx, entry) or entry.panel ~= livePanels[1]) then
        local adopted = livePanels[1]
        for previous, other in registry do
            if previous ~= instance and other.panel == adopted then registry[previous] = nil end
        end
        entry = {panel = adopted, source = origin.pane, binding = binding, location = location}
        registry[instance] = entry
    end
    if entry and isPanel(cx, entry) then
        if entry.source ~= origin.pane then fail(cx, "现有面板属于另一个来源；未重新认领"); return end
        width(cx, entry)
        local panel = cx.session:pane(entry.panel)
        if panel.tab ~= origin.tab or panel.parked or panel.floating then
            local moved = cx.layout:move(entry.panel, origin.pane, "right", {focus = false})
            if not moved then fail(cx, "原面板无法恢复到来源右侧；未创建副本"); return end
        end
        entry.binding, entry.location = binding, location
        tern.kv.set("live:binding:" .. cx:window_key() .. ":" .. entry.panel, payload)
        setHealth(cx, entry, origin)
        save(cx)
        rearm(cx)
        cx.layout:focus(entry.panel)
        return
    end
    -- Replace only this instance's stale registration; legacy KV remains untouched.
    local pane = cx:new_block(live.kind, {tern.json.encode(payload)}, "beside", {target = origin.pane, dir = "right",
        ratio = math.clamp(tonumber(tern.kv.get("live:width:" .. cx:window_key())) or 0.4, 0.2, 0.65), focus = false})
    if not pane then fail(cx, "原生工作台 block 不可用；请检查插件状态"); return end
    entry = {panel = pane, source = origin.pane, binding = binding, location = location}
    registry[instance] = entry
    tern.kv.set("live:binding:" .. cx:window_key() .. ":" .. pane, payload)
    setHealth(cx, entry, origin)
    save(cx)
    rearm(cx)
    cx.layout:focus(pane)
end
local function openPath(path, cx)
    local location = live.path(path)
    if not location then fail(cx, "打开路径不属于工作台私有 WSL 运行目录"); return end
    if pending[location.instanceId] then return end
    pending[location.instanceId] = true
    live.openMarker(path, function(opened, problem, fresh)
        pending[location.instanceId] = nil
        if not fresh then fail(cx, problem or "文件读取未启动"); return end
        if problem then fail(fresh, problem); return end
        local ok, failure = pcall(open, fresh, opened)
        if not ok then fail(fresh, failure) end
    end)
end
tern.route.open(function(req, cx)
    if req.path:sub(-#".omp-workbench.json") ~= ".omp-workbench.json" then return nil end
    -- Claim immediately; never briefly open the marker as an extra file pane.
    openPath(req.path, cx)
    return {handled = true}
end)
tern.command({id = "open", title = "恢复实时工作台（首次请在 omp 输入 /wb）", group = "需求交付工作台", run = function(cx)
    local found = {}
    for _, entry in registry do
        local origin = source(cx, entry.binding, entry.source)
        if origin and origin.pane == entry.source then table.insert(found, entry) end
    end
    if #found ~= 1 then
        cx:toast("info", "请在目标 omp 输入 /wb", "没有唯一已绑定来源；不会按焦点、目录或第一个窗口猜测。")
        return
    end
    openPath(found[1].location.marker, cx)
end})
tick = function(cx)
    if not cx then return end
    rearm(cx)
    local changed = false
    for instance, entry in registry do
        if isPanel(cx, entry) then
            local pane, problem = source(cx, entry.binding, entry.source)
            if pane and pane.pane ~= entry.source then pane, problem = nil, "来源 pane 已改变；请重新 /wb" end
            setHealth(cx, entry, pane, problem)
        else
            registry[instance], changed = nil, true
        end
    end
    if changed then save(cx) end
end
tern.on("pane_closed", function(ev, cx)
    local changed = false
    for instance, entry in registry do
        if entry.panel == ev.pane then
            registry[instance], changed = nil, true
        elseif entry.source == ev.pane and isPanel(cx, entry) then
            setHealth(cx, entry, nil, "来源 omp 已关闭")
        end
    end
    if changed then save(cx) end
end)
tern.timer(100, function(cx)
    if not cx then return end
    local saved = tern.kv.get(key(cx))
    if type(saved) == "table" then
        for instance, entry in saved do
            if live.token(instance) and type(entry) == "table" and type(entry.location) == "table"
                and live.path(entry.location.marker) and type(entry.binding) == "table"
                and live.marker(entry.binding, entry.location) then registry[instance] = entry end
        end
    end
    -- Re-establish source proof only. Reload never opens a pane or sends text.
    tick(cx)
end)
