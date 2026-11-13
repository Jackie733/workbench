--!strict
-- Append-only review records, finding dispositions and human acceptance decisions.
local Store = require('./store')
local Validity = require('./validity')
local M = {}
local MAX_REVIEWS, MAX_FINDINGS, MAX_EVENTS, MAX_DECISIONS = 50, 50, 200, 20
local sources = {native_review = true, manual = true, external = true}
local severities = {blocking = true, major = true, minor = true, note = true}
local actions = {resolved = true, waived = true, reopened = true}

local function join(a, b) return a .. "\\" .. b end
function M.path(paths, req) return join(join(paths.requirements, req.requirementId), "reviews.json") end
local function text(value, max, empty)
    if type(value) ~= "string" or #value > max or (not empty and value:match("%S") == nil)
        or value:find("[%z\1-\8\11\12\14-\31\127]") then return false end
    return utf8.len(value) ~= nil
end
local function hash(value) return type(value) == "string" and #value == 64 and value:match("^[0-9a-f]+$") ~= nil end
local function integer(value, minimum) return type(value) == "number" and value % 1 == 0 and value >= minimum end
local function allowed(value, keys)
    for key in value do if not keys[key] then return false end end
    return true
end
local function read(file)
    if not tern.fs.exists(file) then return nil, "missing" end
    local ok, raw = pcall(tern.fs.read, file, Store.maxJson)
    if not ok then return nil, "read_failed" end
    local decoded, value = pcall(tern.json.decode, raw)
    if not decoded or type(value) ~= "table" then return nil, "corrupt_reviews" end
    return value
end
local function empty(req)
    return {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId, revision=0,
        reviews=tern.json.array(), acceptances=tern.json.array(), reopenings=tern.json.array()}
end
local reviewKeys = {id=true, source=true, scope=true, codeSnapshotSha256=true, requirementRevision=true,
    createdAt=true, findings=true, events=true}
local findingKeys = {id=true, severity=true, description=true, createdAt=true}
local eventKeys = {id=true, findingId=true, action=true, reason=true, at=true}
local acceptanceKeys = {id=true, decision=true, requirementRevision=true, codeSnapshotSha256=true,
    verificationIds=true, reviewIds=true, comment=true, createdAt=true}
local reopeningKeys = {id=true, acceptanceId=true, reason=true, at=true}
local function validFinding(finding)
    return type(finding) == "table" and Store.token(finding.id) and finding.id:match("^finding%-[%w]+$")
        and severities[finding.severity] and text(finding.description, 4000, false)
        and integer(finding.createdAt, 0) and allowed(finding, findingKeys)
end
local function validReview(review)
    if type(review) ~= "table" or not Store.token(review.id) or not review.id:match("^review%-[%w]+$")
        or not sources[review.source] or not text(review.scope, 2000, false) or not hash(review.codeSnapshotSha256)
        or not integer(review.requirementRevision, 1) or not integer(review.createdAt, 0)
        or type(review.findings) ~= "table" or #review.findings > MAX_FINDINGS
        or type(review.events) ~= "table" or #review.events > MAX_EVENTS
        or not allowed(review, reviewKeys) then return false end
    local findings = {}
    for _, finding in review.findings do
        if not validFinding(finding) or findings[finding.id] then return false end
        findings[finding.id] = true
    end
    for _, event in review.events do
        if type(event) ~= "table" or not Store.token(event.id) or not event.id:match("^review%-event%-[%w]+$")
            or not findings[event.findingId] or not actions[event.action] or not text(event.reason, 2000, false)
            or not integer(event.at, 0) or not allowed(event, eventKeys) then return false end
    end
    return true
end
local function validAcceptance(item)
    if type(item) ~= "table" or not Store.token(item.id) or not item.id:match("^acceptance%-[%w]+$")
        or (item.decision ~= "accepted" and item.decision ~= "rejected")
        or not integer(item.requirementRevision, 1) or not hash(item.codeSnapshotSha256)
        or type(item.verificationIds) ~= "table" or #item.verificationIds > 50
        or type(item.reviewIds) ~= "table" or #item.reviewIds > 50
        or not text(item.comment, 4000, item.decision == "accepted")
        or not integer(item.createdAt, 0) or not allowed(item, acceptanceKeys) then return false end
    if item.decision == "rejected" and not item.comment:match("%S") then return false end
    local seen = {}
    for _, id in item.verificationIds do if not Store.token(id) or seen[id] then return false end; seen[id] = true end
    local reviews = {}
    for _, id in item.reviewIds do if not Store.token(id) or reviews[id] then return false end; reviews[id] = true end
    return true
end
local function validReopening(item, acceptances)
    return type(item) == "table" and Store.token(item.id) and item.id:match("^reopening%-[%w]+$")
        and acceptances[item.acceptanceId] and text(item.reason, 2000, false)
        and integer(item.at, 0) and allowed(item, reopeningKeys)
end
function M.validate(data, req)
    if type(data) ~= "table" or data.schemaVersion ~= 1 or data.projectId ~= req.projectId
        or data.requirementId ~= req.requirementId or not integer(data.revision, 0)
        or type(data.reviews) ~= "table" or #data.reviews > MAX_REVIEWS
        or type(data.acceptances) ~= "table" or #data.acceptances > MAX_DECISIONS
        or type(data.reopenings) ~= "table" or #data.reopenings > MAX_DECISIONS
        or not allowed(data, {schemaVersion=true, projectId=true, requirementId=true, revision=true,
            reviews=true, acceptances=true, reopenings=true}) then return nil, "corrupt_reviews" end
    local ids = {}
    for _, review in data.reviews do
        if not validReview(review) or ids[review.id] then return nil, "corrupt_reviews" end
        ids[review.id] = true
    end
    local acceptances = {}
    for _, item in data.acceptances do
        if not validAcceptance(item) or acceptances[item.id] then return nil, "corrupt_reviews" end
        acceptances[item.id] = true
        for _, id in item.reviewIds do if not ids[id] then return nil, "corrupt_reviews" end end
    end
    for _, item in data.reopenings do
        if not validReopening(item, acceptances) then return nil, "corrupt_reviews" end
    end
    return data
end
function M.load(paths, req)
    local data, err = read(M.path(paths, req))
    if err == "missing" then return empty(req), nil end
    if not data then return nil, {code=err} end
    local valid, problem = M.validate(data, req)
    if not valid then return nil, {code=problem} end
    return data, nil
end
local function copy(items, limit)
    local out = tern.json.array()
    for index, item in items do
        if index > limit then break end
        table.insert(out, item)
    end
    return out
end
local function save(paths, req, token, data, expected, cb)
    Store.putScoped(paths, M.path(paths, req), data, expected, token, function(saved, reason, cx)
        if saved then cb(data, nil, cx) else cb(nil, {code=reason}, cx) end
    end)
end
function M.createReview(paths, req, token, args, expected, cb)
    local function fail(code, detail) cb(nil, {code=code, detail=detail}) end
    if type(args) ~= "table" or not sources[args.source] or not text(args.scope, 2000, false)
        or not hash(args.codeSnapshotSha256) or type(args.findings) ~= "table" or #args.findings > MAX_FINDINGS then
        fail("invalid_review"); return
    end
    local data, problem = M.load(paths, req)
    if not data then cb(nil, problem); return end
    if data.revision ~= expected then fail("revision_conflict"); return end
    if #data.reviews >= MAX_REVIEWS then fail("review_limit"); return end
    local now = os.time() * 1000
    local review = {id=Store.newId("review", now), source=args.source, scope=args.scope,
        codeSnapshotSha256=args.codeSnapshotSha256, requirementRevision=req.revision, createdAt=now,
        findings=tern.json.array(), events=tern.json.array()}
    for _, item in args.findings do
        if type(item) ~= "table" or not severities[item.severity] or not text(item.description, 4000, false) then
            fail("invalid_finding"); return
        end
        table.insert(review.findings, {id=Store.newId("finding", now), severity=item.severity,
            description=item.description, createdAt=now})
    end
    local nextData = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=data.revision + 1, reviews=copy(data.reviews, MAX_REVIEWS),
        acceptances=copy(data.acceptances, MAX_DECISIONS), reopenings=copy(data.reopenings, MAX_DECISIONS)}
    table.insert(nextData.reviews, review)
    local valid, why = M.validate(nextData, req)
    if not valid then fail(why); return end
    save(paths, req, token, nextData, data.revision, cb)
end
function M.disposeFinding(paths, req, token, args, expected, cb)
    local function fail(code) cb(nil, {code=code}) end
    if type(args) ~= "table" or not Store.token(args.reviewId) or not Store.token(args.findingId)
        or not actions[args.action] or not text(args.reason, 2000, false) then fail("invalid_disposition"); return end
    local data, problem = M.load(paths, req)
    if not data then cb(nil, problem); return end
    if data.revision ~= expected then fail("revision_conflict"); return end
    local nextData = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=data.revision + 1, reviews=copy(data.reviews, MAX_REVIEWS),
        acceptances=copy(data.acceptances, MAX_DECISIONS), reopenings=copy(data.reopenings, MAX_DECISIONS)}
    local matched
    for _, review in nextData.reviews do
        if review.id == args.reviewId then
            matched = false
            for _, finding in review.findings do if finding.id == args.findingId then matched = true; break end end
            if not matched then fail("missing_finding"); return end
            if #review.events >= MAX_EVENTS then fail("review_event_limit"); return end
            table.insert(review.events, {id=Store.newId("review-event", os.time() * 1000), findingId=args.findingId,
                action=args.action, reason=args.reason, at=os.time() * 1000})
            break
        end
    end
    if matched == nil then fail("missing_review"); return end
    local valid, why = M.validate(nextData, req)
    if not valid then fail(why); return end
    save(paths, req, token, nextData, data.revision, cb)
end
function M.findingState(review, findingId)
    return Validity.findingState(review, findingId)
end
function M.latestAcceptance(data)
    local item = data and data.acceptances and data.acceptances[#data.acceptances]
    return item
end
function M.acceptanceGate(req, results, data)
    return Validity.acceptance(req, results, data)
end
function M.recordAcceptance(paths, req, token, args, expected, cb)
    local function fail(code) cb(nil, {code=code}) end
    if type(args) ~= "table" or (args.decision ~= "accepted" and args.decision ~= "rejected")
        or not hash(args.codeSnapshotSha256) or type(args.verificationIds) ~= "table" or #args.verificationIds > 50
        or type(args.reviewIds) ~= "table" or #args.reviewIds > 50
        or not text(args.comment, 4000, args.decision == "accepted") then fail("invalid_acceptance"); return end
    local data, problem = M.load(paths, req)
    if not data then cb(nil, problem); return end
    if data.revision ~= expected then fail("revision_conflict"); return end
    if #data.acceptances >= MAX_DECISIONS then fail("acceptance_limit"); return end
    local now = os.time() * 1000
    local item = {id=Store.newId("acceptance", now), decision=args.decision,
        requirementRevision=req.revision, codeSnapshotSha256=args.codeSnapshotSha256,
        verificationIds=tern.json.array(), reviewIds=tern.json.array(), comment=args.comment, createdAt=now}
    for _, id in args.verificationIds do table.insert(item.verificationIds, id) end
    for _, id in args.reviewIds do table.insert(item.reviewIds, id) end
    local nextData = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=data.revision + 1, reviews=copy(data.reviews, MAX_REVIEWS),
        acceptances=copy(data.acceptances, MAX_DECISIONS), reopenings=copy(data.reopenings, MAX_DECISIONS)}
    table.insert(nextData.acceptances, item)
    local valid, why = M.validate(nextData, req)
    if not valid then fail(why); return end
    save(paths, req, token, nextData, data.revision, cb)
end
function M.recordReopen(paths, req, token, args, expected, cb)
    local function fail(code) cb(nil, {code=code}) end
    if type(args) ~= "table" or not Store.token(args.acceptanceId) or not text(args.reason, 2000, false) then
        fail("invalid_reopening"); return
    end
    local data, problem = M.load(paths, req)
    if not data then cb(nil, problem); return end
    if data.revision ~= expected then fail("revision_conflict"); return end
    if #data.reopenings >= MAX_DECISIONS then fail("reopening_limit"); return end
    local found = false
    for _, acceptance in data.acceptances do if acceptance.id == args.acceptanceId and acceptance.decision == "accepted" then found = true end end
    if not found then fail("missing_acceptance"); return end
    local now = os.time() * 1000
    local nextData = {schemaVersion=1, projectId=req.projectId, requirementId=req.requirementId,
        revision=data.revision + 1, reviews=copy(data.reviews, MAX_REVIEWS),
        acceptances=copy(data.acceptances, MAX_DECISIONS), reopenings=copy(data.reopenings, MAX_DECISIONS)}
    table.insert(nextData.reopenings, {id=Store.newId("reopening", now), acceptanceId=args.acceptanceId,
        reason=args.reason, at=now})
    local valid, why = M.validate(nextData, req)
    if not valid then fail(why); return end
    save(paths, req, token, nextData, data.revision, cb)
end
return M
