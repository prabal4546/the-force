import Foundation

struct DemoCoordinator {
    private(set) var state: DemoState = .idle

    mutating func handle(_ event: ProductEvent) -> [ProductCommand] {
        switch (state, event) {
        case (.idle, .gesture(.grab)):
            state = .acquiringSource
            return [.requestTargetCapture(.source)]

        case (.acquiringSource, .targetDetected(.mac)):
            state = .capturingWindow
            return [.captureFrontmostWindow]

        case (.acquiringSource, .targetDetected(let target)) where target.isPerson:
            let payload = CarriedPayload.attention(person: target)
            state = .carrying(payload)
            return [.setVexoLED(.yellow)]

        case (.capturingWindow, .windowCaptured(let token)):
            state = .carrying(.window(token: token))
            return [.setVexoLED(.yellow)]

        case (.carrying(let payload), .gesture(.throwGesture)):
            state = .acquiringDestination(payload)
            return [.requestTargetCapture(.destination)]

        case (.acquiringDestination(.window(let token)), .targetDetected(.externalDisplay)):
            state = .executing
            return [.moveWindow(token: token)]

        case (.acquiringDestination(.attention(let person)), .targetDetected(.gimbal)):
            state = .executing
            return [.trackPerson(person)]

        case (.executing, .windowMoveFinished(true)):
            state = .idle
            return [.setVexoLED(.green)]

        case (.executing, .windowMoveFinished(false)):
            state = .failed("Window move failed")
            return [.setVexoLED(.red)]

        case (.executing, .trackingChanged(let person, .tracking)):
            state = .tracking(person)
            return [.setVexoLED(.green)]

        case (_, .gesture):
            return []

        default:
            state = .failed("Invalid source, destination, or hardware response")
            return [.setVexoLED(.red)]
        }
    }
}
