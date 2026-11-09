import Foundation
import Vision
import ImageIO

// Image bytes arrive over stdin and are never written to disk by this helper.
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard !data.isEmpty, data.count <= 20_000_000,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "AthenaOCR", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid screen image"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
    try VNImageRequestHandler(cgImage: image).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let text = String(lines.joined(separator: "\n").prefix(24_000))
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: ["text": text]))
} catch {
    FileHandle.standardError.write(Data("Screen text recognition failed: \(error.localizedDescription)".utf8))
    exit(1)
}
