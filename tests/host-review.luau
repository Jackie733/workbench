--!strict
-- Host interaction regression for the review UI pilot: drives the real
-- host.luau event/key handlers against an in-memory filesystem and KV, and
-- checks the new draft/panel actions, their guards, and reload persistence.
-- Storage-writing actions are intentionally out of scope here; they keep their
-- existing code paths and are covered by the native storage tests.
return function(tern, def, cx, payloadJson, modules)
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function event(s, ev) def.event(s, ev, cx) end
    local function action(s, act) event(s, {ev = "action", act = act}) end

    local s = def.init(cx, {payloadJson}, nil)
    check(s.ui ~= nil, "init 应建立界面状态")
    check(#s.ui.requirements == 3, "应读取到三项需求")
    check(s.ui.writable == false, "打开先只读")
    check(s.ui.review ~= nil and s.ui.review.fields.findingDraft ~= nil, "findingDraft 字段应存在")

    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-1"})
    check(s.ui.selected == "req-1", "应选择需求")
    check(s.ui.tab == "requirement" and s.ui.detailMode == true, "选择需求应进入工作区需求页")
    check(s.ui.attention ~= nil and type(s.ui.attention.items) == "table", "打开后应派生需要处理投影")
    check(s.ui.attention.actionable >= 1, "待验收需求缺少代码快照时应出现在需要处理")
    check(#s.ui.activity.events > 0, "打开后应汇总跨需求事件")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "acceptance"})
    check(s.ui.tab == "acceptance" and s.ui.detailMode == true, "工作区标签应切换到验收")
    local v = s.ui.review
    check(v.data ~= nil and #v.data.reviews == 2, "审查记录应加载")

    action(s, "back-workspace")
    check(s.ui.tab == "requirements" and s.ui.detailMode == false, "返回应回到需求数据集")
    check(s.ui.selected == "req-1", "返回应保留选中项")
    action(s, "change:layout=board")
    check(s.ui.layout == "board", "布局切换应生效")
    -- Plain nodes (board/attention cards) get act/value split by Tern; the host
    -- must still route the joined vocabulary.
    event(s, {ev = "action", act = "change:layout", value = "list"})
    check(s.ui.layout == "list", "分裂的布局动作应生效")
    event(s, {ev = "action", act = "change:layout", value = "board"})
    event(s, {ev = "action", act = "requirement", value = "req-1"})
    check(s.ui.selected == "req-1" and s.ui.tab == "requirement", "看板卡片点击应打开需求工作区")
    -- Drafts belong to their requirement: switching must not carry text across.
    s.ui.handoff.fields.paths.text = "src/login.ts"
    v.fields.lifecycleReason.text = "等待外部接口确认"
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-2"})
    check(s.ui.selected == "req-2" and s.ui.handoff.fields.paths.text == "", "切换需求不得带入另一项需求的资料草稿")
    check(v.fields.lifecycleReason.text == "", "生命周期原因不得泄漏到另一需求")
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-1"})
    check(s.ui.handoff.fields.paths.text == "src/login.ts", "切回需求应恢复其草稿")
    check(v.fields.lifecycleReason.text == "等待外部接口确认", "切回需求应恢复生命周期原因草稿")
    check(s.ui.handoff.drafts["req-2"] ~= nil, "切换时应保存原需求草稿")
    -- The preparation panel only toggles; opening it creates no request.
    local requestsBefore = #(s.ui.handoff.workflow and s.ui.handoff.workflow.requests or {})
    action(s, "handoff-prepare")
    check(s.ui.handoff.panel == true, "准备交接应打开面板")
    check(#(s.ui.handoff.workflow and s.ui.handoff.workflow.requests or {}) == requestsBefore
        and s.ui.handoff.pendingSend == nil, "打开准备交接不得创建请求或发送")
    action(s, "handoff-prepare")
    check(s.ui.handoff.panel == false, "再次点击应收起面板")
    action(s, "wb-open-design-materials")
    check(s.ui.tab == "design" and s.ui.handoff.panel == true, "资料步骤应打开准备交接面板")
    action(s, "back-workspace")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "activity"})
    check(s.ui.tab == "activity" and s.ui.detailMode == false, "活动是全局目的地")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "session"})
    check(s.ui.tab == "session", "会话是全局目的地")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "definition"})
    check(s.ui.tab == "session", "未知标签不应切换页面")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "acceptance"})

    action(s, "review-toggle=reject")
    check(v.panel == "reject", "toggle 应打开驳回面板")
    action(s, "review-toggle=reject")
    check(v.panel == "", "再次 toggle 应关闭面板")
    action(s, "review-toggle=bogus")
    check(v.panel == "", "未知面板名应被忽略")

    action(s, "review-inline=review-aaa|finding-1")
    check(v.finding == "review-aaa|finding-1" and v.panel == "dispose", "inline 应选中发现并打开处置面板")
    action(s, "review-inline=review-aaa|finding-missing")
    check(v.finding == "review-aaa|finding-1", "未知发现不应改变选择")
    action(s, "review-cancel")
    check(v.panel == "", "cancel 应关闭面板")

    action(s, "change:draftSeverity=blocking")
    check(v.draftSeverity == "blocking", "draftSeverity 应可切换")
    action(s, "change:draftSeverity=bogus")
    check(v.draftSeverity == "blocking", "非法严重度应被忽略")

    s.ui.writable = true
    v.fields.findingDraft.text = "过期后没有入口"
    v.fields.findingDraft.cursor = utf8.len(v.fields.findingDraft.text)
    action(s, "review-add-finding")
    check(v.fields.reviewFindings.text == "blocking|过期后没有入口\n", "添加发现应序列化进既有草稿字段")
    check(v.fields.findingDraft.text == "", "添加后应清空描述输入")

    s.focusTarget, s.focusId = "findingDraft", "main.workbench.findingDraft"
    v.fields.findingDraft.text = "文案不一致"
    v.fields.findingDraft.cursor = utf8.len(v.fields.findingDraft.text)
    local handled = def.key(s, {name = "enter", ctrl = false, meta = false, shift = false, alt = false}, cx)
    check(handled == true, "回车应触发添加")
    check(v.fields.reviewFindings.text == "blocking|过期后没有入口\nblocking|文案不一致\n", "回车添加应使用当前严重度")

    v.fields.findingDraft.text = ""
    action(s, "review-add-finding")
    check(v.error ~= nil and v.fields.reviewFindings.text:find("文案不一致") ~= nil, "空描述应拒绝且不改动草稿")
    v.error = nil
    v.fields.findingDraft.text = "第一行\n第二行"
    action(s, "review-add-finding")
    check(v.error ~= nil, "多行描述应拒绝")
    v.error = nil
    v.fields.findingDraft.text = string.rep("x", 4001)
    action(s, "review-add-finding")
    check(v.error ~= nil, "超长描述应拒绝")
    v.error = nil
    v.fields.findingDraft.text = ""

    action(s, "review-remove-finding=1")
    check(v.fields.reviewFindings.text == "blocking|文案不一致\n", "移除应按行号重建草稿")
    action(s, "review-remove-finding=9")
    check(v.fields.reviewFindings.text == "blocking|文案不一致\n", "越界移除不应改动草稿")

    s.ui.writable = false
    v.fields.findingDraft.text = "只读尝试"
    action(s, "review-add-finding")
    check(v.error ~= nil and v.fields.reviewFindings.text == "blocking|文案不一致\n", "只读时添加应拒绝")
    s.ui.writable = true
    v.error = nil
    v.fields.findingDraft.text = ""

    event(s, {ev = "select", id = "main.workbench.findingsTablereview-aaa", item = "review-aaa|finding-2"})
    check(v.finding == "review-aaa|finding-2", "表格行选择应更新当前发现")
    action(s, "change:rvAction=waived")
    check(v.action == "waived", "处置方式应可切换")

    v.fields.reviewReason.text = ""
    action(s, "review-dispose")
    check(v.error ~= nil and v.error:find("处置理由") ~= nil, "无理由处置应拒绝")
    v.error = nil
    action(s, "review-create")
    check(v.error ~= nil and v.error:find("快照") ~= nil, "无快照记录审查应拒绝")
    v.error = nil

    v.panel = "dispose"
    v.fields.reviewFindings.text = "blocking|过期后没有入口\n"
    local saved = def.save(s)
    local revived = def.init(cx, {payloadJson}, saved)
    check(revived.ui.tab == "acceptance" and revived.ui.detailMode == true, "重载应恢复工作区标签")
    check(revived.ui.layout == "board", "重载应恢复列表/看板布局")
    check(revived.ui.selected == "req-1", "重载应恢复选中需求")
    check(revived.ui.review.panel == "dispose", "重载应恢复面板状态")
    check(revived.ui.review.draftSeverity == "blocking", "重载应恢复草稿严重度")
    check(revived.ui.review.fields.reviewFindings.text == "blocking|过期后没有入口\n", "重载应恢复发现草稿")

    check(revived.ui.review.fields.lifecycleReason.text == "等待外部接口确认", "重载应恢复本需求生命周期原因草稿")
    -- Readiness is derived at render time from the same gate inputs, and it is
    -- read-only: missing snapshots stay unknown, matching evidence becomes ready.
    local context = require("../lib/context")
    local requirement = s.ui.byId["req-1"]
    local snapshot = s.ui.review.data.reviews[1].codeSnapshotSha256
    local revisionBefore = requirement.revision
    local reading = context.readiness(requirement, s.ui)
    check(reading ~= nil and reading.state == "unknown", "缺少代码快照时 readiness 不得显示可以验收")
    check(requirement.revision == revisionBefore, "readiness 不改变需求修订")
    s.ui.trace.results.changes = {head = "abc123", fingerprint = snapshot, files = {}, filesTruncated = false,
        diff = "", diffSha256 = snapshot, diffTruncated = false, commits = {}, commitsTruncated = false,
        capturedAt = 1700000000000, dirty = false}
    s.ui.trace.results.verifications = {{id = "verification-1", command = "node test.js", cwd = "/tmp/demo-project",
        criterionIds = {"C1", "C2"}, requirementRevision = requirement.revision, codeSnapshotSha256 = snapshot,
        startedAt = 1700000000000, endedAt = 1700000001000, exitCode = 0, timedOut = false, result = "passed",
        stdoutPreview = "ok", stderrPreview = "", stdoutBytes = 2, stderrBytes = 0, stdoutTruncated = false,
        stderrTruncated = false, evidencePath = "evidence/verification-1.json"}}
    reading = context.readiness(requirement, s.ui)
    check(reading.state ~= "ready", "仍有未处置阻断发现时不得显示可以验收")
    for _, review in s.ui.review.data.reviews do
        for _, finding in review.findings do
            if finding.severity == "blocking" then
                table.insert(review.events, {id = "review-event-waive", findingId = finding.id,
                    action = "waived", reason = "风险已接受", at = 1700000009000})
            end
        end
    end
    reading = context.readiness(requirement, s.ui)
    check(reading.state == "ready" and reading.label:find("验收", 1, true) ~= nil,
        "当前证据齐备且阻断已豁免后 readiness 应可验收")

    -- Command discovery is read-only and offers drafts; running needs a preview
    -- that still matches the current command and criteria.
    local discovered = {}
    for _, item in s.ui.trace.candidates or {} do discovered[item.command] = item.source end
    check(discovered["npm run test"] == "package.json", "应从 package.json 只读发现测试脚本")
    check(discovered["make test"] == "Makefile", "应从 Makefile 只读发现目标")
    s.ui.writable = true
    s.ui.trace.fields.verifyCommand.text = "npm run test"
    s.ui.trace.fields.verifyCriteria.text = "C1"
    s.ui.trace.runPreview = nil
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest == nil and s.ui.trace.error:find("预览", 1, true) ~= nil,
        "未预览时不得运行验证")
    s.ui.trace.error = nil
    action(s, "results-preview-verification")
    check(s.ui.trace.runPreview ~= nil and s.ui.trace.runPreview.command == "npm run test",
        "预览应记录确切命令")
    check(#s.ui.trace.runPreview.criterionIds == 1 and s.ui.trace.runPreview.criterionIds[1] == "C1",
        "预览应记录关联条件")
    s.ui.trace.fields.verifyCommand.text = "npm run build"
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest == nil and s.ui.trace.error:find("变化", 1, true) ~= nil,
        "预览后命令变化必须要求重新预览")
    s.ui.trace.error = nil
    local previewReq = s.ui.byId[s.ui.selected]
    local oldRevision = previewReq.revision
    s.ui.trace.fields.verifyCommand.text = "npm run test"
    previewReq.revision += 1
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest == nil and s.ui.trace.error:find("变化", 1, true) ~= nil,
        "仅实体修订变化也必须拒绝旧验证预览")
    previewReq.revision = oldRevision
    local oldFingerprint = s.ui.trace.results.changes.fingerprint
    s.ui.trace.results.changes.fingerprint = string.rep("f", 64)
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest == nil and s.ui.trace.error:find("变化", 1, true) ~= nil,
        "代码快照漂移必须拒绝旧验证预览")
    s.ui.trace.results.changes.fingerprint = oldFingerprint
    local oldSession = s.payload.binding.sessionId
    s.payload.binding.sessionId = "other-session"
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest == nil and s.ui.trace.error:find("变化", 1, true) ~= nil,
        "会话绑定漂移必须拒绝旧验证预览")
    s.payload.binding.sessionId = oldSession
    s.ui.trace.fields.verifyCommand.text = "npm run test"
    action(s, "results-run-verification")
    check(s.ui.trace.verifyRequest ~= nil and s.ui.trace.verifyRequest.command == "npm run test",
        "匹配的预览应允许进入快照步骤")
    check(s.ui.trace.verifyRequest.requirement ~= requirement
        and s.ui.trace.verifyRequest.contentRevision == modules.store.contentRevision(requirement),
        "验证必须冻结原需求与内容身份，而不是保留可变当前选择")
    check(s.ui.trace.pending == nil and s.ui.trace.error ~= nil
        and s.ui.trace.error:find("写入状态待核对", 1, true) ~= nil,
        "运行前应先尝试读取代码快照（测试环境拒绝真实进程写入）")
    s.ui.trace.pending, s.ui.trace.busy, s.ui.trace.busyLabel = nil, false, nil
    s.ui.trace.error = nil
    s.ui.trace.verifyRequest = nil
    s.ui.trace.fields.verifyCommand.text = ""
    local candidateIndex
    for index, item in s.ui.trace.candidates or {} do
        if item.command == "npm run test" then candidateIndex = index end
    end
    check(candidateIndex ~= nil, "候选应可按位置选择")
    event(s, {ev = "action", act = "results-use-candidate", value = tostring(candidateIndex)})
    check(s.ui.trace.fields.verifyCommand.text == "npm run test", "选择候选只应填入草稿")
    check(s.ui.trace.runPreview == nil, "选择候选后仍需重新预览")

    -- Batch: queueing needs a matching preview, starts serially, refuses a second
    -- start, and stop only requests that no further command be scheduled.
    s.ui.trace.fields.verifyCommand.text = "npm run test"
    s.ui.trace.fields.verifyCriteria.text = "C1"
    action(s, "results-preview-verification")
    action(s, "results-batch-add")
    check(#(s.ui.trace.batchEntries or {}) == 1, "匹配的预览可加入批量队列")
    s.ui.trace.runPreview = nil
    action(s, "results-batch-add")
    check(#(s.ui.trace.batchEntries or {}) == 1 and s.ui.trace.error ~= nil, "没有匹配预览时不得加入队列")
    s.ui.trace.error = nil
    action(s, "results-batch-start")
    check(s.ui.trace.batch ~= nil and s.ui.trace.batch.state == "running", "批量应开始运行")
    check(s.ui.trace.verifyRequest ~= nil and s.ui.trace.verifyRequest.command == "npm run test",
        "批量应先读取首个命令的快照")
    action(s, "results-batch-start")
    check(s.ui.trace.error ~= nil and s.ui.trace.error:find("运行", 1, true) ~= nil, "不得并行启动第二个批量")
    s.ui.trace.error = nil
    action(s, "results-batch-stop")
    check(s.ui.trace.batch.stopRequested == true, "停止只应请求结束调度")
    s.ui.trace.batch, s.ui.trace.batchEntries, s.ui.trace.verifyRequest = nil, nil, nil
    s.ui.trace.pending, s.ui.trace.busy, s.ui.trace.busyLabel = nil, false, nil

    -- Resource bindings: loaded per requirement, unknown versions stay read-only,
    -- and invalid paths are refused before any write.
    check(s.ui.resources.safe == true and s.ui.resources.data ~= nil
        and #s.ui.resources.data.resources == 1, "应读取到需求级资源绑定")
    check(s.ui.resources.status["resource-1"] == "ok", "存在的绑定资源应可读取")
    s.ui.handoff.fields.resourcePath.text = "../escape"
    action(s, "resources-add")
    check(s.ui.handoff.error ~= nil, "越界资源路径应被拒绝")
    s.ui.handoff.error = nil
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-3"})
    check(s.ui.resources.safe == false and s.ui.resources.error ~= nil, "未知资源版本必须只读而不是重置")
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-1"})
    check(s.ui.resources.safe == true, "切回兼容需求应恢复可读")

    -- Activity export writes only its event index into the project export folder.
    s.ui.writable = true
    check(#s.ui.activity.events > 0, "活动事件应可用于导出")
    action(s, "activity-write")
    check(s.ui.activity.exportPath ~= nil and s.ui.activity.exportPath:find("activity%-") ~= nil,
        "活动导出应写入项目导出目录")

    local ui = require("../lib/ui")
    local ok, view = pcall(ui.build, revived)
    check(ok, "宿主状态应能渲染整页 " .. tostring(ok and "" or view))
    if ok then
        local found = false
        local function walk(n)
            if type(n) ~= "table" then return end
            if n.k == "button" and n.p and n.p.key == "review-add-finding" then found = true end
            for _, c in n.c or {} do walk(c) end
        end
        walk(view)
        check(found, "渲染结果应包含添加发现按钮")
    end

    -- Boundary-level async regressions: the real host and readers run against
    -- controlled storage/process callbacks; Store's own tests cover atomic writes.
    local Store, R, Live = modules.store, modules.results, modules.live
    local originalLifecycle, originalChanges, originalVerification = Store.lifecycle, R.putChanges, R.addVerification
    local originalCommand, originalRun = Live.command, tern.process.run
    local isolated = def.init(cx, {payloadJson}, nil)
    event(isolated, {ev="select", id="main.workbench.requirements", item="req-1"})
    local u = isolated.ui
    u.writable, u.dirty, u.token = true, false, "host-test-token"
    local binding = isolated.payload.binding
    local now = Live.epoch()
    tern.kv.set("live:source:" .. isolated.payload.window .. ":" .. binding.instanceId,
        {instanceId=binding.instanceId, sessionId=binding.sessionId, sourcePane=isolated.payload.source,
            panel=isolated.panel, valid=true, updatedAt=now})
    tern.fs.write(isolated.payload.location.runtime .. "snapshot.json", tern.json.encode({
        schemaVersion=1, instanceId=binding.instanceId, sessionId=binding.sessionId, sourceMarker=binding.sourceMarker,
        projectRoot=binding.projectRoot, sequence=1, updatedAt=now, pid=1, cwd=binding.cwd, state="idle", recentEvents={}}))
    local calls = {}
    Store.lifecycle = function(paths, req, kind, reason, revision, token, cb)
        table.insert(calls, {paths=paths, req=req, kind=kind, reason=reason, revision=revision, token=token})
        cb(nil, {code="revision_conflict"})
    end
    local target = u.byId["req-1"]
    local originalStage = target.stage
    for _, item in {{stage="awaiting_acceptance", action="block"}, {stage="blocked", action="unblock"},
        {stage="blocked", action="cancel"}, {stage="cancelled", action="reopen"}, {stage="done", action="reopen"}} do
        target.stage = item.stage
        event(isolated, {ev="action", act="lifecycle-open", value=item.action})
        check(u.review.lifecycleAction == item.action, "分裂的生命周期按钮应打开对应确认面板")
        local before = #calls
        u.review.fields.lifecycleReason.text = ""
        action(isolated, "lifecycle-confirm")
        check(#calls == before, "空原因不得调用 Store.lifecycle")
        u.review.fields.lifecycleReason.text = "保留历史并记录人工原因"
        action(isolated, "lifecycle-confirm")
        check(#calls == before + 1 and calls[#calls].kind == item.action
            and calls[#calls].reason == "保留历史并记录人工原因"
            and calls[#calls].revision == target.revision and calls[#calls].req == target,
            "确认应以完整原因及精确 CAS 调用共享生命周期 API")
        check(u.lifecycleError ~= nil and u.review.fields.lifecycleReason.text == "保留历史并记录人工原因",
            "冲突必须要求核对并保留原因，不能清空草稿")
    end
    target.stage = "done"
    action(isolated, "review-toggle=reopen")
    local beforeReopen = #calls
    action(isolated, "review-reopen")
    check(#calls == beforeReopen + 1 and calls[#calls].kind == "reopen",
        "既有验收重开入口也必须调用 Store.lifecycle，而非 advanceStage")
    u.dirty = true
    local beforeDirty = #calls
    action(isolated, "lifecycle-confirm")
    check(#calls == beforeDirty and u.lifecycleError ~= nil, "脏需求表单时宿主必须拒绝生命周期写入")
    u.dirty = false
    target.stage = originalStage
    action(isolated, "lifecycle-dismiss")
    Store.lifecycle = originalLifecycle

    local snapshot = {head="abc123", fingerprint=string.rep("a", 64), files={}, commits={}, diff="", dirty=false,
        capturedAt=now, filesTruncated=false, commitsTruncated=false, diffTruncated=false, diffSha256=string.rep("b", 64)}
    local commands, launches, recorded = {}, {}, {}
    Live.command = function(_, command, cb) table.insert(commands, command); cb(true, nil) end
    R.putChanges = function(paths, req, token, changes, expected, cb)
        local saved = table.clone(u.trace.results)
        saved.revision, saved.changes = expected + 1, changes
        cb(saved, nil)
    end
    R.addVerification = function(paths, req, token, verification, evidence, expected, cb)
        table.insert(recorded, {paths=paths, req=req, token=token, verification=verification, evidence=evidence, expected=expected})
        local saved = {revision=expected + 1, verifications={verification}, changes=snapshot}
        cb(saved, nil)
    end
    tern.process.run = function(argv, _, cb)
        check(argv[1] == "wsl.exe", "异步验证回归不得运行真实进程")
        table.insert(launches, {argv=argv, finish=cb})
    end
    local function prepare()
        event(isolated, {ev="select", id="main.workbench.requirements", item="req-1"})
        u.trace.results = {schemaVersion=2, projectId=target.projectId, requirementId="req-1", revision=0,
            changes=snapshot, verifications={}}
        u.trace.busy, u.trace.pending, u.trace.batch = false, nil, nil
        u.trace.fields.verifyCommand.text, u.trace.fields.verifyCriteria.text = "printf verified", "C1"
        action(isolated, "results-preview-verification")
        action(isolated, "results-run-verification")
        return u.trace.pending
    end
    local function receipt(pending, changes)
        tern.fs.write(isolated.payload.location.runtime .. "receipts/" .. pending.requestId .. ".json",
            tern.json.encode({schemaVersion=1, requestId=pending.requestId, instanceId=pending.instanceId,
                sessionId=pending.sessionId, status="inspected", data={changes=changes}}))
        action(isolated, "prefill") -- refreshes receipts; blank materials never publish a command
    end
    local pending = prepare()
    receipt(pending, snapshot)
    check(#launches == 1, "匹配的冻结上下文在新快照一致时才可启动验证")
    local frozenRevision = target.revision
    local originalPaths, originalRoot = u.paths, binding.projectRoot
    event(isolated, {ev="select", id="main.workbench.requirements", item="req-2"})
    local selectedResults = u.trace.results
    binding.projectRoot = "/tmp/other-project"
    target.revision = frozenRevision + 10
    launches[1].finish({stdout="partial output", stderr="deadline", status=0, timed_out=true})
    local saved = recorded[1]
    check(saved ~= nil and saved.req.requirementId == "req-1" and saved.paths == originalPaths
        and saved.req.revision == frozenRevision and saved.verification.requirementRevision == frozenRevision
        and saved.verification.requirementContentRevision == frozenRevision
        and saved.verification.cwd == originalRoot and saved.expected == 1,
        "完成时必须保存到执行前的原需求、原项目、原结果修订和原内容身份")
    check(saved.verification.result == "unknown" and saved.verification.exitCode == nil
        and saved.verification.timedOut == true, "超时结果必须为 unknown 字符串且无退出码，不能写入布尔 true")
    check(u.trace.results == selectedResults and u.selected == "req-2" and #commands == 1,
        "切换选择后不得把证据或后续代码观察绑定到新需求")
    binding.projectRoot, target.revision = originalRoot, frozenRevision
    pending = prepare()
    event(isolated, {ev="select", id="main.workbench.requirements", item="req-2"})
    receipt(pending, snapshot)
    check(#launches == 1 and #recorded == 1, "快照返回前切换需求必须拒绝执行")
    pending = prepare()
    local changedSnapshot = table.clone(snapshot)
    changedSnapshot.fingerprint = string.rep("c", 64)
    receipt(pending, changedSnapshot)
    check(#launches == 1 and #recorded == 1, "读取到的代码快照相对预览漂移时必须拒绝执行")
    local reqPath = u.paths.requirements .. "\\req-1\\requirement.json"
    local originalJson = tern.fs.read(reqPath)
    pending = prepare()
    local changedReq = tern.json.decode(originalJson)
    changedReq.revision += 1
    tern.fs.write(reqPath, tern.json.encode(changedReq))
    receipt(pending, snapshot)
    check(#launches == 1 and #recorded == 1, "磁盘需求发生仅实体修订漂移时也必须拒绝执行")
    tern.fs.write(reqPath, originalJson)
    -- Candidate imports use the existing inspect channel, never generic handoff
    -- file state. Domain callbacks are controlled here; real CAS is covered by
    -- candidate-adoption.luau.
    local Review = modules.review
    local originalPlanLoad, originalPlanAdopt, originalReviewAdopt, originalPlanApply =
        R.loadPlan, R.adoptCandidate, Review.adoptCandidate, R.applyPlan
    local importedState = def.init(cx, {payloadJson}, nil)
    event(importedState, {ev="action", act="requirement", value="req-1"})
    local iu = importedState.ui
    iu.writable, iu.dirty, iu.token = true, false, "host-import-token"
    importedState.snapshot, importedState.problem = tern.json.decode(tern.fs.read(
        importedState.payload.location.runtime .. "snapshot.json")), nil
    importedState.text, importedState.pending, importedState.receipt = "", nil, nil
    local importCommands, observations, adoptions, linkWrites = {}, {}, {}, {}
    local revisionDrift = 0
    R.loadPlan = function(paths, req)
        local value, problem = originalPlanLoad(paths, req)
        if not value then return nil, problem end
        value = table.clone(value)
        value.revision += revisionDrift
        return value
    end
    Live.command = function(_, command, cb) table.insert(importCommands, command); cb(true, nil) end
    R.putChanges = function(paths, req, token, changes, expected, cb)
        table.insert(observations, {paths=paths, req=req, changes=changes, expected=expected})
        local saved = table.clone(iu.trace.results)
        saved.changes, saved.revision = changes, expected + 1
        cb(saved, nil)
    end
    Review.adoptCandidate = function(paths, req, token, candidate, sha256, expected, cb)
        table.insert(adoptions, {kind="review", paths=paths, req=req, candidate=candidate, sha256=sha256, expected=expected})
        cb(iu.review.data, nil)
    end
    R.adoptCandidate = function(paths, req, token, candidate, sha256, expected, cb)
        table.insert(adoptions, {kind="plan", paths=paths, req=req, candidate=candidate, sha256=sha256, expected=expected})
        cb(iu.trace.plan, nil)
    end
    local importReq = iu.byId["req-1"]
    local artifactHash = string.rep("d", 64)
    local function candidate(kind)
        local value = {schemaVersion=1, kind=kind, id="external-" .. kind, projectId=importReq.projectId,
            requirementId=importReq.requirementId, requirementRevision=importReq.revision,
            requirementContentRevision=Store.contentRevision(importReq), codeSnapshotSha256=snapshot.fingerprint,
            planRevision=iu.trace.plan.revision, complete=true}
        if kind == "review" then
            value.scope, value.findings = "完整工作区声明", {{id="external-finding", severity="blocking", description="不要从自然语言猜测身份"}}
        else
            value.steps = {{id="external-step", title="明确实现", criterionIds={"C1"}, filePaths={"src/login.ts"}}}
        end
        return value
    end
    local function respond(data, status)
        local p = iu.trace.pending
        check(p ~= nil, "候选每个来源阶段必须有独立 pending")
        if not p then return end
        tern.fs.write(importedState.payload.location.runtime .. "receipts/" .. p.requestId .. ".json",
            tern.json.encode({schemaVersion=1, requestId=p.requestId, instanceId=p.instanceId, sessionId=p.sessionId,
                status=status or "inspected", data=data, reason=status and "显式来源失败" or nil}))
        action(importedState, "prefill")
    end
    local function start(kind, value)
        local state = kind == "plan" and iu.trace or iu.review
        state.fields[kind == "plan" and "planImportPath" or "reviewImportPath"].text = kind .. ".json"
        action(importedState, kind == "plan" and "results-import-preview" or "review-import-preview")
        return tern.json.encode(value or candidate(kind))
    end
    local function preview(kind)
        local body = start(kind)
        respond({file={path=kind .. ".json", body=body, sha256=artifactHash}})
        respond({changes=snapshot})
        return body
    end
    iu.handoff.importedFile = {path="wrong.json", body="unrelated draft", sha256=string.rep("e",64)}
    local body = preview("review")
    local frozen = iu.imports["req-1"].review
    check(frozen.ready and frozen.body == body and frozen.path == "review.json", "完整预览必须冻结原候选文件，不读取通用 importedFile")
    check(#observations == 0 and #adoptions == 0, "候选预览不得写代码观察、审查或计划")
    local count = #importCommands
    action(importedState, "review-import-adopt")
    action(importedState, "review-import-adopt")
    check(#importCommands == count + 1 and iu.trace.pending.operation == "file", "采用必须重读原文件，连点不得重复派发")
    respond({file={path="review.json", body=body, sha256=artifactHash}})
    check(iu.trace.pending and iu.trace.pending.operation == "changes", "采用读文件后必须再次读取当前代码快照")
    respond({changes=snapshot})
    check(#observations == 1 and #adoptions == 1 and adoptions[1].kind == "review"
        and adoptions[1].req.requirementId == "req-1" and adoptions[1].sha256 == artifactHash,
        "只有人工采用且两次检查匹配后才允许调用原需求 adoption API")
    action(importedState, "review-import-adopt")
    check(#adoptions == 1 and #importCommands == count + 2, "已采用的同一预览不得重复派发")
    check(iu.handoff.importedFile.path == "wrong.json", "候选采用不得消费或覆盖其他交接草稿")
    body = preview("review")
    action(importedState, "review-import-adopt")
    respond({file={path="review.json", body=body, sha256=string.rep("f",64)}})
    check(#adoptions == 1 and not iu.trace.pending and not iu.imports["req-1"].review.ready,
        "采用时原始文件摘要漂移必须拒绝且不能自动重试")
    body = preview("review")
    action(importedState, "review-import-adopt")
    respond({file={path="review.json", body=body, sha256=artifactHash}})
    respond({changes=changedSnapshot})
    check(#adoptions == 1 and #observations == 1, "采用时全局代码快照漂移必须在任何域写入之前拒绝")
    body = preview("review")
    action(importedState, "review-import-adopt")
    local pendingImport = iu.trace.pending
    event(importedState, {ev="action", act="requirement", value="req-2"})
    check(iu.review.fields.reviewImportPath.text == "" and iu.imports["req-1"] == nil, "切换需求必须清除冻结预览且隔离路径草稿")
    respond({file={path="review.json", body=body, sha256=artifactHash}})
    check(#adoptions == 1 and not iu.trace.pending and iu.selected == "req-2", "异步回执不得转存或采用到新选择")
    event(importedState, {ev="action", act="requirement", value="req-1"})
    check(iu.review.fields.reviewImportPath.text == "review.json", "切回原需求必须恢复其路径草稿，但不能恢复待采用候选")
    body = preview("review")
    local oldOpen = importedState.payload.binding.openRequestId
    importedState.payload.binding.openRequestId = "other-open"
    count = #importCommands
    action(importedState, "review-import-adopt")
    check(#importCommands == count and #adoptions == 1, "openRequest 绑定漂移必须在派发前拒绝采用")
    importedState.payload.binding.openRequestId = oldOpen
    body = preview("review")
    revisionDrift = 1
    action(importedState, "review-import-adopt")
    check(#adoptions == 1 and not iu.trace.pending, "磁盘计划修订漂移必须拒绝采用")
    revisionDrift = 0
    body = preview("review")
    tern.fs.write(reqPath, tern.json.encode(changedReq))
    action(importedState, "review-import-adopt")
    check(#adoptions == 1 and not iu.trace.pending, "磁盘需求 CAS 漂移必须拒绝采用，即使内容未变化")
    tern.fs.write(reqPath, originalJson)
    body = preview("review")
    local input = iu.review.fields.reviewImportPath
    event(importedState, {ev="edit", id="main.workbench.reviewImportPath", len=utf8.len(input.text),
        from=0, to=utf8.len(input.text), text="other.json", cursor=10})
    check(iu.imports["req-1"].review == nil, "编辑候选路径必须立即作废冻结预览")
    body = start("review")
    respond({}, "rejected")
    check(not iu.trace.pending and not iu.trace.busy and iu.review.error ~= nil, "来源失败必须清理 pending 并在审查页明确提示，不重试")
    body = preview("plan")
    action(importedState, "results-import-adopt")
    respond({file={path="plan.json", body=body, sha256=artifactHash}})
    respond({changes=snapshot})
    check(#adoptions == 2 and adoptions[2].kind == "plan" and adoptions[2].candidate.steps[1].criterionIds[1] == "C1",
        "计划候选必须经同一显式检查路径追加，并保留显式稳定链接")
    body = preview("review")
    local revivedImport = def.init(cx, {payloadJson}, def.save(importedState))
    check(revivedImport.ui.trace.pending == nil and revivedImport.ui.imports["req-1"] == nil
        and revivedImport.ui.review.fields.reviewImportPath.text == "review.json",
        "重载只能恢复需求路径草稿，不能恢复候选、pending 或自动采用")
    -- Native split action/value routes stable step/finding IDs, never titles.
    local h = iu.handoff
    h.importedFile, h.candidate, h.preview = nil, nil, nil
    for _, field in h.fields do field.text, field.cursor = "", 0 end
    local findingEvents = #iu.review.data.reviews[1].events
    local workflowRequests = #(h.workflow and h.workflow.requests or {})
    event(importedState, {ev="action", act="review-fix-draft", value="review-aaa|finding-1"})
    check(h.activity == "implement" and h.fields.excerpt.text:find("review-aaa", 1, true) ~= nil
        and h.fields.excerpt.text:find("finding-1", 1, true) ~= nil
        and h.fields.excerpt.text:find(iu.review.data.reviews[1].codeSnapshotSha256, 1, true) ~= nil,
        "修复草稿必须携带稳定审查/发现 ID 与原快照")
    check(#iu.review.data.reviews[1].events == findingEvents and #(h.workflow and h.workflow.requests or {}) == workflowRequests
        and h.pending == nil and h.pendingSend == nil, "修复草稿不得授权、发送、改变发现处置或验收")
    local excerpt = h.fields.excerpt.text
    event(importedState, {ev="action", act="review-fix-draft", value="review-aaa|finding-2"})
    check(h.fields.excerpt.text == excerpt and iu.review.error ~= nil, "修复草稿不得覆盖已有交接摘录")
    h.fields.excerpt.text, h.fields.proposal.text = "", "已有正式方案草稿"
    event(importedState, {ev="action", act="review-fix-draft", value="review-aaa|finding-1"})
    check(h.fields.excerpt.text == "" and h.fields.proposal.text == "已有正式方案草稿", "其他非空交接草稿也必须阻止修复草稿覆盖")
    local stablePlan = table.clone(iu.trace.plan)
    stablePlan.steps = {{id="stable-step", title="不是身份", status="pending", criterionIds={"C1"}, filePaths={"src/old.ts"}}}
    iu.trace.plan = stablePlan
    R.applyPlan = function(_, req, _, kind, args, expected, cb)
        table.insert(linkWrites, {req=req, kind=kind, args=args, expected=expected})
        cb(nil, nil, {code="revision_conflict"})
    end
    event(importedState, {ev="action", act="results-link-pick", value="stable-step"})
    check(iu.trace.selectedStep == "stable-step" and iu.trace.fields.stepCriteria.text == "C1"
        and iu.trace.fields.stepFiles.text == "src/old.ts", "链接编辑器必须选择稳定步骤 ID 并回填显式链接")
    iu.trace.fields.stepFiles.text = "src/new.ts"
    action(importedState, "results-plan-links")
    check(#linkWrites == 1 and linkWrites[1].kind == "links" and linkWrites[1].args.stepId == "stable-step"
        and linkWrites[1].args.filePaths[1] == "src/new.ts" and iu.trace.fields.stepFiles.text == "src/new.ts"
        and not iu.trace.busy and iu.trace.error ~= nil, "显式链接保存冲突必须保留草稿并清理 busy")
    iu.trace.fields.stepFiles.text = "../escape"
    action(importedState, "results-plan-links")
    check(#linkWrites == 1, "不安全的计划文件链接不得调用域写入")
    R.loadPlan, R.adoptCandidate, Review.adoptCandidate, R.applyPlan =
        originalPlanLoad, originalPlanAdopt, originalReviewAdopt, originalPlanApply
    Store.lifecycle, R.putChanges, R.addVerification = originalLifecycle, originalChanges, originalVerification
    Live.command, tern.process.run = originalCommand, originalRun
    return {checks = checks, failures = failures}
end