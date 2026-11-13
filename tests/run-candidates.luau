--!strict
-- Standalone strict external-candidate parser regressions; no native process.
local fs, serde = require("@lune/fs"), require("@lune/serde")
local json = {encode=function(value) return serde.encode("json",value) end,
    decode=function(value) return serde.decode("json",value) end}
local Store = assert(loadstring(fs.readFile("lib/store.luau")))()
local Candidates = assert(loadstring("local tern, require=...\n" .. fs.readFile("lib/candidates.luau")))({json=json},
    function(name) assert(name=="./store"); return Store end)
local result = require("./candidates")(Candidates,json)
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures",result.checks,#result.failures))
if #result.failures > 0 then error("candidate validation contract violated") end
