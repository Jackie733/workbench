--!strict
-- Standalone runner for tests/host-review.luau: lune run tests/run-host.luau
-- Loads the real host.luau with an in-memory tern (fs/kv/json/timer) and drives
-- its event handlers. Requires Lune (fs + serde); the view contract test runs
-- on any Luau via tests/run-views.luau.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local repo = "."

local function node(k, p, c) return {k = k, p = p or {}, c = c} end
local function merge(a, b)
    local out = {}
    for k, v in a or {} do out[k] = v end
    for k, v in b or {} do out[k] = v end
    return out
end
local uiStub = {
    node = node,
    span = function(t, s) return {t = t, s = s} end,
    text = function(spans) return node("text", {spans = spans}) end,
    badge = function(t, tone) return node("badge", {text = t, tone = tone}) end,
    button = function(text, props) return node("button", merge(props, {text = text})) end,
    card = function(head, children, props) return node("card", merge(props, {head = head}), children) end,
    section = function(head, children) return node("section", {head = head}, children) end,
    rule = function(label) return node("rule", {label = label}) end,
    md = function(t) return node("md", {text = t}) end,
    stats = function(items) return node("stats", {items = items}) end,
    kv = function(items) return node("kv", {items = items}) end,
    table = function(cols, rows, opts) return node("table", merge(opts, {cols = cols, rows = rows})) end,
    list = function(items) return node("list", {items = items}) end,
    row = function(children) return node("row", {}, children) end,
    col = function(children) return node("col", {}, children) end,
    lines = function(children) return node("lines", {}, children) end,
    code = function(t, lang) return node("code", {text = t, lang = lang}) end,
    diff = function(t) return node("diff", {text = t}) end,
    meter = function(v, label) return node("meter", {value = v, label = label}) end,
    progress = function(v, label) return node("progress", {value = v, label = label}) end,
    meter_cell = function(v) return {meter = {value = v}} end,
    meter_parts_cell = function(parts) return {meter = {parts = parts}} end,
    tree = function(nodes) return node("tree", {nodes = nodes}) end,
    overflow = function(n) return node("overflow", {hidden = n}) end,
    el = function(tag, props, children) return node("el", merge(props, {tag = tag}), children) end,
}

local function copy(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for k, v in value do out[copy(k)] = copy(v) end
    return out
end
local files, kvStore, timers = {}, {}, {}
local holder = {}
local stub = {
    ui = uiStub,
    json = {encode = function(value) return serde.encode("json", value) end,
        decode = function(text) return serde.decode("json", text) end, array = function() return {} end},
    fs = {
        exists = function(path) return files[path] ~= nil end,
        read = function(path) return assert(files[path], "missing file " .. path) end,
        write = function(path, text) files[path] = text end,
        list = function(dir)
            local names, seen = {}, {}
            local prefix = dir .. "\\"
            for path in files do
                if path:sub(1, #prefix) == prefix then
                    local name = path:sub(#prefix + 1):match("^([^\\]+)")
                    if name and not seen[name] then seen[name] = true; table.insert(names, name) end
                end
            end
            return names
        end,
        mkdir = function() end,
        remove = function(path) files[path] = nil end,
    },
    kv = {
        get = function(key) return copy(kvStore[key]) end,
        set = function(key, value) kvStore[key] = copy(value) end,
    },
    timer = function(delay, fn) table.insert(timers, {delay = delay, fn = fn}); return {cancel = function() end} end,
    now = function() return os.time() * 1000 end,
    block = {define = function(_, def) holder.def = def end},
    pane = {list = function() return {{pane = 1}} end},
    process = {run = function() error("测试不应触发真实进程写入") end},
    base64 = {encode = function(text) return text end},
}
tern = stub

local SHA = string.rep("ab12", 16)
local store = "\\\\wsl.localhost\\Ubuntu\\tmp\\demo-project\\.omp\\workbench"
local function put(path, value) files[path] = serde.encode("json", value) end
put(store .. "\\project.json", {schemaVersion = 1, projectId = "project-1", root = "/tmp/demo-project",
    name = "demo", revision = 1, nextNumber = 2, createdAt = 1700000000000})
put(store .. "\\requirements\\req-1\\requirement.json", {schemaVersion = 1, requirementId = "req-1",
    projectId = "project-1", number = "REQ-0001", revision = 3, title = "登录过期时提供重新登录入口",
    type = "bug", priority = "high", stage = "awaiting_acceptance",
    goal = "会话过期后用户能明确看到入口并重新登录。", scope = "仅登录模块。",
    acceptanceCriteria = {{id = "C1", description = "过期后显示重新登录入口", required = true},
        {id = "C2", description = "重新登录后回到原页面", required = true}},
    labels = {"界面"}, createdAt = 1700000000000, updatedAt = 1700000000000})
local projectUnc = "\\\\wsl.localhost\\Ubuntu\\tmp\\demo-project"
put(projectUnc .. "\\package.json", {scripts = {test = "node test.js", build = "node build.js"}})
files[projectUnc .. "\\Makefile"] = "test:\n\tnode test.js\n\nbuild:\n\tnode build.js\n"
put(store .. "\\requirements\\req-2\\requirement.json", {schemaVersion = 1, requirementId = "req-2",
    projectId = "project-1", number = "REQ-0002", revision = 1, title = "补充会话续期入口",
    type = "feature", priority = "normal", stage = "designing",
    goal = "续期到期前给出提示。", scope = "", acceptanceCriteria = {{id = "C1", description = "提示可见", required = true}},
    labels = {}, createdAt = 1700000001000, updatedAt = 1700000001000})
put(store .. "\\requirements\\req-1\\resources.json", {schemaVersion = 1, projectId = "project-1",
    requirementId = "req-1", revision = 1, resources = {{id = "resource-1", path = "AGENTS.md",
        kind = "context", addedAt = 1}}, updatedAt = 1})
files[projectUnc .. "\\AGENTS.md"] = "# Guidelines\nKeep evidence honest.\n"
put(store .. "\\requirements\\req-3\\requirement.json", {schemaVersion = 1, requirementId = "req-3",
    projectId = "project-1", number = "REQ-0003", revision = 1, title = "资源记录版本不兼容",
    type = "chore", priority = "low", stage = "backlog", goal = "验证未知版本只读。", scope = "",
    acceptanceCriteria = {}, labels = {}, createdAt = 1700000002000, updatedAt = 1700000002000})
put(store .. "\\requirements\\req-3\\resources.json", {schemaVersion = 2, projectId = "project-1",
    requirementId = "req-3", revision = 1, resources = {}, updatedAt = 2})
put(store .. "\\requirements\\req-1\\reviews.json", {schemaVersion = 1, projectId = "project-1",
    requirementId = "req-1", revision = 2,
    reviews = {
        {id = "review-aaa", source = "native_review", scope = "未提交改动", codeSnapshotSha256 = SHA,
            requirementRevision = 3, createdAt = 1700000000000,
            findings = {
                {id = "finding-1", severity = "blocking", description = "过期后没有入口", createdAt = 1700000000000},
                {id = "finding-2", severity = "minor", description = "文案不一致", createdAt = 1700000000000},
            },
            events = {
                {id = "review-event-1", findingId = "finding-2", action = "resolved", reason = "已统一文案", at = 1700000001000},
            }},
        {id = "review-bbb", source = "manual", scope = "登录模块", codeSnapshotSha256 = SHA,
            requirementRevision = 3, createdAt = 1700000002000, findings = {}, events = {}},
    },
    acceptances = {}, reopenings = {}})

local cache = {}
local function loadModule(path)
    if cache[path] then return cache[path] end
    local source = fs.readFile(path)
    local dir = path:match("^(.*)/") or "."
    local chunk = assert(loadstring("local tern, require = ...\n" .. source, "@" .. path))
    local module = chunk(stub, function(dep)
        local target = dep:match("^%./(.+)$") or dep
        return loadModule(dir .. "/" .. target .. ".luau")
    end)
    cache[path] = module
    return module
end
loadModule(repo .. "/host.luau")
assert(holder.def, "host.luau 应注册 live block")

local cx = {pane = 1, cols = 80, rows = 24,
    render = function() end, save = function() end, toast = function() end,
    frame = function() end, copy = function() end}
local payload = {
    binding = {schemaVersion = 1, instanceId = "wb-inst-0001", sessionId = "session-1", openRequestId = "open-1",
        runtimeDir = "/tmp/omp-workbench-1000/wb-inst-0001", sourceMarker = "⚒ demo · wbinst00",
        projectRoot = "/tmp/demo-project", cwd = "/tmp/demo-project"},
    location = {marker = "//wsl.localhost/Ubuntu/tmp/omp-workbench-1000/wb-inst-0001/open.omp-workbench.json",
        host = "wsl.localhost", distro = "Ubuntu"},
    source = 7, window = "win-1",
}

local test = require("./host-review")
local result = test(stub, holder.def, cx, serde.encode("json", payload))
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("host review contract violated") end