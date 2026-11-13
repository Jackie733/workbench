--!strict
-- Standalone runner for tests/validity.luau: lune run tests/run-validity.luau
-- The module under test is pure table inspection, so no tern stub is needed.
local test = require("./validity")
local result = test()

for _, failure in result.failures do print("FAIL " .. failure) end
print(string.format("%d checks, %d failures", result.checks, #result.failures))
if #result.failures > 0 then error("validity contract violated") end
