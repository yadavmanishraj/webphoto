# Browser limitations — deliberately omitted / subset features

Per §2 of the master prompt: features that cannot work in a normal browser are
not faked. This document is the record.

## Omitted entirely (v1)
- **PSD import/export** — proprietary internals; a corrupted/partial PSD is worse
  than an honest refusal. Native `.wpsc` format is used instead (§33/§34 subset).
- **Photoshop plugins, Adobe services, Creative Cloud** — impossible/irrelevant in-browser.
- **OS font installation / full local font enumeration** — browsers expose only
  web fonts + generic families; the Font Access API is Chromium-only and optional.
- **Native printer/scanner drivers, OS window manipulation, filesystem watching,
  arbitrary local app execution** — outside the browser sandbox.
- **Complete ICC color management** — working space is sRGB; no ICC profiles are
  claimed (§28).
- **Pen/path tool with full Bézier editing** — deferred (Tier 3); shapes and
  lasso/polygon selections cover the common cases in v1.
- **Curves UI** — levels/gamma/color-balance adjustments are implemented; a full
  curves editor is Tier 3.

## Browser-appropriate subsets
- **Save/Open** — File System Access pickers are not assumed; projects download
  as `.wpsc` files and open via a file input. Autosave uses IndexedDB.
- **Text rendering** — Canvas2D font engine in the browser renderer; the pure-TS
  core compositor skips text pixels (text layers still serialize/edit fully).
- **Pressure/tilt** — used when Pointer Events provide them; gracefully absent otherwise.
- **Workers** — v1 processing is main-thread with typed-array engines; the module
  boundaries (pure functions over PixelBuffers) allow worker offload without API change.
- **Tiled rendering** — v1 uses document-sized layer buffers with dirty-by-command
  re-render; the renderer consumes the document model so tiling can be added
  behind `compositeDocument` without touching tools.

## Known v1 simplifications (honest, not fake)
- Group duplicate clones children with fresh ids; nested-group duplicate is shallow-tested.
- Adjustment layers apply to the composite below them (standard semantics), but
  clipped adjustments are not yet scoped to a single layer's alpha beyond `clipped` flag on raster layers.
- SVG import goes through the browser image decoder (scripts in SVG images are
  inert in `<img>`/createImageBitmap contexts); SVG is never inserted as live DOM.
