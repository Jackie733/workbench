--!strict
-- One read-only evaluation of approval, verification evidence, criteria coverage,
-- finding dispositions and the acceptance gate. Pure table inspection: no writes,
-- no tern dependency, no revision increments. Every consumer (Delivery list,
-- readiness summary, attention projection, acceptance enforcement) must call
-- this module instead of re-deriving the same predicates.
local M = {}

local approvalMessages = {
    current = "当前授权有效；仍须生成并检查实施预览，再明确发送。",
    not_approved = "尚无批准记录。",
    revoked = "当前授权已撤销。",
    requirement_changed = "需求修订或内容摘要已改变；必须重新授权。",
    newer_design = "已有更新的正式方案；必须批准最新版本。",
    design_changed = "批准的正式方案校验不再匹配；必须重新授权。",
    invalid_authorization = "授权记录的方式或直接实施依据无效；必须重新授权。",
}

-- Last disposition event wins; "reopened" returns the finding to open.
function M.findingState(review, findingId)
    local state, reason, at = "open", nil, nil
    for _, event in review.events or {} do
        if event.findingId == findingId then
            state = event.action == "reopened" and "open" or event.action
            reason, at = event.reason, event.at
        end
    end
    return state, reason, at
end

local function reason(code, message, refs)
    return {code = code, message = message, refs = refs or {}}
end

-- New records pin the last content-changing CAS revision. Legacy records keep
-- their original exact-revision rule; upgrading a container never rebinds them.
function M.matchesRequirement(record, requirement)
    local pinned = record.requirementContentRevision
    if pinned == nil then return record.requirementRevision == requirement.revision end
    local current = requirement.contentRevision or requirement.revision
    return type(pinned) == "number" and pinned % 1 == 0 and pinned >= 1
        and pinned <= 9007199254740991 and pinned == current
end

-- Canonical content is checked independently of the monotonic content identity.
function M.approval(workflow, requirement, content)
    local function invalid(code)
        return {valid = false, reason = code, message = approvalMessages[code]}
    end
    local a = workflow and workflow.approval
    if type(a) ~= "table" then return invalid("not_approved") end
    if a.revokedAt then return invalid("revoked") end
    if content == nil or not M.matchesRequirement(a, requirement) or a.requirementContent ~= content then
        return invalid("requirement_changed")
    end
    if a.latestVersion ~= workflow.latestVersion then return invalid("newer_design") end
    if a.mode ~= "design" and a.mode ~= "direct" then return invalid("invalid_authorization") end
    if a.mode == "design" then
        if a.designVersion ~= workflow.latestVersion then return invalid("design_changed") end
        local d = workflow.designs and workflow.designs[a.designVersion]
        if not d or d.sha256 ~= a.designSha256 or d.requirementSha256 ~= a.requirementSha256
            or d.version ~= a.designVersion or not M.matchesRequirement(d, requirement) then return invalid("design_changed") end
    end
    if a.mode == "direct" and (a.designVersion ~= 0 or a.designSha256 ~= ""
        or type(a.reason) ~= "string" or not a.reason:match("%S")
        or type(requirement.scope) ~= "string" or not requirement.scope:match("%S")
        or #(requirement.acceptanceCriteria or {}) == 0) then return invalid("invalid_authorization") end
    return {valid = true, reason = "current", message = approvalMessages.current,
        approvalId = a.id, mode = a.mode, designVersion = a.designVersion}
end

-- Content identity and observed code snapshot must both match. Legacy evidence
-- remains bound to its exact entity revision. Missing observation never turns a
-- pass green and never hides a recorded failure.
function M.verification(results, requirement, verification)
    if not M.matchesRequirement(verification, requirement) then
        return "stale", "需求内容或旧记录绑定的修订已变化", "requirement_changed"
    end
    local snapshot = results and results.changes and results.changes.fingerprint
    if not snapshot then
        if verification.result == "passed" then
            return "unknown", "缺少当前代码快照，无法确认证据适用", "snapshot_missing"
        end
        return verification.result, nil, nil
    end
    if verification.codeSnapshotSha256 ~= snapshot then
        return "stale", "验证后代码已变化", "code_changed"
    end
    return verification.result, nil, nil
end

function M.evidence(results, requirement, snapshot)
    local items, counts = {}, {passed = 0, failed = 0, unknown = 0, stale = 0}
    for _, verification in results and results.verifications or {} do
        local state, why, code = M.verification(results, requirement, verification)
        counts[state] = (counts[state] or 0) + 1
        table.insert(items, {id = verification.id, state = state, reason = why, code = code,
            command = verification.command, criterionIds = verification.criterionIds,
            requirementRevision = verification.requirementRevision,
            requirementContentRevision = verification.requirementContentRevision,
            codeSnapshotSha256 = verification.codeSnapshotSha256})
    end
    return {items = items, counts = counts, total = #items, snapshot = snapshot}
end

-- Required and informational criteria are reported separately; a combined x/y
-- would mix authorization, coverage and review blockers into a false percentage.
function M.criteria(requirement, results, snapshot)
    local items = {required = 0, requiredCovered = 0, informational = 0, informationalCovered = 0}
    items.items = {}
    for _, criterion in requirement.acceptanceCriteria or {} do
        local evidenceIds = {}
        for _, verification in results and results.verifications or {} do
            if verification.result == "passed" and M.matchesRequirement(verification, requirement)
                and snapshot ~= nil and verification.codeSnapshotSha256 == snapshot then
                for _, id in verification.criterionIds or {} do
                    if id == criterion.id then table.insert(evidenceIds, verification.id); break end
                end
            end
        end
        local covered = #evidenceIds > 0
        if criterion.required == true then
            items.required += 1
            if covered then items.requiredCovered += 1 end
        else
            items.informational += 1
            if covered then items.informationalCovered += 1 end
        end
        table.insert(items.items, {id = criterion.id, description = criterion.description,
            required = criterion.required == true,
            state = covered and "covered" or (criterion.required == true and "missing" or "uncovered"),
            evidenceIds = evidenceIds})
    end
    return items
end

function M.findings(reviewsData)
    local items, total, open, blockingOpen = {}, 0, 0, 0
    for _, review in reviewsData and reviewsData.reviews or {} do
        for _, finding in review.findings or {} do
            local state, why, at = M.findingState(review, finding.id)
            total += 1
            if state == "open" then
                open += 1
                if finding.severity == "blocking" then blockingOpen += 1 end
            end
            table.insert(items, {reviewId = review.id, findingId = finding.id, severity = finding.severity,
                description = finding.description, state = state, reason = why, at = at})
        end
    end
    return {items = items, total = total, open = open, blockingOpen = blockingOpen}
end

-- The acceptance gate. Reason order is stable: missing snapshot, required
-- criteria in requirement order, then open blocking findings in review order.
function M.acceptance(requirement, results, reviewsData)
    local snapshot = results and results.changes and results.changes.fingerprint or nil
    local coverage = M.criteria(requirement, results, snapshot)
    local findings = M.findings(reviewsData)
    local reasons, problems = {}, {}
    local function add(item)
        table.insert(reasons, item)
        table.insert(problems, item.message)
    end
    if not snapshot then
        add(reason("snapshot_missing", "缺少当前代码快照；请先在结果页读取代码变化"))
    end
    for _, criterion in coverage.items do
        if criterion.required and criterion.state ~= "covered" then
            add(reason("criterion_uncovered",
                "必需验收条件 " .. criterion.id .. " 缺少当前代码快照上的通过证据",
                {criterionId = criterion.id}))
        end
    end
    for _, finding in findings.items do
        if finding.severity == "blocking" and finding.state == "open" then
            add(reason("blocking_finding_open",
                "阻断发现仍未解决或豁免：" .. finding.description:sub(1, 160),
                {reviewId = finding.reviewId, findingId = finding.findingId}))
        end
    end
    return {ok = #reasons == 0, reasons = reasons, problems = problems, snapshot = snapshot,
        criteria = coverage, findings = findings}
end

-- Select only evidence with matching content identity (legacy: exact revision)
-- and snapshot. No historical evidence is rebound to the current requirement.
function M.currentVerificationIds(results, requirement, snapshot, passedOnly)
    local ids = {}
    for _, verification in results and results.verifications or {} do
        if snapshot ~= nil and M.matchesRequirement(verification, requirement)
            and verification.codeSnapshotSha256 == snapshot
            and (not passedOnly or verification.result == "passed") then
            table.insert(ids, verification.id)
        end
    end
    return ids
end

-- Composed read-only view for the readiness summary and attention projection.
-- `content` is only needed for approval; omit it when no workflow is loaded.
function M.evaluate(input)
    local requirement, results, reviewsData = input.requirement, input.results, input.reviews
    local approval = nil
    if input.workflow ~= nil and input.content ~= nil then
        approval = M.approval(input.workflow, requirement, input.content)
    end
    local acceptance = M.acceptance(requirement, results, reviewsData)
    return {snapshot = acceptance.snapshot, approval = approval,
        criteria = acceptance.criteria, findings = acceptance.findings,
        evidence = M.evidence(results, requirement, acceptance.snapshot),
        acceptance = acceptance}
end

M.approvalMessages = approvalMessages
-- Field names and order of the canonical approval snapshot
-- (`Workflow.requirementContent`): title, type, priority, goal, scope, criteria,
-- labels. Comparing decoded snapshots keeps the reader independent of encoding.
M.contentFields = {"title", "type", "priority", "goal", "scope", "criteria", "labels"}

local function same(a, b)
    if a == b then return true end
    if type(a) ~= "table" or type(b) ~= "table" then return false end
    local countA, countB = 0, 0
    for _ in a do countA += 1 end
    for _ in b do countB += 1 end
    if countA ~= countB then return false end
    for key, value in a do
        if not same(value, b[key]) then return false end
    end
    return true
end

-- Comparison against an existing approval snapshot. `nil` or malformed input is
-- "unavailable", never "no changes".
function M.contentDiff(before, after)
    if type(before) ~= "table" or type(after) ~= "table" then
        return {available = false, reason = "corrupt_snapshot", changes = {}}
    end
    local changes = {}
    for index, name in M.contentFields do
        local old, new = before[index], after[index]
        if old == nil and new == nil then
            -- Absent pairs are equal; a missing trailing field is not invented.
        elseif not same(old, new) then
            table.insert(changes, {field = name, before = old, after = new})
        end
    end
    return {available = true, changes = changes, identical = #changes == 0}
end

return M
