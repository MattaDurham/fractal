// Passive previews with Apple Image I/O, Core Graphics, Core Text and Quick Look.
// No source document is launched, evaluated or modified. One JSON request on stdin.
import Foundation
import ImageIO
import CoreGraphics
import CoreText
import QuickLookThumbnailing
import UniformTypeIdentifiers

func failure(_ message: String) -> NSError { NSError(domain: "AtlasPreview", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func emit(_ result: [String:Any]) {
    if let data = try? JSONSerialization.data(withJSONObject:result,options:[.sortedKeys]) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
func context(_ width: Int,_ height: Int) throws -> CGContext {
    guard let c=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw failure("Unable to allocate preview pixels")}
    c.setFillColor(CGColor(red:1,green:1,blue:1,alpha:1));c.fill(CGRect(x:0,y:0,width:width,height:height));return c
}
func jpeg(_ image:CGImage,_ path:String) throws {
    guard let dest=CGImageDestinationCreateWithURL(URL(fileURLWithPath:path) as CFURL,UTType.jpeg.identifier as CFString,1,nil) else {throw failure("Cannot create preview output")}
    // Flatten transparent artwork onto paper; no source metadata is copied.
    let c=try context(image.width,image.height);c.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height))
    CGImageDestinationAddImage(dest,c.makeImage()!,[kCGImageDestinationLossyCompressionQuality:0.83] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {throw failure("Cannot finish preview output")}
}
func quickLook(_ url:URL,_ edge:Int) throws -> CGImage {
    let request=QLThumbnailGenerator.Request(fileAt:url,size:CGSize(width:edge,height:edge),scale:1,representationTypes:.thumbnail)
    var done=false;var image:CGImage?;var reason="No content thumbnail is supplied by the installed renderer"
    QLThumbnailGenerator.shared.generateBestRepresentation(for:request) { rep,error in
        if let rep=rep,rep.type == .thumbnail {image=rep.cgImage}
        if error != nil {reason="The installed Quick Look renderer could not preview this format"}
        done=true
    }
    let deadline=Date().addingTimeInterval(6)
    while !done && Date()<deadline {RunLoop.current.run(until:Date().addingTimeInterval(0.03))}
    QLThumbnailGenerator.shared.cancel(request)
    guard let image=image else {throw failure(done ? reason : "Quick Look preview timed out")};return image
}
func drawPDF(_ page:CGPDFPage,_ c:CGContext,_ tw:Int,_ th:Int,_ pw:CGFloat,_ ph:CGFloat) {
    // Normalize in page points, then scale explicitly. Quartz's drawing transform
    // otherwise centers a small page without enlarging it into a larger pixel rect.
    c.scaleBy(x:CGFloat(tw)/pw,y:CGFloat(th)/ph)
    c.concatenate(page.getDrawingTransform(.cropBox,rect:CGRect(x:0,y:0,width:pw,height:ph),rotate:0,preserveAspectRatio:true))
    c.drawPDFPage(page)
}
do {
    let input=FileHandle.standardInput.readDataToEndOfFile()
    guard let req=try JSONSerialization.jsonObject(with:input) as? [String:Any],let path=req["path"] as? String,let output=req["output"] as? String else {throw failure("Invalid preview request")}
    let edge=min(4096,max(64,req["edge"] as? Int ?? 512)),page=max(1,req["page"] as? Int ?? 1)
    let mode=req["mode"] as? String ?? "render",url=URL(fileURLWithPath:path),ext=url.pathExtension.lowercased()
    var image:CGImage?;var pages=1;var width=0;var height=0;var renderer="";var extent=""
    if ext=="pdf" {
        guard let pdf=CGPDFDocument(url as CFURL),pdf.isUnlocked else {throw failure("PDF is unavailable, damaged or password protected")}
        pages=pdf.numberOfPages
        guard page<=pages,let p=pdf.page(at:page) else {throw failure("Page is outside the document")}
        let bounds=p.getBoxRect(.cropBox),rotation=p.rotationAngle
        let rotated=abs(rotation)%180==90
        let w=rotated ? bounds.height : bounds.width,h=rotated ? bounds.width : bounds.height
        width=max(1,Int(w*2));height=max(1,Int(h*2));renderer="Apple Core Graphics PDF";extent="PDF page \(page) of \(pages), passive raster rendering"
        if mode=="tile" {
            let level=req["level"] as? Int ?? 0,x=req["x"] as? Int ?? 0,y=req["y"] as? Int ?? 0
            let maxLevel=Int(ceil(log2(Double(max(width,height))))),scale=pow(2.0,Double(level-maxLevel))
            let lw=max(1,Int(ceil(Double(width)*scale))),lh=max(1,Int(ceil(Double(height)*scale)))
            guard level>=0,level<=maxLevel,x>=0,y>=0,x*256<lw,y*256<lh else {throw failure("Invalid deep zoom tile")}
            let tw=min(256,lw-x*256),th=min(256,lh-y*256),c=try context(tw,th)
            c.translateBy(x: -CGFloat(x*256),y:CGFloat(th+y*256-lh))
            drawPDF(p,c,lw,lh,w,h);image=c.makeImage()
        } else {
            let ratio=min(Double(edge)/Double(max(width,height)),1),rw=max(1,Int(Double(width)*ratio)),rh=max(1,Int(Double(height)*ratio)),c=try context(rw,rh)
            drawPDF(p,c,rw,rh,w,h);image=c.makeImage()
        }
    } else if ["jpg","jpeg","png","gif","webp","heic","heif","tif","tiff","bmp","psd","raf","rw2","dng","cr2","cr3","nef","arw","avif","ico","icns","jp2"].contains(ext),let source=CGImageSourceCreateWithURL(url as CFURL,[kCGImageSourceShouldCache:false] as CFDictionary),CGImageSourceGetType(source) != nil {
        let props=CGImageSourceCopyPropertiesAtIndex(source,0,nil) as? [CFString:Any] ?? [:]
        width=props[kCGImagePropertyPixelWidth] as? Int ?? 0;height=props[kCGImagePropertyPixelHeight] as? Int ?? 0
        let orientation=props[kCGImagePropertyOrientation] as? Int ?? 1
        if orientation>=5 {swap(&width,&height)}
        renderer="Apple Image I/O";extent="First image, orientation-corrected downsample"
        if mode=="tile" {
            let ratio=min(1,8192/Double(max(1,max(width,height))))
            width=max(1,Int((Double(width)*ratio).rounded()));height=max(1,Int((Double(height)*ratio).rounded()))
            let level=req["level"] as? Int ?? 0,x=req["x"] as? Int ?? 0,y=req["y"] as? Int ?? 0
            let maxLevel=Int(ceil(log2(Double(max(1,max(width,height)))))),scale=pow(2.0,Double(level-maxLevel))
            let lw=max(1,Int(ceil(Double(width)*scale))),lh=max(1,Int(ceil(Double(height)*scale)))
            guard level>=0,level<=maxLevel,x>=0,y>=0,x*256<lw,y*256<lh else {throw failure("Invalid deep zoom tile")}
            guard let full=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:max(lw,lh),kCGImageSourceShouldCacheImmediately:true] as CFDictionary) else {throw failure("Image cannot be decoded")}
            image=full.cropping(to:CGRect(x:x*256,y:y*256,width:min(256,full.width-x*256),height:min(256,full.height-y*256)))
        } else {
            image=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:edge,kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
        }
    } else if ["txt","md","py","js","ts","tsx","jsx","css","sql","sh","swift","rs","go"].contains(ext) {
        guard page==1 else {throw failure("Text previews have one excerpt page")}
        let handle=try FileHandle(forReadingFrom:url);defer{try? handle.close()}
        let data=try handle.read(upToCount:65536) ?? Data()
        guard let text=String(data:data,encoding:.utf8) else {throw failure("Text encoding is not supported")}
        let secret="(?i)(password|api[_ -]?key|access[_ -]?token|secret[_ -]?key|recovery phrase)\\s*[:=]|BEGIN [A-Z ]*PRIVATE KEY"
        guard text.range(of:secret,options:.regularExpression)==nil else {throw failure("Credential-like text; content preview withheld")}
        width=1000;height=1300;renderer="Apple Core Text";extent="First 64 KiB / first 60 lines; actual text excerpt, not a whole-file read"
        let w=edge,h=Int(Double(edge)*1.3),c=try context(w,h);c.scaleBy(x:CGFloat(w)/1000,y:CGFloat(h)/1300)
        let excerpt=text.components(separatedBy:.newlines).prefix(60).joined(separator:"\n")
        let attr=NSAttributedString(string:excerpt,attributes:[NSAttributedString.Key(kCTFontAttributeName as String):CTFontCreateWithName("Menlo" as CFString,13,nil),NSAttributedString.Key(kCTForegroundColorAttributeName as String):CGColor(gray:0.13,alpha:1)])
        let frame=CTFramesetterCreateFrame(CTFramesetterCreateWithAttributedString(attr),CFRange(location:0,length:0),CGPath(rect:CGRect(x:45,y:45,width:910,height:1210),transform:nil),nil)
        CTFrameDraw(frame,c);image=c.makeImage()
    } else if ["doc","docx","xls","xlsx","ppt","pptx","rtf","odt","ods","odp","pages","numbers","key"].contains(ext) {
        image=try quickLook(url,edge);width=image!.width;height=image!.height;renderer="Apple Quick Look";extent="Installed provider's content thumbnail; page selection unavailable"
    } else {throw failure("No compatible passive renderer for this format")}
    guard let rendered=image else {throw failure("The file could not be rendered")}
    try jpeg(rendered,output)
    emit(["ok":true,"width":width,"height":height,"preview_width":rendered.width,"preview_height":rendered.height,"pages":pages,"renderer":renderer,"extent":extent])
} catch {emit(["ok":false,"error":error.localizedDescription]);exit(2)}
