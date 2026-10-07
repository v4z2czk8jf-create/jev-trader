import {test,expect} from "bun:test";
import {mkdtemp,writeFile,readFile,appendFile,readdir,open} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {STORAGE} from "./storage-policy";
import {PLAN,MARKET,hash} from "./config";
import {scanRaw,rawProof,RawHasher,restoreHistory,forwardStorage} from "./raw-storage";
import {recoverRaw} from "./collector";
import {CampaignJournal,footprint,checkBatchSize} from "./journal";
import {capacityGuard,WRITE_RESERVE} from "./runner";
import {KuruHistorySource} from "../market-data/rpc-source";
import {compactHistory} from "../market-data/history-store";
const temp=()=>mkdtemp(join(tmpdir(),"forward-hardening-"));
const chunk=(i:number)=>({version:1,market:MARKET.contract,sizeDecimals:10,fromBlock:i+1,throughBlock:i+1,
 fromTimestamp:i*60000,throughTimestamp:(i+1)*60000,receivedTimestamp:(i+1)*60000+1,endHash:"0x"+"a".repeat(64),
 trades:[{id:`${i+1}:0`,block:i+1,timestamp:i*60000+1000,price:1,volume:2}]});
test("batch reserve bounds both decompressed payload and physical encoded bytes",()=>{
 expect(()=>checkBatchSize(32*1024**2,32*1024**2)).not.toThrow();
 expect(()=>checkBatchSize(32*1024**2+1,1)).toThrow("BATCH_MEMORY");
 expect(()=>checkBatchSize(1,32*1024**2+1)).toThrow("BATCH_MEMORY");
});
test("Forward4GiB512MiB608MiB settings do not change default Phase collector64MiB",()=>{
 expect(PLAN.capacityBytes).toBe(4*1024**3);expect(PLAN.warningRatio).toBe(.8);expect(WRITE_RESERVE).toBe(608*1024**2);
 expect(new KuruHistorySource(MARKET.contract,async()=>{}).storage().rawLimitBytes).toBe(64*1024**2);
 expect(new KuruHistorySource(MARKET.contract,async()=>{},"unused",forwardStorage(MARKET.contract)).storage().rawLimitBytes).toBe(512*1024**2);
});
test("stream hash retains exact source bytes and boundary across64KiB buffers",async()=>{
 const p=join(await temp(),"raw");const text=JSON.stringify({text:"z".repeat(70000)})+"\n";await writeFile(p,text);
 let count=0;const r=await scanRaw(p,line=>{count++;expect(JSON.parse(line.toString()).text.length).toBe(70000);});
 expect(count).toBe(1);expect(r.sha256).toBe(hash(text));expect(r.completeBytes).toBe(Buffer.byteLength(text));
});
test("incremental raw hash equals full audit without rehashing earlier observations",async()=>{
 const p=join(await temp(),"raw");await writeFile(p,JSON.stringify(chunk(0))+"\n");const h=new RawHasher(p);
 expect(await h.proof()).toEqual(await rawProof(p));await appendFile(p,JSON.stringify(chunk(1))+"\n");
 expect(await h.proof()).toEqual(await rawProof(p));expect(await h.proof()).toEqual(await rawProof(p));
});
test("truncation refuses incremental hash",async()=>{
 const p=join(await temp(),"raw");await writeFile(p,"complete\n");const h=new RawHasher(p);await h.proof();await writeFile(p,"x");await expect(h.proof()).rejects.toThrow("IMMUTABILITY");
});
test("oversized JSON line stops bounded reader without deleting evidence",async()=>{
 const p=join(await temp(),"raw");await writeFile(p,"x".repeat(STORAGE.maxLineBytes+1));await expect(scanRaw(p)).rejects.toThrow("MEMORY_BOUND");expect((await readFile(p)).length).toBe(STORAGE.maxLineBytes+1);
});
test("few records with huge IDs cannot bypass retained-byte memory limit",async()=>{
 const p=join(await temp(),"raw"),f=await open(p,"wx");
 try{for(let i=0;i<5;i++){const c=chunk(i);c.trades[0]!.id=i+":"+"x".repeat(7*1024**2);await f.writeFile(JSON.stringify(c)+"\n");}}finally{await f.close();}
 await expect(restoreHistory(p,MARKET.contract,null)).rejects.toThrow("retained-byte memory capacity");
},30000);
test("checkpointless reconstruction uses unchanged confirmed candle aggregation",async()=>{
 const p=join(await temp(),"raw"),cs=Array.from({length:500},(_,i)=>chunk(i));await writeFile(p,cs.map(c=>JSON.stringify(c)+"\n").join(""));
 const r=await restoreHistory(p,MARKET.contract,null);const expected=compactHistory({market:MARKET.contract,source:`monad:143:kuru:${MARKET.contract.toLowerCase()}:finalized-Trade`,
  fromTimestamp:0,throughTimestamp:500*60000,receivedTimestamp:500*60000+1,trades:cs.flatMap(c=>c.trades),error:null});
 expect(r.checkpoint!.history).toEqual(expected);expect(r.checkpoint!.history.trades.length).toBe(20);
});
test("more than200000 trades in an unfinished4h span still stops; guard is not enlarged",async()=>{
 const p=join(await temp(),"raw"),f=await open(p,"wx");
 try{for(let i=0;i<201;i++){const c=chunk(i);c.trades=Array.from({length:1000},(_,j)=>({id:`${i+1}:${j}`,block:i+1,timestamp:i*60000+1000+j,price:1,volume:2}));await f.writeFile(JSON.stringify(c)+"\n");}}finally{await f.close();}
 await expect(restoreHistory(p,MARKET.contract,null)).rejects.toThrow("active4h trade bound");
 expect((await readdir(join(p,".."))).includes("raw")).toBe(true);
},30000);
test("wrong market/gap cannot become a reconstructed checkpoint",async()=>{
 const p=join(await temp(),"raw");await writeFile(p,[chunk(0),chunk(2)].map(c=>JSON.stringify(c)+"\n").join(""));
 await expect(restoreHistory(p,MARKET.contract,null)).rejects.toThrow("gapped");
});
test("partial raw is preserved for recovery, never accepted as confirmed history",async()=>{
 const p=join(await temp(),"raw");await writeFile(p,JSON.stringify(chunk(0))+"\n"+"{partial");await expect(restoreHistory(p,MARKET.contract,null)).rejects.toThrow("incomplete");
});
test("recovery reserve shortage refuses copy and leaves original intact",async()=>{
 const d=await temp(),p=join(d,"raw"),text=JSON.stringify(chunk(0))+"\n";await writeFile(p,text);
 await expect(recoverRaw(p,join(d,"new"),await rawProof(p),0)).rejects.toThrow("RESERVE");expect(await readdir(d)).toEqual(["raw"]);expect(await readFile(p,"utf8")).toBe(text);
});
test("campaign and free-disk reserves stop without extending hard limit",()=>{
 expect(()=>capacityGuard(PLAN.capacityBytes-WRITE_RESERVE,PLAN.capacityBytes,WRITE_RESERVE)).not.toThrow();
 expect(()=>capacityGuard(PLAN.capacityBytes-WRITE_RESERVE+1,PLAN.capacityBytes,WRITE_RESERVE)).toThrow("RESERVE");
 expect(()=>capacityGuard(0,PLAN.capacityBytes,WRITE_RESERVE-1)).toThrow("RESERVE");
});
test("incremental journal accounting includes mutable external checkpoint growth",async()=>{
 const j=await CampaignJournal.create(await temp(),"synthetic");await j.commit([],{n:1});await writeFile(join(j.directory,"cache"),"abc");
 await j.commit([],{n:2});await appendFile(join(j.directory,"cache"),"defgh");const a=await j.status(),b=await footprint(j.directory);
 expect({bytes:a.bytes,files:a.files}).toEqual(b);const r=await CampaignJournal.resume(j.directory);expect((await r.status()).bytes).toBe(b.bytes);
});
test("normal status does not reread old journal; full resume still refuses corruption",async()=>{
 const j=await CampaignJournal.create(await temp(),"synthetic");await j.commit([],{n:1});
 // External journal modification is forbidden during single-writer operation; audit detects it.
 await appendFile(join(j.directory,"journal/00000001.json"),"corrupt");expect((await j.status()).sequence).toBe(1);
 await expect(CampaignJournal.resume(j.directory)).rejects.toThrow();
});
test("warning and hard stop still include external data under incremental accounting",async()=>{
 const j=await CampaignJournal.create(await temp(),"synthetic",10000);await writeFile(join(j.directory,"cache"),"x".repeat(8000));expect((await j.status()).warning80).toBe(true);
 await writeFile(join(j.directory,"cache"),"x".repeat(10000));await expect(j.commit([],{a:1})).rejects.toThrow("CAPACITY");
 expect((await readFile(join(j.directory,"cache"))).length).toBe(10000);
});
test("manifest/summary/smoke artifacts cannot bypass campaign cap or overwrite files",async()=>{
 const j=await CampaignJournal.create(await temp(),"synthetic",1000);await j.writeArtifact("manifest.json","x".repeat(800));
 expect((await j.status()).warning80).toBe(true);await expect(j.writeArtifact("summary.json","x".repeat(201))).rejects.toThrow("CAPACITY");
 expect(await readFile(join(j.directory,"manifest.json"),"utf8")).toBe("x".repeat(800));expect(await readdir(j.directory)).not.toContain("summary.json");
 const k=await CampaignJournal.create(await temp(),"synthetic",1000);await k.writeArtifact("smoke.json","first");await expect(k.writeArtifact("smoke.json","second")).rejects.toThrow();
 expect(await readFile(join(k.directory,"smoke.json"),"utf8")).toBe("first");
});
