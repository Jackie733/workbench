--!strict
-- Isolated probe only; install exclusively in a temporary TERN_CONFIG_DIR.
local ui=tern.ui
local contextDriver=require("./context")
local function persist(s)
    local out={text=s.text,title=s.titleText,modalNote=s.modalNoteText,open=s.open,focusId=s.focusId,
        submitCount=s.submitCount,confirmCount=s.confirmCount,events=s.events,refresh=s.refresh,cols=s.cols,rows=s.rows}
    tern.kv.set("af-probe:result",out)
    if s.output then tern.fs.write(s.output,tern.json.encode(out)) end
end
local function point(text,offset)
    local units,index=0,0
    for _,code in utf8.codes(text) do
        local width=code>0xFFFF and 2 or 1
        if units+width>offset then break end
        units+=width;index+=1
    end
    return index
end
local function splice(text,a,b,value)
    return text:sub(1,(utf8.offset(text,a+1) or #text+1)-1)..value..text:sub(utf8.offset(text,b+1) or #text+1)
end
local function width(text)
    local n=0
    for _,code in utf8.codes(text) do n+=code>0xFFFF and 2 or 1 end
    return n
end
local function bufferFor(s,focusId)
    if s.mode~="matrix" or focusId=="main.draft" then return "draft" end
    if focusId=="main.title" then return "title" end
    if focusId=="layer.dialog.modalNote" then return "modalNote" end
    return nil
end
local function readBuf(s,name)
    if name=="title" then return s.titleText,s.titleCursor,s.titleHistory end
    if name=="modalNote" then return s.modalNoteText,s.modalNoteCursor,s.modalNoteHistory end
    return s.text,s.cursor,s.history
end
local function writeBuf(s,name,text,cursor)
    if name=="title" then s.titleText,s.titleCursor=text,cursor
    elseif name=="modalNote" then s.modalNoteText,s.modalNoteCursor=text,cursor
    else s.text,s.cursor=text,cursor end
end
local MAIN_ORDER={"main.title","main.draft","main.open","main.choice","main.submit"}
local MODAL_ORDER={"layer.dialog.modalNote","layer.dialog.modalConfirm","layer.dialog.close"}
local function stepFocus(order,current,back)
    local idx
    for i,id in order do if id==current then idx=i;break end end
    if not idx then return order[1] end
    local nextIdx=if back then (if idx<=1 then #order else idx-1) else (if idx>=#order then 1 else idx+1)
    return order[nextIdx]
end
local function pushEdit(s,name,atPos,delEnd,value,nextCursor,now)
    local text,cursor,history=readBuf(s,name)
    local grouped=false
    if s.groupedUndo and delEnd==atPos and value~="" and value~="\n" and not value:find("\n",1,true) then
        local top=history[#history]
        if top and top.coalesce and (now-top.lastAt)<=60 and top.endCursor==cursor then
            top.lastAt=now;top.endCursor=nextCursor;grouped=true
        end
    end
    if not grouped then
        table.insert(history,{text=text,cursor=cursor,lastAt=now,endCursor=nextCursor,
            coalesce=(delEnd==atPos and value~="" and value~="\n" and not value:find("\n",1,true))})
    end
    writeBuf(s,name,splice(text,atPos,delEnd,value),nextCursor)
end
tern.block.define("probe",{
    font="sans",features={"edit","undo"},
    init=function(cx,args)
        local s={text="初始",cursor=2,history={},
            titleText="标题",titleCursor=2,titleHistory={},
            modalNoteText="",modalNoteCursor=0,modalNoteHistory={},
            open=false,focusId="main.draft",returnFocus="main.open",
            submitCount=0,confirmCount=0,
            mode=args[2] or "default",variant=args[3] or "native-tab",
            groupedUndo=(args[2]=="matrix" and args[3]=="grouped-undo"),
            events=tern.json.array(),output=args[1]~="" and args[1] or nil,refresh=0,cols=cx.cols,rows=cx.rows}
        if args[2]=="context" then s.context=contextDriver(tern,args[3],args[4]) end
        return s
    end,
    title=function() return "AF 隔离能力探针" end,
    view=function(s,cx)
        if s.context then return {main=ui.col({s.context.module.bar(s.context.state)})} end
        if s.mode=="matrix" then
            local children={
                ui.text("AF 交互矩阵探针 · "..s.variant.." · 焦点 "..tostring(s.focusId)),
                ui.node("input",{key="title",text=s.titleText,cursor=s.titleCursor,variant="field",aria="探针标题"}),
                ui.node("editor",{key="draft",text=s.text,cursor=s.cursor,variant="field",aria="探针草稿",maxLines=4}),
                ui.button("打开面板",{key="open",actions={click="open"}}),
                ui.node("select",{key="choice",value="list",options={{value="list",label="列表"},{value="board",label="看板"}}}),
                ui.button("提交探针",{key="submit",actions={click="submit"}}),
            }
            local layer
            if s.open then layer=ui.col({ui.node("overlay",{key="dialog",head="确认弹层",modal=true},{
                ui.text("弹窗内输入与按键测试 · 确认 "..tostring(s.confirmCount)),
                ui.node("input",{key="modalNote",text=s.modalNoteText,cursor=s.modalNoteCursor,variant="field",aria="弹窗备注"}),
                ui.button("确认弹窗",{key="modalConfirm",actions={click="modalConfirm"}}),
                ui.button("关闭面板",{key="close",actions={click="close"}}),
            })}) end
            return {main=ui.node("col",{key="probe",role="af.capabilities"},children),layer=layer}
        end
        local children={
            ui.text("AF 原生能力探针 · "..cx.cols.."列 / 刷新 "..s.refresh),
            ui.md("# 方案标题\n\n正文包含 **粗体**、`version` 和 [链接](https://example.com)。\n\n- 条件一\n- 条件二"),
            ui.node("editor",{key="draft",text=s.text,cursor=s.cursor,variant="field",aria="探针草稿",maxLines=4}),
            ui.button("打开面板",{key="open",actions={click="open"}}),
            ui.button("异步刷新",{key="refresh",actions={click="refresh"}}),
            ui.button("禁止执行",{key="disabled",disabled="探针：未获得执行授权",actions={click="forbidden"}}),
            ui.text("未获得执行授权；上方禁用按钮不应发送事件。"),
            ui.node("select",{key="choice",value="list",options={{value="list",label="列表"},{value="board",label="看板"}}}),
        }
        for i=1,18 do table.insert(children,ui.text("滚动证据行 "..i.."：可读内容，不含业务数据。")) end
        local layer
        if s.open then layer=ui.col({ui.node("overlay",{key="dialog",head="仅查看，不执行",modal=true},
            {ui.text("关闭后恢复草稿焦点"),ui.button("关闭面板",{key="close",actions={click="close"}})})}) end
        return {main=ui.node("col",{key="probe",role="af.capabilities"},children),layer=layer}
    end,
    resize=function(s,cols,rows) s.cols=cols;s.rows=rows;persist(s) end,
    key=function(s,key,cx)
        local now=tern.now()
        table.insert(s.events,{ev="key",at=now,name=key.name,ctrl=key.ctrl,meta=key.meta,shift=key.shift,text=key.text,focusId=s.focusId})
        if key.name=="escape" and s.open then
            s.open=false
            local target=s.mode=="matrix" and (s.returnFocus or "main.draft") or "main.draft"
            s.focusId=target;cx:frame({{"focus",target}})
        elseif s.mode=="matrix" and key.name=="tab" then
            if s.variant=="native-tab" then persist(s);return false end
            local order=s.open and MODAL_ORDER or MAIN_ORDER
            local nextId=stepFocus(order,s.focusId,key.shift==true)
            s.focusId=nextId;cx:frame({{"focus",nextId}})
        elseif key.name=="f6" then
            tern.timer(300,function() s.refresh+=1;persist(s);cx:render() end)
        elseif (key.ctrl or key.meta) and key.name=="z" then
            local name=bufferFor(s,s.focusId)
            if name then
                local _,_,history=readBuf(s,name)
                local prior=table.remove(history)
                if prior then writeBuf(s,name,prior.text,prior.cursor) end
            end
        elseif key.name=="end" then
            local name=bufferFor(s,s.focusId)
            if name then local text=readBuf(s,name);writeBuf(s,name,text,width(text)) end
        elseif key.name=="home" then
            local name=bufferFor(s,s.focusId)
            if name then local text=readBuf(s,name);writeBuf(s,name,text,0) end
        elseif not key.ctrl and not key.meta and (key.text or key.name=="enter" or key.name=="paste") then
            local name=bufferFor(s,s.focusId)
            if name then
                local value=key.name=="enter" and (name=="draft" and "\n" or nil) or key.text
                if value then
                    local text,cursor=readBuf(s,name)
                    local at=point(text,cursor)
                    pushEdit(s,name,at,at,value,cursor+width(value),now)
                end
            end
        end
        persist(s)
    end,
    event=function(s,ev,cx)
        local now=tern.now()
        ev.at=now
        table.insert(s.events,ev)
        if ev.ev=="focus" then
            s.focusId=ev.id
            cx:frame({{"focus",ev.id}})
        elseif ev.ev=="edit" then
            local name=bufferFor(s,ev.id) or "draft"
            pushEdit(s,name,point(readBuf(s,name),ev.from),point(readBuf(s,name),ev.to),ev.text,ev.cursor,now)
        elseif ev.ev=="undo" then
            local name=bufferFor(s,ev.id) or bufferFor(s,s.focusId) or "draft"
            local _,_,history=readBuf(s,name)
            local prior=table.remove(history)
            if prior then writeBuf(s,name,prior.text,prior.cursor) end
        elseif ev.ev=="action" then
            if ev.act=="open" then
                s.returnFocus=s.focusId or "main.open"
                s.open=true
                if s.mode=="matrix" then s.focusId="layer.dialog.modalNote";cx:frame({{"focus","layer.dialog.modalNote"}}) end
            elseif ev.act=="close" then
                s.open=false
                local target=s.mode=="matrix" and (s.returnFocus or "main.draft") or "main.draft"
                s.focusId=target;cx:frame({{"focus",target}})
            elseif ev.act=="modalConfirm" then s.confirmCount+=1
            elseif ev.act=="submit" then s.submitCount+=1
            elseif ev.act=="refresh" then
                tern.timer(300,function() s.refresh+=1;persist(s);cx:render() end)
            end
        end
        persist(s)
    end,
})
