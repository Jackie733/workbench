--!strict
-- Shared Phase 1 transport. No project data or model/session creation lives here.
local M = {}
M.kind = "multi-model-workbench.live"
M.maxText = 16384
M.staleMs = 6000

function M.epoch() return os.time() * 1000 end
function M.token(value)
    return type(value) == "string" and #value > 0 and #value <= 128 and value:match("^[%w_%-]+$") ~= nil
end
function M.path(path)
    if type(path) ~= "string" or #path > 2048 or path:find("[%z\1-\31]") then return nil end
    local p = path:gsub("\\", "/")
    -- Windows route paths are canonicalized to the extended UNC namespace.
    if p:sub(1, 8):lower() == "//?/unc/" then p = "//" .. p:sub(9) end
    local host, distro, uid, instance = p:match("^//([^/]+)/([%w_.%-]+)/tmp/omp%-workbench%-(%d+)/([%w_%-]+)/open%.omp%-workbench%.json$")
    if not host or (host:lower() ~= "wsl.localhost" and host:lower() ~= "wsl$") or not M.token(instance) then return nil end
    local linux = "/tmp/omp-workbench-" .. uid .. "/" .. instance
    local normalized = p:gsub("/", "\\")
    return {marker = normalized, runtime = normalized:sub(1, #normalized - #"open.omp-workbench.json"), linux = linux, instanceId = instance, distro = distro}
end
function M.marker(data, location)
    if type(data) ~= "table" or data.schemaVersion ~= 1 or data.instanceId ~= location.instanceId
        or not M.token(data.sessionId) or not M.token(data.openRequestId) or data.runtimeDir ~= location.linux
        or data.sourceMarker ~= "OMPWB:" .. data.instanceId
        or type(data.projectRoot) ~= "string" or data.projectRoot:sub(1, 1) ~= "/"
        or type(data.cwd) ~= "string" or data.cwd:sub(1, 1) ~= "/"
        or #data.projectRoot > 2048 or #data.cwd > 2048 or data.projectRoot:find("[%z\1-\31]") or data.cwd:find("[%z\1-\31]") then
        return nil, "打开标记身份无效；请回到来源 omp 输入 /wb"
    end
    return data
end
function M.snapshot(data, binding)
    if type(data) ~= "table" or data.schemaVersion ~= 1 or data.instanceId ~= binding.instanceId then return nil, "桥接实例不匹配" end
    if data.sessionId ~= binding.sessionId then return nil, "会话已改变；旧绑定失效，请在当前 omp 输入 /wb" end
    if data.sourceMarker ~= binding.sourceMarker or data.projectRoot ~= binding.projectRoot then return nil, "来源或项目已改变；请重新 /wb" end
    if type(data.sequence) ~= "number" or data.sequence < 0 or data.sequence % 1 ~= 0 or type(data.updatedAt) ~= "number"
        or type(data.pid) ~= "number" or type(data.cwd) ~= "string" then return nil, "运行快照缺少有效字段" end
    if data.state ~= "idle" and data.state ~= "working" and data.state ~= "waiting_user" and data.state ~= "disconnected" then return nil, "未知运行状态" end
    if data.model ~= nil and type(data.model) ~= "string" then return nil, "模型字段无效" end
    if data.currentTool ~= nil and type(data.currentTool) ~= "table" then return nil, "工具字段无效" end
    if type(data.recentEvents) ~= "table" or #data.recentEvents > 100 then return nil, "事件列表无效或超限" end
    return data
end
function M.read(path, bound)
    local ok, value = pcall(function() return tern.json.decode(tern.fs.read(path, bound)) end)
    if not ok then return nil, tostring(value) end
    return value
end

-- Only explicit opens/clicks start a process. Polling stays in the host worker.
-- Paths and UTF-8 text are environment data, never interpolated into executable code.
local READ = [==[
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$p=$env:OMPWB_MARKER
$a=[IO.File]::GetAttributes($p)
if (($a -band [IO.FileAttributes]::ReparsePoint) -or ($a -band [IO.FileAttributes]::Directory)) { throw 'Marker must be a regular file' }
$f=[IO.File]::Open($p,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete)
try {
 if ($f.Length -gt 16384) { throw 'Marker exceeds 16 KiB' }
 $b=[byte[]]::new(16385)
 $n=0
 while ($n -lt $b.Length) { $got=$f.Read($b,$n,$b.Length-$n); if ($got -eq 0) { break }; $n+=$got }
 if ($n -gt 16384) { throw 'Marker grew beyond bound' }
 [Console]::Write([Text.UTF8Encoding]::new($false,$true).GetString($b,0,$n))
} finally { $f.Dispose() }
]==]
local WRITE = [==[
$ErrorActionPreference='Stop'
$p=$env:OMPWB_COMMAND
$text=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OMPWB_PAYLOAD))
if ($env:OMPWB_REPLACE -eq '1') {
 $ack=ConvertFrom-Json -InputObject $text
 $ack.updatedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
 $text=ConvertTo-Json -InputObject $ack -Compress
}
$tmp=$p+'.tmp-'+[Guid]::NewGuid().ToString('N')
try {
 $f=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try { $b=[Text.UTF8Encoding]::new($false).GetBytes($text); $f.Write($b,0,$b.Length); $f.Flush($true) } finally { $f.Dispose() }
 if ($env:OMPWB_REPLACE -eq '1') {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OmpWorkbenchRename { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string source, string target, int flags); }'
  if (-not [OmpWorkbenchRename]::MoveFileEx($tmp,$p,9)) { throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error()) }
 } else { [IO.File]::Move($tmp,$p) }
} finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
]==]
local function process(script, env, callback)
    local ok, failure = pcall(function()
        tern.process.run({"powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script},
            {env = env, timeout_ms = 5000}, function(r, cx)
                if r.timed_out then callback(nil, "文件通信超时；投递状态待核对，不自动重试", cx)
                elseif r.status ~= 0 then callback(nil, tostring(r.stderr):sub(1, 800), cx)
                else callback(r.stdout, nil, cx) end
            end)
    end)
    if not ok then callback(nil, tostring(failure), nil) end
end
function M.openMarker(path, callback)
    local location = M.path(path)
    if not location then callback(nil, "只接受本机 WSL 私有运行目录的打开标记", nil); return end
    process(READ, {OMPWB_MARKER = path}, function(text, err, cx)
        if err then callback(nil, err, cx); return end
        local ok, decoded = pcall(tern.json.decode, text)
        if not ok then callback(nil, "打开标记 JSON 无效", cx); return end
        local marker, problem = M.marker(decoded, location)
        if not marker then callback(nil, problem, cx); return end
        callback({location = location, binding = marker}, nil, cx)
    end)
end
function M.command(location, command, callback)
    process(WRITE, {OMPWB_COMMAND = location.runtime .. "commands\\" .. command.requestId .. ".json",
        OMPWB_PAYLOAD = tern.base64.encode(tern.json.encode(command))}, callback)
end
function M.opened(location, acknowledgment, callback)
    process(WRITE, {OMPWB_COMMAND = location.runtime .. "opened.json", OMPWB_REPLACE = "1",
        OMPWB_PAYLOAD = tern.base64.encode(tern.json.encode(acknowledgment))}, callback)
end
return M
