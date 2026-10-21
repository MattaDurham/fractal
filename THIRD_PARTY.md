# Third-party components

- [OpenSeadragon](https://github.com/openseadragon/openseadragon), version 6.1.1, BSD-3-Clause. Its minified viewer and original license are vendored in `fractal/web/vendor`. Archive integrity and SHA256 are recorded in `docs/vendor.json`. It supplies the document deep-zoom viewer; no CDN is used at runtime.
- [Pillow](https://github.com/python-pillow/Pillow), installed from PyPI, with its included license (MIT-CMU in the tested version 13; earlier supported versions carry Pillow’s historical license). Portable image and text rendering. Not vendored.
- [pypdfium2](https://github.com/pypdfium2-team/pypdfium2), installed from PyPI, Apache-2.0/BSD-3-Clause licensing; its distribution includes PDFium and its third-party notices. Not vendored. PDFium rendering is isolated in subprocesses because its API is not thread-safe.
- macOS native helpers call Apple's system frameworks. They are optional and are compiled from the included Swift source; no Apple framework binaries are redistributed.
