/** Explicit local fault-injection probe. Synthetic records only; no market connections. */
import { mkdir,readFile,appendFile,readdir,writeFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Archive,exclusive,readArchive } from "../src/market-data/derivatives/long-term/archive";
import { assertSafe } from "../src/market-data/derivatives/types";
assertSafe(process.env);
if(process.argv[2]==="--crash-child"){
  const dir=process.argv[3];if(!dir)throw Error("Missing test directory");
  await exclusive(); // OS releases local mutex on abrupt process exit.
  const a=new Archive(dir);await a.init();await a.append("checkpoint",{fixture:"synthetic-only",heartbeat:Date.now(),clean:false});
  const file=(await readdir(dir)).find(n=>n.endsWith(".jsonl"))!;
  await appendFile(join(dir,file),'{"synthetic-incomplete":');
  console.log("READY_FOR_TERMINATION");
  await Bun.sleep(60000);
  throw Error("Parent failed to terminate fault-injection child");
}else{
  if(process.argv.length>2)throw Error("No arguments expected");
  const start=Date.now(),dir=resolve("data","long-recovery-tests",randomUUID());await mkdir(dir,{recursive:true});
  const child=Bun.spawn([process.execPath,"--no-env-file","--no-install",import.meta.path,"--crash-child",dir],{stdout:"pipe",stderr:"pipe"});
  const timeout=setTimeout(()=>child.kill(),10000);
  try {
    const reader=child.stdout.getReader();let message="";
    while(!message.includes("READY_FOR_TERMINATION")){const next=await reader.read();if(next.done)throw Error("Child did not initialize");message+=new TextDecoder().decode(next.value);}
    reader.releaseLock();
    const file=(await readdir(dir)).find(n=>n.endsWith(".jsonl"))!,before=await readFile(join(dir,file));
    child.kill();await child.exited;
    const lock=await exclusive();
    try {
      const rows:any[]=[],a=new Archive(dir);await a.init(row=>rows.push(row));
      if(!rows.some(r=>r.kind==="checkpoint")||!rows.some(r=>r.kind==="recovery-tail"))throw Error("Recovery evidence missing");
      await a.append("gap",{fixture:"synthetic-only",start:rows.find(r=>r.kind==="checkpoint").data.heartbeat,end:Date.now(),reason:"forced-process-exit",recoverable:false,series:"liquidation"});
      if(!before.equals(await readFile(join(dir,file))))throw Error("Prior file was modified");
      const recovered=[];for await(const row of readArchive(dir))recovered.push(row.kind);
      const report={fixture:"synthetic-only",elapsedMs:Date.now()-start,forcedExit:true,mutexReacquired:true,
        priorFileUnchanged:true,recoveredRecordKinds:recovered,storage:a.stats(),directory:dir};
      await writeFile(join(dir,"report.json"),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
    }finally{await lock.close();}
  }finally{clearTimeout(timeout);if(child.exitCode===null)child.kill();}
}
