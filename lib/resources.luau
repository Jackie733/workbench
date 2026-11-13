--!strict
-- Requirement-scoped persistent resource bindings. A new file per requirement,
-- schema 1, strict allowlists; a missing file means "no bindings", never a
-- fallback to guessed paths. Older binaries reject unknown fields instead of
-- silently dropping them.
local Store = require('./store')
local M = {}
M.MAX_RESOURCES = 32
local kinds = {context = true, verify = true}

local function join(a, b) return a .. "\\" .. b end
local function text(value, max, empty)
    if type(value) ~= "string" or #value > max or (not empty and value:match("%S") == nil)
        or value:find("[%z\1-\8\11\12\14-\31\127]") then return false end
    return utf8.len(value) ~= nil
end
local function integer(value, minimum)
    return type(value) == "number" and value % 1 == 0 and value >= minimum
end
local function allowed(value, keys)
    for key in value do if not keys[key] then return false end end
    return true
end
local function read(file)
    if not tern.fs.exists(file) then return nil, "missing" end
    local ok, raw = pcall(tern.fs.read, file, Store.maxJson)
    if not ok then return nil, "read_failed" end
    local decoded, value = pcall(tern.json.decode, raw)
    if not decoded or type(value) ~= "table" then return nil, "corrupt_resources" end
    return value
end

-- Relative, project-internal path: no absolute form, no backslashes, no "." or
-- ".." components, no control characters.
function M.cleanPath(value)
    if not text(value, 2048, false) then return nil, "invalid_path" end
    if value:sub(1, 1) == "/" or value:find("\\", 1, true) or value:match("^%a:") then return nil, "invalid_path" end
    for part in value:gmatch("[^/]+") do
        if part == "." or part == ".." then return nil, "invalid_path" end
    end
    if value:find("//", 1, true) then return nil, "invalid_path" end
    return value
end

function M.path(paths, req)
    return join(join(paths.requirements, req.requirementId), "resources.json")
end
function M.empty(req)
    return {schemaVersion = 1, projectId = req.projectId, requirementId = req.requirementId,
        revision = 0, resources = tern.json.array(), updatedAt = 0}
end
local entryKeys = {id = true, path = true, kind = true, addedAt = true}
local dataKeys = {schemaVersion = true, projectId = true, requirementId = true, revision = true,
    resources = true, updatedAt = true}
function M.validate(data, req)
    if type(data) ~= "table" or data.schemaVersion ~= 1 or data.projectId ~= req.projectId
        or data.requirementId ~= req.requirementId or not integer(data.revision, 0)
        or type(data.resources) ~= "table" or #data.resources > M.MAX_RESOURCES
        or not integer(data.updatedAt, 0) or not allowed(data, dataKeys) then
        return nil, "corrupt_resources"
    end
    local ids, paths = {}, {}
    for index, entry in data.resources do
        if type(index) ~= "number" or index % 1 ~= 0 or type(entry) ~= "table"
            or not Store.token(entry.id) or ids[entry.id]
            or not M.cleanPath(entry.path) or paths[entry.path]
            or not kinds[entry.kind] or not integer(entry.addedAt, 0)
            or not allowed(entry, entryKeys) then
            return nil, "corrupt_resources"
        end
        ids[entry.id], paths[entry.path] = true, true
    end
    return data
end
function M.load(paths, req)
    local data, error = read(M.path(paths, req))
    if error == "missing" then return M.empty(req), nil end
    if not data then return nil, {code = error} end
    local valid, problem = M.validate(data, req)
    if not valid then return nil, {code = problem} end
    return data, nil
end

local function copyResources(resources)
    local out = tern.json.array()
    for _, entry in resources do
        table.insert(out, {id = entry.id, path = entry.path, kind = entry.kind, addedAt = entry.addedAt})
    end
    return out
end

-- add: {path, kind}; remove: {id}. Returns the new record; CAS keeps concurrent
-- writers from overwriting each other.
function M.apply(paths, req, token, action, args, expected, cb)
    local function fail(code) cb(nil, nil, {code = code}) end
    if not Store.token(token) or type(args) ~= "table" or not integer(expected, 0) then fail("invalid_options"); return end
    local current, problem = M.load(paths, req)
    if not current then cb(nil, nil, problem); return end
    if current.revision ~= expected then fail("revision_conflict"); return end
    local nextData = {schemaVersion = 1, projectId = req.projectId, requirementId = req.requirementId,
        revision = current.revision + 1, resources = copyResources(current.resources), updatedAt = os.time() * 1000}
    if action == "add" then
        local path, pathError = M.cleanPath(args.path)
        if not path then fail(pathError or "invalid_path"); return end
        local kind = args.kind == nil and "context" or args.kind
        if not kinds[kind] then fail("invalid_kind"); return end
        if #nextData.resources >= M.MAX_RESOURCES then fail("resource_limit"); return end
        for _, entry in nextData.resources do
            if entry.path == path then fail("duplicate_path"); return end
        end
        table.insert(nextData.resources, {id = Store.newId("resource", nextData.updatedAt), path = path,
            kind = kind, addedAt = nextData.updatedAt})
    elseif action == "remove" then
        if not Store.token(args.id) then fail("invalid_options"); return end
        local found
        for index, entry in nextData.resources do
            if entry.id == args.id then found = index; break end
        end
        if not found then fail("missing_resource"); return end
        table.remove(nextData.resources, found)
    else fail("invalid_action"); return end
    nextData.updatedAt = os.time() * 1000
    local valid, why = M.validate(nextData, req)
    if not valid then fail(why); return end
    Store.putScoped(paths, M.path(paths, req), nextData, current.revision, token,
        function(saved, reason, ctx)
            if saved then cb(nextData, nil, ctx) else cb(nil, nil, {code = reason}, ctx) end
        end)
end
return M
