--!strict
-- Loads only fixed production modules and synthetic fixtures; never a project DB.
return function(native, repo, fixture)
    local cache={}
    local sources={store="lib\\store.luau",validity="lib\\validity.luau",workflow="lib\\workflow.luau",
        context="lib\\context.luau",fixtures="tests\\af-fixtures.luau",ui="lib\\ui.luau",
        handoff="lib\\handoff.luau",runview="lib\\runview.luau",reviewview="lib\\reviewview.luau",
        auditview="lib\\auditview.luau",audit="lib\\audit.luau",results="lib\\results.luau",
        review="lib\\review.luau",batch="lib\\batch.luau",diff="lib\\diff.luau",candidates="lib\\candidates.luau"}
    local function load(name)
        if cache[name] then return cache[name] end
        local source=assert(sources[name],"unsupported native probe module")
        local text=native.fs.read(repo.."\\"..source,262144)
        local chunk=assert(loadstring("local tern,require=...\n"..text,"@"..source))
        cache[name]=chunk(native,function(dep)
            local key=assert(dep:match("([^/]+)$"))
            return load(key)
        end)
        return cache[name]
    end
    local context=load("context")
    return {module=context,state=load("fixtures").make(fixture),load=load}
end
