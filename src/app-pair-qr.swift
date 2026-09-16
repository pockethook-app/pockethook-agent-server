import Foundation
import CoreImage
import AppKit

let payload = FileHandle.standardInput.readDataToEndOfFile()
let arguments = Array(CommandLine.arguments.dropFirst())
guard payload.count <= 4096,
      arguments.count == 1 || (arguments.count == 2 && arguments[1] == "--matrix"),
      let filter = CIFilter(name: "CIQRCodeGenerator") else { exit(1) }
filter.setValue(payload, forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
guard let qr = filter.outputImage else { exit(1) }
let scale: CGFloat = 8
let inset: CGFloat = 4 * scale
let scaled = qr.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
let translated = scaled.transformed(by: CGAffineTransform(translationX: inset, y: inset))
let extent = CGRect(x: 0, y: 0, width: scaled.extent.width + 2 * inset, height: scaled.extent.height + 2 * inset)
let background = CIImage(color: .white).cropped(to: extent)
guard let cgImage = CIContext().createCGImage(translated.composited(over: background), from: extent),
      let data = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else { exit(1) }
try data.write(to: URL(fileURLWithPath: arguments[0]), options: .atomic)

if arguments.count == 2 {
    // Use the same image, including its four-module white border, for both outputs.
    let bitmap = NSBitmapImageRep(cgImage: cgImage)
    let moduleCount = cgImage.width / Int(scale)
    var rows: [String] = []
    for y in 0..<moduleCount {
        var row = ""
        for x in 0..<moduleCount {
            guard let color = bitmap.colorAt(x: x * Int(scale), y: y * Int(scale))?
                .usingColorSpace(.deviceRGB) else { exit(1) }
            row.append(color.redComponent < 0.5 ? "1" : "0")
        }
        rows.append(row)
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(rows))
}
