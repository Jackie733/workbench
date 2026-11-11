--!strict
-- Paths remain argv/base64 data; no provider, credential or global Git configuration access.
local M = {}

function M.parse(cwd)
    if type(cwd) ~= "string" or cwd == "" or cwd:find("[%z\1-\31]") then
        return nil, "项目目录为空或含控制字符"
    end
    local p = cwd:gsub("\\", "/")
    local distro, linux
    if p:sub(1, 2) == "//" then
        local host
        host, distro, linux = p:match("^//([^/]+)/([^/]+)(/.*)$")
        if not host or (host:lower() ~= "wsl.localhost" and host:lower() ~= "wsl$") then
            return nil, "仅支持本机 WSL 项目；请选择 WSL 项目面板"
        end
    elseif p:sub(1, 1) == "/" then
        distro, linux = "Ubuntu", p
    else
        return nil, "需要 WSL UNC 或 Linux 绝对目录"
    end
    if not distro or not distro:match("^[%w_.%-]+$") then return nil, "WSL 发行版名称无效" end
    local parts = {}
    for part in linux:gmatch("[^/]+") do
        if part == ".." then return nil, "项目目录不允许 .." end
        if part ~= "." then table.insert(parts, part) end
    end
    linux = "/" .. table.concat(parts, "/")
    return {
        distro = distro, linuxRoot = linux, key = distro .. ":" .. linux,
        windowsRoot = "\\\\wsl.localhost\\" .. distro .. linux:gsub("/", "\\"),
    }
end

function M.contains(project, cwd)
    local other = M.parse(cwd)
    if not other or other.distro:lower() ~= project.distro:lower() then return false end
    local root = project.linuxRoot
    return other.linuxRoot == root or root == "/" or other.linuxRoot:sub(1, #root + 1) == root .. "/"
end

local INSPECT = [==[
import hashlib, json, os, stat, subprocess, sys
try:
    requested = os.path.realpath(sys.argv[1])
    def git(*args):
        r = subprocess.run(['/usr/bin/git', '-C', requested, *args], stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=8, check=False)
        if r.returncode:
            raise ValueError(r.stderr.decode('utf-8', 'replace').strip()[:1200])
        return r.stdout.decode('utf-8', 'strict').strip()
    root = git('rev-parse', '--show-toplevel')
    requested = root
    head = git('rev-parse', 'HEAD')
    status = git('status', '--porcelain=v1', '--untracked-files=normal')
    result = {'root': root, 'head': head, 'dirty': bool(status), 'status': status[:12000]}
    if len(sys.argv) > 2:
        rel = sys.argv[2]
        if (not rel or len(rel) > 512 or os.path.isabs(rel) or '\\' in rel
            or any(ord(c) < 32 for c in rel) or '..' in rel.split('/')
            or not rel.lower().endswith('.md')):
            raise ValueError('交付文件必须是项目内的相对 Markdown 路径，不允许 .. 或反斜杠')
        selected = os.path.realpath(os.path.join(root, rel))
        if os.path.commonpath([root, selected]) != root:
            raise ValueError('交付文件链接指向项目外部')
        # Open nonblocking, then verify the opened object: never block on FIFO/device inputs.
        fd = os.open(selected, os.O_RDONLY | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 131072:
                raise ValueError('交付文件必须为不超过 128 KiB 的普通文件')
            with os.fdopen(fd, 'rb', closefd=False) as f:
                data = f.read(131073)
            if len(data) > 131072:
                raise ValueError('交付文件超过 128 KiB')
        finally:
            os.close(fd)
        result.update(relativePath=rel, digest=hashlib.sha256(data).hexdigest(),
                      text=data.decode('utf-8', 'strict'))
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'error': str(e)[:1500]}, ensure_ascii=False))
    sys.exit(1)
]==]

-- callback(result?, error?, fresh window cx); false return means spawn failed synchronously.
function M.inspect(project, relativePath, callback)
    local argv = {"wsl.exe", "--distribution", project.distro, "--exec", "/usr/bin/python3", "-c", INSPECT, project.linuxRoot}
    if relativePath ~= nil then table.insert(argv, relativePath) end
    local ok, err = pcall(function()
        tern.process.run(argv, {timeout_ms = 15000}, function(r, cx)
            if not cx then return end
            local decoded, data = pcall(tern.json.decode, r.stdout)
            if r.timed_out then callback(nil, "WSL 项目读取超时", cx)
            elseif not decoded or type(data) ~= "table" then callback(nil, "项目读取未返回有效 JSON: " .. tostring(r.stderr):sub(1, 500), cx)
            elseif r.status ~= 0 or data.error then callback(nil, data.error or "WSL 项目读取失败", cx)
            elseif type(data.head) ~= "string" or type(data.root) ~= "string" then callback(nil, "项目快照缺少基线", cx)
            else callback(data, nil, cx) end
        end)
    end)
    if not ok then return false, tostring(err) end
    return true
end

function M.atRoot(project, linuxRoot)
    return M.parse("\\\\wsl.localhost\\" .. project.distro .. linuxRoot:gsub("/", "\\"))
end

-- This installation uses Tern's WSL shell. Pass it a Linux command, not a
-- second wsl.exe (whose extra ConPTY drops TSP). Keep path data out of shell text.
local PREPARE_LAUNCH = [==[
import base64, json, os, stat, sys, tempfile
SCRIPT = """import base64, json, os, sys
data = json.loads(base64.urlsafe_b64decode(sys.argv[1]))
if data['role'] not in ('design', 'execute'):
    raise ValueError('invalid workbench role')
os.environ['TERM_PROGRAM'] = 'tern'  # WSL --exec does not forward Tern's terminal identity.
os.chdir(data['root'])
os.execv('/bin/bash', ['bash', '-lc',
    'exec omp --cwd "$2" --model "$1" --no-title',
    'tern-workbench', '@' + data['role'], data['root']])
"""
try:
    root, role, distro = sys.argv[1:4]
    if role not in ('design', 'execute'):
        raise ValueError('invalid workbench role')
    cache = '/tmp/tern-workbench-launch-' + str(os.getuid())
    try:
        os.mkdir(cache, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(cache)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('unsafe workbench launch directory')
    fd, temporary = tempfile.mkstemp(dir=cache)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as output:
            output.write(SCRIPT)
        os.replace(temporary, cache + '/launch.py')
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    payload = base64.urlsafe_b64encode(json.dumps({'root': root, 'role': role, 'distro': distro}).encode()).decode()
    print(json.dumps({'path': cache + '/launch.py', 'payload': payload}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
    sys.exit(1)
]==]

function M.prepareLaunch(p, role, callback)
    local ok, err = pcall(function()
        assert(role == "design" or role == "execute", "启动角色无效")
        tern.process.run({"wsl.exe", "--distribution", p.distro, "--exec", "/usr/bin/python3", "-c",
            PREPARE_LAUNCH, p.linuxRoot, role, p.distro}, {timeout_ms = 15000}, function(r, cx)
            if not cx then return end
            local decoded, data = pcall(tern.json.decode, r.stdout)
            if r.timed_out then callback(nil, "WSL 启动准备超时", cx)
            elseif not decoded or type(data) ~= "table" then callback(nil, "WSL 启动准备未返回有效结果", cx)
            elseif r.status ~= 0 or data.error then callback(nil, data.error or "WSL 启动准备失败", cx)
            elseif type(data.path) ~= "string" or not data.path:match("^/tmp/tern%-workbench%-launch%-%d+/launch%.py$")
                or type(data.payload) ~= "string" or not data.payload:match("^[%w_=%-]+$") then
                callback(nil, "WSL 启动参数无效", cx)
            else
                callback("/usr/bin/python3 " .. data.path .. " " .. data.payload, nil, cx)
            end
        end)
    end)
    if not ok then return false, tostring(err) end
    return true
end

return M
