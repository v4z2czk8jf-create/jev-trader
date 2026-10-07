import { Archive,readArchive,exclusive,DEFAULT_DIRECTORY } from "../src/market-data/derivatives/long-term/archive";
import { HORIZONS,evaluateOutcome,type PriceBar } from "../src/market-data/derivatives/long-term/evaluation";
import { assertSafe } from "../src/market-data/derivatives/types";
import { join } from "node:path";
assertSafe(process.env);
const campaign=process.argv[2];
if(process.argv.length!==3||!campaign||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(campaign))throw Error("Require campaign name");
const inputDirectory=join(DEFAULT_DIRECTORY,campaign);
const lock=await exclusive();
try {
  const evaluatedAt=Date.now(),bars:PriceBar[]=[];
  for await(const row of readArchive(inputDirectory))if(row.kind==="price-bar"){
    if(bars.length>=100000)throw Error("Offline evaluator price-cache limit reached; input preserved");
    bars.push(row.data);
  }
  const output=new Archive(join("data/derivatives-outcomes",campaign));await output.init();
  for await(const row of readArchive(inputDirectory))if(row.kind==="anchor"){
    for(const horizon of HORIZONS)await output.append("outcome",evaluateOutcome(row.data,bars,horizon,evaluatedAt));
  }
  await output.flush();console.log(JSON.stringify(output.stats()));
}finally{await lock.close();}
