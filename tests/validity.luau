--!strict
-- Domain regression for lib/validity.luau: approval, verification evidence,
-- criteria coverage, finding dispositions and the acceptance gate. These are the
-- shared inputs of the Delivery list, readiness summary and acceptance action.
local Validity = require("../lib/validity")

local function copy(value)
    if type(value) ~= "table" then return value end
    local out = {}
    for k, v in value do out[k] = copy(v) end
    return out
end

local SHA_A = string.rep("a1", 32)
local SHA_B = string.rep("b2", 32)
local function requirement(overrides)
    local r = {schemaVersion = 1, requirementId = "req-1", projectId = "project-1", number = "REQ-0001",
        revision = 3, title = "登录过期时提供重新登录入口", type = "bug", priority = "high",
        stage = "awaiting_acceptance", goal = "会话过期后能重新登录。", scope = "仅登录模块。",
        acceptanceCriteria = {
            {id = "C1", description = "过期后显示重新登录入口", required = true},
            {id = "C2", description = "重新登录后回到原页面", required = true},
            {id = "C3", description = "日志记录过期事件", required = false},
        }, labels = {}}
    for k, v in overrides or {} do r[k] = v end
    return r
end
local function verification(overrides)
    local v = {id = "verification-1", command = "node test.js", cwd = "/repo",
        criterionIds = {"C1", "C2"}, requirementRevision = 3, codeSnapshotSha256 = SHA_A,
        startedAt = 1700000000000, endedAt = 1700000001000, exitCode = 0, timedOut = false,
        result = "passed", stdoutPreview = "ok", stderrPreview = "", stdoutBytes = 2, stderrBytes = 0,
        stdoutTruncated = false, stderrTruncated = false, evidencePath = "evidence/verification-1.json"}
    for k, x in overrides or {} do v[k] = x end
    return v
end
local function results(overrides)
    local r = {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 4,
        changes = {capturedAt = 1700000002000, head = "abc123", fingerprint = SHA_A, dirty = true,
            files = {}, filesTruncated = false, diff = "", diffSha256 = SHA_A, diffTruncated = false,
            commits = {}, commitsTruncated = false},
        verifications = {verification()}}
    for k, x in overrides or {} do r[k] = x end
    return r
end
local function reviews(findings, events)
    return {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 2,
        reviews = {{id = "review-1", source = "manual", scope = "登录模块", codeSnapshotSha256 = SHA_A,
            requirementRevision = 3, createdAt = 1700000003000,
            findings = findings or {}, events = events or {}}},
        acceptances = {}, reopenings = {}}
end
local function finding(overrides)
    local f = {id = "finding-1", severity = "blocking", description = "过期后没有入口",
        createdAt = 1700000003000}
    for k, x in overrides or {} do f[k] = x end
    return f
end
local function codes(items)
    local out = {}
    for _, item in items do table.insert(out, item.code) end
    return table.concat(out, ",")
end

return function()
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function equal(actual, expected, message)
        check(actual == expected, message .. " (got " .. tostring(actual) .. ", want " .. tostring(expected) .. ")")
    end

    -- V01: a current passed verification covers only its own required criteria.
    local r, res = requirement(), results()
    local gate = Validity.acceptance(r, res, reviews())
    check(gate.ok, "当前快照上的必需证据通过门禁")
    equal(gate.criteria.required, 2, "必需条件数量")
    equal(gate.criteria.requiredCovered, 2, "必需条件覆盖数量")
    equal(gate.criteria.informational, 1, "信息性条件单独计数")
    equal(gate.criteria.informationalCovered, 0, "信息性条件不冒充必需覆盖")
    equal(gate.snapshot, SHA_A, "门禁返回当前快照")

    -- Optional evidence never satisfies a required criterion: a passed C3 run
    -- still leaves C1/C2 uncovered.
    local optionalOnly = results({verifications = {verification({id = "verification-2", criterionIds = {"C3"}})}})
    local optionalGate = Validity.acceptance(r, optionalOnly, reviews())
    check(not optionalGate.ok, "仅覆盖信息性条件的证据不能通过门禁")
    equal(codes(optionalGate.reasons), "criterion_uncovered,criterion_uncovered", "必需条件逐项列出缺失")

    -- Failed and unknown results are not coverage; the gate names the criteria.
    for _, result in {"failed", "unknown"} do
        local bad = Validity.acceptance(r, results({verifications = {verification({result = result})}}), reviews())
        check(not bad.ok, result .. " 结果不通过门禁")
        equal(codes(bad.reasons), "criterion_uncovered,criterion_uncovered", result .. " 结果仍逐项列出必需条件")
        equal(Validity.verification(results({verifications = {verification({result = result})}}), r,
            verification({result = result})), result, result .. " 状态按记录返回")
    end

    -- V01/V03: requirement revision or code snapshot drift makes evidence stale.
    local revised = requirement({revision = 4})
    local staleRevision = Validity.acceptance(revised, res, reviews())
    check(not staleRevision.ok, "需求修订变化使证据失效")
    local state, why, code = Validity.verification(res, revised, verification())
    equal(state, "stale", "修订不匹配的证据状态")
    equal(code, "requirement_changed", "修订不匹配的原因代码")
    check(why ~= nil and why:match("修订"), "修订不匹配保留说明")

    local movedCode = results({changes = {capturedAt = 1700000004000, head = "abc123", fingerprint = SHA_B,
        dirty = true, files = {}, filesTruncated = false, diff = "", diffSha256 = SHA_B, diffTruncated = false,
        commits = {}, commitsTruncated = false}})
    state, _, code = Validity.verification(movedCode, r, verification())
    equal(state, "stale", "代码变化后的证据状态")
    equal(code, "code_changed", "代码变化的原因代码")
    check(not Validity.acceptance(r, movedCode, reviews()).ok, "代码变化后门禁不通过")

    -- No observation: a pass cannot be confirmed (unknown, never green); a
    -- recorded failure stays failed so the failure is not hidden.
    local noSnapshot = results()
    noSnapshot.changes = nil
    state, _, code = Validity.verification(noSnapshot, r, verification())
    equal(state, "unknown", "缺少快照时通过证据只能是未知")
    equal(code, "snapshot_missing", "缺少快照的原因代码")
    state = Validity.verification(noSnapshot, r, verification({result = "failed"}))
    equal(state, "failed", "缺少快照不隐藏已记录失败")
    local noSnapshotGate = Validity.acceptance(r, noSnapshot, reviews())
    check(not noSnapshotGate.ok, "缺少快照时门禁不通过")
    equal(codes(noSnapshotGate.reasons), "snapshot_missing,criterion_uncovered,criterion_uncovered",
        "缺少快照先说明快照，再逐项列出必需条件")

    -- V01: blocking findings block until an explicit disposition; reopened
    -- findings block again. Major/minor/note findings do not block.
    local blocking = Validity.acceptance(r, res, reviews({finding()}))
    check(not blocking.ok, "未处置阻断发现阻止验收")
    equal(codes(blocking.reasons), "blocking_finding_open", "阻断发现原因")
    equal(blocking.findings.blockingOpen, 1, "阻断发现计数")
    local resolved = Validity.acceptance(r, res, reviews({finding()},
        {{id = "review-event-1", findingId = "finding-1", action = "resolved", reason = "已补入口", at = 1700000004000}}))
    check(resolved.ok, "已解决阻断发现不再阻止验收")
    local waived = Validity.acceptance(r, res, reviews({finding()},
        {{id = "review-event-2", findingId = "finding-1", action = "waived", reason = "明确豁免", at = 1700000004000}}))
    check(waived.ok, "明确豁免不再阻止验收")
    local reopened = Validity.acceptance(r, res, reviews({finding()}, {
        {id = "review-event-3", findingId = "finding-1", action = "resolved", reason = "先修", at = 1700000004000},
        {id = "review-event-4", findingId = "finding-1", action = "reopened", reason = "仍可复现", at = 1700000005000}}))
    check(not reopened.ok, "重新打开的阻断发现再次阻止验收")
    local minor = Validity.acceptance(r, res, reviews({finding({severity = "minor"})}))
    check(minor.ok, "非阻断发现不阻止验收")
    equal(minor.findings.open, 1, "非阻断发现仍计入未处置")

    -- Delivery evidence and the gate agree: the same state drives both.
    local evidence = Validity.evidence(res, r, gate.snapshot)
    equal(evidence.items[1].state, "passed", "证据列表状态")
    equal(evidence.counts.passed, 1, "证据计数")
    local ids = Validity.currentVerificationIds(res, r, gate.snapshot, true)
    equal(#ids, 1, "验收选用的当前快照证据")
    equal(#Validity.currentVerificationIds(res, r, SHA_B, true), 0, "其他快照不选用证据")
    equal(#Validity.currentVerificationIds(res, revised, gate.snapshot, true), 0, "修订变化后不选用证据")
    equal(#Validity.currentVerificationIds(noSnapshot, r, nil, false), 0, "缺少快照时不选用证据")

    -- Evaluation is read-only: inputs and their revisions are unchanged.
    local beforeReq, beforeRes, beforeReviews = copy(r), copy(res), copy(reviews({finding()}))
    local evaluated = Validity.evaluate({requirement = r, results = res, reviews = reviews({finding()})})
    check(not evaluated.acceptance.ok, "evaluate 复用同一门禁结果")
    equal(r.revision, beforeReq.revision, "评估不改变需求修订")
    check(#res.verifications == #beforeRes.verifications and res.changes.fingerprint == beforeRes.changes.fingerprint,
        "评估不改变结果记录")
    equal(beforeReviews.reviews[1].events and #beforeReviews.reviews[1].events or 0, 0, "评估不追加处置事件")

    -- Approval: design and direct modes, revocation, content/design drift.
    local wf = {schemaVersion = 1, projectId = "project-1", requirementId = "req-1", revision = 5,
        latestVersion = 1, designs = {{version = 1, sha256 = SHA_A, requirementSha256 = SHA_B,
            requirementRevision = 3, createdAt = 1700000000000}},
        comments = {}, approvals = {}, requests = {},
        approval = {id = "approval-1", mode = "design", requirementRevision = 3,
            requirementSha256 = SHA_B, requirementContent = "content-v3", latestVersion = 1,
            designVersion = 1, designSha256 = SHA_A, baseline = {head = "abc", fingerprint = SHA_A, dirty = false},
            approvedAt = 1700000000000}}
    local ok = Validity.approval(wf, r, "content-v3")
    check(ok.valid, "当前设计与需求的批准有效")
    equal(ok.reason, "current", "有效批准原因")
    equal(Validity.approval(wf, r, "content-v4").reason, "requirement_changed", "内容变化使批准失效")
    equal(Validity.approval(wf, r, nil).reason, "requirement_changed", "缺少内容摘要不视为有效批准")
    equal(Validity.approval({latestVersion = 2, designs = wf.designs, approval = wf.approval}, r, "content-v3").reason,
        "newer_design", "更新方案使批准失效")
    local revoked = {latestVersion = 1, designs = wf.designs}
    for k, v in wf.approval do revoked[k] = v end
    revoked.revokedAt = 1700000005000
    equal(Validity.approval({latestVersion = 1, designs = wf.designs, approval = revoked}, r, "content-v3").reason,
        "revoked", "撤销的批准无效")
    equal(Validity.approval({latestVersion = 1, designs = wf.designs}, r, "content-v3").reason,
        "not_approved", "没有批准记录")
    local direct = {latestVersion = 0, designs = {}, approval = {id = "approval-2", mode = "direct",
        requirementRevision = 3, requirementContent = "content-v3", latestVersion = 0, designVersion = 0,
        designSha256 = "", baseline = {head = "abc", fingerprint = SHA_A, dirty = false}, approvedAt = 1700000000000}}
    check(Validity.approval(direct, r, "content-v3").valid, "快捷实施授权不伪造方案")
    local brokenDesign = {latestVersion = 1, designs = {{version = 1, sha256 = SHA_B,
        requirementSha256 = SHA_B, requirementRevision = 3, createdAt = 0}}, approval = wf.approval}
    equal(Validity.approval(brokenDesign, r, "content-v3").reason, "design_changed", "方案指纹变化使批准失效")

    for _, item in failures do print("FAIL " .. item) end
    return {checks = checks, failures = failures}
end
