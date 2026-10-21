import AppKit
import Foundation
final class FractalFolderDelegate: NSObject, NSApplicationDelegate {
    var panel: NSOpenPanel?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        let chooser=NSOpenPanel()
        panel=chooser
        chooser.title="Choose a folder for Fractal"
        chooser.message="Fractal reads this folder locally. Your files stay unchanged."
        chooser.prompt="Choose folder"
        chooser.canChooseDirectories=true
        chooser.canChooseFiles=false
        chooser.allowsMultipleSelection=false
        chooser.canCreateDirectories=false
        chooser.resolvesAliases=false
        chooser.begin { response in
            let value:[String:Any] = response == .OK && chooser.url != nil ? ["path":chooser.url!.path] : ["cancelled":true]
            if let data=try? JSONSerialization.data(withJSONObject:value) { FileHandle.standardOutput.write(data) }
            NSApp.terminate(nil)
        }
    }
}
if CommandLine.arguments.contains("--choose-folder") {
    let app=NSApplication.shared
    let delegate=FractalFolderDelegate()
    app.setActivationPolicy(.regular)
    app.delegate=delegate
    withExtendedLifetime(delegate) { app.run() }
    exit(0)
}
