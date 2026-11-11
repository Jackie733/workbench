-- Run in Tern's Luau runtime with the production policy/project modules.
return function(Policy, Project)
    local passed = 0
    local function check(value, why) assert(value, why); passed += 1 end
    local p = assert(Project.parse("\\\\wsl.localhost\\Ubuntu\\repo"))
    local pane = {pane = 123, cwd = "\\repo\\child"}
    local agent = {pane = 123, cwd = pane.cwd, host = 0, model = "DeepSeek-Flash", state = "idle"}
    local function command(root, distro)
        local payload = tern.base64.encode(tern.json.encode({root = root, distro = distro, role = "execute"}), {url = true})
        return "/usr/bin/python3 /tmp/tern-workbench-launch-1000/launch.py " .. payload
    end
    local function eligible() return Policy.validateTarget(p, 123, {agent}, {pane}, true) end
    agent.command = command("/repo", "Ubuntu")
    check(eligible() == agent, "无法识别本机自建原生会话的 Windows 规范化 Linux 路径")
    agent.command = "powershell.exe"
    check(not eligible(), "把任意 Windows 根路径当成 WSL 项目")
    agent.command = command("/repo", "Debian")
    check(not eligible(), "把另一发行版会话关联到本项目")
    agent.command, agent.host = command("/repo", "Ubuntu"), 1
    check(not eligible(), "接受了远程主机的原生路径")
    agent.host, pane.cwd = 0, "\\repo2"
    check(not eligible(), "项目前缀误匹配了相邻目录")
    pane.cwd, agent.command = "\\repo\\child", command("/other", "Ubuntu")
    check(not eligible(), "启动上下文不属于项目仍通过校验")
    agent.command, agent.model = command("/repo", "Ubuntu"), "no-model"
    check(not eligible(), "模型未知仍允许发送")
    agent.model, agent.state = "DeepSeek-Flash", "waiting_input"
    check(not eligible(), "等待用户输入仍允许追加请求")
    agent.state, agent.command, pane.cwd = "idle", nil, "\\\\wsl.localhost\\Ubuntu\\repo\\child"
    check(eligible() == agent, "破坏了已有正常 WSL UNC 会话的关联")
    agent.command, pane.cwd = command("/repo", "Ubuntu"), "\\repo\\child"
    local recovered = Policy.projectForTarget(123, {agent}, {pane})
    check(recovered and recovered.key == p.key, "无法从原生工作会话恢复项目导航")
    pane.cwd = "\\outside"
    check(not Policy.projectForTarget(123, {agent}, {pane}), "离开项目后仍用旧启动载荷恢复导航")
    return {passed = passed}
end
