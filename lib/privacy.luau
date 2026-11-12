--!strict
-- Only an explicit initialization choice may change this repository's local exclude.
local live = require("./live")
local M = {}
local LOCAL = [==[
set -eu
root=$1
inside=$(git -C "$root" rev-parse --is-inside-work-tree)
[ "$inside" = true ] || { printf '%s\n' 'Not a Git work tree' >&2; exit 1; }
if git -C "$root" ls-files --error-unmatch -- .omp/workbench >/dev/null 2>&1; then
  printf '%s\n' 'Workbench files are already tracked; ignore rules cannot make them private. Choose project Git rules or untrack them explicitly.' >&2
  exit 1
fi
exclude=$(git -C "$root" rev-parse --path-format=absolute --git-path info/exclude)
mkdir -p "$(dirname "$exclude")"
(
  flock -x 9
  [ ! -L "$exclude" ] || { printf '%s\n' 'Refusing to modify a symbolic-link exclude file' >&2; exit 1; }
  if ! git -C "$root" check-ignore --quiet --no-index -- .omp/workbench/; then
    printf '\n/.omp/workbench/\n' >> "$exclude"
  fi
  git -C "$root" check-ignore --quiet --no-index -- .omp/workbench/ || {
    printf '%s\n' 'Project ignore rules override the local exclude; resolve them before private initialization.' >&2
    exit 1
  }
) 9>"$exclude.workbench-gate"
]==]
function M.apply(location, root, mode, callback)
    if mode ~= "local" and mode ~= "tracked" then callback(nil, "请选择项目资料的隐私方式", nil); return end
    if type(location) ~= "table" or not live.path(location.marker) or type(root) ~= "string"
        or root:sub(1, 1) ~= "/" or root:find("[%z\1-\31\\]") or #root > 2048 then
        callback(nil, "项目路径无效；未修改 Git 设置", nil); return
    end
    if mode == "tracked" then callback(true, nil, nil); return end
    local verified = live.path(location.marker)
    local ok, err = pcall(function()
        tern.process.run({"wsl.exe", "--distribution", verified.distro, "--exec", "sh", "-c", LOCAL, "workbench-privacy", root},
            {timeout_ms = 5000}, function(result, cx)
                if result.timed_out then callback(nil, "设置本地忽略超时；请检查 Git 规则后重试", cx)
                elseif result.status ~= 0 then callback(nil, "未初始化：无法保证资料仅保存在本机。" .. tostring(result.stderr):sub(1, 800), cx)
                else callback(true, nil, cx) end
            end)
    end)
    if not ok then callback(nil, tostring(err), nil) end
end
return M
