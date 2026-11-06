// 画像の顔の位置を調べる。photos.mjs が swiftc で作って呼び出す（Mac 専用）。
//   faces <画像>...  … 画像ごとに1行の JSON を出す。座標はピクセルで、原点は左上
import Foundation
import ImageIO
import Vision

for path in CommandLine.arguments.dropFirst() {
  var line: [String: Any] = ["file": path]
  if let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
     let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
    let width = Double(image.width)
    let height = Double(image.height)
    let request = VNDetectFaceRectanglesRequest()
    do {
      try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
      line["width"] = image.width
      line["height"] = image.height
      line["faces"] = (request.results ?? []).map { face -> [String: Double] in
        let box = face.boundingBox
        return ["x": box.minX * width, "y": (1 - box.maxY) * height, "w": box.width * width, "h": box.height * height]
      }
    } catch {
      line["error"] = "\(error)"
    }
  } else {
    line["error"] = "画像を開けません"
  }
  let data = try JSONSerialization.data(withJSONObject: line, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self))
}
