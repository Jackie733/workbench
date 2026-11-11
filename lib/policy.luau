--!strict
local project = require("./project")
local M = {}

function M.model(agent)
    local v = agent and agent.model
    return if type(v) == "string" and v ~= "" and v ~= "no-model" then v else "未知"
end

-- Windows may report a native Linux program's cwd as \tmp\... rather than
-- a WSL UNC path. Only normalize our own local launcher with matching context;
-- arbitrary rooted Windows paths and remote POSIX panes remain ineligible.
local function launchProject(agent)
    if agent.host ~= 0 or type(agent.command) ~= "string" then return nil end
    local payload = agent.command:match("^/usr/bin/python3 /tmp/tern%-workbench%-launch%-%d+/launch%.py ([%w_=%-]+)$")
    if not payload then return nil end
    local ok, context = pcall(function() return tern.json.decode(tern.base64.decode(payload)) end)
    if not ok or type(context) ~= "table" or type(context.root) ~= "string" or type(context.distro) ~= "string"
        or context.root:sub(1, 1) ~= "/" or (context.role ~= "design" and context.role ~= "execute") then return nil end
    local p = project.parse("\\\\wsl.localhost\\" .. context.distro .. context.root:gsub("/", "\\"))
    return p and p.linuxRoot == context.root and p or nil
end
local function managedCwd(p, pane, agent)
    local context = launchProject(agent)
    if not context or context.key ~= p.key then return nil end
    local cwd = pane.cwd:gsub("\\", "/")
    if cwd:sub(1, 1) ~= "/" or cwd:sub(1, 2) == "//" then return nil end
    return "\\\\wsl.localhost\\" .. p.distro .. cwd:gsub("/", "\\")
end

function M.validateTarget(p, boundPane, agents, panes, needsIdle)
    if type(boundPane) ~= "number" then return nil, "请先绑定已有 omp 会话" end
    local pane = nil
    for _, item in panes do if item.pane == boundPane then pane = item; break end end
    if not pane or type(pane.cwd) ~= "string" then return nil, "关联的面板已关闭" end
    local found = nil
    for _, agent in agents do if agent.pane == boundPane then found = agent; break end end
    if not found then return nil, "Tern 尚未识别该面板的原生 Agent；保留会话，稍后刷新或重新选择" end
    local cwd = pane.cwd
    local localWsl = cwd:sub(1, 2) == "\\\\" or cwd:sub(1, 2) == "//"
    if not localWsl then cwd = managedCwd(p, pane, found) end
    if not cwd or not project.contains(p, cwd) then
        return nil, "关联的面板已离开项目，或不能确认本机 WSL 身份；请重新选择"
    end
    if found.state == "exited" or found.alive == false then return nil, "绑定的 Agent 已退出" end
    if type(found.delivery_error) == "string" and found.delivery_error ~= "" then
        return nil, "存在未解决的发送错误：" .. found.delivery_error
    end
    if needsIdle and found.state ~= "idle" then return nil, "Agent 正忙或等待输入；本次未发送" end
    if needsIdle and M.model(found) == "未知" then
        return nil, "Tern 尚未报告可用模型；本次未发送。请在原会话确认模型后刷新。"
    end
    return found
end

function M.projectForTarget(boundPane, agents, panes)
    for _, agent in agents do
        if agent.pane == boundPane then
            local p = launchProject(agent)
            if p and M.validateTarget(p, boundPane, agents, panes, false) then return p end
        end
    end
    return nil
end

function M.approvalMatches(approved, snapshot)
    return type(approved) == "table" and type(snapshot) == "table"
        and type(approved.head) == "string" and approved.head ~= ""
        and type(approved.digest) == "string" and approved.digest ~= ""
        and type(approved.relativePath) == "string" and approved.relativePath ~= ""
        and approved.head == snapshot.head and approved.digest == snapshot.digest
        and approved.relativePath == snapshot.relativePath
end

return M
