import Foundation
import Testing
@testable import MentraBridgeCore

struct CoreTests {
    @Test func markerTextsMapToRuntimeTargets() {
        #expect(TargetMarker.target(for: "bodyos://device/mac") == "mac")
        #expect(TargetMarker.target(for: " BodyOS://Device/external-display/ \n") == "externalDisplay")
        #expect(TargetMarker.target(for: "bodyos://person/blue") == "personBlue")
        #expect(TargetMarker.target(for: "bodyos://device/lamp") == nil)
        #expect(TargetMarker.target(for: "bodyos://device/mac?x=1") == nil)
        #expect(TargetMarker.target(for: "https://example.com") == nil)
    }

    /// Vision reads every printed marker in docs/mentra-markers.
    @Test func printedMarkersDecode() throws {
        let markers = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("docs/mentra-markers")
        let expected = [
            "mac.png": "mac", "external-display.png": "externalDisplay", "gimbal.png": "gimbal",
            "person-red.png": "personRed", "person-blue.png": "personBlue",
        ]
        for (file, target) in expected {
            let codes = try MarkerDecoder.decode(Data(contentsOf: markers.appendingPathComponent(file)))
            #expect(TargetPicker.pick(codes)?.target == target, "\(file)")
        }
    }

    /// A real glasses photo with a soft (out of focus) marker pasted in. Vision misses it at
    /// the photo's own size; the enlarged, sharpened second pass reads it.
    @Test func softMarkerIsReadOnTheSecondPass() throws {
        let photo = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("Fixtures/soft-marker-person-blue.jpg")
        #expect(TargetPicker.pick(try MarkerDecoder.decode(Data(contentsOf: photo)))?.target == "personBlue")
    }

    @Test func notAPhotoIsAnError() {
        #expect(throws: UnreadablePhoto.self) { try MarkerDecoder.decode(Data("not a jpeg".utf8)) }
    }

    @Test func markerNearestTheMiddleWins() {
        let edge = DetectedCode(payload: "a", target: "mac", boundingBox: CGRect(x: 0.02, y: 0.4, width: 0.1, height: 0.1))
        let middle = DetectedCode(payload: "b", target: "gimbal", boundingBox: CGRect(x: 0.45, y: 0.45, width: 0.1, height: 0.1))
        let stranger = DetectedCode(payload: "c", target: nil, boundingBox: CGRect(x: 0.48, y: 0.48, width: 0.04, height: 0.04))
        #expect(TargetPicker.pick([edge, stranger, middle])?.target == "gimbal")
        #expect(TargetPicker.pick([stranger]) == nil)
    }

    @Test func targetDetectedMatchesTheRuntimeContract() throws {
        let json = try JSONSerialization.jsonObject(with: Data(Wire.targetDetected("mac", id: "m-1").utf8)) as? [String: Any]
        #expect(json?["version"] as? Int == 1)
        #expect(json?["id"] as? String == "m-1")
        #expect(json?["type"] as? String == "target.detected")
        #expect(json?["target"] as? String == "mac")
        #expect(json?["confidence"] as? Int == 1)
    }

    @Test func photoUploadIsTheMultipartTheApiExpects() {
        let body = String(decoding: Wire.multipartPhoto(Data("JPEG".utf8), requestId: "photo-1", boundary: "b"), as: UTF8.self)
        #expect(body.contains("--b\r\nContent-Disposition: form-data; name=\"requestId\"\r\n\r\nphoto-1\r\n"))
        #expect(body.contains("name=\"photo\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n--b--\r\n"))
    }

    @Test func runtimeAddressForms() {
        #expect(Wire.runtimeURL("127.0.0.1")?.absoluteString == "ws://127.0.0.1:8765/")
        #expect(Wire.runtimeURL("http://192.168.8.10:9000/x?y")?.absoluteString == "ws://192.168.8.10:9000/")
        #expect(Wire.runtimeURL("wss://mac.local")?.absoluteString == "wss://mac.local:8765/")
        #expect(Wire.runtimeURL("  ") == nil)
        #expect(Wire.runtimeURL("ftp://mac") == nil)
    }

    @Test func httpRequestWaitsForTheWholeBody() {
        let head = "POST /capture?size=low&x HTTP/1.1\r\nContent-Length: 4\r\n\r\n"
        #expect(HTTPRequest(Data((head + "ab").utf8)) == nil)
        let request = HTTPRequest(Data((head + "abcd").utf8))
        #expect(request?.method == "POST")
        #expect(request?.path == "/capture")
        #expect(request?.query["size"] == "low")
        #expect(request?.body == Data("abcd".utf8))
    }
}
