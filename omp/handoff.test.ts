import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Handoff, gitBaseline, projectFile, requirementContent, workspaceChanges, type Preview } from "./handoff";
import { validateCommand, type InspectCommand } from "./runtime";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true,force:true}); });
const now = 1800000000000;
const identity = {schemaVersion:1 as const,requestId:"inspect-one",instanceId:"source-one",sessionId:"session-one",createdAt:now,expiresAt:now+30000};
function fixture(schemaVersion = 1) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-handoff-")); roots.push(root);
	execFileSync("git",["init","-q",root]);
	const folder = path.join(root,".omp/workbench/requirements/req-one"); fs.mkdirSync(folder,{recursive:true});
	const requirement = {schemaVersion,projectId:"project-one",requirementId:"req-one",number:"REQ-0001",revision:1,
		title:"中文需求 🧭",type:"feature",priority:"normal",stage:"backlog",goal:"完整交接",scope:"只修改选定项目",
		acceptanceCriteria:[{id:"C1",description:"全部选中内容完整可见",required:true}],labels:[],createdAt:now,updatedAt:now,
		...(schemaVersion === 2 ? {contentRevision:1,lifecycleEvents:[] as Record<string,unknown>[]} : {})};
	fs.writeFileSync(path.join(root,".omp/workbench/project.json"),JSON.stringify({schemaVersion:1,projectId:"project-one",root,name:"test",revision:1,nextNumber:2,createdAt:now}));
	const reqFile=path.join(folder,"requirement.json"); fs.writeFileSync(reqFile,JSON.stringify(requirement));
	const service=new Handoff();
	const inspect=(extra:Partial<InspectCommand>={})=>service.inspect({...identity,kind:"inspect",operation:"preview",requirementId:"req-one",activity:"design",includeRequirement:true,paths:[],excerpt:"",...extra},root,"session-one",[],now) as Preview;
	const approval=(mode:"design"|"direct"="design")=>{
		const body="正式方案\n按验收条件实现，不扩大范围。";
		const requirementSha256=createHash("sha256").update(requirementContent(requirement)).digest("hex");
		const sha256=createHash("sha256").update(body).digest("hex");
		const marker = schemaVersion === 2 ? {requirementContentRevision:requirement.contentRevision} : {};
		fs.mkdirSync(path.join(folder,"designs"),{recursive:true});
		fs.writeFileSync(path.join(folder,"designs/v1.json"),JSON.stringify({schemaVersion,projectId:"project-one",requirementId:"req-one",version:1,
			requirementRevision:requirement.revision,...marker,requirementSha256,body,sha256,source:{kind:"manual"},createdAt:now}));
		const decision={id:"approval-one",mode,requirementRevision:requirement.revision,...marker,requirementSha256,
			requirementContent:requirementContent(requirement),latestVersion:1,
			designVersion:mode==="design"?1:0,designSha256:mode==="design"?sha256:"",baseline:gitBaseline(root),reason:"明确授权按范围直接实施",approvedAt:now};
		const value={schemaVersion,projectId:"project-one",requirementId:"req-one",revision:1,latestVersion:1,
			designs:[{version:1,sha256,requirementSha256,requirementRevision:requirement.revision,...marker,createdAt:now}],
			comments:[],approvals:[decision],requests:[] as Record<string,unknown>[],approval:decision};
		fs.writeFileSync(path.join(folder,"workflow.json"),JSON.stringify(value)); return value;
	};
	return {root,folder,reqFile,requirement,service,inspect,approval};
}

describe("explicit complete materials",()=>{
	test("previews whole UTF8 files and selected excerpt; rejects overflow instead of clipping",()=>{
		const f=fixture(); const body="第一行 🧭\n第二行 <保持原文>";
		fs.writeFileSync(path.join(f.root,"资料.txt"),body);
		const p=f.inspect({paths:["资料.txt"],excerpt:"只选择这段讨论。"});
		expect(p.text).toContain(body); expect(p.text).toContain("只选择这段讨论。");
		expect(p.sha256).toBe(createHash("sha256").update(p.text).digest("hex"));
		fs.writeFileSync(path.join(f.root,"big.txt"),"中".repeat(5000));
		expect(()=>f.inspect({paths:["big.txt"],excerpt:"文".repeat(1000)})).toThrow("materials_too_large");
	});
	test("selected path cannot traverse outside, follow symlinks, read git secrets or binary",()=>{
		const f=fixture(); fs.writeFileSync(path.join(f.root,"valid.txt"),"safe");
		fs.symlinkSync(path.join(f.root,"valid.txt"),path.join(f.root,"link.txt"));
		fs.writeFileSync(path.join(f.root,"binary"),Buffer.from([0xff,0x00]));
		for(const candidate of ["../outside","/etc/passwd",".git/config",".omp/workbench/lock.json","a/../valid.txt","link.txt","binary"])
			expect(()=>projectFile(f.root,candidate)).toThrow();
	});
	test("reviewed requirement and file modifications are refused even without revision bumps",()=>{
		const f=fixture();fs.writeFileSync(path.join(f.root,"notes"),"before");
		const p=f.inspect({paths:["notes"]});
		fs.writeFileSync(path.join(f.root,"notes"),"after");
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("source_file_changed");
		const next=f.inspect();f.requirement.goal="未增加 revision 的外部改动";fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(()=>f.service.resolve(next.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("requirement_changed");
	});
	test("tokens expire, belong to one session and cannot be reused after dispatch",()=>{
		const f=fixture();const p=f.inspect();
		expect(()=>f.service.resolve(p.previewToken,f.root,"other-session","source-one","send-one",false,now+1)).toThrow("preview_expired_or_source_changed");
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+300001)).toThrow("preview_expired_or_source_changed");
		f.service.consume(p.previewToken);
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("preview_expired_or_source_changed");
	});
	test("latest text is only a candidate; thinking/tool input is not imported or adopted",()=>{
		const f=fixture();const before=fs.readFileSync(f.reqFile,"utf8");
		const data=f.service.inspect({...identity,kind:"inspect",operation:"candidate",requirementId:"req-one"},f.root,"session-one",[
			{type:"message",id:"entry-one",message:{role:"assistant",content:[{type:"thinking",thinking:"private reasoning"},{type:"text",text:"候选全文"},{type:"toolCall",arguments:{secret:"not selected"}}]}},
		],now) as {candidate:{body:string;includesToolCalls:boolean}};
		expect(data.candidate.body).toBe("候选全文");expect(data.candidate.includesToolCalls).toBe(true);
		expect(fs.readFileSync(f.reqFile,"utf8")).toBe(before);expect(fs.existsSync(path.join(f.folder,"workflow.json"))).toBe(false);
	});
});

describe("workspace changes are observed, never attributed to the task",()=>{
	test("baseline records real dirty and untracked files; diff and commits are bounded evidence",()=>{
		const root=fs.mkdtempSync(path.join(os.tmpdir(),"workbench-changes-")); roots.push(root);
		execFileSync("git",["init","-q",root]);
		execFileSync("git",["-C",root,"config","user.email","test@example.invalid"]);
		execFileSync("git",["-C",root,"config","user.name","Workbench Test"]);
		fs.writeFileSync(path.join(root,"a.txt"),"one\n");
		execFileSync("git",["-C",root,"add","a.txt"]);
		execFileSync("git",["-C",root,"commit","-qm","初始提交"]);
		fs.writeFileSync(path.join(root,"a.txt"),"two\n");
		fs.writeFileSync(path.join(root,"new.txt"),"untracked body\n");
		fs.mkdirSync(path.join(root,".omp/workbench"),{recursive:true});
		fs.writeFileSync(path.join(root,".omp/workbench/project.json"),"{\"revision\":1}\n");
		const baseline=gitBaseline(root);
		expect(baseline.dirty).toBe(true);
		const current=Object.fromEntries(baseline.files.map(file=>[file.path,file]));
		expect(current["a.txt"].status).toBe("M");
		expect(current["new.txt"].status).toBe("??");
		expect(current["a.txt"].sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(current[".omp/workbench/project.json"]).toBeUndefined();
		const changes=workspaceChanges(root,baseline.head);
		expect(changes.diff).toContain("-one");
		expect(changes.diff).toContain("+two");
		expect(changes.diff).toContain("+untracked body");
		expect(changes.diffSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(changes.commits).toEqual([]);
		execFileSync("git",["-C",root,"add","a.txt","new.txt"]);
		execFileSync("git",["-C",root,"commit","-qm","实现改动"]);
		const committed=workspaceChanges(root,baseline.head);
		expect(committed.commits.map(commit=>commit.subject)).toEqual(["实现改动"]);
		expect(committed.files).toEqual([]);
		expect(committed.diff).toBe("");
		fs.appendFileSync(path.join(root,"a.txt"),"later external edit\n");
		const later=workspaceChanges(root,committed.head);
		expect(later.dirty).toBe(true);
		expect(later.files.find(file=>file.path==="a.txt")?.status).toBe("M");
		expect(later.fingerprint).not.toBe(committed.fingerprint);
	});
	test("changes inspection enforces its exact command shape",()=>{
		const accepted={...identity,kind:"inspect",operation:"changes",requirementId:"req-one",since:"a".repeat(40)};
		expect(validateCommand(accepted,"inspect-one","source-one","session-one",now)).toBeNull();
		expect(validateCommand({...accepted,since:"not-a-hash"},"inspect-one","source-one","session-one",now)).toBe("invalid_baseline");
		expect(validateCommand({...accepted,path:"a.txt"},"inspect-one","source-one","session-one",now)).toBe("invalid_command");
	});
});

describe("approval is enforced at source, not merely button visibility",()=>{
	test("binary untracked file boundaries cannot produce an ambiguous baseline",()=>{
		const f=fixture();const a=path.join(f.root,"a"),b=path.join(f.root,"b");
		fs.writeFileSync(a,"\0b\0");fs.writeFileSync(b,"");
		const before=gitBaseline(f.root).fingerprint;
		fs.writeFileSync(a,"");fs.writeFileSync(b,"\0b\0");
		expect(gitBaseline(f.root).fingerprint).not.toBe(before);
	});
	test("a cancelled requirement cannot reuse an otherwise valid implementation preview",()=>{
		const f=fixture();f.approval("direct");const p=f.inspect({activity:"implement"});
		f.requirement.stage="cancelled";fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("stage_not_actionable");
	});
	test("business metadata is excluded from Git baseline, real worktree edits are not",()=>{
		const f=fixture();const before=gitBaseline(f.root);
		fs.writeFileSync(path.join(f.folder,"workflow.json"),"private metadata");
		expect(gitBaseline(f.root)).toEqual(before);
		fs.writeFileSync(path.join(f.root,"code.txt"),"change");
		expect(gitBaseline(f.root).fingerprint).not.toBe(before.fingerprint);
	});
	test("no approval or changed current requirement cannot start implementation",()=>{
		const f=fixture();expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
		f.approval();f.requirement.scope="未批准的新范围";fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
	});
	test("new version, tampered body, revoked approval and stale baseline are refused",()=>{
		const f=fixture();const w=f.approval();
		const p=f.inspect({activity:"implement"});expect(p.text).toContain("正式方案");
		const file=path.join(f.folder,"designs/v1.json");const version=JSON.parse(fs.readFileSync(file,"utf8"));
		fs.writeFileSync(file,JSON.stringify({...version,body:"篡改正文"}));
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("design_changed");
		fs.writeFileSync(file,JSON.stringify(version));
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,latestVersion:2}));
		expect(()=>f.inspect({activity:"implement"})).toThrow("invalid_workflow");
		const revoked={...w.approval,revokedAt:now+1,revocationReason:"人工撤销"};
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,approval:revoked,approvals:[revoked]}));
		expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify(w));
		fs.writeFileSync(path.join(f.root,"external.txt"),"external edit");
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("baseline_changed");
	});
	test("direct authorization still needs real scope, criteria and explicit reason",()=>{
		const f=fixture();const w=f.approval("direct");
		expect(f.inspect({activity:"implement"}).text).toContain("快捷实施授权");
		const invalid={...w.approval,reason:""};
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,approval:invalid,approvals:[invalid]}));
		expect(()=>f.inspect({activity:"implement"})).toThrow("invalid_workflow");
	});
	test("send requires an exact persisted intent, not a token borrowed for another source",()=>{
		const f=fixture();const w=f.approval();const p=f.inspect({activity:"implement"});
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",true,now+1)).toThrow("request_intent_mismatch");
		w.requests.push({requestId:"send-one",activity:"implement",sessionId:"session-one",instanceId:"source-one",payloadSha256:p.sha256,
			requirementRevision:1,authorizedRequirementRevision:1,currentRequirementRevision:1,createdAt:now,
			requirementSha256:createHash("sha256").update(requirementContent(f.requirement)).digest("hex"),status:"pending"});
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify(w));
		expect(f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",true,now+1).sha256).toBe(p.sha256);
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","other-source","send-one",true,now+1)).toThrow("request_intent_mismatch");
	});
	test("marked design and approval survive stage-only CAS changes but reviewed previews do not",()=>{
		const f=fixture(2);const w=f.approval();const preview=f.inspect({activity:"implement"});
		f.requirement.revision=2;f.requirement.stage="implementing";fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(f.inspect({activity:"implement"}).text).toContain("正式方案");
		expect(()=>f.service.resolve(preview.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("requirement_changed");
		const next=f.inspect({activity:"implement"});
		w.requests.push({requestId:"send-one",activity:"implement",sessionId:"session-one",instanceId:"source-one",payloadSha256:next.sha256,
			requirementRevision:1,requirementContentRevision:1,authorizedRequirementRevision:1,currentRequirementRevision:1,createdAt:now,
			requirementSha256:createHash("sha256").update(requirementContent(f.requirement)).digest("hex"),status:"pending"});
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify(w));
		expect(()=>f.service.resolve(next.previewToken,f.root,"session-one","source-one","send-one",true,now+1)).toThrow("request_intent_mismatch");
		Object.assign(w.requests[0]!,{requirementRevision:2,authorizedRequirementRevision:2,currentRequirementRevision:2});
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify(w));
		expect(f.service.resolve(next.previewToken,f.root,"session-one","source-one","send-one",true,now+1).sha256).toBe(next.sha256);
		Object.assign(w.requests[0]!,{requirementContentRevision:2});
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify(w));
		expect(()=>f.service.resolve(next.previewToken,f.root,"session-one","source-one","send-one",true,now+1)).toThrow("request_intent_mismatch");
	});
	test("upgrading legacy containers never rebinds an unmarked approval or design",()=>{
		const f=fixture();const w=f.approval();
		Object.assign(f.requirement,{schemaVersion:2,contentRevision:1,lifecycleEvents:[],revision:2,stage:"implementing"});
		fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,schemaVersion:2}));
		expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
		const marked={...w.approval,requirementContentRevision:1};
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,schemaVersion:2,approval:marked,approvals:[marked]}));
		expect(()=>f.inspect({activity:"implement"})).toThrow("design_changed");
	});
	test("A to B to A canonical content never resurrects marked authorization",()=>{
		const f=fixture(2);f.approval();const scope=f.requirement.scope;
		Object.assign(f.requirement,{revision:2,contentRevision:2,scope:"B scope"});fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
		Object.assign(f.requirement,{revision:3,contentRevision:3,scope});fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		expect(()=>f.inspect({activity:"implement"})).toThrow("approval_required_or_stale");
	});
	test("lifecycle events preserve optional legacy blocked metadata without fabricating missing fields",()=>{
		const f=fixture(2);
		const event={id:"lifecycle-one",action:"unblock",from:"blocked",to:"designing",reason:"恢复工作",at:now,
			previousBlockedFrom:"designing",previousBlockedReason:"旧阻塞原因"};
		for (const preserved of [event,{...event,previousBlockedFrom:undefined},{...event,previousBlockedReason:undefined},
			{...event,previousBlockedReason:""},{...event,previousBlockedFrom:undefined,previousBlockedReason:undefined}]) {
			Object.assign(f.requirement,{stage:"designing",revision:2,lifecycleEvents:[preserved]});
			fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
			expect(f.inspect().text).toContain("完整交接");
		}
		for (const invalid of [{...event,previousBlockedFrom:"implementing"},{...event,previousBlockedFrom:"unknown"},
			{...event,previousBlockedReason:42},{...event,previousBlockedReason:"x".repeat(2001)},
			{...event,action:"block",from:"designing",to:"blocked"}]) {
			Object.assign(f.requirement,{lifecycleEvents:[invalid]});fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
			expect(()=>f.inspect()).toThrow("invalid_requirement");
		}
	});
	test("schema and identity combinations reject unknown versions and unknown fields per entity",()=>{
		const f=fixture(2);const w=f.approval();const workflowFile=path.join(f.folder,"workflow.json");
		for (const invalid of [{...f.requirement,schemaVersion:3},{...f.requirement,schemaVersion:1},{...f.requirement,contentRevision:undefined},
			{...f.requirement,contentRevision:2},{...f.requirement,unknown:true}]) {
			fs.writeFileSync(f.reqFile,JSON.stringify(invalid));expect(()=>f.inspect({activity:"implement"})).toThrow();
		}
		fs.writeFileSync(f.reqFile,JSON.stringify(f.requirement));
		for (const invalid of [{...w,schemaVersion:3},{...w,schemaVersion:1},{...w,unknown:true},
			{...w,designs:[{...w.designs[0],unknown:true}]},{...w,approval:{...w.approval,unknown:true}}]) {
			fs.writeFileSync(workflowFile,JSON.stringify(invalid));expect(()=>f.inspect({activity:"implement"})).toThrow();
		}
		fs.writeFileSync(workflowFile,JSON.stringify(w));
		const designFile=path.join(f.folder,"designs/v1.json"),design=JSON.parse(fs.readFileSync(designFile,"utf8"));
		for (const invalid of [{...design,schemaVersion:3},{...design,schemaVersion:1},{...design,requirementContentRevision:undefined},{...design,unknown:true}]) {
			fs.writeFileSync(designFile,JSON.stringify(invalid));expect(()=>f.inspect({activity:"implement"})).toThrow();
		}
		const projectFile=path.join(f.root,".omp/workbench/project.json"),project=JSON.parse(fs.readFileSync(projectFile,"utf8"));
		fs.writeFileSync(projectFile,JSON.stringify({...project,schemaVersion:2}));
		expect(()=>f.inspect()).toThrow("invalid_project_record");
	});
	test("preview pins approval and exact design source even when ids, identity and CAS stay unchanged",()=>{
		const f=fixture(2);const w=f.approval();const p=f.inspect({activity:"implement"});
		const designFile=path.join(f.folder,"designs/v1.json"),design=JSON.parse(fs.readFileSync(designFile,"utf8"));
		fs.writeFileSync(designFile,JSON.stringify({...design,source:{kind:"file",path:"changed-origin"}}));
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("approval_changed");
		fs.writeFileSync(designFile,JSON.stringify(design));
		const decision={...w.approval,approvedAt:now+1};
		fs.writeFileSync(path.join(f.folder,"workflow.json"),JSON.stringify({...w,approval:decision,approvals:[decision]}));
		expect(()=>f.service.resolve(p.previewToken,f.root,"session-one","source-one","send-one",false,now+1)).toThrow("approval_changed");
	});
	test("inspection, unknown operations and text injection retain strict protocol boundaries",()=>{
		const valid={...identity,kind:"inspect",operation:"preview",requirementId:"req-one",activity:"design",includeRequirement:true,paths:[],excerpt:"选择的内容"};
		const validate=(v:unknown)=>validateCommand(v,"inspect-one","source-one","session-one",now);
		expect(validate(valid)).toBeNull();expect(validate({...valid,operation:"shell"})).toBe("invalid_operation");
		expect(validate({...valid,extra:"ignored"})).toBe("invalid_command");
		expect(validate({...valid,excerpt:"\u001b[13u"})).toBe("invalid_materials");
	});
});
