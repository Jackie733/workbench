--!strict
local M = {}

local function lines(text)
    local result = {}
    for line in (text .. "\n"):gmatch("(.-)\n") do table.insert(result, line) end
    return result
end

function M.render(before, after)
    before, after = before or "", after or ""
    if before == "" and after == "" then return "（两个版本均为空）" end
    local old, new, output = lines(before), lines(after), {}
    local prefix = 0
    while prefix < #old and prefix < #new and old[prefix + 1] == new[prefix + 1] do prefix += 1 end
    local suffix = 0
    while suffix < #old - prefix and suffix < #new - prefix
        and old[#old - suffix] == new[#new - suffix] do suffix += 1 end

    for index = 1, prefix do table.insert(output, "  " .. old[index]) end
    for index = prefix + 1, #old - suffix do table.insert(output, "- " .. old[index]) end
    for index = prefix + 1, #new - suffix do table.insert(output, "+ " .. new[index]) end
    for index = #old - suffix + 1, #old do table.insert(output, "  " .. old[index]) end

    return table.concat(output, "\n")
end

return M
