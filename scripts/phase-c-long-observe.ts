import { runLong } from "../src/market-data/derivatives/long-term/runner";
import { join } from "node:path";
import { DEFAULT_DIRECTORY } from "../src/market-data/derivatives/long-term/archive";
// No default duration: importing modules or omitting flags never starts a campaign.
const args=process.argv.slice(2);
const flags=new Map<string,string>();
for(let i=0;i<args.length;i+=2){
  const key=args[i]!,value=args[i+1];
  if(!["--seconds","--price-tail-seconds","--campaign"].includes(key)||!value||flags.has(key))throw Error("Invalid/duplicate argument");
  flags.set(key,value);
}
const campaign=flags.get("--campaign");
if(!flags.has("--seconds")||!campaign||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(campaign))throw Error("Require --seconds <1..604800> --campaign <name> [--price-tail-seconds <0..86400>]");
const controller=new AbortController();
process.once("SIGINT",()=>controller.abort());process.once("SIGTERM",()=>controller.abort());
console.log(JSON.stringify(await runLong({seconds:Number(flags.get("--seconds")),tailSeconds:Number(flags.get("--price-tail-seconds")??0),
  directory:join(DEFAULT_DIRECTORY,campaign),signal:controller.signal}),null,2));
