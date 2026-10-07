import { test, expect } from "bun:test";
import { mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBatch, decodeBatch, batchBytes } from "./storage-codec";
import { CampaignJournal, footprint } from "./journal";
import { reusableRaw, rawProof } from "./collector";
import { MARKET, hash } from "./config";
import { HistoryStore, compactHistory } from "../market-data/history-store";
import { validateSession } from "./runner";
import { rateWindow } from "./capacity-report";
const tmp=()=>mkdtemp(join(tmpdir(),"kuru-capacity-offline-"));
const record={stream:"signal",id:"first",value:{availableAt:100,sourceTimestamp:50,receivedTimestamp:99,price:12.5,status:"stale",refs:["a","b"],repeated:"evidence ".repeat(500)}};
const payload=()=>JSON.stringify({version:1,sequence:1,previousHash:null,records:[record],checkpoint:{pending:["exit1","exit4"],sourceHash:"raw"},storageBefore:{bytes:0,files:0},identifiersAdded:["signal:first"]});

test("rate window includes book/health-only batches between all three increments",()=>{
  const xs=Array.from({length:8},(_,i)=>({b:{sequence:i+1},...(i%2===0?{history:{purpose:"CURRENT_INCREMENT"}}:{})}));
  const r=rateWindow(xs);expect(r.measured.map(x=>x.b.sequence)).toEqual([2,3,4,5,6,7]);expect(r.window).toHaveLength(4);
});
test("later resume/backfill cannot discard the first complete steady window",()=>{
  const xs=Array.from({length:4},(_,i)=>({b:{sequence:i+1},history:{purpose:"CURRENT_INCREMENT"}}));
  xs.push({b:{sequence:5},history:{purpose:"BACKFILL_INCOMPLETE"}});
  expect(rateWindow(xs).last.b.sequence).toBe(4);expect(rateWindow(xs.slice(0,3)).measured).toHaveLength(0);
});
test("lossless compressed payload preserves original hash, clocks, quality and order",()=>{
  const p=payload(),encoded=encodeBatch(p),r=decodeBatch(encoded);expect(r.payload).toBe(p);expect(r.sha256).toBe(hash(p));expect(encoded.length).toBeLessThan(p.length);
});
test("same input gives deterministic encoded byte count and bytes",()=>{expect(encodeBatch(payload())).toBe(encodeBatch(payload()));});
test("legacy uncompressed journals remain readable without rewriting",()=>{const p=payload();expect(decodeBatch(JSON.stringify({payload:p,sha256:hash(p)})).payload).toBe(p);});
test("record ID and hash tampering fail closed",()=>{const w=JSON.parse(encodeBatch(payload()));w.sha256="wrong";expect(()=>decodeBatch(JSON.stringify(w))).toThrow("CHECKSUM");});
test("bad compressed record and unknown codec fail closed",()=>{
  const w=JSON.parse(encodeBatch(payload()));w.records[0].data="bad";expect(()=>decodeBatch(JSON.stringify(w))).toThrow();w.encoding="new";expect(()=>decodeBatch(JSON.stringify(w))).toThrow("CODEC");
});
test("physical stream accounting adds to exact file bytes",()=>{const t=encodeBatch(payload()),b=batchBytes(t);expect(Object.values(b.physical).reduce((a,x)=>a+x,0)).toBe(Buffer.byteLength(t));expect(b.logical.signal).toBe(Buffer.byteLength(JSON.stringify(record)));});
test("warmup records repeat without duplicate; only new increment is added",async()=>{
  const j=await CampaignJournal.create<any>(await tmp(),"test");const first=await j.commit([record],{cursor:1});
  const r=await j.commit([record,{...record,id:"new",value:{...record.value,availableAt:200}}],{cursor:2});
  expect(r.added).toBe(1);expect(r.suppressed).toBe(1);expect(r.recordCount).toBe(2);
  const y=await CampaignJournal.resume<any>(j.directory);expect(y.checkpoint()).toEqual({cursor:2});expect((await y.status()).recordCount).toBe(2);
  expect((await readFile(join(j.directory,"journal","00000001.json"))).length).toBeGreaterThan(0);
});
test("same values with later availability remain distinct point-in-time observations",async()=>{
  const j=await CampaignJournal.create<any>(await tmp(),"test");await j.commit([record,{...record,id:"reobservation",value:{...record.value,availableAt:200,receivedTimestamp:199}}],{});
  const {batch}=decodeBatch(await readFile(join(j.directory,"journal","00000001.json"),"utf8"));
  expect(batch.records.map((r:any)=>r.value.availableAt)).toEqual([100,200]);
});
async function rawFixture(){const dir=await tmp(),path=join(dir,`143-${MARKET.contract.toLowerCase()}.jsonl`),endHash="0x"+"a".repeat(64);
  const history={market:MARKET.contract,source:"fixture",fromTimestamp:0,throughTimestamp:60000,receivedTimestamp:60001,trades:[],error:null};
  await writeFile(path,JSON.stringify({version:1,market:MARKET.contract,sizeDecimals:10,fromBlock:1,throughBlock:100,fromTimestamp:0,throughTimestamp:60000,receivedTimestamp:60001,endHash,trades:[]})+"\n");
  await new HistoryStore(dir,MARKET.contract).save({version:1,market:MARKET.contract,block:100,hash:endHash,sizeDecimals:10,history:compactHistory(history)});
  return {dir,path,proof:await rawProof(path)};
}
test("verified graceful resume reuses raw without copying bytes or files",async()=>{const f=await rawFixture(),before=await footprint(f.dir),raw=await readFile(f.path);expect(await reusableRaw(f.dir,f.proof)).toBe(true);expect(await footprint(f.dir)).toEqual(before);expect(await readFile(f.path)).toEqual(raw);});
test("raw mismatch and possible active writer cannot use no-copy fast path",async()=>{const f=await rawFixture();await writeFile(f.path+".writer.lock","fixture lock");expect(await reusableRaw(f.dir,f.proof)).toBe(false);});
test("source checkpoint mismatch requires original preservation recovery path",async()=>{const f=await rawFixture();const p=f.path.replace(/\.jsonl$/,".checkpoint.json"),w=JSON.parse(await readFile(p,"utf8")),c=JSON.parse(w.payload);c.block=99;w.payload=JSON.stringify(c);w.sha256=hash(w.payload);await writeFile(p,JSON.stringify(w));expect(await reusableRaw(f.dir,f.proof)).toBe(false);});
test("committed raw hash mismatch is not ignored by reuse",async()=>{const f=await rawFixture();await writeFile(f.path,"corrupt");await expect(reusableRaw(f.dir,f.proof)).rejects.toThrow("PREFIX");});
test("compressed storage warning/hard stop count actual bytes; no deletion",async()=>{
  const j=await CampaignJournal.create<any>(await tmp(),"test",2000);await writeFile(join(j.directory,"retained"),"x".repeat(1700));
  expect((await j.status()).warning80).toBe(true);await expect(j.commit([record],{})).rejects.toThrow("CAPACITY");expect((await stat(join(j.directory,"retained"))).size).toBe(1700);
});
test("capacity mode is separately bounded; previous smoke/forward bounds are unchanged",()=>{
  const o={parent:"unused",campaignId:"test",resume:false,mode:"capacity" as const,approval:"PUBLIC_CAPACITY_MEASUREMENT",seconds:900,maxRpc:4000,dryRun:true,model:"mock",noEnvFile:true};
  expect(()=>validateSession(o)).not.toThrow();expect(()=>validateSession({...o,seconds:901})).toThrow();expect(()=>validateSession({...o,maxRpc:4001})).toThrow();
  expect(()=>validateSession({...o,mode:"smoke",approval:"PUBLIC_READ_ONLY_SMOKE"})).toThrow();
});
