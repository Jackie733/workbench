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
    check(#s.ui.requirements == 1, "应读取到一项需求")
    check(s.ui.writable == false, "打开先只读")
    check(s.ui.review ~= nil and s.ui.review.fields.findingDraft ~= nil, "findingDraft 字段应存在")

    event(s, {ev = "select", id = "main.workbench.requirements", item = "req-1"})
    check(s.ui.selected == "req-1", "应选择需求")
    event(s, {ev = "select", id = "main.workbench.tabs", item = "review"})
    local v = s.ui.review
    check(v.data ~= nil and #v.data.reviews == 2, "审查记录应加载")

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
    check(revived.ui.review.panel == "dispose", "重载应恢复面板状态")
    check(revived.ui.review.draftSeverity == "blocking", "重载应恢复草稿严重度")
    check(revived.ui.review.fields.reviewFindings.text == "blocking|过期后没有入口\n", "重载应恢复发现草稿")

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