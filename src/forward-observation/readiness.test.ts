import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import Abi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { CampaignJournal, exclusiveVerified, footprint, campaignLock } from "./journal";
import { ForwardController } from "./controller";
import { manifest, MARKET, PLAN, hash, verifyFrozenRules } from "./config";
import { virtualSnapshot } from "./execution";
import { BookSource, bookMetrics, type BookObservation } from "../market-data/book-source";
import { missing } from "../market-data/adapter";
import { MinuteSource } from "./minute-source";
import { ForwardCollector, validateRead, feeMetadata, PARAMS_SELECTOR, recoverRaw, rawProof } from "./collector";
import { runSession, validateSession, capacityGuard, WRITE_RESERVE, storageSmoke, type SessionOptions } from "./runner";
import { SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS } from "../book";
import type { Evaluation } from "../signals/types";
const T = Date.UTC(2026,8,22), safety = { dryRun: true, model: "mock", noEnvFile: true };
const temp = () => mkdtemp(join(tmpdir(), "kuru-readiness-offline-"));
const c = () => new ForwardController(manifest("synthetic", T, safety));
function seed(x: ForwardController, at = T, stage = "BREAKOUT") {
  const e = { decision: { id: `fixture:${at}:${stage}`, timestamp: at, stage, direction: "LONG", metFactors: [], dataFreshness: {} },
    state: { market: MARKET.contract, timestamp: at, stage, direction: "LONG", price: 100, levels: [], breakout: null },
    events: [{ type: "STAGE_CHANGED", toStage: stage }] } as unknown as Evaluation;
  return (x as any).recordEvaluation(e, at, ["SYNTHETIC_ONLY"], []);
}
function book(at = T, size = 100): BookObservation {
  return { block: 42, blockHash: "0x" + "a".repeat(64), data: { status: "available", source: `monad:143:kuru:${MARKET.contract.toLowerCase()}:finalized-book`,
    observedAt: at, sourceTimestamp: at, receivedTimestamp: at, ageMs: 0, maxAgeMs: 5000, timeBasis: "chain_snapshot", trace: {},
    value: { ...bookMetrics([[99,size]],[[101,size]]), vaultActive: false, thinness: missing("fixture","unused",at) } },
    finality: "finalized", requestedTimestamp: at, completedTimestamp: at, acquisitionMs: 0, intervalMs: 5000, metrics: {} } as BookObservation;
}
const params = () => new ethers.utils.Interface(Abi.abi).encodeFunctionResult("getMarketParams",[100000000,10000000000,
  "0x"+"0".repeat(40),18,"0x"+"0".repeat(40),6,100,1,1000000000,5,2]);
function l2(block: number) {
  const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64,"0");
  const payload = [block,9900000000n,1000000000000n,0,10100000000n,1000000000000n].map(word).join("");
  return "0x" + word(32) + word(payload.length / 2) + payload;
}
function fakeRpc() {
  const calls: string[] = [], now = Math.floor(Date.now()/1000)*1000, head = 100000;
  return { calls, rpc: async (method: string, p: unknown[]) => {
    calls.push(method); if(method==="eth_chainId") return "0x8f";
    if(method==="eth_getBlockByNumber") { const n=p[0]==="finalized"?head:Number(BigInt(p[0] as string));
      return { number: "0x"+n.toString(16), timestamp: "0x"+Math.floor((now-(head-n)*300)/1000).toString(16), hash:"0x"+"a".repeat(64), baseFeePerGas:"0x64" }; }
    if(method==="eth_getLogs") return [];
    if(method==="eth_call") { const d=(p[0] as any).data; if(d===SEL_GET_L2_BOOK) return l2(head); if(d===SEL_GET_VAULT_PARAMS) return "0x"+"0".repeat(512); return params(); }
    throw Error("UNEXPECTED_TEST_CALL");
  } };
}
test("checkpoint JSON roundtrip preserves null clocks, policy, SR and all pending exits", () => {
  const x=c(); seed(x); x.book(book(),T,"entry"); const s=JSON.parse(JSON.stringify(x.checkpoint()));
  const y=ForwardController.restore(x.manifest,s); expect(y.checkpoint()).toEqual(s); expect(y.state().jobs.filter(j=>!j.done)).toHaveLength(2);
});
test("restored decision cadence and minute boundary do not regenerate completed observations", () => {
  const x=c(), h={market:MARKET.contract,source:"fixture",fromTimestamp:T-60000,throughTimestamp:T,receivedTimestamp:T,trades:[],error:null};
  x.observe(h,T,["raw"]); const y=ForwardController.restore(x.manifest,x.checkpoint()); expect(y.observe(h,T,["raw"])).toHaveLength(0);
});
test("checkpoint cannot extend original observation or tail", () => {
  const x=c(), s=x.checkpoint(); s.tailEnd++; expect(()=>ForwardController.restore(x.manifest,s)).toThrow();
});
test("restored existing Entry is not recreated and additional stage references same position", () => {
  const x=c(); seed(x); x.book(book(),T,"entry"); const y=ForwardController.restore(x.manifest,x.checkpoint());
  seed(y); const rows=seed(y,T+1000,"ACCELERATION"); expect(y.state().entries).toHaveLength(1);
  expect(rows[0].value.positionReference).toBe(y.state().entries[0]!.id); expect(y.state().entries[0]!.additionalSignalIds).toHaveLength(1);
});
test("exit completion survives resume; same Exit never evaluated twice", () => {
  const x=c();seed(x);x.book(book(),T,"entry");x.book(book(T+3600000),T+3600000,"exit");
  const y=ForwardController.restore(x.manifest,x.checkpoint()); expect(y.book(book(T+3600000),T+3600000,"exit")).toHaveLength(0);
  expect(y.state().jobs.filter(j=>!j.done)).toHaveLength(1);
});
test("pending Entry cannot be filled after observation end", () => {
  const x=c();seed(x,x.manifest.observationEnd-1);
  expect(x.book(book(x.manifest.observationEnd),x.manifest.observationEnd,"tail")).toHaveLength(0);expect(x.state().entries[0]!.entry).toBeNull();
});
test("tailEnd terminates with incomplete reservations and unchanged market Stage", () => {
  const x=c();seed(x);x.book(book(),T,"entry");const rows=x.book(book(x.manifest.tailEnd),x.manifest.tailEnd,"end");
  expect(x.phase(x.manifest.tailEnd)).toBe("ENDED");expect((rows[0]!.value as any).missingExitsRemainIncomplete).toBe(true);
  expect(x.checkpoint().previous!.stage).toBe("BREAKOUT");
});
test("valid zero book quantity is UNFILLED and creates no inventory exit", () => {
  const x=c();seed(x);const rows=x.book(book(T,0),T,"empty");expect((rows[0]!.value as any).benchmark.status).toBe("UNFILLED");
  expect(x.state().jobs).toHaveLength(1);
});
test("PARTIAL entry preserves acquired quantity separately from100USDC exit benchmark", () => {
  const x=c();seed(x);x.book(book(T,.1),T,"partial");const row=x.book(book(T+3600000),T+3600000,"exit")[0]!.value as any;
  expect(row.inventoryExit.requestedUnit).toBe("MON");expect(row.inventoryExit.requestedAmount).toBe(.1);
  expect(row.benchmark.requestedAmount).toBe(100);
});
test("atomic batch roundtrip restores identifiers and deduplicates records", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test");await j.commit([{stream:"signal",id:"a",value:1}],{pending:["exit"]});
  const y=await CampaignJournal.resume<any>(j.directory);expect(y.checkpoint()).toEqual({pending:["exit"]});
  const r=await y.commit([{stream:"signal",id:"a",value:1}],{pending:["exit"]});expect(r.suppressed).toBe(1);expect(r.recordCount).toBe(1);
});
test("conflicting record never overwrites existing batch", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test");await j.commit([{stream:"signal",id:"a",value:1}],{});
  await expect(j.commit([{stream:"signal",id:"a",value:2}],{})).rejects.toThrow("CONFLICT");expect((await CampaignJournal.resume(j.directory)).checkpoint()).toEqual({});
});
test("checksum corruption and chain gaps refuse resume", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test");await j.commit([],{});
  await appendFile(join(j.directory,"journal","00000001.json"),"bad");await expect(CampaignJournal.resume(j.directory)).rejects.toThrow();
});
test("unpublished crash batch preserved and never becomes a committed observation", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test");await j.commit([],{pending:["exit"]});
  await writeFile(join(j.directory,"journal","crash.pending"),"partial");const y=await CampaignJournal.resume<any>(j.directory);
  expect(y.checkpoint()).toEqual({pending:["exit"]});expect(y.recoveredPending).toEqual(["crash.pending"]);
  await y.commit([],{pending:["exit"],resumed:true});expect(await readFile(join(j.directory,"journal","crash.pending"),"utf8")).toBe("partial");
});
test("capacity accounts external files and warns at80 percent; preserves data on stop", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test",2000);await writeFile(join(j.directory,"cache"),"x".repeat(1610));
  // Compression makes repeated x fit; deterministic high-entropy fixture still exceeds the physical cap.
  expect((await j.status()).warning80).toBe(true);await expect(j.commit([],{large:Array.from({length:40},(_,i)=>hash(`capacity-fixture:${i}`)).join("")})).rejects.toThrow("CAPACITY");
  expect((await readFile(join(j.directory,"cache"))).length).toBe(1610);
});
test("write failure does not advance durable controller state", async () => {
  const j=await CampaignJournal.create<any>(await temp(),"test");await j.commit([],{step:1});await mkdir(join(j.directory,"journal","00000002.json"));
  await expect(j.commit([],{step:2})).rejects.toThrow();expect(j.checkpoint()).toEqual({step:1});
});
test("campaign writer lock refuses concurrent access, retains closed lock audit", async () => {
  const d=await temp(),release=await campaignLock(d);await expect(campaignLock(d)).rejects.toThrow("ALREADY_RUNNING");await release();
  expect((await readdir(d)).some(n=>n.startsWith("closed-lock"))).toBe(true);
});
test("actual private child abrupt exit preserves committed checkpoint and uncommitted bytes", async () => {
  const dir=await temp();
  const js=`import {CampaignJournal} from ${JSON.stringify(resolve(import.meta.dir,"journal.ts"))}; import {writeFile} from 'node:fs/promises';
    const j=await CampaignJournal.create(${JSON.stringify(dir)},'crash');await j.commit([],{pending:['1h','4h'],synthetic:true});
    await writeFile(j.directory+'/journal/killed.pending','partial');process.exit(23);`;
  const child=Bun.spawn([process.execPath,"--no-env-file","-e",js],{stdout:"pipe",stderr:"pipe"});expect(await child.exited).toBe(23);
  const j=await CampaignJournal.resume<any>(join(dir,"crash"));expect(j.checkpoint().pending).toEqual(["1h","4h"]);expect(j.recoveredPending).toHaveLength(1);
});
test("raw recovery keeps committed prefix and complete extra chunks, preserves partial tail", async () => {
  const d=await temp(),path=join(d,"old.jsonl");await writeFile(path,'{"a":1}\n');const proof=await rawProof(path);
  await appendFile(path,'{"b":2}\n{"partial":');const before=await readFile(path);
  const r=await recoverRaw(path,join(d,"next"),proof);expect(r.recoveredUncommittedBytes).toBe(8);expect(r.incompleteTrailingBytesPreserved).toBeGreaterThan(0);
  expect(await readFile(path)).toEqual(before);expect(r.missedSignalAndExecutionBooksRecoverable).toBe(false);
});
test("changed committed raw prefix and corrupt complete JSON are refused", async () => {
  const d=await temp(),path=join(d,"old.jsonl");await writeFile(path,'{"a":1}\n');const proof=await rawProof(path);
  await writeFile(path,'{"a":2}\n');await expect(recoverRaw(path,join(d,"new"),proof)).rejects.toThrow("PREFIX");
  await writeFile(path,"not-json\n");await expect(recoverRaw(path,join(d,"bad"),null)).rejects.toThrow();
});
test("minute cursor and unfinished candle survive checkpoint roundtrip", async () => {
  const d=await temp(),path=join(d,"raw.jsonl");const row={version:1,market:MARKET.contract,sizeDecimals:10,fromBlock:1,throughBlock:1,fromTimestamp:T,throughTimestamp:T+1000,receivedTimestamp:T+1000,trades:[]};
  await writeFile(path,JSON.stringify(row)+"\n");const a=new MinuteSource(path);await a.read();const b=MinuteSource.restore(path,a.checkpoint());
  expect((await b.read()).bytesRead).toBe(0);expect(b.checkpoint()).toEqual(a.checkpoint());
});
test("public read allowlist refuses transaction, alternate market, from address and arbitrary calls", () => {
  expect(()=>validateRead("eth_sendRawTransaction",[])).toThrow();expect(()=>validateRead("eth_call",[{to:MARKET.contract,data:"0x1234"},"finalized"])).toThrow();
  expect(()=>validateRead("eth_call",[{to:MARKET.contract,data:PARAMS_SELECTOR,from:"address"},"finalized"])).toThrow();
  expect(()=>validateRead("eth_call",[{to:"other",data:PARAMS_SELECTOR},"finalized"])).toThrow();
});
test("existing BookSource reused; fee parameters and gas context do not become paid costs", async () => {
  const f=fakeRpc(),x=new ForwardCollector(await temp(),()=>{},f.rpc);await x.book.refresh();
  expect(x.book).toBeInstanceOf(BookSource);expect(x.book.snapshot().data.status).toBe("available");expect(f.calls).toHaveLength(5);
  const rows=x.drain(),fee=rows.find(x=>x.stream==="fee")!.value as any,gas=rows.find(x=>x.stream==="gas")!.value as any;
  expect(fee.takerFeeBpsParameter).toBe("5");expect(fee.actualPaidFee).toBeNull();expect(fee.executionCostLedger[0].evidenceClass).toBe("UNKNOWN");
  expect(gas.gasCostClass).toBe("UNKNOWN");expect(gas.actualPaidGasCost).toBeNull();
});
test("unknown fee source time stays null, not received time", () => {
  const f=feeMetadata(params(),"0x1",null,T);expect(f.sourceTimestamp).toBeNull();expect(f.ageMs).toBeNull();
});
test("guard failure never calls transport", async () => {
  let calls=0;const x=new ForwardCollector(await temp(),()=>{throw Error("budget");},async()=>{calls++;});
  await expect(x.rpc("eth_chainId",[])).rejects.toThrow("budget");expect(calls).toBe(0);
});
test("storage smoke uses exclusive create, sync and hash readback", async () => {
  const r=await storageSmoke(await temp());expect(hash(await readFile(r.path))).toBe(r.sha256);expect(r.sync).toBe(true);
});
test("capacity reserve includes raw and temporary checkpoint peak", () => {
  expect(()=>capacityGuard(PLAN.capacityBytes-WRITE_RESERVE+1,PLAN.capacityBytes,PLAN.capacityBytes)).toThrow();
  expect(()=>capacityGuard(0,PLAN.capacityBytes,WRITE_RESERVE-1)).toThrow();
});
const options=(parent:string):SessionOptions=>({parent,campaignId:"fake-session",resume:false,mode:"smoke",approval:"PUBLIC_READ_ONLY_SMOKE",seconds:10,maxRpc:80,...safety});
test("no execution approval or no-env flag rejects before any transport", async () => {
  let calls=0;await expect(runSession({...options(await temp()),approval:""},async()=>{calls++;})).rejects.toThrow("APPROVAL");expect(calls).toBe(0);
  expect(()=>validateSession({...options("unused"),noEnvFile:false})).toThrow();
});
test("fake public session gracefully pauses and separate resume keeps original deadlines", async () => {
  const parent=await temp(),f=fakeRpc(),a=await runSession(options(parent),f.rpc);
  expect(a.checkpoint.status).toBe("PAUSED");expect(a.controller.stopped).toBe(false);expect(a.rpcCount).toBeGreaterThan(5);
  const b=await runSession({...options(parent),resume:true},fakeRpc().rpc);
  expect(b.observationEnd).toBe(a.observationEnd);expect(b.tailEnd).toBe(a.tailEnd);expect(b.checkpoint.status).toBe("PAUSED");
  expect(b.checksumFailures).toBe(0);expect(b.recovery).not.toBeNull();
},10000);
test("frozen11 rule files remain byte-identical",()=>{expect(Object.keys(verifyFrozenRules().fileHashes)).toHaveLength(11);});
test("same restored fixture inputs produce identical execution results",()=>{
  const x=c();seed(x);const s=x.checkpoint();expect(ForwardController.restore(x.manifest,s).book(book(),T,"b")).toEqual(ForwardController.restore(x.manifest,s).book(book(),T,"b"));
});
test("graceful stop request saves PAUSED checkpoint without resolving Stage or extending time",async()=>{
  const parent=await temp(),f=fakeRpc();let marked=false;
  const result=await runSession(options(parent),async(m,p)=>{
    if(!marked){marked=true;await writeFile(join(parent,"fake-session","STOP_REQUESTED"),"synthetic user stop");}
    return f.rpc(m,p);
  });
  expect(result.reason).toBe("GRACEFUL_STOP_FILE");expect(result.checkpoint.status).toBe("PAUSED");expect(result.controller.stopped).toBe(false);
},10000);
test("a missed pre-tail Entry does not force unnecessary5s book polling during tail",()=>{
  const x=c();seed(x,x.manifest.observationEnd-1);expect(x.dueBook(x.manifest.observationEnd)).toBe(false);
});
