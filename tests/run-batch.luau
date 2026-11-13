--!strict
-- Standalone runner for tests/batch.luau: lune run tests/run-batch.luau
local test = require("./batch")
local result = test()
for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("batch contract violated") end
