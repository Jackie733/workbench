--!strict
-- lune run tests/run-store-lifecycle.luau (no native process or persistent writes)
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local test = require("./store-lifecycle")
local result = test(fs.readFile("lib/store.luau"), {
    array=function() return {} end,
    encode=function(value) return serde.encode("json",value) end,
    decode=function(value) return serde.decode("json",value) end,
})
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures",result.checks,#result.failures))
if #result.failures > 0 then error("store/lifecycle contract violated") end
