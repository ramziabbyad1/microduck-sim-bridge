import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_SOCKET = "/tmp/microduck-sim/robotd.sock";
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

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffered = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out waiting for robot.do response"));
    }, 5_000);

    const cleanup = () => clearTimeout(timeout);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "robot.do",
        params: { skill },
      })}\n`);
    });
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      socket.end();
      try {
        resolve(JSON.parse(buffered.slice(0, newline)));
      } catch (error) {
        reject(new Error(`invalid JSON response: ${error.message}`));
      }
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
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
