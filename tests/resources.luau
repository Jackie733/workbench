--!strict
-- Resource binding validation: strict schema, project-relative paths, duplicates
-- and unknown versions rejected instead of silently dropped.
tern = {json = {array = function() return {} end}}
local Resources = require("../lib/resources")

return function()
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function equal(actual, expected, message)
        check(actual == expected, message .. " (got " .. tostring(actual) .. ", want " .. tostring(expected) .. ")")
    end
    local req = {projectId = "project-1", requirementId = "req-1"}

    for _, path in {"AGENTS.md", "docs/checklist.md", "src/a-b_c.ts"} do
        check(Resources.cleanPath(path) == path, "合法相对路径 " .. path)
    end
    for _, path in {"/etc/passwd", "C:/x", "src\\a.ts", "../a", "a/../b", "./a", "a//b", "", string.rep("x", 2049)} do
        equal(Resources.cleanPath(path), nil, "拒绝路径 " .. path:sub(1, 24))
    end
    equal(Resources.cleanPath("bad\1path"), nil, "拒绝控制字符")

    local function record(overrides)
        local data = {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 1,
            resources = {{id = "resource-1", path = "AGENTS.md", kind = "context", addedAt = 1},
                {id = "resource-2", path = "docs/verify.md", kind = "verify", addedAt = 2}}, updatedAt = 2}
        for key, value in overrides or {} do data[key] = value end
        return data
    end
    check(Resources.validate(record(), req) ~= nil, "合法资源记录")
    check(Resources.validate(Resources.empty(req), req) ~= nil, "空记录合法")
    equal(Resources.validate(record({schemaVersion = 2}), req), nil, "未知版本被拒绝")
    equal(Resources.validate(record({requirementId = "req-2"}), req), nil, "需求不匹配被拒绝")
    equal(Resources.validate(record({extra = true}), req), nil, "未知字段被拒绝")
    equal(Resources.validate(record({revision = -1}), req), nil, "负修订被拒绝")
    equal(Resources.validate(record({resources = {{id = "resource-1", path = "a.md", kind = "context", addedAt = 1},
        {id = "resource-1", path = "b.md", kind = "context", addedAt = 2}}}), req), nil, "重复 ID 被拒绝")
    equal(Resources.validate(record({resources = {{id = "resource-1", path = "a.md", kind = "context", addedAt = 1},
        {id = "resource-2", path = "a.md", kind = "verify", addedAt = 2}}}), req), nil, "重复路径被拒绝")
    equal(Resources.validate(record({resources = {{id = "resource-1", path = "a.md", kind = "other", addedAt = 1}}}), req), nil,
        "未知用途被拒绝")
    local many = {}
    for index = 1, Resources.MAX_RESOURCES + 1 do
        table.insert(many, {id = "resource-" .. tostring(index), path = "f" .. tostring(index) .. ".md", kind = "context", addedAt = 1})
    end
    equal(Resources.validate(record({resources = many}), req), nil, "超过上限被拒绝")
    equal(Resources.validate(record({resources = {{id = "resource-1", path = "../x", kind = "context", addedAt = 1}}}), req), nil,
        "越界路径被拒绝")

    for _, item in failures do print("FAIL " .. item) end
    return {checks = checks, failures = failures}
end
