import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { compactHistory, type Checkpoint } from "../market-data/history-store";
import { validateCachedChunk, type Chunk, type HistoryStorageOptions } from "../market-data/rpc-source";
import type { History } from "../market-data/types";
import { STORAGE } from "./storage-policy";
export interface RawProof { bytes: number; sha256: string }

/** Fixed file range; <=64KiB reads, <=8MiB one JSON line. No512MiB allocation. */
export async function hashRange(path:string,start:number,end:number,digest=createHash("sha256"),write?:(b:Buffer)=>Promise<void>){
  const f=await open(path,"r"),buffer=Buffer.alloc(STORAGE.readChunkBytes);
  try{for(let pos=start;pos<end;){const {bytesRead}=await f.read(buffer,0,Math.min(buffer.length,end-pos),pos);
    if(!bytesRead)throw Error("RAW_TRUNCATED");const b=buffer.subarray(0,bytesRead);digest.update(b);if(write)await write(b);pos+=bytesRead;}}
  finally{await f.close();}return digest;
}
export async function scanRaw(path:string,onLine?:(line:Buffer,end:number)=>void|Promise<void>,proof?:RawProof|null,start=0){
  const f=await open(path,"r"),initial=await f.stat(),size=initial.size;
  if(size>STORAGE.rawBytes||start<0||start>size){await f.close();throw Error("RAW_CAPACITY_OR_OFFSET");}
  const full=createHash("sha256"),prefix=createHash("sha256"),buffer=Buffer.alloc(STORAGE.readChunkBytes);
  let pending=Buffer.alloc(0),complete=start,position=start;
  try{
    while(position<size){const {bytesRead}=await f.read(buffer,0,Math.min(buffer.length,size-position),position);
      if(!bytesRead)throw Error("RAW_TRUNCATED");const b=buffer.subarray(0,bytesRead);full.update(b);
      if(proof&&position<proof.bytes)prefix.update(b.subarray(0,Math.min(bytesRead,proof.bytes-position)));
      position+=bytesRead;let from=0;
      for(let i=0;i<b.length;i++)if(b[i]===10){const part=b.subarray(from,i+1);
        if(pending.length+part.length>STORAGE.maxLineBytes)throw Error("RAW_LINE_MEMORY_BOUND");
        const line=pending.length?Buffer.concat([pending,part]):Buffer.from(part);complete+=line.length;
        if(onLine)await onLine(line,complete);pending=Buffer.alloc(0);from=i+1;}
      if(from<b.length){if(pending.length+b.length-from>STORAGE.maxLineBytes)throw Error("RAW_LINE_MEMORY_BOUND");pending=Buffer.concat([pending,b.subarray(from)]);}
    }
    const after=await f.stat();if(after.size!==size||after.mtimeMs!==initial.mtimeMs)throw Error("RAW_CHANGED_DURING_SCAN");
    if(proof&&(start!==0||size<proof.bytes||prefix.digest("hex")!==proof.sha256))throw Error("RAW_COMMITTED_PREFIX_CHANGED");
    return {bytes:size,completeBytes:complete,pending,sha256:full.digest("hex")};
  }finally{await f.close();}
}
export async function rawProof(path:string):Promise<RawProof|null>{
  try{const r=await scanRaw(path);return {bytes:r.bytes,sha256:r.sha256};}catch(e:any){if(e.code==="ENOENT")return null;throw e;}
}
/** One exclusive writer: hash only newly appended bytes during a session. Full proof on resume. */
export class RawHasher {
  private bytes=0;private digest=createHash("sha256");private mtime:number|null=null;
  constructor(readonly path:string){}
  async proof():Promise<RawProof|null>{
    let s;try{s=await stat(this.path);}catch(e:any){if(e.code==="ENOENT"&&this.bytes===0)return null;throw e;}
    if(s.size<this.bytes||s.size>STORAGE.rawBytes||s.size===this.bytes&&this.mtime!==null&&s.mtimeMs!==this.mtime)throw Error("RAW_SIZE_OR_IMMUTABILITY");
    await hashRange(this.path,this.bytes,s.size,this.digest);this.bytes=s.size;this.mtime=s.mtimeMs;
    return {bytes:this.bytes,sha256:this.digest.copy().digest("hex")};
  }
}

/** Reuse the existing confirmed-OHLCV aggregator; never synthesize bars or availability. */
export async function restoreHistory(path:string,market:string,checkpoint:Checkpoint|null){
  let last:Chunk|undefined,h:History|null=null,uncompacted=0,retainedBytes=0;
  let result;
  try{result=await scanRaw(path,line=>{
    const c=JSON.parse(line.toString("utf8")) as Chunk;validateCachedChunk(c,market,last);
    if(c.throughTimestamp>c.receivedTimestamp||last&&c.receivedTimestamp<last.receivedTimestamp)throw Error("RAW_RECEIPT_CLOCK_INVALID");
    if(c.trades.length>STORAGE.retainedPrints)throw Error("History trade bound reached");
    if(!checkpoint){
      h??={market,source:`monad:143:kuru:${market.toLowerCase()}:finalized-Trade`,fromTimestamp:c.fromTimestamp,
        throughTimestamp:c.fromTimestamp,receivedTimestamp:c.receivedTimestamp,trades:[],error:null};
      const incomingBytes=Buffer.byteLength(JSON.stringify(c.trades));
      if(h.trades.length+c.trades.length>STORAGE.retainedPrints||retainedBytes+incomingBytes>STORAGE.retainedTradeBytes){h=compactHistory(h);retainedBytes=Buffer.byteLength(JSON.stringify(h.trades));
        if(h.trades.length+c.trades.length>STORAGE.retainedPrints)throw Error("History active4h trade bound reached; data preserved");
        if(retainedBytes+incomingBytes>STORAGE.retainedTradeBytes)throw Error("History retained-byte memory capacity; data preserved");}
      h.trades.push(...c.trades);h.throughTimestamp=c.throughTimestamp;h.receivedTimestamp=c.receivedTimestamp;uncompacted+=c.trades.length;
      retainedBytes+=incomingBytes;
      if(uncompacted>=5000||Math.floor(c.throughTimestamp/14400000)!==Math.floor(c.fromTimestamp/14400000)){h=compactHistory(h);uncompacted=0;retainedBytes=Buffer.byteLength(JSON.stringify(h.trades));}
    }
    // Keep only range metadata from the preceding chunk, not its trade array.
    last={...c,trades:[]};
  });}catch(e:any){if(e.code==="ENOENT"&&!checkpoint)return {bytes:0,checkpoint:null};throw e;}
  if(result.pending.length)throw Error("Raw incomplete; preservation recovery required");
  const tail=last as Chunk|undefined;
  if(checkpoint){if(!tail||tail.throughBlock!==checkpoint.block||tail.endHash!==checkpoint.hash||checkpoint.history.trades.length>STORAGE.retainedPrints||Buffer.byteLength(JSON.stringify(checkpoint.history.trades))>STORAGE.retainedTradeBytes)
    throw Error("Raw/checkpoint boundary mismatch; data preserved");return {bytes:result.bytes,checkpoint};}
  const history=h as History|null;
  const rebuilt:Checkpoint|null=tail&&history?{version:1,market,block:tail.throughBlock,hash:tail.endHash,sizeDecimals:tail.sizeDecimals,history:compactHistory(history)}:null;
  return {bytes:result.bytes,checkpoint:rebuilt};
}
export const forwardStorage=(market:string):HistoryStorageOptions=>({rawLimitBytes:STORAGE.rawBytes,maxChunkBytes:STORAGE.maxLineBytes,maxRetainedBytes:STORAGE.retainedTradeBytes,restore:(p,c)=>restoreHistory(p,market,c)});
