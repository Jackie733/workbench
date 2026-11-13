--!strict
-- No source/workbench binding; this opens only the synthetic probe block.
tern.on("window_start",function(cx)
    cx:new_block("af-capability-probe.probe",{},"over")
end)
