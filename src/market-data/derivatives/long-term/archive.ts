import { mkdir,readdir,stat,statfs,open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash,randomUUID } from "node:crypto";
import { createServer,type Server } from "node:net";
import { join } from "node:path";

export const DEFAULT_CAPACITY=1024**3;
export const DEFAULT_DIRECTORY="data/derivatives-long/bybit/linear-perpetual/MONUSDT";
type Row={sequence:number;writtenTimestamp:number;kind:string;data:any;checksum:string};
export async function* readArchive(directory:string):AsyncGenerator<Row|{kind:"recovery-tail";data:{file:string;bytes:number}}> {
  const names=(await readdir(directory)).filter(n=>n.endsWith(".jsonl")).sort();
  for(const name of names){
    let pending="";
    for await(const chunk of createReadStream(join(directory,name),{encoding:"utf8",highWaterMark:65536})){
      pending+=chunk;let newline:number;
      while((newline=pending.indexOf("\n"))>=0){
        const line=pending.slice(0,newline);pending=pending.slice(newline+1);
        const r=JSON.parse(line) as Row;
        const {checksum,...payload}=r;
        if(checksum!==createHash("sha256").update(JSON.stringify(payload)).digest("hex"))throw Error(`Archive checksum failure: ${name}`);
        yield r;
      }
      if(Buffer.byteLength(pending)>2*1024**2)throw Error("Archive line capacity exceeded");
    }
    if(pending.length)yield {kind:"recovery-tail",data:{file:name,bytes:Buffer.byteLength(pending)}};
  }
}

/** Global local TCP mutex releases automatically on process death; never deletes a stale lock. */
export async function exclusive(port=31987):Promise<{port:number;close:()=>Promise<void>}> {
  const server:Server=createServer(socket=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port,exclusive:true},()=>{server.removeListener("error",reject);resolve();});});
  const bound=server.address();
  return {port:typeof bound==="object"&&bound?bound.port:port,close:()=>new Promise<void>(resolve=>server.close(()=>resolve()))};
}

export class Archive {
  totalBytes=0;writtenBytes=0;queuedBytes=0;failure:string|null=null;sequence=0;
  private queue=Promise.resolve();private segmentBytes=0;private segment="";
  private runId=`${Date.now()}-${randomUUID()}`;private segmentCount=0;
  private lastSpaceCheck=0;
  readonly bytesByKind:Record<string,number>={};
  constructor(readonly directory=DEFAULT_DIRECTORY,readonly capacity=DEFAULT_CAPACITY,
    readonly queueLimit=8*1024**2,readonly freeBytes=async()=>{const s=await statfs(directory);return s.bavail*s.bsize;},
    readonly minimumFree=256*1024**2){}
  async init(restore:(row:any)=>void=()=>{}) {
    await mkdir(this.directory,{recursive:true});
    for(const name of await readdir(this.directory)){
      const s=await stat(join(this.directory,name));if(!s.isFile())throw Error("Unexpected nested archive entry");this.totalBytes+=s.size;
    }
    if(this.totalBytes>=this.capacity)throw Error("Archive full; prior data preserved");
    for await(const r of readArchive(this.directory)){
      if("sequence" in r)this.sequence=Math.max(this.sequence,r.sequence);
      restore(r);
    }
  }
  append(kind:string,data:unknown):Promise<void> {
    if(this.failure)return Promise.reject(Error(this.failure));
    if(!/^[a-z0-9-]+$/.test(kind))return Promise.reject(Error("Invalid archive kind"));
    const payload={sequence:++this.sequence,writtenTimestamp:Date.now(),kind,data};
    const line=JSON.stringify({...payload,checksum:createHash("sha256").update(JSON.stringify(payload)).digest("hex")})+"\n";
    const bytes=Buffer.byteLength(line);
    if(bytes>2*1024**2||this.queuedBytes+bytes>this.queueLimit){this.failure="Archive queue full; observation must stop";return Promise.reject(Error(this.failure));}
    this.queuedBytes+=bytes;
    const task=this.queue.then(async()=>{
      if(this.failure)throw Error(this.failure);
      if(this.totalBytes+bytes>this.capacity)throw Error("Archive capacity reached; prior data preserved");
      if(Date.now()-this.lastSpaceCheck>5000){if(await this.freeBytes()<this.minimumFree+bytes)throw Error("Insufficient disk space");this.lastSpaceCheck=Date.now();}
      const day=new Date(payload.writtenTimestamp).toISOString().slice(0,10);
      if(!this.segment.startsWith(day)||this.segmentBytes+bytes>16*1024**2){this.segment=`${day}-${this.runId}-${String(++this.segmentCount).padStart(6,"0")}.jsonl`;this.segmentBytes=0;}
      const f=await open(join(this.directory,this.segment),"a");
      try{await f.writeFile(line);await f.sync();}finally{await f.close();}
      this.totalBytes+=bytes;this.writtenBytes+=bytes;this.segmentBytes+=bytes;
      this.bytesByKind[kind]=(this.bytesByKind[kind]??0)+bytes;
    }).catch((e:unknown)=>{this.failure=e instanceof Error?e.message:"Archive failure";throw Error(this.failure);})
      .finally(()=>{this.queuedBytes-=bytes;});
    this.queue=task.catch(()=>{});return task;
  }
  async flush(){await this.queue;if(this.failure)throw Error(this.failure);}
  stats(){return {totalBytes:this.totalBytes,writtenBytes:this.writtenBytes,bytesByKind:this.bytesByKind,capacity:this.capacity,
    utilization:this.totalBytes/this.capacity,warning:this.totalBytes>=this.capacity*.8,queuedBytes:this.queuedBytes,failure:this.failure};}
}
