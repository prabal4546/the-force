# iPhone app

The iPhone app is the product coordinator. It talks directly to Mentra Live,
controls Flow 2 Pro through DockKit, and exchanges commands with the Mac runtime
over one WebSocket.

## Generate the project

The source of truth is `project.yml` so project-file merges do not block the
team.

```bash
brew install xcodegen
cd apps/ios
xcodegen generate
open BodyOS.xcodeproj
```

Select your development team and run on a physical iPhone. The checked-in app
starts as a fully mocked vertical slice; real adapters should preserve the same
protocols.

## Module boundaries

- `ProductCore`: state machine and domain types; no hardware SDK imports.
- `MentraTargeting`: turns a glasses capture into one `TargetID`.
- `GimbalTracking`: accepts a person target and handles search/tracking.
- `MacBridge`: encodes and decodes versioned WebSocket messages.

The Mentra owner and gimbal owner both work inside this one app. Do not create a
second iPhone application.

## Hardware dependencies

Add the Mentra Swift package only in the Mentra adapter:

```text
https://github.com/Mentra-Community/mentra-bluetooth-sdk-ios.git
```

Pin it to the release matching the Mentra Live glasses software. DockKit ships
with iOS and does not require an Insta360 SDK.
