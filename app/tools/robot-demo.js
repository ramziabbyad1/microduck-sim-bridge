import process from "node:process";
import { pathToFileURL } from "node:url";

import { DEFAULT_SOCKET, RobotClient, rpcResult } from "./robot-client.js";
import { driveRobot } from "./robot-move.js";

function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(new Error("demo interrupted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      reject(new Error("demo interrupted"));
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function requireDemoReady(state) {
  if (state.ready !== true) throw new Error("simulator is still booting");
  if (state.inputLocked) {
    throw new Error("simulator input is locked; enter the simulator and let the entrance finish");
  }
  if (state.locomotion !== "legs") {
    throw new Error("demo requires legs mode; switch back from rollers first");
  }
  if (state.mode !== "walk" || state.activeSkill) {
    throw new Error(`demo requires an idle standing duck; current mode is ${state.mode}`);
  }
}

export async function runRobotDemo({
  socketPath = DEFAULT_SOCKET,
  client,
  signal,
  log = () => {},
  forwardSeconds = 1.25,
  turnSeconds = 0.75,
  settleMs = 750,
} = {}) {
  const robot = client ?? new RobotClient({ socketPath });
  const ownsClient = client === undefined;
  try {
    const initial = rpcResult(
      await robot.request("robot.get_state"),
      "robot.get_state",
    );
    requireDemoReady(initial);

    log("Walking forward...");
    await driveRobot({
      client: robot,
      direction: "forward",
      seconds: forwardSeconds,
      speed: 0.18,
      signal,
    });
    log("Turning left...");
    await driveRobot({
      client: robot,
      direction: "turn-left",
      seconds: turnSeconds,
      speed: 0.6,
      signal,
    });
    log("Standing still before kick...");
    await pause(settleMs, signal);
    const kick = rpcResult(
      await robot.request("robot.do", { skill: "kick_left" }),
      "robot.do",
      { accepted: true },
    );
    const final = rpcResult(
      await robot.request("robot.get_state"),
      "robot.get_state",
    );
    return { initial, kick, final };
  } finally {
    if (ownsClient) robot.close();
  }
}

function parseArgs(argv) {
  if (argv.length === 0) return { socketPath: DEFAULT_SOCKET };
  if (argv.length === 2 && argv[0] === "--socket" && argv[1]) {
    return { socketPath: argv[1] };
  }
  throw new Error("usage: npm run robot:demo -- [--socket <path>]");
}

async function main() {
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const result = await runRobotDemo({
    ...parseArgs(process.argv.slice(2)),
    signal: abort.signal,
    log: console.log,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
