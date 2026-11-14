# Contributing

## Branches

- `main` must stay runnable.
- Use short branches such as `vexo/ble-input`, `mentra/photo-target`,
  `mac/window-move`, and `gimbal/dockkit-track`.
- Merge or rebase at least every 60-90 minutes during the build.
- Do not keep integration work until the end of the day.

## Shared-contract rule

Hardware modules publish or consume the messages in
`shared/protocol/events.schema.json`. Change the schema first when adding or
renaming a message, then update both sides in the same pull request.

Do not import another owner's hardware SDK directly into your module. Depend on
their protocol instead and keep a mock implementation.

## Pull-request checklist

- `make check` passes.
- The feature works with its mock or simulator.
- No secrets, local IP addresses, band numbers, or provisioning profiles are
  committed.
- A failure produces a visible status instead of hanging.
- The change has been exercised from the shared app or Mac runtime.

## Integration cadence

At the end of every hour, stop feature work for ten minutes and run both mocked
flows from `main`:

```text
Mac -> GRAB -> externalDisplay -> THROW -> window moved
personBlue -> GRAB -> gimbal -> THROW -> tracking
```

Once a real adapter works, replace exactly one mock at a time.
