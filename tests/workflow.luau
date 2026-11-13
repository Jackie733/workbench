--!strict
-- Exercises workflow CAS and immutable publication through the production PowerShell writer.
return function(tern, repo, tempRoot, waitOne)
    assert(type(waitOne)=="function","需要可协作等待器")
    -- Carly callbacks cannot await and have a smaller budget than the host worker.
    -- Keep real native I/O, but drive queued completions on the awaitable test call.
    local native,queue=tern,{}
    local filesystem={}
    for _,name in {"read","write","list","exists","mkdir","remove"} do
        filesystem[name]=function(...)
            local value=native.fs[name](...);waitOne();return value
        end
    end
    tern=setmetatable({fs=filesystem,process={run=function(argv,options,callback)
        waitOne()
        local handle
        if callback then
            handle=native.process.run(argv,options,function(value,cx)
                table.insert(queue,function() callback(value,cx) end)
            end)
        else handle=native.process.run(argv,options) end
        waitOne()
        return handle
    end}},{__index=native})
    local function step()
        waitOne(native.sleep(50))
        local callback=table.remove(queue,1)
        if callback then callback() end
    end
    waitOne()
    local Store=assert(loadstring("local tern=...\n"..tern.fs.read(repo.."\\lib\\store.luau",262144)))(tern)
    waitOne()
    local source=tern.fs.read(repo.."\\lib\\workflow.luau",262144)
    local Validity=assert(loadstring(tern.fs.read(repo.."\\lib\\validity.luau",262144)))()
    waitOne()
    local Workflow=assert(loadstring("local tern,require=...\n"..source))(tern,function(name)
        if name=="./store" then return Store end
        assert(name=="./validity","未知工作流依赖");return Validity
    end)
    waitOne()
    local Diff=assert(loadstring(tern.fs.read(repo.."\\lib\\diff.luau",262144)))()
    local phase,aborted=0,false
    local checks,failures=0,tern.json.array()
    local function check(ok,message) checks+=1;if not ok then table.insert(failures,message) end end
    local function result() return {checks=checks,failures=failures,done=aborted or phase>=7,phase=phase} end
    tern.fs.mkdir(tempRoot)
    local root="/tmp/"..assert(tempRoot:match("[^\\]+$"))
    local paths=assert(Store.paths({host="wsl.localhost",distro="Ubuntu"},root))
    local project,req,immutable
    local request={requestId="request-one",activity="implement",sessionId="session-one",instanceId="instance-one",payloadSha256=string.rep("a",64)}
    local baseline={head="",fingerprint=string.rep("b",64),dirty=false}
    local function apply(action,args,expected)
        local w=assert(Workflow.load(paths,req))
        local called,value,errorValue=false
        Workflow.apply(paths,req,"workflow-owner",action,args,expected or w.revision,function(saved,updated,err)
            called=true;value,errorValue=saved,err;if updated then req=updated end
        end)
        while not called do step() end
        return value,errorValue
    end
    -- Invoke the returned function once per native call, preserving state between phases.
    return function()
    if aborted or phase>=7 then return result() end
    phase+=1
    if phase==1 then
        local initError,initialized
        Store.init(paths,{projectId="workflow-project",root=root,name="工作流验证",token="workflow-owner",
            owner={window="workflow-test",panel=1},now=os.time()*1000},function(value,err) project,initError,initialized=value,err,true end)
        while not initialized do step() end
        check(project~=nil,"真实 PowerShell 初始化: "..tostring(initError and initError.code))
        if not project then aborted=true;return result() end
        local createError,created
        Store.create(paths,project,{id="workflow-req",title="版本验证",type="feature",goal="保存完整方案",
            scope="项目内实现",criteria={"可恢复"},now=os.time()*1000},"workflow-owner",function(value,updated,err) req,project,createError,created=value,updated,err,true end)
        while not created do step() end
        check(req~=nil,"创建需求: "..tostring(createError and createError.code))
        if not req then aborted=true;return result() end
        local empty=assert(Workflow.load(paths,req))
        check(empty.revision==0 and empty.latestVersion==0,"缺失工作流作为内存空记录且不落盘")
    elseif phase==2 then
    local body="方案第一行\n完整内容"
    local adopted,adoptError=apply("adopt",{body=body,source={kind="manual"}})
    check(adopted~=nil,"真实原子写入版本及工作流: "..tostring(adoptError and adoptError.code))
    if not adopted then aborted=true;return result() end
    local design=assert(Workflow.readDesign(paths,req,1))
    check(req.stage=="awaiting_approval" and design.requirementRevision==req.revision,"正式版本绑定采用之后的真实需求修订")
    check(design.sha256=="02ad138027b3e3f79b21f7b594d58fda551a6b28df844ef807af148f20b0c71d","中文完整内容的 SHA-256 与独立 oracle 一致")
    immutable=tern.fs.read(paths.requirements.."\\workflow-req\\designs\\v1.json",262144)
    local _,stale=apply("comment",{designVersion=1,text="旧 CAS"},0)
    check(stale and stale.code=="revision_conflict","旧工作流 revision 被拒绝")
    local _,unauthorized=apply("request",request)
    check(unauthorized and unauthorized.code=="approval_invalid","未批准的实施被后端拒绝")
    local _,implicit=apply("approve",{designVersion=1,baseline=baseline})
    check(implicit and implicit.code=="explicit_confirmation_required","没有显式批准操作不能建立授权")
    local approved=apply("approve",{designVersion=1,baseline=baseline,clicked=true})
    check(approved and Workflow.approvalState(approved,req).valid,"批准绑定当前需求及正式方案")
    elseif phase==3 then
    apply("comment",{designVersion=1,text="仅对第一版的批注"})
    local second=apply("adopt",{body="修订方案\n完整内容",source={kind="manual"}})
    check(second and not Workflow.approvalState(second,req).valid,"新版本使旧批准失效")
    check(second and second.approvals[1].revokedAt~=nil and second.approvals[1].revocationReason=="newer_design","批准历史保留失效时间及原因")
    check(second and second.comments[1].designVersion==1 and second.latestVersion==2,"批注不会漂移到新版本")
    check(tern.fs.read(paths.requirements.."\\workflow-req\\designs\\v1.json",262144)==immutable,"采用新版本不会覆盖旧版本文件")
    local reapproved=apply("approve",{designVersion=2,baseline=baseline,clicked=true})
    local revoked=apply("revoke",{reason="人工撤回"})
    check(reapproved and revoked and revoked.approvals[2].revokedAt~=nil and not Workflow.approvalState(revoked,req).valid,"撤销被保留在对应历史决定中")
    local _,noBasis=apply("authorize_direct",{baseline=baseline,reason="",clicked=true})
    check(noBasis and noBasis.code=="direct_basis_required","快捷实施不能绕过授权依据")
    local direct=apply("authorize_direct",{baseline=baseline,reason="按当前范围与验收条件实施",clicked=true})
    check(direct and Workflow.approvalState(direct,req).valid,"明确快捷授权可建立实施依据")
    elseif phase==4 then
    local pending=apply("request",request)
    check(pending and pending.requests[1].status=="pending" and req.stage=="awaiting_approval","持久化发送意图不能冒充实施已开始")
    local unknown=apply("receipt",{requestId="request-one",status="delivery_unknown",reason="等待核对"})
    check(unknown and req.stage=="awaiting_approval","未知投递不推进生命周期")
    elseif phase==5 then
    local submitted=apply("receipt",{requestId="request-one",status="submitted",reason="已核实"})
    check(submitted and req.stage=="implementing" and submitted.requests[1].authorizedRequirementRevision<req.revision,"迟到肯定回执仅对账，保留授权修订并推进真实阶段")
    local before=assert(Workflow.load(paths,req)).revision
    local duplicate=apply("receipt",{requestId="request-one",status="submitted",reason="已核实"})
    check(duplicate and duplicate.revision==before,"重复肯定回执不会重复推进或写入")
    elseif phase==6 then
    -- Reproduce a cancelled callback after the requirement-stage CAS.
    local designRequest={requestId="request-two",activity="design",sessionId="session-one",instanceId="instance-one",payloadSha256=string.rep("c",64)}
    local intent=apply("request",designRequest)
    local moved,movementDone
    Store.workflowStage(paths,req,"designing",req.revision,"workflow-owner",function(updated) moved,movementDone=updated,true end)
    while not movementDone do step() end
    check(moved~=nil and intent~=nil,"真实阶段写入可用于中断恢复")
    if moved then req=moved end
    local recovered=apply("receipt",{requestId="request-two",status="submitted",reason="中断后核实"})
    check(recovered and recovered.requests[2].currentRequirementRevision==req.revision and req.stage=="designing","阶段已落盘但工作流未落盘时恢复同一请求，不再增加修订")
    elseif phase==7 then
    local function reconstruct(diff)
        local before,after={},{}
        for line in (diff.."\n"):gmatch("(.-)\n") do
            local prefix,body=line:sub(1,2),line:sub(3)
            if prefix~="+ " then table.insert(before,body) end
            if prefix~="- " then table.insert(after,body) end
        end
        return table.concat(before,"\n"),table.concat(after,"\n")
    end
    for _,pair in {{"a\nb","a\nc"},{"a","a\n"},{string.rep("x\n",2000).."old",string.rep("x\n",2000).."new"}} do
        local old,new=reconstruct(Diff.render(pair[1],pair[2]))
        check(old==pair[1] and new==pair[2],"共享 UI 差异可无损重建两份完整方案")
    end
    local created
    Store.create(paths,project,{id="direct-req",title="快捷验证",type="chore",goal="直接授权",
        scope="只检查项目",criteria={"无需正式方案"},now=os.time()*1000},"workflow-owner",function(value,updated) req,project,created=value,updated,true end)
    while not created do step() end
    if not req then check(false,"创建快捷实施需求");aborted=true;return result() end
    local direct=apply("authorize_direct",{baseline=baseline,reason="只按当前范围和验收实施",clicked=true})
    check(direct and direct.latestVersion==0 and Workflow.approvalState(direct,req).valid,"需求池可显式授权快捷实施，无需伪造方案")
    local intent=apply("request",{requestId="direct-request",activity="implement",sessionId="session-one",instanceId="instance-one",payloadSha256=string.rep("d",64)})
    local accepted=apply("receipt",{requestId="direct-request",status="submitted",reason="已核实"})
    check(intent and accepted and req.stage=="implementing","快捷实施肯定回执可由需求池进入实施")
    end
    return result()
end
end
