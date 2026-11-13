--!strict
-- View-layer regression: renders every page and every review state, then checks
-- that emitted action names, editor keys and node keys stay inside the host's
-- dispatch contract. Run standalone: luau tests/run-views.luau (the runner sets
-- a recording tern.ui stub); inside Tern the real tern.ui is used instead.
local ui = require("../lib/ui")
local reviewview = require("../lib/reviewview")
return function(tern, repo)
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    check(tern ~= nil and tern.ui ~= nil, "缺少 tern.ui")

    local SHA = string.rep("ab12", 16)
    local function buffer(text) return { text = text or "", cursor = utf8.len(text or ""), anchor = nil } end
    local function fields(names)
        local out = {}
        for _, name in names do out[name] = buffer("") end
        return out
    end
    local function copy(value)
        if type(value) ~= "table" then return value end
        local out = {}
        for k, v in value do out[copy(k)] = copy(v) end
        return out
    end
    local function requirement(id, number, stage, overrides)
        local r = {schemaVersion = 1, requirementId = id, projectId = "project-1", number = number, revision = 3,
            title = "登录过期时提供重新登录入口", type = "bug", priority = "high", stage = stage,
            goal = "会话过期后用户能明确看到入口并重新登录。", scope = "仅登录模块。",
            acceptanceCriteria = {{id = "C1", description = "过期后显示重新登录入口", required = true},
                {id = "C2", description = "重新登录后回到原页面", required = true}},
            labels = {"界面"}, createdAt = 1700000000000, updatedAt = 1700000000000}
        for k, v in overrides or {} do r[k] = v end
        return r
    end
    local function reviewsData()
        return {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 2,
            reviews = {
                {id = "review-aaa", source = "native_review", scope = "未提交改动", codeSnapshotSha256 = SHA,
                    requirementRevision = 3, createdAt = 1700000000000,
                    findings = {
                        {id = "finding-1", severity = "blocking", description = "过期后没有入口", createdAt = 1700000000000},
                        {id = "finding-2", severity = "minor", description = "文案不一致", createdAt = 1700000000000},
                    },
                    events = {
                        {id = "review-event-1", findingId = "finding-2", action = "resolved", reason = "已统一文案", at = 1700000001000},
                    }},
                {id = "review-bbb", source = "manual", scope = "登录模块", codeSnapshotSha256 = SHA,
                    requirementRevision = 3, createdAt = 1700000002000, findings = {}, events = {}},
            },
            acceptances = {}, reopenings = {}}
    end
    local function passedVerification()
        return {id = "verification-1", command = "node test.js", exitCode = 0, result = "passed", timedOut = false,
            requirementRevision = 3, codeSnapshotSha256 = SHA, criterionIds = {"C1", "C2"},
            startedAt = 1700000003000, endedAt = 1700000004000, stdoutPreview = "ok", stderrPreview = "",
            stdoutTruncated = false, stderrTruncated = false, evidencePath = "evidence/verification-1.json"}
    end
    local function baseState()
        local r1 = requirement("req-1", "R-001", "awaiting_acceptance")
        local r2 = requirement("req-2", "R-002", "implementing", {title = "补充会话续期", type = "feature", priority = "normal"})
        local design = {version = 1, sha256 = SHA, body = "# 方案\n内容", requirementRevision = 3, source = {kind = "manual"}}
        return {
            payload = {binding = {projectRoot = "/tmp/demo-project", sessionId = "session-1", instanceId = "instance-1",
                sourceMarker = "⚒ demo · ab12cd34"}, source = 7, window = "win-1", location = {distro = "Ubuntu", marker = "m"}},
            snapshot = {state = "idle", model = "test/model", recentEvents = {}},
            problem = nil, error = nil, receipt = nil, pending = nil, text = "", cursor = 0,
            ui = {tab = "acceptance", selected = "req-1", writable = true, loading = false, busy = false,
                project = {projectId = "project-1", name = "demo", root = "/tmp/demo-project"},
                requirements = {r1, r2}, byId = {["req-1"] = r1, ["req-2"] = r2},
                query = "", queryCursor = 0, sort = "recent", priorityFilter = "all", stageFilter = "all",
                privacyMode = "local", layout = "list", detailMode = true, formMode = false, mode = nil,
                fields = fields({"title", "goal", "scope", "criteria", "labels"}),
                type = "feature", priority = "normal", drafts = {},
                error = nil, notice = nil, storageUnsafe = false, takeoverAvailable = false,
                handoff = {tab = "design", panel = false, draftRequirement = "req-1", drafts = {}, draftOrder = {},
                    fields = fields({"paths", "excerpt", "proposal", "importPath", "comment", "directReason", "revokeReason", "ackReason"}),
                    includeRequirement = true, activity = "design", preview = nil, previewStale = false,
                    baseline = nil, baselineCheckedAt = nil, candidate = nil, importedFile = nil,
                    pending = nil, pendingSend = nil, sourceReceipt = nil, selectedVersion = nil, compareVersion = 0,
                    safe = true, workflowBusy = false, workflow = nil, selectedDesign = nil, compareDesign = nil,
                    approvalValid = false, approvalReason = nil, error = nil, notice = nil},
                trace = {fields = fields({"verifyCommand", "verifyCriteria", "newStep", "blockReason"}),
                    safe = true, busy = false, error = nil, notice = nil, pending = nil,
                    plan = {revision = 1, steps = {{id = "S1", title = "实现入口", status = "active", updatedAt = 1700000000000}}},
                    results = {baseline = {head = "abc123", fingerprint = SHA, files = {}, dirty = false,
                        requestId = "req-base", capturedAt = 1700000000000, filesTruncated = false},
                        changes = {head = "abc123", fingerprint = SHA, files = {}, commits = {}, diff = "",
                            capturedAt = 1700000000000, filesTruncated = false, commitsTruncated = false, diffTruncated = false},
                        verifications = {}}},
                review = {fields = fields({"reviewScope", "reviewFindings", "reviewReason", "reviewComment", "reviewReject", "reviewReopen", "auditQuery", "activityQuery", "findingDraft"}),
                    source = "native_review", finding = "", action = "resolved", panel = "", draftSeverity = "major",
                    safe = true, busy = false, data = reviewsData(), error = nil, notice = nil},
                audit = {busy = false, events = {}, eventsTruncated = false, markdown = "# 审计", exportPath = nil, error = nil, notice = nil},
                activity = {busy = false, events = {}, truncated = false, errors = 0, scanned = 2, exportPath = nil, error = nil, notice = nil}},
        }
    end

    -- Dispatch contract: everything the views emit must be handled by host.luau.
    local simpleActions = {prefill = true, reload = true, ["enable-edit"] = true, initialize = true, takeover = true,
        ["takeover-initialize"] = true, ["new-requirement"] = true, ["edit-requirement"] = true, ["save-requirement"] = true,
        back = true, ["back-workspace"] = true, ["prefill-selected"] = true, rebase = true, ["acknowledge-unknown"] = true, ["open-handoff"] = true,
        ["review-open-native"] = true, ["review-create"] = true, ["review-dispose"] = true, ["review-accept"] = true,
        ["review-reject"] = true, ["review-reopen"] = true, ["review-cancel"] = true, ["review-add-finding"] = true,
        ["handoff-preview"] = true, ["handoff-baseline"] = true, ["handoff-prefill"] = true, ["handoff-send"] = true,
        ["handoff-candidate"] = true, ["handoff-import-file"] = true, ["handoff-import-file-content"] = true,
        ["handoff-import-candidate"] = true, ["handoff-adopt"] = true, ["handoff-comment"] = true, ["handoff-approve"] = true,
        ["handoff-revoke"] = true, ["handoff-authorize-direct"] = true, ["handoff-end-wait"] = true, ["handoff-prepare"] = true,
        ["results-refresh-changes"] = true, ["results-run-verification"] = true, ["results-plan-add"] = true, ["results-plan-generate"] = true,
        ["audit-refresh"] = true, ["audit-copy"] = true, ["audit-write"] = true,
        ["activity-refresh"] = true, ["activity-write"] = true}
    local changeNames = {rvSource = true, rvAction = true, draftSeverity = true, type = true, priority = true, sort = true,
        layout = true, priorityFilter = true, stageFilter = true, activity = true, includeRequirement = true, selectedVersion = true,
        compareVersion = true, privacyMode = true}
    local fieldKeys = {reviewScope = true, reviewFindings = true, reviewReason = true, reviewComment = true,
        reviewReject = true, reviewReopen = true, auditQuery = true, activityQuery = true, findingDraft = true,
        verifyCommand = true, verifyCriteria = true, newStep = true, blockReason = true,
        materials = true, search = true, diff = true}
    local function validAction(act)
        if type(act) ~= "string" then return false end
        if simpleActions[act] then return true end
        local name = act:match("^change:([%w%-_]+)=")
        if name then return changeNames[name] or name:match("^status%-%d+$") ~= nil end
        if act:match("^wb%-open%-[%w%-_]+$") then return true end
        if act:match("^requirement=.+$") then return true end
        if act:match("^review%-toggle=") then return act == "review-toggle=reject" or act == "review-toggle=reopen" or act == "review-toggle=dispose" end
        if act:match("^review%-inline=.+$") then return true end
        if act:match("^review%-remove%-finding=%d+$") then return true end
        if act:match("^review%-pick=.+$") then return true end
        return false
    end
    local function validFieldKey(key)
        if type(key) ~= "string" then return false end
        if fieldKeys[key] then return true end
        return key:match("^f%-[%w]+$") ~= nil or key:match("^h%-[%w]+$") ~= nil
    end
    local function walk(n, visit)
        if type(n) ~= "table" then return end
        if n.k then visit(n) end
        for _, child in n.c or {} do walk(child, visit) end
        if n.k == "table" and n.p and n.p.rows then
            for _, row in n.p.rows do
                for _, cell in row.cells or {} do
                    if type(cell) == "table" and cell.button then visit({k = "cellButton", p = cell.button}) end
                end
            end
        end
    end
    local function validateTree(label, root)
        local keys, seen = {}, {}
        walk(root, function(n)
            local p = n.p or {}
            if type(p.key) == "string" then
                if seen[p.key] then table.insert(keys, p.key) end
                seen[p.key] = true
            end
            local act = p.actions and p.actions.click or p.act
            if act ~= nil then check(validAction(act), label .. ": 未接入宿主的动作 " .. tostring(act)) end
            if n.k == "editor" or n.k == "input" then
                check(validFieldKey(p.key), label .. ": 无法路由的输入键 " .. tostring(p.key))
            end
        end)
        check(#keys == 0, label .. ": 重复节点键 " .. table.concat(keys, ", "))
        walk(root, function(n)
            if n.k ~= "card" then return end
            local primaries = 0
            local function rec(m)
                if type(m) ~= "table" or not m.k then return end
                if m.k == "card" and m ~= n then return end
                local p = m.p or {}
                if (m.k == "button" or m.k == "cellButton") and p.variant == "primary" and p.on ~= true then primaries += 1 end
                for _, c in m.c or {} do rec(c) end
            end
            for _, c in n.c or {} do rec(c) end
            check(primaries <= 1, label .. ": 卡片 " .. tostring(n.p and n.p.key) .. " 有 " .. tostring(primaries) .. " 个主按钮")
        end)
    end
    local function findByKey(root, key)
        local found
        walk(root, function(n) if n.p and n.p.key == key then found = n end end)
        return found
    end
    local function render(label, mutate, assertFn)
        local s = copy(baseState())
        if mutate then mutate(s) end
        local ok, view = pcall(reviewview.build, s)
        check(ok, label .. ": reviewview.build 失败 " .. tostring(ok and "" or view))
        if not ok then return end
        validateTree(label, view)
        local okFull, full = pcall(ui.build, s)
        check(okFull, label .. ": ui.build 失败 " .. tostring(okFull and "" or full))
        if okFull then validateTree(label .. "/full", full) end
        if assertFn then assertFn(s, view) end
    end

    render("未选择需求", function(s) s.ui.selected = nil end, function(_, view)
        check(findByKey(view, "acceptance") == nil, "未选择需求时不应渲染验收卡")
    end)
    render("只读", function(s) s.ui.writable = false end, function(_, view)
        for _, key in {"review-create", "review-accept", "review-add-finding"} do
            local node = findByKey(view, key)
            check(node ~= nil and node.p.disabled ~= false and node.p.disabled ~= nil, "只读时 " .. key .. " 应禁用")
        end
    end)
    render("空审查无快照", function(s)
        s.ui.review.data = {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 0,
            reviews = {}, acceptances = {}, reopenings = {}}
        s.ui.trace.results = nil
    end, function(_, view)
        local record = findByKey(view, "recordCard")
        check(record ~= nil and record.p.collapsed == false, "无审查记录时记录卡应展开")
        local accept = findByKey(view, "review-accept")
        check(accept ~= nil and accept.p.disabled ~= false, "无快照时接受应禁用")
    end)
    render("阻断未处置", nil, function(_, view)
        check(findByKey(view, "findingsTablereview-aaa") ~= nil, "应渲染发现表格")
        local accept = findByKey(view, "review-accept")
        check(accept ~= nil and accept.p.disabled ~= false, "阻断未处置时接受应禁用")
        local record = findByKey(view, "recordCard")
        check(record ~= nil and record.p.collapsed == true, "已有审查时记录卡应折叠")
    end)
    render("处置面板", function(s)
        s.ui.review.panel = "dispose"
        s.ui.review.finding = "review-aaa|finding-1"
    end, function(_, view)
        check(findByKey(view, "dispositionPanel") ~= nil, "应渲染内联处置面板")
        check(findByKey(view, "review-dispose") ~= nil, "处置面板应有确认按钮")
        check(findByKey(view, "rvActionField") ~= nil, "处置面板应有处置方式选择")
    end)
    render("门禁通过", function(s)
        s.ui.review.data.reviews[1].events = {
            {id = "review-event-1", findingId = "finding-2", action = "resolved", reason = "已统一文案", at = 1700000001000},
            {id = "review-event-2", findingId = "finding-1", action = "waived", reason = "风险已接受", at = 1700000002000},
        }
        s.ui.trace.results.verifications = {passedVerification()}
    end, function(_, view)
        local accept = findByKey(view, "review-accept")
        check(accept ~= nil and accept.p.disabled == false, "门禁通过时接受应可用")
        check(findByKey(view, "reviewComment") ~= nil, "门禁通过时应显示验收说明输入")
    end)
    render("驳回面板", function(s) s.ui.review.panel = "reject" end, function(_, view)
        check(findByKey(view, "rejectPanel") ~= nil, "应渲染驳回面板")
        check(findByKey(view, "reviewReject") ~= nil, "驳回面板应有原因输入")
        check(findByKey(view, "reviewReopen") == nil, "未打开重开面板时不应渲染重开输入")
    end)
    render("重开面板", function(s)
        s.ui.byId["req-1"].stage = "done"
        s.ui.review.panel = "reopen"
        s.ui.review.data.acceptances = {{id = "acceptance-1", decision = "accepted", requirementRevision = 3,
            codeSnapshotSha256 = SHA, verificationIds = {}, reviewIds = {}, comment = "", createdAt = 1700000005000}}
    end, function(_, view)
        check(findByKey(view, "reopenPanel") ~= nil, "应渲染重开面板")
        check(findByKey(view, "historyCard") ~= nil, "有验收历史时应渲染历史卡")
    end)
    render("无效草稿行", function(s)
        s.ui.review.fields.reviewFindings = buffer("这行没有严重度\n")
    end, function(_, view)
        local manual = findByKey(view, "manualFindings")
        check(manual ~= nil and manual.p.collapsed == false, "无效行时手动编辑应展开")
    end)
    render("忙碌", function(s) s.ui.review.busy = true end, function(_, view)
        local accept = findByKey(view, "review-accept")
        check(accept ~= nil and accept.p.disabled ~= false, "忙碌时接受应禁用")
    end)
    render("连接异常", function(s) s.problem = "来源证明已断开" end, function(_, view)
        local native = findByKey(view, "review-open-native")
        check(native ~= nil and native.p.disabled ~= false, "连接异常时原生预填应禁用")
    end)
    render("草稿发现列表", function(s)
        s.ui.review.fields.reviewFindings = buffer("blocking|过期后没有入口\nminor|文案不一致\n")
        s.ui.review.fields.findingDraft = buffer("新的问题")
    end, function(_, view)
        check(findByKey(view, "draftFindings") ~= nil, "应渲染草稿发现表格")
        local add = findByKey(view, "review-add-finding")
        check(add ~= nil and add.p.disabled == false, "有描述时添加应可用")
    end)

    -- Whole-page smoke for every tab, plus the error/empty key-collision cases.
    local function page(label, mutate)
        local s = copy(baseState())
        if mutate then mutate(s) end
        local ok, view = pcall(ui.build, s)
        check(ok, label .. ": ui.build 失败 " .. tostring(ok and "" or view))
        if ok then validateTree(label, view) end
    end
    page("需求列表", function(s) s.ui.tab = "requirements"; s.ui.detailMode = false end)
    page("需求列表-看板", function(s) s.ui.tab = "requirements"; s.ui.layout = "board"; s.ui.detailMode = false end)
    page("需要处理", function(s)
        s.ui.tab = "requirements"; s.ui.detailMode = false
        s.ui.attention = {items = {{requirementId = "req-1", number = "R-001", title = "需求一",
            reasons = {"缺少当前代码快照", "有 1 项阻断发现未处置"}, rank = 4, tone = "warning"}},
            actionable = 1, errors = 0, scanned = 2, truncated = false}
    end)
    page("工作区-需求", function(s) s.ui.tab = "requirement"; s.ui.detailMode = true end)
    page("工作区-需求表单", function(s)
        s.ui.tab = "requirement"; s.ui.detailMode = true; s.ui.formMode = true; s.ui.mode = "new"; s.ui.dirty = true
    end)
    page("工作区-未选择需求", function(s) s.ui.tab = "requirement"; s.ui.detailMode = true; s.ui.selected = nil end)
    page("初始化", function(s) s.ui.tab = "requirements"; s.ui.detailMode = false; s.ui.project = nil; s.ui.requirements = {}; s.ui.byId = {}; s.ui.selected = nil end)
    page("锁错误与初始化并存", function(s)
        s.ui.tab = "requirements"; s.ui.detailMode = false; s.ui.project = nil; s.ui.requirements = {}; s.ui.byId = {}; s.ui.selected = nil
        s.ui.error = "上次的工作台实例留下了过期写锁"; s.ui.takeoverAvailable = true
    end)
    page("空需求只读", function(s) s.ui.tab = "requirements"; s.ui.detailMode = false; s.ui.requirements = {}; s.ui.byId = {}; s.ui.selected = nil; s.ui.writable = false end)
    page("工作区-方案", function(s) s.ui.tab = "design"; s.ui.detailMode = true end)
    page("工作区-准备交接", function(s)
        s.ui.tab = "design"; s.ui.detailMode = true; s.ui.handoff.panel = true
    end)
    page("工作区-准备交接预览", function(s)
        s.ui.tab = "requirement"; s.ui.detailMode = true; s.ui.handoff.panel = true
        s.ui.handoff.preview = {text = "工作台请求：设计\n需求：R-001", sha256 = SHA, requirementId = "req-1",
            requirementRevision = 3, activity = "design", sources = {}, designVersion = 0}
    end)
    page("工作区-方案", function(s)
        s.ui.tab = "design"
        local h = s.ui.handoff
        h.tab = "design"
        h.workflow = {designs = {{version = 1, sha256 = SHA, body = "# 方案", requirementRevision = 3, source = {kind = "manual"}}},
            latestVersion = 1, comments = {{designVersion = 1, text = "评论", createdAt = 1700000000000}}, approvals = {}}
        h.selectedDesign = h.workflow.designs[1]
        h.selectedVersion = 1
    end)
    page("工作区-批准", function(s)
        s.ui.tab = "design"
        s.ui.detailMode = true
        local h = s.ui.handoff
        h.tab = "approval"
        h.workflow = {designs = {}, latestVersion = 0, comments = {}, approvals = {},
            approval = {mode = "design", requirementRevision = 3, designVersion = 1, approvedAt = 1700000000000}}
        h.approvalValid = true
        h.baseline = {head = "abc123", fingerprint = "fp", dirty = false}
        h.baselineCheckedAt = 1700000000000
    end)
    page("工作区-交付", function(s) s.ui.tab = "delivery"; s.ui.detailMode = true end)
    page("工作区-验收", function(s) s.ui.tab = "acceptance"; s.ui.detailMode = true end)
    page("工作区-历史", function(s)
        s.ui.tab = "history"; s.ui.detailMode = true
        s.ui.audit.events = {{at = 1700000000000, kind = "需求", summary = "创建需求", ref = ""}}
    end)
    page("活动", function(s)
        s.ui.tab = "activity"; s.ui.detailMode = false
        s.ui.activity.events = {{at = 1700000000000, kind = "需求", summary = "创建需求", ref = "", requirement = "R-001"}}
        s.ui.activity.scanned = 2
    end)
    page("会话", function(s) s.ui.tab = "session"; s.ui.detailMode = false end)

    -- Preparation panel: opening shows distinct Prefill and Send actions; closing
    -- removes them; a busy session keeps the preview but disables sending.
    local prepared = copy(baseState())
    prepared.ui.tab, prepared.ui.detailMode, prepared.ui.handoff.panel = "design", true, true
    prepared.ui.handoff.preview = {text = "工作台请求：设计\n需求：R-001", sha256 = SHA, requirementId = "req-1",
        requirementRevision = 3, activity = "design", sources = {}, designVersion = 0}
    local preparedView = ui.build(prepared)
    check(findByKey(preparedView, "handoff-prefill") ~= nil, "准备交接应提供只预填动作")
    check(findByKey(preparedView, "handoff-send") ~= nil, "准备交接应提供明确发送动作")
    check(findByKey(preparedView, "handoff-send").p.disabled == false, "空闲会话中预览可发送")
    local busy = copy(prepared)
    busy.snapshot = {state = "working", recentEvents = {}}
    check(findByKey(ui.build(busy), "handoff-send").p.disabled ~= false, "会话忙碌时不得发送")
    local closed = copy(prepared)
    closed.ui.handoff.panel = false
    check(findByKey(ui.build(closed), "handoff-prefill") == nil, "面板关闭时不应出现发送动作")

    -- Approval diff: changed content is a warning, identical content is muted,
    -- and an unreadable snapshot is explicitly unavailable.
    local diffState = copy(baseState())
    diffState.ui.tab, diffState.ui.detailMode = "design", true
    diffState.ui.handoff.tab = "approval"
    local diffRequirement = diffState.ui.byId["req-1"]
    local function snapshot(title)
        return {title, diffRequirement.type, diffRequirement.priority, diffRequirement.goal, diffRequirement.scope,
            {{"C1", "过期后显示重新登录入口", true}, {"C2", "重新登录后回到原页面", true}}, {"界面"}}
    end
    local function approval(content)
        return {id = "approval-1", mode = "design", requirementRevision = 3, designVersion = 1,
            designSha256 = SHA, latestVersion = 1, requirementSha256 = SHA, requirementContent = content,
            baseline = {head = "abc", fingerprint = SHA, dirty = false}, approvedAt = 0}
    end
    local function diffWorkflow(content)
        return {designs = {{version = 1, sha256 = SHA, requirementSha256 = SHA, requirementRevision = 3, createdAt = 0}},
            latestVersion = 1, comments = {}, approvals = {}, approval = approval(content)}
    end
    diffState.ui.handoff.selectedDesign = {version = 1, sha256 = SHA, body = "方案", requirementRevision = 3}
    diffState.ui.handoff.workflow = diffWorkflow(tern.json.encode(snapshot("旧标题")))
    local changed = ui.build(diffState)
    check(findByKey(changed, "approvalDiff") ~= nil, "批准页应显示与上次批准的差异")
    check(findByKey(changed, "approvalDiff").p.tone == "warning", "内容变化时差异卡应为警告态")
    diffState.ui.handoff.workflow = diffWorkflow(tern.json.encode(snapshot(diffRequirement.title)))
    check(findByKey(ui.build(diffState), "approvalDiff").p.tone == "muted", "内容一致时差异卡不应警告")
    diffState.ui.handoff.workflow = diffWorkflow("not-json")
    check(findByKey(ui.build(diffState), "approvalDiff").p.tone == "warning", "无法比较时必须明示而不是当作无变化")

    return {checks = checks, failures = failures}
end