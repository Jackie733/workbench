--!strict
-- Host interaction regression for the review UI pilot: drives the real
-- host.luau event/key handlers against an in-memory filesystem and KV, and
-- checks the new draft/panel actions, their guards, and reload persistence.
-- Storage-writing actions are intentionally out of scope here; they keep their
-- existing code paths and are covered by the native storage tests.
return function(tern, def, cx, payloadJson)
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function event(s, ev) def.event(s, ev, cx) end
    local function action(s, act) event(s, {ev = "action", act = act}) end

    local s = def.init(cx, {payloadJson}, nil)
    check(s.ui ~= nil, "init 应建立界面状态")
    check(#s.ui.requirements == 2, "应读取到两项需求")
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
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-2"})
    check(s.ui.selected == "req-2" and s.ui.handoff.fields.paths.text == "", "切换需求不得带入另一项需求的资料草稿")
    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-1"})
    check(s.ui.handoff.fields.paths.text == "src/login.ts", "切回需求应恢复其草稿")
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

    return {checks = checks, failures = failures}
end