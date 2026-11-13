--!strict
return function(Candidates, json)
    local checks, failures = 0, {}
    local function check(ok, message)
        checks += 1
        if not ok then table.insert(failures, message) end
    end
    local function copy(value) return json.decode(json.encode(value)) end
    local SHA = string.rep("a", 64)
    local req = {projectId="project-1",requirementId="req-1",revision=8,contentRevision=3,
        acceptanceCriteria={{id="C1",description="通过",required=true},{id="C2",description="说明",required=false}}}
    local review = {schemaVersion=1,kind="review",id="review-candidate-1",projectId="project-1",requirementId="req-1",
        requirementRevision=8,requirementContentRevision=3,codeSnapshotSha256=SHA,planRevision=2,complete=true,
        scope="完整工作区与需求范围",findings={{id="F1",severity="blocking",description="中文发现 🧭"}}}
    local plan = copy(review)
    plan.kind, plan.scope, plan.findings = "plan", nil, nil
    plan.steps = {{id="P1",title="修复入口",criterionIds={"C1"},filePaths={"src/login.ts"}}}
    check(Candidates.validate(review) ~= nil, "完整审查候选可解析")
    check(Candidates.validate(plan) ~= nil, "显式关联的计划候选可解析")
    check(Candidates.current(review,req,{revision=2},SHA), "完整身份匹配的审查可供采用")
    check(Candidates.current(plan,req,{revision=2},SHA), "完整身份与条件匹配的计划可供采用")
    local clean = copy(review)
    clean.findings = {}
    check(Candidates.validate(clean) ~= nil, "允许完整范围的零发现声明，不推断处置")
    for _, body in {"not json", "{", string.rep("x",16385), string.char(255)} do
        check(Candidates.decode(body) == nil, "非法、不完整、超限或非UTF8文件拒绝")
    end
    local parsed = Candidates.decode(json.encode(review))
    check(parsed and parsed.findings[1].description == review.findings[1].description, "有效JSON完整保留中文发现")
    for field, value in {schemaVersion=2,kind="native_review",id="",projectId="../project",requirementId="",
        requirementRevision=0,requirementContentRevision=9,planRevision=-1,complete=false,
        codeSnapshotSha256="unknown",scope=""} do
        local bad = copy(review)
        bad[field] = value
        check(Candidates.validate(bad) == nil, "拒绝错误字段 " .. field)
    end
    local partial = copy(review)
    partial.findings[2] = {id="F1",severity="minor",description="重复ID"}
    check(Candidates.validate(partial) == nil, "发现重复来源ID拒绝")
    partial = copy(review)
    partial.findings[1].status = "resolved"
    check(Candidates.validate(partial) == nil, "候选不得声明发现已解决")
    for _, field in {"accepted","predecessor","scopeKind","partial","future"} do
        local bad = copy(review)
        bad[field] = true
        check(Candidates.validate(bad) == nil, "未知或增量字段拒绝 " .. field)
    end
    local badPlan = copy(plan)
    badPlan.steps[1].status = "done"
    check(Candidates.validate(badPlan) == nil, "候选不能把步骤设为完成")
    badPlan = copy(plan)
    badPlan.steps[1].criterionIds = {"C1","C1"}
    check(Candidates.validate(badPlan) == nil, "重复条件关联拒绝")
    badPlan = copy(plan)
    badPlan.steps[1].filePaths = {"src/login.ts","src/login.ts"}
    check(Candidates.validate(badPlan) == nil, "重复文件关联拒绝")
    badPlan = copy(plan)
    badPlan.steps[2] = copy(badPlan.steps[1])
    check(Candidates.validate(badPlan) == nil, "重复步骤来源ID拒绝")
    for _, value in {{}, {[2]=copy(plan.steps[1])}, {bad=copy(plan.steps[1])}} do
        badPlan = copy(plan)
        badPlan.steps = value
        check(Candidates.validate(badPlan) == nil, "空、稀疏、对象步骤不是完整候选")
    end
    local many = copy(plan)
    for index=1,41 do many.steps[index]={id="P"..index,title="步骤",criterionIds={},filePaths={}} end
    check(Candidates.validate(many) == nil, "超过计划容量拒绝而非截断")
    for _, path in {"AGENTS.md","src/中文.ts","docs/a-b_c.md"} do check(Candidates.path(path), "项目相对路径合法 "..path) end
    for _, path in {"/etc/passwd","C:/x","../x","a/../b","./a","a//b","a/","a\\b",".git/config",
        ".GIT/config",".omp/workbench/project.json","a\nfile","",string.rep("a",2049)} do
        check(not Candidates.path(path), "拒绝非授权路径 "..path:sub(1,30))
    end
    local function stale(r,p,s,message,expected)
        local ok, err = Candidates.current(plan,r,p,s)
        check(not ok and err and err.code == (expected or "candidate_stale"), message)
    end
    local moved = copy(req); moved.revision=9
    stale(moved,{revision=2},SHA,"仅阶段变化后也必须重新预览")
    moved = copy(req); moved.contentRevision=4
    stale(moved,{revision=2},SHA,"内容身份漂移拒绝")
    moved = copy(req); moved.requirementId="req-2"
    stale(moved,{revision=2},SHA,"不能将候选改绑另一个需求","candidate_wrong_target")
    moved = copy(req); moved.projectId="other-project"
    stale(moved,{revision=2},SHA,"不能将候选改绑另一个项目","candidate_wrong_target")
    stale(req,{revision=3},SHA,"计划编辑后候选过期")
    stale(req,nil,SHA,"没有完整计划观察时拒绝")
    stale(req,{revision=2},nil,"缺少代码快照时拒绝")
    stale(req,{revision=2},string.rep("b",64),"代码变化后拒绝")
    moved = copy(req); moved.acceptanceCriteria={}
    stale(moved,{revision=2},SHA,"不存在的条件ID不能采用","candidate_criterion_missing")
    local record = {id="candidate-1",sha256=SHA,sourceIds={"P1"},entityIds={"step-123"}}
    check(Candidates.importValid(record,"plan"), "计划采用映射合法")
    record.reviewId="review-123"
    check(Candidates.importValid(record,"review"), "审查采用映射保留所属审查")
    check(not Candidates.importValid(record,"plan"), "计划映射拒绝审查字段")
    record.reviewId=nil
    check(not Candidates.importValid(record,"review"), "审查映射不能丢失所属记录")
    record.entityIds={}
    check(not Candidates.importValid(record,"plan"), "外部内部ID映射长度不一致拒绝")
    record.entityIds={"step-123"}; record.sourceIds={"P1","P1"}
    check(not Candidates.importValid(record,"plan"), "采用映射重复来源ID拒绝")
    check(req.revision==8 and req.contentRevision==3 and plan.steps[1].criterionIds[1]=="C1", "所有校验只读")
    return {checks=checks,failures=failures}
end
