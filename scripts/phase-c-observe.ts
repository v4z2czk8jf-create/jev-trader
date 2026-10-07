import { runObservation } from "../src/market-data/derivatives/observe";
await runObservation(Number(process.argv[2]??95));
