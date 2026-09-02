# Kick hiccup investigation

Status: investigation handoff, 2026-09-01

This note separates two related projects that should not be debugged as one:

1. **API adapter:** make an external Microduck application control the browser simulator through the same JSON-RPC interface as a physical duck.
2. **Simulator fidelity:** determine why a kick sometimes looks jerky or fails to contact the ball consistently.

The adapter has not changed the simulator's existing keyboard kick path. A kick performed with Q, E, or F in the browser therefore does **not** test the adapter, and a hiccup on that path should initially be treated as a simulator issue.

## Current behavior and useful distinctions

- Q requests a left kick.
- E requests a right kick.
- F alternates sides, so it is a poor input for repeatable comparisons.
- The kick policy is blind: it does not observe the ball.
- A newly spawned ball has a randomized distance and heading. A missed ball is therefore not, by itself, evidence of a timing bug.
- The HUD's `FPS` and `CTRL HZ` values are averaged. They can hide a brief one-frame or one-control-step stall.

When reproducing the hiccup, distinguish these cases:

| Observation | Most likely area |
| --- | --- |
| FPS drops, control remains near 50 Hz | rendering or main-thread work |
| Control rate drops | policy inference or the physics/control loop missed a deadline |
| Both remain stable but the pose snaps at kick start/end | policy handoff, actuator tuning, low-pass filtering, or render interpolation |
| Motion looks normal but the ball is missed | randomized ball placement or blind kick geometry |

## What the code currently does

The kick lasts 25 control steps, which is 0.5 seconds at the 50 Hz control rate. Afterward, the simulator returns to walking and temporarily locks additional commands. The policy deliberately receives no ball observation.

Relevant locations:

- `app/src/game/game.js:439` — kick duration (`KICK_STEPS = 25`)
- `app/src/game/game.js:691` — policy action is assigned directly to actuator targets
- `app/src/game/game.js:767` — kick completion and command lock
- `app/src/game/game.js:868` — asynchronous 50 Hz control loop
- `app/src/game/game.js:1263` — render rig reads the latest physics pose directly
- `app/src/game/game.js:1461` — averaged FPS/control telemetry
- `app/src/game/game.js:1713` — blind-kick behavior
- `app/src/game/game.js:570` — randomized ball placement
- `app/src/game/constants.js:41` — one action scale for every policy mode
- `app/src/game/controls/keyboard.js` — Q/E/F mappings
- `app/public/robot/mjlab/robot_allcollisions.xml:41` — fixed position-actuator gain

The physical runtime's current defaults provide useful comparison points:

- walking action scale: 0.9
- standing and kicking action scale: 1.0
- standing/kick gain ratio: 0.8
- head target low-pass: 0.5
- leg target low-pass: 0.7
- kick duration: 0.5 seconds

The browser simulator currently applies policy targets without the physical runtime's head/leg low-pass and uses a fixed actuator gain. Those are confirmed implementation differences, but they are not yet confirmed causes of the visible hiccup. The 0.5-second kick duration already agrees with the physical runtime and should not be changed blindly.

References:

- Microduck protocol definitions: <https://raw.githubusercontent.com/pollen-robotics/microduck/main/duck-ipc-proto/src/lib.rs>
- Robot daemon design: <https://github.com/pollen-robotics/microduck/blob/main/docs/design/robotd-design.md>
- Runtime parameters: <https://raw.githubusercontent.com/pollen-robotics/microduck/main/robotd-params/src/lib.rs>

## Investigation plan

### 1. Make the experiment repeatable

Add simulator-only development methods under a `sim.*` namespace, rather than pretending they exist on the physical robot API:

- `sim.reset`
- `sim.spawnBall` with explicit distance and bearing
- `sim.state`

Use a stable starting pose and explicit left/right kicks. Do not use F for comparisons.

### 2. Record evidence before tuning

Add a short trace around each kick with:

- active policy/mode and control-step number
- elapsed time between control steps
- inference duration
- missed 20 ms control deadlines
- norm of the change in action targets between steps
- trunk pose and velocity
- render-frame gaps during the same interval

The existing averaged HUD values can remain, but the trace needs to retain short spikes. This should tell us whether the hiccup is a missed deadline, a target discontinuity, or merely a rendering artifact.

### 3. Run controlled A/B tests

Keep the initial robot state and ball pose fixed, then change one item at a time:

1. baseline simulator
2. physical-style leg target low-pass
3. softened gain during standing/kicking
4. visual interpolation between physics poses

Test left and right policies separately. Ball contact should be evaluated only after the motion trace is healthy, because contact also depends on placement and collision geometry.

### 4. Define success from measurements

- A kick executes all 25 policy steps without a fall or unintended mode reset.
- Repeating the same initialized test produces the same motion and ball outcome.
- Control-loop p95/p99 timing and every missed deadline are reported.
- Render hitches are measured separately from control-loop hitches.
- Any tuning change is justified against physical runtime behavior, not only by appearance.

## Separate API-adapter track

Status: implemented and covered by an end-to-end bridge test.

The completed milestone:

1. implements the physical API's five `robot.do` skills, including `kick_left` and `kick_right`
2. exercises it through the bridge with a small command-line JSON-RPC client
3. carries the simulator's accepted/refused result back to the caller

The remaining manual proof is to refresh the built simulator tab and watch a
kick invoked by the CLI without a browser keyboard event. Subscriptions and
telemetry remain a later adapter milestone.

The intended path is:

```text
external application
  -> JSON-RPC robot.do
  -> local bridge
  -> WebSocket
  -> browser API source
  -> simulator controller
  -> kick policy
```

That end-to-end test proves the adapter. Keyboard testing proves only that the original simulator controls work.

## Recommended work split

Checkpoint the adapter work after the refreshed-browser CLI demonstration.
Then investigate simulator fidelity on a separate branch or commit, starting
with instrumentation rather than tuning.

A concise prompt for a fresh conversation is:

> Open `docs/kick-hiccup-investigation.md`. The `robot.do` adapter and CLI are implemented; verify the refreshed-browser kick if needed, then start simulator instrumentation. Do not tune the simulator until a kick trace exists.
