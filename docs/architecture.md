# Architecture

Fractal has a buildless web frontend and a Python local server. SVG owns map geometry, labels and hit testing; a bounded canvas layer holds actual preview pixels. OpenSeadragon owns close inspection. There is no alternate staged map renderer.

`collections.py` creates a separate SQLite metadata inventory for each explicitly selected folder. A background scan records directory entries, excluding symlinks from traversal and optionally hidden entries. Stable relative-path identities survive rescans. Directory totals resolve after the scan, and the UI reports indexing/error state. Large child lists become bounded alphabetical navigation ranges instead of being truncated. By-type groups are extension-based; they do not summarize content.

`app.py` serves only allowlisted application assets and explicit JSON/derivative endpoints on loopback. It never serves arbitrary source files. Every collection request carries a collection ID, so independent tabs keep their own source context. Mutations require a bootstrap session token as well as Host/Origin checks. Selected folder paths are runtime state, never bundled examples or Git source.

`previews.py` resolves regular files through the collection inventory and checks path containment and source fingerprints. It has one cancellable priority queue per opened collection, with source writes serialized by a shared state lock. A generation receipt records the source path, page, tier/tile, timestamps, renderer, extent and status. The private cache is derived data and can regenerate. No filename-based duplicate inference is used.

`render.py` uses Pillow and PDFium in subprocesses. The subprocess working directory is the trusted package directory, never the selected source. PDFs are rendered passively and helper resources are closed explicitly. On macOS, the optional Swift helper provides native format previews; `NSOpenPanel` supplies the directory chooser. Helper binaries are built into private app data. Python dependencies and the package must remain installed for later renderer subprocesses.

The visible-image cache protects current cards. It apportions retained resolution across them and evicts offscreen images. This prevents visible cards from evicting and reloading each other when several large decoded thumbnails exceed the pixel budget. Coarse images remain until sharper replacements arrive. The budget covers retained thumbnails, not total GPU/browser/decoder memory.

The public project includes only reusable code and a synthetic example generator. It contains no prebuilt personal inventory, source paths, private thumbnails, original documents, credentials or telemetry service.

Useful upstream references:

- [Apple NSOpenPanel](https://developer.apple.com/documentation/appkit/nsopenpanel)
- [Apple Quick Look thumbnail guidance](https://developer.apple.com/documentation/quicklookthumbnailing/creating-quick-look-thumbnails-to-preview-files-in-your-app)
- [pypdfium2 API and threading rules](https://pypdfium2-team.github.io/pypdfium2/python_api.html)
- [Pillow thumbnail API](https://pillow.readthedocs.io/en/stable/reference/Image.html#PIL.Image.Image.thumbnail)
- [Python HTTP server scope](https://docs.python.org/3/library/http.server.html)
