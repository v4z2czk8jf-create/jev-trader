import { mkdir, readdir, stat, appendFile } from "node:fs/promises";
import { join } from "node:path";
/** One writer, bounded total directory capacity; never prune or overwrite prior runs. */
export class ObservationStore {
  bytes=0; writtenBytes=0; error:string|null=null;
  private queue:Promise<void>=Promise.resolve();
  constructor(readonly directory:string, readonly filename:string, readonly capacity=16*1024*1024) {
    if(!/^[a-zA-Z0-9.-]+\.jsonl$/.test(filename))throw Error("Invalid observation filename");
  }
  async init() {
    await mkdir(this.directory,{recursive:true});
    for(const name of await readdir(this.directory)) {
      const s=await stat(join(this.directory,name));
      if(!s.isFile())throw Error("Unexpected nested observation storage");
      this.bytes+=s.size;
    }
  }
  append(row:unknown):Promise<void> {
    const task=this.queue.then(async()=>{
      if(this.error)throw Error(this.error);
      const line=JSON.stringify(row)+"\n",size=Buffer.byteLength(line);
      if(this.bytes+size>this.capacity)throw Error("Observation capacity exceeded; existing files preserved");
      await appendFile(join(this.directory,this.filename),line);
      this.bytes+=size;this.writtenBytes+=size;
    }).catch(()=>{this.error="Observation write unavailable; existing files preserved";throw Error(this.error);});
    this.queue=task.catch(()=>{});return task;
  }
}
