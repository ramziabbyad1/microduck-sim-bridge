# Draft upstream discussion: optional JSON-RPC simulator adapter

Status: draft for review; not posted.

## Suggested title

Would an optional robotd-compatible JSON-RPC control boundary be useful?

## Suggested discussion body

We have been prototyping an optional adapter that lets an external application
drive the browser simulator with the same JSON-RPC movement and skill messages
used for a physical Microduck. The goal is to let examples and teaching tools
switch between the robot and MuJoCo at the transport boundary instead of
maintaining separate control applications.

The prototype does not write directly to MuJoCo. It adds an `ApiSource` to the
existing input `Controller`, alongside keyboard, gamepad, touch, and waypoint
sources. API movement has first priority while fresh, uses the physical
runtime's 500 ms dead-man, and releases authority immediately on
`robot.stop`. Local controls continue working when API input is idle.

The current data path is:

```text
Unix NDJSON or WebSocket client
  -> localhost Node gateway
  -> browser WebSocket
  -> validated JSON-RPC
  -> ApiSource
  -> existing Controller
  -> existing policy and MuJoCo loop
```

Implemented physical-compatible methods:

- `robot.move` with `vx`, `vy`, and `vyaw`
- `robot.stop`
- `robot.do` for ground pick, left/right kick, sit toggle, and roulade

The prototype also has a read-only `robot.get_state` simulator extension for
boot/input readiness, locomotion variant, active policy mode/skill, effective
movement command, and recovery state. This makes automated demos fail clearly
when the simulator is locked or in roller mode instead of silently losing an
action.

The local gateway binds to `127.0.0.1` and has no authentication, so it is not
intended to be exposed to an untrusted network. The adapter is inactive unless
the simulator is opened with a gateway query parameter.

Validation so far:

- unit and transport tests for JSON-RPC validation, the 500 ms dead-man,
  client routing, streamed movement, state, and interrupted-command stopping
- a real headless-browser test using the production bundle and Unix socket
- forward/turn/stop in both legs and roller modes
- a repeatable walk, turn, 750 ms settle, kick sequence
- a clear refusal for legs-only skills while rollers are active

Would this boundary be useful in the official simulator? In particular:

1. Would you prefer the optional gateway integration in this Space, or an
   independent adapter package that patches/registers an input source?
2. Is `robot.get_state` a reasonable simulator-only extension, or should state
   follow an existing physical subscription/event contract?
3. Are there additional safety or naming constraints we should match before
   preparing a focused pull request?
4. What license should downstream integrations use for the simulator source?

We can share the implementation as a small reviewable series rather than one
large feature commit.
