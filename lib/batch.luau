--!strict
-- Serial verification batches: a frozen, ordered list of command/criteria pairs
-- with no retries, no parallel execution and no automatic resume. The scheduler
-- is in-memory only; a reload forgets the batch instead of continuing it.
local M = {}
M.MAX_ENTRIES = 5
M.MAX_TOTAL_MS = 10 * 60 * 1000

local function validText(value)
    return type(value) == "string" and #value > 0 and #value <= 4000 and not value:find("[%z\1-\8\11\12\14-\31\127]")
        and utf8.len(value) ~= nil
end
local function copyIds(ids)
    local out = {}
    for _, id in ids or {} do table.insert(out, tostring(id)) end
    return out
end

function M.add(entries, command, criterionIds, now)
    if #entries >= M.MAX_ENTRIES then return nil, "batch_limit" end
    if not validText(command) then return nil, "invalid_command" end
    local entry = {command = command, criterionIds = copyIds(criterionIds), addedAt = now or 0}
    table.insert(entries, entry)
    return entry
end
function M.remove(entries, index)
    if type(index) ~= "number" or index % 1 ~= 0 or index < 1 or index > #entries then return false end
    table.remove(entries, index)
    return true
end

-- Freezes a copy: later edits of the draft list cannot change a running batch.
function M.freeze(entries, now)
    if type(entries) ~= "table" or #entries == 0 or #entries > M.MAX_ENTRIES then return nil, "empty_batch" end
    local frozen = {}
    for _, entry in entries do
        if not validText(entry.command) then return nil, "invalid_command" end
        table.insert(frozen, {command = entry.command, criterionIds = copyIds(entry.criterionIds)})
    end
    return {entries = frozen, index = 1, startedAt = now or 0, state = "running", stopReason = nil}
end
function M.current(batch)
    if not batch or batch.state ~= "running" then return nil end
    return batch.entries[batch.index]
end

-- Called after one command's evidence is recorded. Stop reasons are conservative:
-- any non-pass, timeout, unknown exit or code change ends scheduling.
function M.advance(batch, outcome)
    if not batch or batch.state ~= "running" then return {action = "stop", reason = "not_running"} end
    outcome = outcome or {}
    if batch.stopRequested then
        batch.state, batch.stopReason = "stopped", "cancelled"
        return {action = "stop", reason = "cancelled"}
    end
    if type(outcome.elapsedMs) == "number" and outcome.elapsedMs > M.MAX_TOTAL_MS then
        batch.state, batch.stopReason = "stopped", "time_limit"
        return {action = "stop", reason = "time_limit"}
    end
    if outcome.result ~= "passed" then
        batch.state, batch.stopReason = "stopped", "not_passed"
        return {action = "stop", reason = "not_passed"}
    end
    if outcome.codeChanged == true then
        batch.state, batch.stopReason = "stopped", "code_changed"
        return {action = "stop", reason = "code_changed"}
    end
    if batch.index >= #batch.entries then
        batch.state, batch.stopReason = "completed", nil
        return {action = "stop", reason = "completed"}
    end
    batch.index += 1
    return {action = "next", entry = batch.entries[batch.index]}
end
function M.requestStop(batch)
    if not batch or batch.state ~= "running" then return false end
    batch.stopRequested = true
    return true
end

-- Remaining entries are never run once a batch stops; the UI reports them as
-- not run rather than cancelled commands.
function M.remaining(batch)
    if not batch then return 0 end
    local count = #batch.entries - batch.index
    return count > 0 and count or 0
end

return M
