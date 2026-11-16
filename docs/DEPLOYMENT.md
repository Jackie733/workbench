# 用户级部署与访问检查

Workbench 使用当前用户的源码、Git 仓库、Agent CLI 及认证目录。macOS 使用 LaunchAgent，Linux 和 WSL2 使用 `systemd --user`；不安装系统服务、不使用 sudo、不启用 linger、不创建 Windows 计划任务，也不提供原生 Windows Bun 服务。默认只监听 `127.0.0.1:4318`。

macOS 已用 Bun 1.4.4 完成隔离部署验收：生产依赖冻结安装、完整 deploy 脚本、真实 launchd 安装/状态/幂等安装/启停/重启/崩溃恢复/卸载；卸载保留项目及 Hub 数据。HTTP health/HTML/JS/CSS、WebSocket `bridge.status`、真实 stdio MCP initialize/tools/list/wb_list 均通过，Chromium 实际加载 Web 并添加切换项目。Linux 主机可访问用户级 systemd，但 Bun 下载超时，未完成运行验收；WSL2、Windows 客户端、重新登录及重启恢复未验证，需按文末流程验收。Hub 健康不等于外部模型执行成功。

## 1. 准备

- 安装 Git 和建议的当前稳定版 Bun，确认 `git --version`、`bun --version` 可运行。不在部署脚本中下载 Bun、升级系统或拉取 Git。
- 将源码放在该用户可读、长期保留的固定绝对路径；不要部署后移动或删除源码、依赖、Bun。服务启动仍会构建 Web 资源，不能只保留静态页面。
- 在同一用户下安装并登录所需 Agent CLI，先在终端确认能使用。安装不会修改外部 CLI 登录状态。服务不继承交互 shell 的临时环境、API key 或 shell 初始化文件；持久环境只有 HOME、安装时的 PATH、WORKBENCH_HUB_DIR。PATH 只保留绝对目录并包含 Bun 所在目录。
- 确认端口空闲；冲突会报错，不会自动换端口。若已有未托管 Hub，先用 `wb stop` 停止；不要自动终止仍在执行任务的进程。
- 实测 Bun 1.4.4 通过 `bun install --production --frozen-lockfile` 及上述运行时检查；旧系统 Bun 1.0.0 的冻结安装失败。1.4.4 是本次测试版本，不是最低兼容版本声明，建议使用当前稳定版。实际部署和验收请记录所用版本；若 `--frozen-lockfile` 报锁文件格式不支持，升级 Bun，不要删除锁文件绕过检查。临时下载运行时仅用于此次隔离验证，不是部署脚本的行为。

### macOS

在已登录的图形用户会话运行安装；需要可访问的 `launchctl gui/<uid>` 会话。服务定义位于 `~/Library/LaunchAgents/com.workbench.hub-<hash>.plist`，下次登录自动加载。退出登录后不承诺继续运行。

### Linux

需要 systemd 及可用的用户会话总线。先运行：

```sh
systemctl --user show-environment
```

失败时先修复用户会话；脚本不会创建总线或启用 linger。unit 位于 `${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/workbench-hub-<hash>.service`；如设置 XDG_CONFIG_HOME，必须使用绝对路径。用户服务随用户会话启动，不承诺注销后或无人登录时运行。

### WSL2

在 Linux 发行版内部安装，建议源码与业务仓库位于 Linux 文件系统，而不是 `/mnt/c`。前提见 [Microsoft：在 WSL 中使用 systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd)。确认 WSL2 和版本支持 systemd；必要时由用户手动在发行版 `/etc/wsl.conf` 配置：

```ini
[boot]
systemd=true
```

保存所有发行版中的工作后，在 Windows 运行 `wsl --shutdown`，再进入发行版。该命令会停止所有发行版。检查 `systemctl --user show-environment` 可达后再部署；仅看到 PID 1 是 systemd 不足以证明用户会话可用。安装脚本不修改 `/etc/wsl.conf`。

systemd 服务本身不保证 WSL 实例持续存活。Windows 重启后仍需启动目标发行版及用户会话；不承诺 Windows 开机即自动可用。

## 2. 安装 → 状态 → 检查 → Web

在固定源码根执行（所有尖括号路径均需替换为真实绝对路径）：

```sh
bun run deploy --port 4318
wb service status
```

部署依次执行依赖冻结安装、`bun link`、用户服务安装及启动；任一步失败立即停止。不会拉取源码、删除 lockfile、清理数据或变更认证。只安装服务也可用 `wb service install --port 4318`。默认端口为 4318，安装只接受 `--port`，不提供远程监听选项。

服务的工作目录及 Hub `--root` 固定为当前用户 HOME，不会把源码仓库自动当作业务项目，安装不透传 WORKBENCH_ROOT。先准备一个已有的、已初始化项目；新项目可以这样初始化：

```sh
wb --root /absolute/path/to/project init
bun run deploy:check --url http://127.0.0.1:4318 --root /absolute/path/to/project
wb open
```

`init` 用于需要初始化的 Git 项目，已有业务项目无需重建。也可先在 Web 左栏添加项目。浏览器访问 `http://127.0.0.1:4318`；自定义端口时使用实际 URL。

`deploy:check` 不启动 Hub，不隐式使用 cwd、不初始化或修改项目。`--root` 必填；省略 `--url` 时读取当前 hubDir 的健康 daemon 记录。检查分别输出 HTTP/WS/MCP PASS/FAIL，任一失败退出非零：

- `/api/health` 的 Hub 标识、健康和 PID；匹配本地记录 URL 时核验 PID。Hub root 是 HOME，不要求等于 MCP 项目 root。
- `/`、`/app.js`、`/styles.css` 的真实应用入口、内容类型与非空内容，不接受后端 fallback 页面。
- `/ws?role=ui` 收到 `bridge.status` 后关闭，不注册执行桥、不触发任务。
- 独立启动真实 stdio MCP，initialize、initialized、tools/list，再调用 `wb_list`（scope=all）；检查五个现有工具与可解析的非错误结果。未初始化项目会失败并给出指引。

## 3. 生命周期、日志与命名空间

```sh
wb service start
wb service stop
wb service restart
wb service status
# 既有命令也遵循服务所有权：
wb start
wb open
wb stop
wb restart
wb status
```

安装后，既有 start/open/stop/restart 由服务管理器处理，不再另起 detached Hub 或直接给托管 PID 发停止信号。open 仅在健康后打开浏览器；start/open 保留当前项目注册语义。显式传入不同端口或非 loopback host 会报错，需重新安装配置。`wb status` 保留 Hub 信息并增加 service 状态；`wb service status` 的 installed、active（管理器状态）、healthy（运行时探针）是不同事实，查询不会启动服务。需要机器可读结果可加全局 `--json`。

macOS stop 使用 bootout，避免 KeepAlive 立即拉回；保留 plist，下次登录仍会自动加载。Linux stop 不取消 enable，下次用户会话仍可启动。缺失或损坏的安装配置、丢失定义、管理器不可达均应诊断为错误，不回退到伪装的后台部署。

默认 hubDir 为 `~/.workbench-hub`。自定义时，在部署、CLI、检查、MCP 客户端中始终使用同一个绝对目录，例如：

```sh
export WORKBENCH_HUB_DIR="$HOME/.workbench-hub-personal"
bun run deploy --port 14318
wb service status
bun run deploy:check --root /absolute/path/to/project
```

服务 ID 的 hash 来自规范绝对 hubDir，不同目录有不同服务，但端口仍须不同。`service.json` 是安装记录（权限 0600），`daemon.json` 仅是运行发现记录，不能证明已安装。不要手工改 PID 或复制记录冒充运行状态。未知来源的同名服务文件不会被覆盖或删除。

日志：

- macOS：`<hubDir>/service.log`（stdout/stderr）。
- Linux/WSL：从 `wb service status` 取得 id，再执行 `journalctl --user -u <id> -f`。
- 未托管后台 Hub：`<hubDir>/hub.log`。

## 4. 更新、改配置与卸载

更新前保存任务并停止服务，在同一个固定源码目录自行更新源码，再部署：

```sh
wb stop
# 在固定源码目录审查并执行自己的源码更新操作
bun run deploy --port 4318
wb service status
bun run deploy:check --root /absolute/path/to/project
```

同配置重复安装在已健康时不重启，已停止时启动。端口、Bun 路径、源码路径或 PATH 改变会停止并重写托管配置再启动，可能中断任务。新增 CLI 路径、移动 Bun/源码或修改 PATH 后，需在正确环境重新部署，不能指望服务读取新的 shell 环境。加载失败会保留可诊断的安装记录；先看状态和日志，不要手工删除记录再启动另一个 Hub。

```sh
wb service install --port 14318
wb service uninstall
```

卸载仅停用并移除本应用拥有的定义与安装记录；保留项目、`.workbench/`、hubDir 数据、认证、日志、源码及依赖。重复卸载应安全；部分失败不代表卸载成功，检查返回错误和管理器状态。

备份项目 `.workbench/` 及 hubDir 前先停服务，避免复制到不一致状态。恢复时保留业务数据，但不要复用旧 `daemon.json` 中的 PID 或另一机器的 service.json/服务定义；在目标用户和机器重新安装服务，并重新验证。不要删除外部 CLI 认证目录。

### 主动选择前台运行

没有可用服务管理器时安装会明确失败。用户可主动选用以下前台方式，但这不是已安装的用户服务：

```sh
bun run src/cli/index.ts serve --hub --host 127.0.0.1 --port 4318 --root "$HOME"
```

保持终端存活；不要在已托管同一 Hub 时另开此前台进程。未安装服务时，`wb start`/`wb open` 仍提供原有未托管后台模式。普通 `serve` 的随机端口不等于固定 4318。omp 的项目级服务器保持独立，不由 Hub service stop/uninstall 管理。

## 5. MCP 客户端与 Windows 边界

MCP 是客户端按需启动的独立 **stdio** 子进程，不是 Hub HTTP 服务；不存在 `/mcp` 网络入口。服务和客户端应使用相同用户、认证及 hubDir，但 MCP 的 `--root` 必须指向业务项目。

macOS/Linux/WSL 内客户端示例（将 Bun、CLI、项目换成真实绝对路径，不能依赖客户端 GUI 的 PATH 或 cwd）：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/workbench/src/cli/index.ts", "mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

自定义 hubDir 可按客户端支持的 `env` 字段设置 `WORKBENCH_HUB_DIR`；不要将 API key 写进服务配置。WSL 内客户端直接使用 Linux Bun，不要再套 wsl.exe。

Windows 原生客户端使用参数数组直接启动 WSL，无需 PowerShell 转发器：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "wsl.exe",
      "args": ["-d", "Ubuntu", "--exec", "/home/alice/.bun/bin/bun", "run", "/home/alice/code/workbench/src/cli/index.ts", "mcp", "--root", "/home/alice/code/project"]
    }
  }
}
```

必须与安装服务使用同一发行版及用户。非默认用户在 `--exec` 前添加 `"-u", "alice"`。所有 Bun、CLI、项目路径都是 Linux 路径，不使用 Windows 盘符。自定义 hubDir 示例：

```json
{
  "mcpServers": {
    "workbench": {
      "command": "wsl.exe",
      "args": ["-d", "Ubuntu", "-u", "alice", "--exec", "/usr/bin/env", "WORKBENCH_HUB_DIR=/home/alice/.workbench-hub-personal", "/home/alice/.bun/bin/bun", "run", "/home/alice/code/workbench/src/cli/index.ts", "mcp", "--root", "/home/alice/code/project"]
    }
  }
}
```

Windows 浏览器 HTTP/WebSocket 依赖 WSL2 localhost forwarding 及实际网络配置。在 PowerShell 检查：

```powershell
Invoke-RestMethod http://localhost:4318/api/health
```

再打开 `http://localhost:4318`，确认 Web 真实加载和 WebSocket 已连接。连接失败应检查发行版是否启动、用户服务是否 active/healthy、端口及 WSL 网络配置；不要以绑定 `0.0.0.0` 作为故障回退。登录、自动启动或网络测试失败不能标记为“已支持成功”。

## 6. 目标机器验收清单

使用空闲端口（如 14318）、独立临时 hubDir 和临时 Git 项目，所有命令明确传入同一 WORKBENCH_HUB_DIR，不操作用户原有服务：

1. 记录平台、Bun 版本；初始化临时项目，deploy → service status，确认 installed/active/healthy 全 true，再运行 deploy:check，逐项 PASS。
2. 浏览器确认实际 Web 而非 fallback，能添加/切换项目且 WebSocket 已连接；不必触发付费 Agent 任务。
3. `wb stop` 后至少等 6 秒，确认端口仍不可达；`wb open` 通过管理器恢复且只有一个 Hub；restart 后恢复健康。
4. 重复 install，确认健康 PID 不变。仅对专用测试 Hub 注入崩溃，确认管理器自动恢复；不要对真实任务进程操作。
5. macOS/Linux 重新登录后检查恢复；WSL 在 Windows 重启并重新进入该用户会话后检查。WSL 还需从 Windows 跑 HTTP 探针、浏览器及实际 MCP 客户端 initialize/tools/list/wb_list。
6. uninstall 后确认管理器不再注册且端口关闭，项目和 Hub 数据仍在，再清理自己创建的临时资源。

必须分别记录 macOS、真实 Linux systemd user 会话及真实 WSL2 的结果。无 systemd 容器或注入的管理器测试不能替代实机验收；不可达环境应标记“未验证”，不能宣称跨平台运行已证实。
