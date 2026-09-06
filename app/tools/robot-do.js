import process from "node:process";
import { pathToFileURL } from "node:url";

import { callRobot, DEFAULT_SOCKET } from "./robot-client.js";

const SKILLS = new Set([
  "ground_pick",
  "kick_left",
  "kick_right",
  "sit_toggle",
  "roulade",
]);

export function callRobotDo({ skill, socketPath = DEFAULT_SOCKET }) {
  if (!SKILLS.has(skill)) {
    throw new TypeError(`skill must be one of: ${[...SKILLS].join(", ")}`);
  }

  return callRobot({ method: "robot.do", params: { skill }, socketPath });
}

async function main() {
  const args = process.argv.slice(2);
  const skill = args[0];
  const socketFlag = args.indexOf("--socket");
  const socketPath = socketFlag === -1 ? DEFAULT_SOCKET : args[socketFlag + 1];
  if (!skill || (socketFlag !== -1 && !socketPath)) {
    throw new Error("usage: npm run robot:do -- <skill> [--socket <path>]");
  }

  const response = await callRobotDo({ skill, socketPath });
  console.log(JSON.stringify(response, null, 2));
  if (response.error || response.result?.accepted !== true) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
