--!strict
local M = {}
function M.clip(value: string, bytes: number): string
    if #value <= bytes then return value end
    local cut = bytes
    while cut > 0 do
        local following = string.byte(value, cut + 1)
        if not following or following < 128 or following >= 192 then break end
        cut -= 1
    end
    return string.sub(value, 1, cut)
end
return M
