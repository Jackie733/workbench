--!strict
-- Isolated probe only; install exclusively in a temporary TERN_CONFIG_DIR.
local ui=tern.ui
local contextDriver=require("./context")
local function persist(s)
    tern.kv.set("af-probe:result",{text=s.text,events=s.events,refresh=s.refresh,cols=s.cols,rows=s.rows})
    if s.output then tern.fs.write(s.output,tern.json.encode({text=s.text,events=s.events,refresh=s.refresh,cols=s.cols,rows=s.rows})) end
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
tern.block.define("probe",{
    font="sans",features={"edit","undo"},
    init=function(cx,args)
        local s={text="初始",cursor=2,history={},events=tern.json.array(),output=args[1]~="" and args[1] or nil,refresh=0,cols=cx.cols,rows=cx.rows}
        if args[2]=="context" then s.context=contextDriver(tern,args[3],args[4]) end
        return s
    end,
    title=function() return "AF 隔离能力探针" end,
    view=function(s,cx)
        if s.context then return {main=ui.col({s.context.module.bar(s.context.state)})} end
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
        table.insert(s.events,{ev="key",name=key.name,ctrl=key.ctrl,meta=key.meta,text=key.text})
        if key.name=="escape" and s.open then
            s.open=false;cx:frame({{"focus","main.draft"}})
        elseif key.name=="f6" then
            tern.timer(300,function() s.refresh+=1;persist(s);cx:render() end)
        elseif (key.ctrl or key.meta) and key.name=="z" then
            local prior=table.remove(s.history)
            if prior then s.text=prior.text;s.cursor=prior.cursor end
        elseif key.name=="end" then s.cursor=width(s.text)
        elseif key.name=="home" then s.cursor=0
        elseif not key.ctrl and not key.meta and (key.text or key.name=="enter" or key.name=="paste") then
            local value=key.name=="enter" and "\n" or key.text
            if value then
                table.insert(s.history,{text=s.text,cursor=s.cursor})
                local at=point(s.text,s.cursor)
                s.text=splice(s.text,at,at,value);s.cursor+=width(value)
            end
        end
        persist(s)
    end,
    event=function(s,ev,cx)
        table.insert(s.events,ev)
        if ev.ev=="focus" then
            cx:frame({{"focus",ev.id}})
        elseif ev.ev=="edit" then
            table.insert(s.history,{text=s.text,cursor=s.cursor})
            s.text=splice(s.text,point(s.text,ev.from),point(s.text,ev.to),ev.text)
            s.cursor=ev.cursor
        elseif ev.ev=="undo" then
            local prior=table.remove(s.history)
            if prior then s.text=prior.text;s.cursor=prior.cursor end
        elseif ev.ev=="action" then
            if ev.act=="open" then s.open=true
            elseif ev.act=="close" then s.open=false;cx:frame({{"focus","main.draft"}})
            elseif ev.act=="refresh" then
                tern.timer(300,function() s.refresh+=1;persist(s);cx:render() end)
            end
        end
        persist(s)
    end,
})
