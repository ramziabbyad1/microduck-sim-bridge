import process from "node:process";
import { pathToFileURL } from "node:url";

import { callRobot, DEFAULT_SOCKET, rpcResult } from "./robot-client.js";

export function callRobotState({ socketPath = DEFAULT_SOCKET } = {}) {
  return callRobot({ method: "robot.get_state", socketPath });
}

function parseArgs(argv) {
  if (argv.length === 0) return { socketPath: DEFAULT_SOCKET };
  if (argv.length === 2 && argv[0] === "--socket" && argv[1]) {
    return { socketPath: argv[1] };
  }
  throw new Error("usage: npm run robot:state -- [--socket <path>]");
}

async function main() {
  const response = await callRobotState(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(rpcResult(response, "robot.get_state"), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
