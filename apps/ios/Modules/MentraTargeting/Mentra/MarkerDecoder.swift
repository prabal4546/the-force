import CoreGraphics
import Foundation
import ImageIO
import Vision

/// One QR code found in a photo.
struct DetectedCode: Equatable, Sendable {
    /// The QR text.
    let payload: String
    /// The marker's target, or nil when the QR code is not one of the five markers.
    let target: TargetID?
    /// Where it is, in normalized image coordinates (0...1, origin bottom-left, as Vision reports).
    let boundingBox: CGRect
    let confidence: Float

    init(payload: String, target: TargetID?, boundingBox: CGRect, confidence: Float) {
        self.payload = payload
        self.target = target
        self.boundingBox = boundingBox
        self.confidence = confidence
    }
}

/// Finds QR codes in a photo. A protocol so tests and mocks can stand in for Vision.
protocol MarkerDecoding: Sendable {
    func decode(_ imageData: Data) async throws -> [DetectedCode]
}

/// Local QR decoding with Apple Vision (`VNDetectBarcodesRequest`). No network, no cloud.
struct VisionMarkerDecoder: MarkerDecoding {
    init() {}

    func decode(_ imageData: Data) async throws -> [DetectedCode] {
        try await Task.detached(priority: .userInitiated) {
            try Self.decodeNow(imageData)
        }.value
    }

    static func decodeNow(_ imageData: Data) throws -> [DetectedCode] {
        guard let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              CGImageSourceGetCount(source) > 0
        else { throw MentraInputError.unreadablePhoto }

        // Respect the JPEG's EXIF orientation so "center of the image" means what the wearer saw.
        var orientation = CGImagePropertyOrientation.up
        if let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let raw = props[kCGImagePropertyOrientation] as? UInt32,
           let value = CGImagePropertyOrientation(rawValue: raw) {
            orientation = value
        }

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        let handler = VNImageRequestHandler(data: imageData, orientation: orientation, options: [:])
        try handler.perform([request])

        return (request.results ?? []).compactMap { observation in
            guard let text = observation.payloadStringValue else { return nil }
            return DetectedCode(
                payload: text,
                target: TargetMarker.target(for: text),
                boundingBox: observation.boundingBox,
                confidence: observation.confidence
            )
        }
    }
}
