# Web Photoshop Clone

A professional, browser-based Photoshop-class image editor built to the master
prompt spec (document-model-first, command-based history, TDD engines).

## Run
```bash
npm install
npm run dev        # http://127.0.0.1:5173
npm test           # unit + integration tests (vitest)
npm run build      # typecheck + production build
```

## Features (verified — see test suite)
Layers & nested groups, masks from selections, 12 blend modes, brush/eraser
with interpolation & pressure, marquee/lasso/polygon selections with
feather/grow/shrink, transforms, crop, image/canvas resize, text & shape &
gradient layers, fill layers, non-destructive adjustment layers, filters,
undo/redo history, project save/load (.wpsc, checksummed, versioned),
IndexedDB autosave + crash recovery, PNG/JPEG/WebP export, image import,
keyboard shortcuts, guides & grid.

Deliberate omissions are documented in `docs/browser-limitations.md` — there
are no fake controls.
