import XCTest
@testable import BodyOS

final class DemoCoordinatorTests: XCTestCase {
    func testWindowFlowUsesCapturedToken() {
        var coordinator = DemoCoordinator()

        XCTAssertEqual(coordinator.handle(.gesture(.grab)).count, 1)
        XCTAssertEqual(coordinator.handle(.targetDetected(.mac)).count, 1)
        XCTAssertEqual(coordinator.handle(.windowCaptured(token: "window-a")).count, 1)
        XCTAssertEqual(coordinator.handle(.gesture(.throwGesture)).count, 1)

        let commands = coordinator.handle(.targetDetected(.externalDisplay))
        guard case .moveWindow(let token) = commands.first else {
            return XCTFail("Expected a window move command")
        }
        XCTAssertEqual(token, "window-a")
    }

    func testPersonFlowRoutesOnlyToGimbal() {
        var coordinator = DemoCoordinator()

        _ = coordinator.handle(.gesture(.grab))
        _ = coordinator.handle(.targetDetected(.personBlue))
        _ = coordinator.handle(.gesture(.throwGesture))

        let commands = coordinator.handle(.targetDetected(.gimbal))
        guard case .trackPerson(let person) = commands.first else {
            return XCTFail("Expected a tracking command")
        }
        XCTAssertEqual(person, .personBlue)
    }
}
