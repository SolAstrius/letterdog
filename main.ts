import { startHttp, startStdio } from "./src/server/transports.ts";
import { loadConfig } from "./src/config.ts";

const config = await loadConfig();

if (config.transport === "stdio") {
  await startStdio(config);
} else {
  await startHttp(config);
}
