import CoreGraphics
import CoreML
import CryptoKit
import Foundation
import ImageIO
import OSLog
import UIKit
import UniformTypeIdentifiers

/// Upscales a manga cover 4x with the bundled Real-ESRGAN x4v3 Core ML model
/// (compact, ~2.4 MB; runs on the Neural Engine). The model takes a fixed
/// 256x256 float32 RGB tile, so larger covers are cut into overlapping tiles
/// and blended with a feather ramp — the same tiling the FreeScaler-style
/// upscalers use. Results are cached on disk per cover URL, so a cover is
/// upscaled once and the big featured cover just reads the file.
///
/// Input contract (verified against the package, not assumed):
/// - input `MLMultiArray` float32, shape [1, 3, 256, 256], RGB, values 0...1
/// - output `MLMultiArray` float32, shape [1, 3, 1024, 1024], RGB, values 0...1
private let srLog = Logger(subsystem: "pm.nemu.super-resolution", category: "engine")

enum NemuSuperResolutionEngine {
  struct Failure: Error {
    let code: String
    let message: String
  }

  static let tileSize = 256
  static let scale = 4
  /// Tile stride: 32 px of overlap on each shared edge, feathered on blend.
  static let overlap = 32
  /// A cover longer than this is downscaled before upscaling: the featured
  /// cover displays at most ~720x1080 px, so anything above 640 on the long
  /// side only costs memory (a 640 px input already yields a 2560 px file).
  static let maxInputLongSide = 640

  /// The directory holding the compiled model, when the build bundled it.
  static var modelsDirectory: URL? {
    let candidates = [
      Bundle.main.url(forResource: "NemuSuperResolution", withExtension: "bundle"),
      Bundle(for: NemuSuperResolutionBundleToken.self).url(
        forResource: "NemuSuperResolution", withExtension: "bundle"),
    ]
    for case let url? in candidates
    where FileManager.default.fileExists(
      atPath: url.appendingPathComponent("RealESRGAN-x4v3.mlmodelc").path)
    {
      return url
    }
    return nil
  }

  static var modelsBundled: Bool { modelsDirectory != nil }

  /// The model is an ML program converted for iOS 18 (specificationVersion 9).
  static var modelsSupported: Bool {
    guard modelsBundled else { return false }
    if #available(iOS 18.0, *) { return true }
    return false
  }

  /// Short fingerprint of the bundled model (manifest written by
  /// `scripts/fetch-sr-model.ts`), part of the upscale cache key.
  static var modelRevision: String {
    guard let directory = modelsDirectory,
      let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
      let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let revision = manifest["revision"] as? String
    else { return "unknown" }
    return revision
  }

  /// Loads the bundled model once and keeps it while the app runs; memory
  /// warnings drop it (the next upscale reloads).
  actor Store {
    static let shared = Store()
    private var model: MLModel?

    func unload() {
      model = nil
    }

    func loadedModel() throws -> MLModel {
      if let model { return model }
      guard let directory = NemuSuperResolutionEngine.modelsDirectory else {
        throw Failure(code: "E_SR_MODEL_MISSING", message: "The super-resolution model is not bundled.")
      }
      guard #available(iOS 18.0, *) else {
        throw Failure(code: "E_SR_UNSUPPORTED", message: "Super-resolution needs iOS 18 or later.")
      }
      let configuration = MLModelConfiguration()
      configuration.computeUnits = .cpuAndNeuralEngine
      do {
        let loaded = try MLModel(
          contentsOf: directory.appendingPathComponent("RealESRGAN-x4v3.mlmodelc"),
          configuration: configuration)
        model = loaded
        return loaded
      } catch {
        throw Failure(code: "E_SR_MODEL_LOAD", message: "The super-resolution model could not be loaded: \(error)")
      }
    }
  }

  /// RGBA8 pixels of a decoded image, row-major, alpha composited over white.
  struct RGBAImage: Sendable {
    let width: Int
    let height: Int
    /// 4 bytes per pixel: R, G, B, A (A is always 255 after compositing).
    let pixels: [UInt8]
  }

  static func decode(_ data: Data) throws -> RGBAImage {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else {
      throw Failure(code: "E_SR_DECODE", message: "The cover could not be decoded as an image.")
    }
    let width = cgImage.width
    let height = cgImage.height
    guard width >= 4, height >= 4, width * height <= 64_000_000 else {
      throw Failure(code: "E_SR_DECODE", message: "The cover is too small or too large to upscale (\(width)x\(height)).")
    }
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    guard
      let context = CGContext(
        data: &pixels, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else {
      throw Failure(code: "E_SR_DECODE", message: "The cover could not be decoded as an image.")
    }
    // Composite over white: a transparent PNG must not upscale to black.
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return RGBAImage(width: width, height: height, pixels: pixels)
  }

  /// Downscales the long side to `maxInputLongSide` (bilinear), keeping the
  /// aspect ratio. No-op when the image already fits.
  static func fit(_ image: RGBAImage) -> RGBAImage {
    let longSide = max(image.width, image.height)
    guard longSide > maxInputLongSide else { return image }
    let ratio = Double(maxInputLongSide) / Double(longSide)
    let width = max(4, Int((Double(image.width) * ratio).rounded()))
    let height = max(4, Int((Double(image.height) * ratio).rounded()))
    var out = [UInt8](repeating: 0, count: width * height * 4)
    for y in 0..<height {
      let srcY = min(image.height - 1, Int(Double(y) / ratio))
      for x in 0..<width {
        let srcX = min(image.width - 1, Int(Double(x) / ratio))
        let src = (srcY * image.width + srcX) * 4
        let dst = (y * width + x) * 4
        out[dst] = image.pixels[src]
        out[dst + 1] = image.pixels[src + 1]
        out[dst + 2] = image.pixels[src + 2]
        out[dst + 3] = 255
      }
    }
    return RGBAImage(width: width, height: height, pixels: out)
  }

  /// Tile origins along one axis: stride `tileSize - overlap`, the last tile
  /// flush with the far edge so every tile is exactly `tileSize` wide.
  static func tileOrigins(length: Int) -> [Int] {
    if length <= tileSize { return [0] }
    let stride = tileSize - overlap
    var origins: [Int] = []
    var at = 0
    while at + tileSize < length {
      origins.append(at)
      at += stride
    }
    origins.append(length - tileSize)
    return origins
  }

  /// Feather weight of an output pixel inside its tile: 1 in the interior,
  /// ramping 0...1 across the overlap shared with the neighbour tile, and 1
  /// on an edge that is also the image edge (nothing to blend there).
  static func featherWeight(
    _ position: Int, tileOrigin: Int, imageLength: Int
  ) -> Float {
    let feather = Float(overlap * scale)
    let local = Float(position - tileOrigin * scale)
    let size = Float(tileSize * scale)
    var weight: Float = 1
    if tileOrigin > 0 {
      weight = min(weight, local / feather)
    }
    if tileOrigin + tileSize < imageLength {
      weight = min(weight, (size - 1 - local) / feather)
    }
    return max(0, min(1, weight))
  }

  static func upscaleTile(_ model: MLModel, image: RGBAImage, x: Int, y: Int) throws -> [Float] {
    let plane = tileSize * tileSize
    let input = try MLMultiArray(
      shape: [1, 3, NSNumber(value: tileSize), NSNumber(value: tileSize)], dataType: .float32)
    let target = input.dataPointer.bindMemory(to: Float.self, capacity: 3 * plane)
    for row in 0..<tileSize {
      // A cover smaller than the tile has no pixel at (x + col, y + row)
      // past its edge (twmanga ships 180x240 covers): replicate the edge
      // pixel instead of reading past the buffer — that read trapped the
      // app (EXC_BREAKPOINT in this loop, 2026-11-13).
      let py = min(y + row, image.height - 1)
      for col in 0..<tileSize {
        let px = min(x + col, image.width - 1)
        let src = (py * image.width + px) * 4
        let index = row * tileSize + col
        target[index] = Float(image.pixels[src]) / 255
        target[plane + index] = Float(image.pixels[src + 1]) / 255
        target[2 * plane + index] = Float(image.pixels[src + 2]) / 255
      }
    }
    let output = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["input": input]))
    guard let array = output.featureValue(for: "output")?.multiArrayValue,
      array.shape.map(\.intValue) == [1, 3, tileSize * scale, tileSize * scale],
      array.dataType == .float32
    else {
      throw Failure(code: "E_SR_MODEL_OUTPUT", message: "The super-resolution model returned an unexpected output.")
    }
    let pointer = array.dataPointer.bindMemory(to: Float.self, capacity: array.count)
    return Array(UnsafeBufferPointer(start: pointer, count: array.count))
  }

  /// Upscales `image` 4x into a new RGBA image, tiled with overlap blending.
  static func upscaleImage(_ model: MLModel, _ image: RGBAImage) throws -> RGBAImage {
    try Task.checkCancellation()
    let outWidth = image.width * scale
    let outHeight = image.height * scale
    let outPlane = outWidth * outHeight
    var accumulated = [Float](repeating: 0, count: outPlane * 3)
    var weights = [Float](repeating: 0, count: outPlane)
    let xs = tileOrigins(length: image.width)
    let ys = tileOrigins(length: image.height)
    for tileY in ys {
      for tileX in xs {
        try Task.checkCancellation()
        let tile = try upscaleTile(model, image: image, x: tileX, y: tileY)
        let tilePlane = tileSize * scale * tileSize * scale
        for outRow in 0..<(tileSize * scale) {
          let wy = featherWeight(outRow, tileOrigin: tileY, imageLength: image.height)
          guard wy > 0 else { continue }
          for outCol in 0..<(tileSize * scale) {
            let wx = featherWeight(outCol, tileOrigin: tileX, imageLength: image.width)
            let weight = wx * wy
            guard weight > 0 else { continue }
            let dstRow = tileY * scale + outRow
            let dstCol = tileX * scale + outCol
            // A tile is always 256x256, but a small cover's output is
            // smaller (180x240 -> 720x960): only blend inside the output,
            // or the write below runs past the buffers and traps as well.
            guard dstRow < outHeight, dstCol < outWidth else { continue }
            let dst = dstRow * outWidth + dstCol
            let src = outRow * tileSize * scale + outCol
            weights[dst] += weight
            for channel in 0..<3 {
              accumulated[channel * outPlane + dst] += weight * tile[channel * tilePlane + src]
            }
          }
        }
      }
    }
    var pixels = [UInt8](repeating: 0, count: outPlane * 4)
    for index in 0..<outPlane {
      let weight = weights[index]
      guard weight > 0 else { continue }
      let dst = index * 4
      for channel in 0..<3 {
        let value = accumulated[channel * outPlane + index] / weight
        pixels[dst + channel] = UInt8(max(0, min(1, value)) * 255)
      }
      pixels[dst + 3] = 255
    }
    return RGBAImage(width: outWidth, height: outHeight, pixels: pixels)
  }

  static func writeJPEG(_ image: RGBAImage, to url: URL) throws {
    var pixels = image.pixels
    guard
      let provider = CGDataProvider(data: Data(pixels) as CFData),
      let cgImage = CGImage(
        width: image.width, height: image.height, bitsPerComponent: 8,
        bitsPerPixel: 32, bytesPerRow: image.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false,
        intent: .defaultIntent)
    else {
      throw Failure(code: "E_SR_ENCODE", message: "The upscaled cover could not be encoded.")
    }
    pixels.removeAll(keepingCapacity: false)
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else {
      throw Failure(code: "E_SR_ENCODE", message: "The upscaled cover could not be written.")
    }
    CGImageDestinationSetProperties(destination, [kCGImageDestinationLossyCompressionQuality: 0.92] as CFDictionary)
    CGImageDestinationAddImage(destination, cgImage, nil)
    guard CGImageDestinationFinalize(destination) else {
      throw Failure(code: "E_SR_ENCODE", message: "The upscaled cover could not be written.")
    }
  }

  static var cacheDirectory: URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    return caches.appendingPathComponent("nemu-super-resolution", isDirectory: true)
  }

  static func cacheURL(for uri: String) -> URL {
    let digest = SHA256.hash(data: Data(uri.utf8))
    let hex = digest.map { String(format: "%02x", $0) }.joined()
    return cacheDirectory.appendingPathComponent("sr-\(hex)-\(modelRevision).jpg")
  }

  /// Downloads the cover, upscales it 4x, writes the JPEG to the cache, and
  /// returns its file URL. A cached file returns immediately without running
  /// the model or the network.
  static func upscaleCover(uri: String, headers: [String: String]) async throws -> (url: URL, width: Int, height: Int, fromCache: Bool, ms: Double) {
    let started = Date()
    let destination = cacheURL(for: uri)
    if FileManager.default.fileExists(atPath: destination.path),
      let data = try? Data(contentsOf: destination),
      let image = try? decode(data)
    {
      return (destination, image.width, image.height, true, 0)
    }
    guard let url = URL(string: uri), url.scheme == "http" || url.scheme == "https" else {
      throw Failure(code: "E_SR_DOWNLOAD", message: "The cover URL is not an http(s) URL.")
    }
    var request = URLRequest(url: url)
    request.timeoutInterval = 30
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let data: Data
    do {
      let (downloaded, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse, 200..<300 ~= http.statusCode else {
        throw Failure(code: "E_SR_DOWNLOAD", message: "The cover download failed.")
      }
      data = downloaded
    } catch let failure as Failure {
      throw failure
    } catch {
      throw Failure(code: "E_SR_DOWNLOAD", message: "The cover download failed: \(error.localizedDescription)")
    }
    let model = try await Store.shared.loadedModel()
    let decoded = try decode(data)
    let fitted = fit(decoded)
    let upscaled = try upscaleImage(model, fitted)
    try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    try writeJPEG(upscaled, to: destination)
    srLog.notice("upscaled cover \(uri, privacy: .public) \(decoded.width)x\(decoded.height) -> \(upscaled.width)x\(upscaled.height) in \(Int(Date().timeIntervalSince(started) * 1000), privacy: .public) ms")
    return (destination, upscaled.width, upscaled.height, false, Date().timeIntervalSince(started) * 1000)
  }
}

/// Token type so the module can find its own resource bundle.
private final class NemuSuperResolutionBundleToken {}
