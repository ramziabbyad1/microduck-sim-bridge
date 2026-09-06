# Simulator adapter architecture

The adapter lets an application send the same JSON-RPC messages to a physical
Microduck or the browser simulator. It does not replace MuJoCo, the ONNX
policies, or the existing simulator controls.

## Data path

```text
WebSocket client ─────────────┐
                             │ plain JSON-RPC
Unix NDJSON client ──────────┤
                             ▼
                    local Node gateway
                             │ routing envelope
                             ▼
                    browser WebSocket
                             │ plain JSON-RPC
                             ▼
                       MicroduckRpc
                             │ validated intent
                             ▼
                         ApiSource
                             │ velocity + discrete actions
                             ▼
                existing input Controller
                             │
                             ▼
                 MuJoCo + real ONNX policy
```

The routing envelope exists only between the local gateway and simulator tab.
Applications never see it. This lets multiple clients use the same JSON-RPC
request IDs without the gateway confusing their responses.

## Why three layers?

### Protocol: `MicroduckRpc`

This layer validates JSON-RPC and the physical API's parameter shapes. It
doesn't know whether a message arrived from WebSocket, a Unix socket, a test,
or the browser console.

### Simulator input: `ApiSource`

This implements the simulator's existing pluggable input contract. API input
therefore participates in the same arbitration as keyboard, gamepad, and
touch instead of bypassing the controller and writing into MuJoCo directly.

API input has first priority while its velocity intent is fresh. After 500 ms
without another `robot.move`, the dead-man zeroes and releases it. This mirrors
the physical robot and allows local controls to take over again.

### Transport: gateway and `GatewayTransport`

A browser cannot listen on a Unix socket or TCP port, so a small local Node
process accepts client connections and opens a WebSocket to the simulator
tab. It also serves the built simulator, keeping the browser connection on the
same origin.

The gateway binds HTTP to `127.0.0.1` by default. It has no authentication and
must not be exposed to an untrusted network.

## Supported API surface

| Method | Kind | Status |
| --- | --- | --- |
| `robot.move` | continuous notification | implemented |
| `robot.stop` | answered request | implemented |
| `robot.get_state` | answered simulator state request | implemented extension |
| `robot.head` | continuous notification | next |
| `robot.do` | answered skill request | implemented |
| `robot.setMode` | answered request | next |
| `robot.subscribe` / `robot.state` | state stream | planned |

Continuous movement deliberately supports answered requests too, because the
physical `robotd` accepts both JSON-RPC forms even though clients normally use
notifications at 20–50 Hz.

## Design rule

Compatibility belongs at the boundary. Physics behavior stays in the existing
simulator, protocol behavior stays in the RPC layer, and byte transport stays
in the gateway. A change in one should not require edits in the other two.

`robot.get_state` is currently a simulator extension rather than a claim of
physical `robotd` compatibility. It reports boot/input readiness, locomotion
variant, policy mode, active skill, effective command, movement, and recovery
state. That lets demonstrations fail with a useful precondition instead of
silently sending a kick while the entrance still owns the robot.

## Command-line demonstrations

Build and start the bridge, open its URL, then enter the simulator and let the
entrance finish:

```bash
cd app
npm run build
npm run bridge
```

In a second terminal, inspect the simulator state:

```bash
cd app
npm run robot:state
```

Stream a movement intent at 20 Hz and stop automatically after two seconds:

```bash
npm run robot:move -- forward --seconds 2
npm run robot:move -- turn-left --seconds 1
```

Directions are `forward`, `backward`, `turn-left`, and `turn-right`. The
short aliases `up`, `down`, `left`, and `right` are also accepted; left/right
turn the duck because the current locomotion policy does not expose lateral
keyboard movement. `--speed`, `--rate`, and `--socket` override their safe
defaults. The tool always requests `robot.stop` after its stream, including
when interrupted with Ctrl-C.

Invoke a discrete skill through the same NDJSON Unix-socket boundary as
`robotd`:

```bash
npm run robot:do -- kick_left
```

Or run the repeatable end-to-end demonstration:

```bash
npm run robot:demo
```

The demo checks `robot.get_state`, walks forward, turns left, explicitly
stops, waits 750 ms for a stable stance, and kicks. It refuses to start while
the simulator is booting/locked, another skill is active, or rollers are
selected.

Refresh an already-open simulator tab after rebuilding so it loads the new
adapter bundle.

Supported skill names are `ground_pick`, `kick_left`, `kick_right`,
`sit_toggle`, and `roulade`. The command exits unsuccessfully when the
simulator refuses the skill and prints its reason. This is distinct from a
keyboard test: no synthetic key event is involved.
