import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit


class DeployError(Exception):
    pass


def run(args, *, env=None, cwd=None, label=None):
    try:
        result = subprocess.run(args, env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        raise DeployError(f"Required executable not found: {args[0]}") from None
    if result.returncode:
        name = label or " ".join(args[:2])
        # Node CLI diagnostics may include data from the pairing config.
        output = "" if label else result.stderr.decode(errors="replace").strip()
        raise DeployError(f"{name} failed (exit {result.returncode})" + (f": {output}" if output else ""))
    return result.stdout


def absolute_path(value, name):
    if not isinstance(value, str) or not value.startswith("/") or re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        raise DeployError(f"Invalid absolute Linux path: {name}")
    return Path(value)


def read_json(path):
    with path.open(encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, dict):
        raise DeployError(f"Expected an object in {path.name}")
    return value


class Installation:
    def __init__(self, request):
        self.hub_dir = absolute_path(request.get("nodeHubDir") or str(Path.home() / ".workbench-hub"), "nodeHubDir").resolve()
        self.node_id = request["nodeId"]
        record = read_json(self.hub_dir / "node-service.json")
        config = read_json(self.hub_dir / "node.json")
        if config.get("schemaVersion") != 1 or config.get("nodeId") != self.node_id:
            raise DeployError("Node is not paired with the configured nodeId; check the existing node.json")
        token = config.get("token")
        try:
            url = config["hubUrl"]
            if not isinstance(url, str):
                raise DeployError("Invalid Hub URL in node.json")
            url = url.strip()
            hub_url = urlsplit(url if re.match(r"^[a-z]+://", url, re.I) else "http://" + url)
            valid = hub_url.scheme in ("http", "https", "ws", "wss") and hub_url.hostname and not hub_url.username and not hub_url.password
        except (KeyError, ValueError, TypeError):
            valid = False
        if not valid or not isinstance(token, str) or not token.strip():
            raise DeployError("Node pairing requires a valid Hub URL and an existing token in node.json")
        self.bun = absolute_path(record.get("bunPath"), "bunPath")
        self.cli = absolute_path(record.get("cliPath"), "cliPath")
        canonical_cli = self.cli.resolve(strict=True)
        self.root = canonical_cli.parents[2] if len(canonical_cli.parents) >= 3 else None
        if self.root is None or canonical_cli.relative_to(self.root).as_posix() != "src/cli/index.ts" or not canonical_cli.is_file():
            raise DeployError("Installed CLI is not src/cli/index.ts in a fixed Workbench checkout")
        if not self.bun.is_file() or not os.access(self.bun, os.X_OK):
            raise DeployError(f"Installed Bun is missing or not executable: {self.bun}")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k.lower() not in ("http_proxy", "https_proxy", "all_proxy", "no_proxy")}
        self.env.update(record.get("proxyEnv") or {})
        self.env.update(WORKBENCH_HUB_DIR=str(self.hub_dir), PATH=record["path"])
        self.env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        self.env.setdefault("DBUS_SESSION_BUS_ADDRESS", f"unix:path={self.env['XDG_RUNTIME_DIR']}/bus")
        try:
            self.run(["systemctl", "--user", "show-environment"])
        except DeployError as error:
            raise DeployError(f"WSL systemd user bus unavailable: {error}") from None
        self.status = self.node("status")
        if (not self.status.get("configured") or not self.status.get("installed") or self.status.get("manager") != "systemd"
                or self.status.get("nodeId") != self.node_id or self.status.get("serviceId") != record.get("id")
                or not isinstance(self.status.get("active"), bool) or not isinstance(self.status.get("connected"), bool)):
            raise DeployError("Expected an installed, configured systemd user node with the requested nodeId")
        unit = self.run(["systemctl", "--user", "show", record["id"], "--property=LoadState,ActiveState"])
        if b"LoadState=loaded\n" not in unit or not any(line.startswith(b"ActiveState=") for line in unit.splitlines()):
            raise DeployError("The installed node systemd unit is not loaded or its state is unavailable")
        active = any(b"ActiveState=" + state in unit.splitlines() for state in (b"active", b"activating", b"reloading", b"deactivating"))
        if active != self.status["active"]:
            raise DeployError("Node service state changed during preflight; retry")

    def run(self, args, **options):
        return run(args, env=self.env, cwd=self.root, **options)

    def git(self, *args):
        return self.run(["git", *args])

    def node(self, action):
        result = self.run([str(self.bun), str(self.cli), "node", action, "--json"], label=f"wb node {action}; inspect the node installation in WSL")
        try:
            value = json.loads(result)
        except (ValueError, UnicodeError):
            raise DeployError(f"wb node {action} did not return valid JSON") from None
        if not isinstance(value, dict):
            raise DeployError(f"wb node {action} did not return a status object")
        return value

    def checkout(self, expected=None):
        if Path(os.fsdecode(self.git("rev-parse", "--show-toplevel").rstrip(b"\n"))).resolve() != self.root:
            raise DeployError("Installed CLI is not in the root Workbench Git checkout")
        for marker in ("MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"):
            if (self.root / os.fsdecode(self.git("rev-parse", "--git-path", marker).rstrip(b"\n"))).exists():
                raise DeployError(f"Git operation in progress in WSL checkout: {marker}")
        if self.git("status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"):
            raise DeployError(f"Dirty Git checkout: {self.root}")
        revision = self.git("rev-parse", "--verify", "HEAD").decode().strip()
        if not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", revision):
            raise DeployError("Invalid Git HEAD in WSL checkout")
        if expected is not None and revision != expected:
            raise DeployError(f"WSL Git HEAD changed: expected {expected}, found {revision}")
        return revision

    def release(self, request):
        previous, revision = request["previous"], request["revision"]
        for value in (previous, revision):
            if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", value):
                raise DeployError("Invalid release Git revision")
        if request["root"] != str(self.root):
            raise DeployError("WSL installation checkout changed during deployment")
        self.checkout(previous)
        return previous, revision

    def check_fast_forward(self, previous, revision):
        if previous == revision:
            return
        if self.git("rev-parse", "--is-shallow-repository").strip() == b"true":
            raise DeployError("Cannot deploy between different HEADs to a shallow WSL checkout")
        self.git("merge-base", "--is-ancestor", previous, revision)
        if self.git("rev-parse", "--verify", "FETCH_HEAD").decode().strip() != revision:
            raise DeployError("WSL FETCH_HEAD no longer matches the verified bundle")
        # Compare byte paths so even filenames not representable as UTF-8 are protected.
        incoming = set(self.git("diff", "--name-only", "-z", "--no-renames", "--diff-filter=AT", previous, revision).split(b"\0"))
        ignored = set(self.git("ls-files", "--others", "--ignored", "--exclude-standard", "-z").split(b"\0"))
        incoming.discard(b"")
        ignored.discard(b"")
        for names, other in ((incoming, ignored), (ignored, incoming)):
            for name in names:
                prefix = name
                while prefix:
                    if prefix in other:
                        raise DeployError(f"Fast-forward would overlap a local ignored path: {os.fsdecode(prefix)!r}")
                    prefix = prefix.rpartition(b"/")[0]

    def import_bundle(self, request):
        previous, revision = self.release(request)
        if previous == revision:
            raise DeployError("No incremental bundle needed for an unchanged revision")
        expected = request["sha256"]
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise DeployError("Invalid Git bundle SHA-256")
        # Only FETCH_HEAD persists across calls; no temporary directory or path crosses SSH.
        with tempfile.TemporaryDirectory(prefix="workbench-deploy-", dir="/tmp") as directory:
            bundle = str(Path(directory) / "release.bundle")
            checksum = hashlib.sha256()
            with open(bundle, "xb") as f:
                for line in sys.stdin.buffer:
                    data = base64.b64decode(line.strip(), validate=True)
                    checksum.update(data)
                    f.write(data)
            if not hmac.compare_digest(expected, checksum.hexdigest()):
                raise DeployError("Git bundle SHA-256 mismatch")
            self.git("bundle", "verify", bundle)
            if self.git("bundle", "list-heads", bundle).decode().strip() != f"{revision} HEAD":
                raise DeployError("Git bundle does not advertise the pinned HEAD")
            self.git("fetch", "--no-tags", "--no-recurse-submodules", bundle, "HEAD")
            self.check_fast_forward(previous, revision)
        return {"revision": revision}


def main(request):
    phase = request["phase"]
    node = Installation(request)
    if phase == "probe":
        return {"root": str(node.root), "revision": node.checkout(), "active": node.status["active"],
                "connected": node.status["connected"], "shallow": node.git("rev-parse", "--is-shallow-repository").strip() == b"true"}
    if phase == "import":
        return node.import_bundle(request)
    if phase == "stop":
        previous, revision = node.release(request)
        node.check_fast_forward(previous, revision)
        if node.status["active"] != request["active"] or (node.status["active"] and not node.status["connected"]):
            raise DeployError("Node service or connection state changed after the idle check; retry before stopping it")
        stopped = node.node("stop")
        if stopped.get("active") is not False:
            raise DeployError("Node service did not stop")
        return {"active": False}
    if phase == "update":
        previous, revision = node.release(request)
        if node.status["active"]:
            raise DeployError("WSL node must be stopped before updating its checkout")
        node.check_fast_forward(previous, revision)
        if previous != revision:
            node.git("-c", "submodule.recurse=false", "merge", "--ff-only", "--no-overwrite-ignore", revision)
        try:
            node.checkout(revision)
            node.run([str(node.bun), "install", "--production", "--frozen-lockfile"], label="Bun frozen production install")
        except DeployError as error:
            raise DeployError(f"WSL checkout at {revision}, node stopped: {error}") from None
        return {"revision": revision}
    if phase == "start":
        node.release(request)
        started = node.node("start")
        if started.get("installed") is not True or started.get("active") is not True:
            raise DeployError("Managed WSL node is not active after start")
        return {"active": True}
    raise DeployError("Unknown WSL deployment phase")


try:
    os.umask(0o077)
    request = json.loads(base64.b64decode(sys.stdin.buffer.readline().strip(), validate=True))
    print("WB_DEPLOY_RESULT " + json.dumps(main(request)), flush=True)
except (DeployError, OSError) as error:
    print(f"WSL deployment: {error}", file=sys.stderr, flush=True)
    sys.exit(1)
except (KeyError, ValueError, TypeError):
    print("WSL deployment: invalid deployment data or installation JSON", file=sys.stderr, flush=True)
    sys.exit(1)
