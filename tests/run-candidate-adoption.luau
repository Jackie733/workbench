--!strict
-- Production domain/storage modules; only filesystem and native CAS transport are isolated.
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local files, modules = {}, {}
local state = {writes=0, reject=nil, race=nil}
local json = {array=function() return {} end,
    encode=function(value) return serde.encode("json", value) end,
    decode=function(value) return serde.decode("json", value) end}
local stub = {json=json, now=function() return 1000 end,
    fs={exists=function(path) return files[path] ~= nil end,
        read=function(path) return assert(files[path], "missing " .. path) end,
        write=function(path, value) files[path]=value end,
        mkdir=function() end, remove=function(path) files[path]=nil end}}
stub.fs.list = function(path)
    local names, seen = {}, {}
    local prefix = path .. "\\"
    for file in files do
        if file:sub(1,#prefix) == prefix then
            local name = file:sub(#prefix+1):match("^[^\\]+")
            if name and not seen[name] then seen[name]=true; table.insert(names,name) end
        end
    end
    return names
end
local function loadModule(name)
    if modules[name] then return modules[name] end
    local chunk = assert(loadstring("local tern, require=...\n" .. fs.readFile("lib/" .. name .. ".luau")))
    local value = chunk(stub, function(relative) return loadModule(relative:match("([^/]+)$")) end)
    modules[name]=value
    return value
end
local Store = loadModule("store")
local CX = {tag="isolated-cas"}
Store.runProcess = function(env, cb)
    local target = env.OMPWB_TARGET
    if state.race then local race=state.race; state.race=nil; race(target) end
    local prior = files[target] and json.decode(files[target])
    local status = 0
    local two = target:match("\\plan%.json$") or target:match("\\results%.json$") or target:match("\\reviews%.json$")
        or target:match("\\workflow%.json$") or target:match("\\requirement%.json$") or target:match("\\evidence\\verification%-[%w_%-]+%.json$")
    if state.reject == target then status=6
    elseif prior and prior.schemaVersion ~= 1
        and not (prior.schemaVersion == 2 and two and env.OMPWB_SCHEMA2 == "1")
        and not (prior.schemaVersion == 3 and target:match("\\reviews%.json$") and env.OMPWB_SCHEMA3 == "1") then status=4
    elseif (prior and prior.revision or 0) ~= tonumber(env.OMPWB_EXPECT) then status=3
    else files[target]=files[env.OMPWB_TEMP]; state.writes+=1 end
    files[env.OMPWB_TEMP]=nil
    cb(status,"",false,CX)
end
local result = require("./candidate-adoption")({Store=Store, Results=loadModule("results"), Review=loadModule("review"),
    Validity=loadModule("validity"), files=files, json=json, state=state, cx=CX})
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("candidate adoption contract violated") end
