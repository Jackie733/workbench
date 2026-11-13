--!strict
-- Standalone runner for tests/views.luau: luau tests/run-views.luau
-- Provides a recording tern.ui stub so the view contract can be checked without
-- the native desktop; inside Tern the same test runs against the real tern.ui.
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
    link = function(t, href, s) return {t = t, href = href, s = s} end,
    path = function(p) return {t = p, s = "path"} end,
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
    code = function(t, lang, start) return node("code", {text = t, lang = lang, start = start}) end,
    diff = function(t, path) return node("diff", {text = t, path = path}) end,
    meter = function(v, label) return node("meter", {value = v, label = label}) end,
    progress = function(v, label) return node("progress", {value = v, label = label}) end,
    meter_cell = function(v, th) return {meter = {value = v, thresholds = th}} end,
    meter_parts_cell = function(parts) return {meter = {parts = parts}} end,
    tree = function(nodes) return node("tree", {nodes = nodes}) end,
    bars = function(series) return node("bars", {series = series}) end,
    spark = function(series) return node("spark", {series = series}) end,
    ansi = function(t) return node("ansi", {text = t}) end,
    diagnostic = function(d) return node("diagnostic", {d = d}) end,
    test_summary = function(p, f, s, took) return node("test_summary", {passed = p, failed = f, skipped = s, took = took}) end,
    overflow = function(n) return node("overflow", {hidden = n}) end,
    el = function(tag, props, children) return node("el", merge(props, {tag = tag}), children) end,
}
local function encode(value)
    local kind = type(value)
    if kind == "table" then
        local parts = {}
        for index = 1, #value do parts[index] = encode(value[index]) end
        return "[" .. table.concat(parts, ",") .. "]"
    elseif kind == "string" then return string.format("%q", value)
    elseif kind == "boolean" then return value and "true" or "false"
    elseif kind == "number" then return tostring(value) end
    return '""'
end
local ternStub = {ui = uiStub, json = {array = function() return {} end, encode = encode,
    decode = function() return nil end}}
tern = ternStub

local test = require("./views")
local result = test(ternStub, ".")

for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("view contract violated") end