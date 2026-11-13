--!strict
-- Synthetic, memory-only states for AF baseline and consumer regressions.
-- No filesystem, commands, model calls or real project/session identities.
local Workflow = require("../lib/workflow")
local M = {}
M.names = {"empty", "single", "awaiting_approval", "approved", "running", "failed",
    "awaiting_acceptance", "done", "legacy", "disconnected", "delivery_unknown"}
local SHA = string.rep("ab12", 16)
local function copy(value)
    if type(value) ~= "table" then return value end
    local result = {}
    for k, v in value do result[k] = copy(v) end
    return result
end
function M.make(name)
    assert(table.find(M.names, name), "unknown AF fixture")
    local r = {schemaVersion=2, projectId="af-project", requirementId="af-requirement", number="REQ-0001",
        revision=3, contentRevision=3, lifecycleEvents={}, title="版本更新", type="chore", priority="normal",
        stage="backlog", goal="将隔离示例版本更新为 1.3.2", scope="仅示例版本字段",
        acceptanceCriteria={{id="C1", description="示例版本为 1.3.2", required=true}}, labels={},
        createdAt=1700000000000, updatedAt=1700000000000}
    local workflow = {schemaVersion=2, projectId=r.projectId, requirementId=r.requirementId, revision=1,
        latestVersion=0, designs={}, comments={}, approvals={}, requests={}}
    local results = {schemaVersion=2, projectId=r.projectId, requirementId=r.requirementId,
        revision=0, verifications={}}
    local reviews = {schemaVersion=3, projectId=r.projectId, requirementId=r.requirementId,
        revision=0, reviews={}, acceptances={}, reopenings={}, candidateImports={}}
    local s = {payload={binding={projectRoot="/tmp/af-synthetic", sessionId="af-session", instanceId="af-instance"}},
        snapshot={state="idle", updatedAt=1700000000000},
        ui={selected=r.requirementId, requirements={r}, byId={[r.requirementId]=r},
            handoff={safe=true, workflow=workflow}, trace={safe=true, results=results}, review={safe=true, data=reviews}}}
    if name == "empty" then s.ui.selected=nil; s.ui.requirements={}; s.ui.byId={}; return s end
    if name == "awaiting_approval" or name == "approved" then
        r.stage="awaiting_approval"
        workflow.latestVersion=1
        workflow.designs={{version=1, sha256=SHA, requirementSha256=SHA, requirementRevision=3,
            requirementContentRevision=3, createdAt=r.createdAt}}
        if name == "approved" then
            workflow.approval={id="af-approval", mode="design", requirementRevision=3, requirementContentRevision=3,
                requirementContent=Workflow.requirementContent(r), requirementSha256=SHA,
                designVersion=1, designSha256=SHA, latestVersion=1,
                baseline={head="af-head", fingerprint=SHA, dirty=false}, approvedAt=r.createdAt}
            workflow.approvals={copy(workflow.approval)}
        end
    elseif name == "running" then
        r.stage="implementing"; s.snapshot.state="working"
        s.snapshot.currentTool={toolCallId="af-tool", toolName="bash", startedAt=r.createdAt}
    elseif name == "failed" or name == "awaiting_acceptance" or name == "done" then
        r.stage=name == "failed" and "verifying" or name
        results.changes={head="af-head", fingerprint=SHA, capturedAt=r.createdAt, dirty=false,
            files={}, filesTruncated=false, commits={}, commitsTruncated=false, diff="", diffSha256=SHA, diffTruncated=false}
        results.verifications={{id="af-evidence", command="synthetic-never-executed", exitCode=name=="failed" and 1 or 0,
            result=name=="failed" and "failed" or "passed", timedOut=false, requirementRevision=3,
            requirementContentRevision=3, codeSnapshotSha256=SHA, criterionIds={"C1"},
            startedAt=r.createdAt, endedAt=r.createdAt+1000, stdoutPreview="synthetic fixture", stderrPreview="",
            stdoutTruncated=false, stderrTruncated=false, evidencePath="evidence/af-synthetic.json"}}
        if name == "done" then
            reviews.acceptances={{id="af-acceptance", decision="accepted", requirementRevision=3,
                requirementContentRevision=3, codeSnapshotSha256=SHA, verificationIds={"af-evidence"},
                reviewIds={}, comment="synthetic fixture", createdAt=r.createdAt+2000}}
        end
    elseif name == "legacy" then
        r.schemaVersion=1; r.contentRevision=nil; r.lifecycleEvents=nil
    elseif name == "disconnected" then
        s.snapshot.state="disconnected"; s.problem="隔离夹具：来源失效"
    elseif name == "delivery_unknown" then
        workflow.requests={{requestId="af-request", activity="design", status="delivery_unknown",
            sessionId="af-session", instanceId="af-instance", payloadSha256=SHA,
            requirementRevision=3, requirementContentRevision=3, requirementSha256=SHA,
            authorizedRequirementRevision=3, currentRequirementRevision=3, createdAt=r.createdAt}}
    end
    if name == "running" or name == "failed" or name == "awaiting_acceptance" or name == "done" then
        workflow.approval={id="af-direct-approval", mode="direct", reason="隔离夹具显式授权",
            requirementRevision=3, requirementContentRevision=3, requirementContent=Workflow.requirementContent(r),
            requirementSha256=SHA, designVersion=0, designSha256="", latestVersion=0,
            baseline={head="af-head", fingerprint=SHA, dirty=false}, approvedAt=r.createdAt}
        workflow.approvals={copy(workflow.approval)}
    end
    return s
end
return M