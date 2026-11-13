--!strict
-- Standalone runner for tests/resources.luau: lune run tests/run-resources.luau
local test = require("./resources")
local result = test()
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("resource contract violated") end
