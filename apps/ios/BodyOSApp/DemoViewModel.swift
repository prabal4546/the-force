import Foundation

@MainActor
final class DemoViewModel: ObservableObject {
    @Published private(set) var state: DemoState = .idle
    @Published var selectedTarget: TargetID = .mac
    @Published private(set) var eventLog: [String] = []

    private var coordinator = DemoCoordinator()

    func send(_ gesture: GestureName) {
        append("Gesture: \(gesture.rawValue)")
        run(coordinator.handle(.gesture(gesture)))
    }

    func reset() {
        coordinator = DemoCoordinator()
        state = coordinator.state
        eventLog.removeAll()
    }

    private func run(_ commands: [ProductCommand]) {
        state = coordinator.state

        for command in commands {
            append("Command: \(command.description)")

            // Mock adapters make the whole product flow runnable before hardware arrives.
            switch command {
            case .requestTargetCapture:
                run(coordinator.handle(.targetDetected(selectedTarget)))
            case .captureFrontmostWindow:
                run(coordinator.handle(.windowCaptured(token: "mock-window-token")))
            case .moveWindow:
                run(coordinator.handle(.windowMoveFinished(success: true)))
            case .trackPerson(let person):
                run(coordinator.handle(.trackingChanged(person: person, state: .tracking)))
            case .setVexoLED:
                break
            }
        }
    }

    private func append(_ text: String) {
        eventLog.insert(text, at: 0)
        eventLog = Array(eventLog.prefix(10))
    }
}
