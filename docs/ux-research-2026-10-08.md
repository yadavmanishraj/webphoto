# UX Research — Web Photoshop Clone vs. Professional Web Image Editors

**Date:** 2026-10-08
**Role:** UX research pass (research only — no code was changed)
**Primary reference:** Photopea (official Learn pages, its GitHub issue tracker, and its documented shortcut set)
**Secondary references:** Photoshop on the web (Adobe Help), Photoshop desktop (Adobe Help / Adobe Learn), Figma editor chrome (third-party compatibility reference, flagged as such)
**Our app:** `src/ui/App.tsx` + `src/ui/styles.css` in this repo, read directly for every "our current state" claim. Line references are to the 2026-10-08 build.

## How to read this document

- Every claim about a *pro* product is followed by a source URL. Where a behaviour could not be verified on an official or credible page, it is explicitly marked **(unverified)** and is not used as the basis for a P0/P1 recommendation.
- "Our current state" claims come from reading our own source, not from memory of the spec.
- Priorities: **P0** = misleading or data-losing today; **P1** = breaks pro muscle memory / core workflow; **P2** = expected by pros, noticeable absence; **P3** = polish / power-user depth. Effort: S ≈ hours, M ≈ a day or two, L ≈ multi-day.

---

## 1. Panel & docking conventions

### What the pros do

**Photoshop (desktop)** docks panels on the right in **tabbed groups**: you switch between panels in a group by clicking their tabs (e.g. Color ↔ Swatches), open more from the Window menu, can move or close panels, and can reset the workspace. Adobe's own fundamentals walkthrough describes exactly this: panels on the right, tab switching inside a group, Window menu to summon a missing panel, and "Reset Essentials" to restore the default layout.
Source: https://www.adobe.com/in/learn/photoshop/web/ps-basics-fundamentals

**Photopea** follows Photoshop's geometry: the Layers panel lives "in the sidebar on the right," and the panel contains the layer list and thumbnails. Auxiliary panels (History, etc.) exist alongside it in the same right dock rather than in dialogs.
Sources: https://www.photopea.com/learn/layers · https://www.webfx.com/blog/web-design/edit-psds-free-photopea/ (lists History panel among Photopea features)

**Photoshop on the web** deliberately simplifies: a left toolbar of grouped tools, and a right-side **taskbar** with three panels — Layers, Layer properties, Comments. Its Layers panel shows "all the layer thumbnails in a simplified view" with an expanded stack for masks, names, visibility, and group contents; the properties panel is contextual to the selected layer type. A floating **Contextual task bar** on the canvas offers next-step actions for the current selection.
Source: https://helpx.adobe.com/sg/photoshop/using/workspace-web.html

**Figma** splits the difference: layers tree on the **left**, properties on the **right** as stacked, labelled sections (Appearance, Fill, Stroke, Effects, Typography, Layout, Position), with resizable sidebars. (Third-party Figma-compatibility reference, not Figma's own docs.)
Source: https://github.com/qitm2333/op-embedded-studio/blob/HEAD/packages/docs/reference/figma-compatibility.md

### Layer panel anatomy (the part users stare at all day)

Verified from Photopea's official Layers lesson and Adobe's Photoshop references:

| Element | Pro convention |
|---|---|
| Panel position | Right sidebar (Photopea, Photoshop); left in Figma |
| Blend mode + Opacity | **At the top of the Layers panel**, applying to the selected layer — Photopea: "you can edit the blend mode and the opacity of that layer at the top of the Layers panel" |
| Visibility | Eye icon per row, left side |
| Lock row | Photoshop/Photopea offer **multiple lock types** (transparent pixels, image pixels, position, all) as a row of lock icons at the top of the panel; Photopea lists Transparency / Pixels / Position / All |
| Filter row | Photoshop desktop has a **filter row at the very top** of the panel: filter by name, kind, effect, mode, attribute, or color label |
| Thumbnails | Real rendered content thumbnails per row |
| Footer | A compact **icon row at the bottom** of the panel: delete (bin), new layer, new group/folder, add mask, fx |
| Group rows | Folders that fold/unfold; selecting a folder selects its contents |

Sources: https://www.photopea.com/learn/layers · https://help.adobe.com/archive/fi/photoshop/cs6/photoshop_reference.pdf (filtering) · https://helpx.adobe.com/tutorial-builder/user-guide/photoshop-tutorial-builder/-ps--capabilities-guides/panel-elements---options-bar-coach-marks.html (panel element inventory: lock types, filter menu, opacity/fill scrubby sliders, bottom icons)

### Our current state, honestly

Our right rail is a **fixed 280px column of stacked sections** (`styles.css`: `.sidepanel { width: 280px }`), top to bottom: **Color → Layers → Properties → History**. No tabs, no collapse, no resize handle.

What this gets right:

- **Blend mode + Opacity placement matches the pros.** Our Layers section header carries the opacity slider and blend-mode `<select>` for the active layer, at the top of the layer list — the same spot Photopea/Photoshop use. Keep this.
- Stacked sections mean nothing is ever hidden behind a tab; a new user sees Color, Layers, Properties, and History at once. For a Tier-1 editor this is defensible and arguably better than tab-hunting.

Where it diverges:

- **The panel cannot be resized or collapsed.** On a laptop-width window, 280px of chrome plus a fixed toolbar is a real tax; every pro editor lets you reclaim that space (tabs, collapse, resizable splitter).
- **Layers is squeezed from both sides.** Layers gets `flex: 1`, which is good, but Properties (with its adjustment sliders) and History sit permanently below it. History's list is capped at 110px with its own scrollbar *inside* a section that is itself in a scrolling column — a double-scroll trap.
- **Our "thumbnails" are fake.** Each layer row shows a 30×30px CSS checkerboard (`styles.css`: `.layer-row .thumb` is a `repeating-conic-gradient`) regardless of the layer's content. Pro panels render the layer's actual pixels; the thumbnail is how users identify layers in a stack of similarly-named rows. This is the single most visible "not a real editor" tell in the panel.
- **Footer actions are text buttons, not an icon row, and they sit in a wrapping flex row** (`+ Layer`, `+ Group`, `Duplicate`, `Delete`, `Add Mask`, `↑`, `↓`). Functionally complete, visually noisy, and the wrap behaviour means the row height changes with panel width.
- **Lock is a single binary toggle per row** (🔒/🔓 button). Pros expose lock *types* at panel top. Our engine only models one lock flag, so this is an honest simplification — but the per-row unlocked padlock icon on every row adds noise; Photoshop shows a lock glyph only on locked layers.
- **No filter/search row** (see §5).

**Verdict:** stacked sections are a legitimate v1 choice and the blend/opacity placement is already pro-correct. The gaps that matter are fake thumbnails, no collapse/resize, and History's cramped double-scroll — not the absence of tabs per se.

---

## 2. Options bar behaviour per tool

### What the pros do

The options bar (Photopea calls it the settings bar under the menus) is **fully contextual**: "it displays different options depending on the tool you've selected… if you choose a brush, you'll see the brush size listed here."
Source: https://www.fahimai.com/how-to-use-photopea

Per tool, the verified pro contents:

- **Brush:** a brush-picker dropdown at the left of the bar (brush tip preview + size + hardness sliders in the popover), plus Mode, Opacity, Flow in the bar. Photoshop adds keyboard control pros rely on: number keys set opacity, Shift+number sets flow, and Alt+right-click-drag on canvas scrubs size/hardness with a HUD. `[` / `]` resize the brush in both Photoshop and Photopea.
  Sources: http://www.nphsphotography.org/wp-content/uploads/2020/09/Photopea-Basic-Editing.pdf (Photopea brush palette dropdown with hardness slider; bracket keys resize) · https://phlearn.com/tutorial/photoshop-basics-the-brush-tool/
- **Marquee / selection tools:** four mode buttons — **New, Add to, Subtract from, Intersect with** — plus a **Feather** field, Anti-alias toggle, and Style (Normal / Fixed Ratio / Fixed Size with W/H fields). Modifier keys mirror the modes (Shift = add, Alt = subtract, Shift+Alt = intersect).
  Source: https://helpx.adobe.com/photoshop/using/selectingmarqueetools (mirrored at http://bpb-us-w2.wpmucdn.com/wonecks.net/dist/3/535/files/2020/03/Select-with-marquee-tools-in-Photoshop.pdf)
- **Text:** the top bar carries **font family, style, size, color, and alignment** while the Type tool is active — editing happens *in* the bar, not in a side panel.
  Source: https://www.fahimai.com/how-to-use-photopea
- **Shape:** fill vs. outline choice (solid fill or stroke-only) and shape kind are chosen in the bar *before* drawing.
  Source: https://www.fahimai.com/how-to-use-photopea
- **Move:** Photoshop's Move options include Auto-Select and Show Transform Controls; Photopea additionally lets Ctrl temporarily turn any selection tool into Move, and arrow keys nudge.
  Source: https://www.photopea.com/learn/moving-selected-data
- **Photoshop on the web** replaces much of this with the **Contextual task bar**: after an action, it offers the curated next steps (e.g. Group layers / Merge layers / Done for a transform) directly on the canvas.
  Sources: https://helpx.adobe.com/sg/photoshop/using/workspace-web.html · https://helpx.adobe.com/my_en/photoshop/web/edit-images/manage-layers/work-with-layers.html

### Our current state

Our options bar (`App.tsx`, `.optionsbar`) is contextual, but the depth varies wildly by tool:

| Tool | Ours | Assessment |
|---|---|---|
| Brush / Eraser | Size (slider + number), Hardness, Opacity, Flow, size presets | **Pro-grade.** Matches the pro set. Missing only the brush-tip picker and number-key opacity/flow. |
| Shape | Kind `<select>` + "Drag on canvas to draw." | Thin: no fill/stroke choice before drawing (fill is edited afterwards in Properties). |
| Marquee / Lasso | Static text: "Mode: Replace · Feather/Grow/Shrink in Select menu" + selection size readout | **The mode is not a control, and it cannot change.** `selMode` is a `useState` initialised to `'replace'` and never updated — there is no Add/Subtract/Intersect anywhere in the app, and no Shift/Alt modifier handling. The status bar prints "replace selection" forever. This is the biggest functional gap in the bar. |
| Move | Static hint text | No Auto-Select, no transform toggle; numeric transform lives in Properties. Acceptable v1, but the bar is wasted space for this tool. |
| Gradient | Static hint text | No gradient preset/type/reverse controls; gradient is always FG→BG linear on a **new** layer. |
| Crop | Static hint text | **Crop commits on mouse-release** with no ratio fields, no commit/cancel affordance, no way to adjust the rectangle before applying. Pros treat crop as a staged, cancellable state. |
| Text | Static hint text ("edit it in Properties") | Text formatting is in the Properties panel (content, size, weight, color, align). **No font-family picker anywhere** — pros put family/size in the bar while typing. |
| Hand / Zoom | Static hint text | See §3. |

**Verdict:** the brush bar proves the pattern works; the other tools got hint text where pros put controls. Selection modes and crop staging are functional gaps, not cosmetic ones. Text's missing font-family control is the most noticeable creative gap.

---

## 3. Canvas navigation conventions

### What users expect

- **Spacebar = temporary Hand tool.** Hold Space, drag to pan, release to return to the previous tool. Present in Photoshop, Photopea (documented in Photopea teaching materials: "hold down the space bar and you will see the hand tool appear"), and Figma (Space+drag).
  Sources: http://www.nphsphotography.org/wp-content/uploads/2020/10/Healing-Tools-Photopea.pdf · https://defkey.com/photopea-5-4-shortcuts (lists "Space — Hand tool" and "Ctrl+Space — Zoom tool" as hold-to-enable in Photopea)
- **Wheel zooming to the cursor.** Photopea: plain wheel scrolls vertically, Ctrl+wheel scrolls horizontally, **Alt+wheel zooms**. Figma: Ctrl/Cmd+scroll zooms (toward the pointer), Cmd+0 = 100%, Cmd+1 = fit, Cmd+2 = zoom to selection. Photoshop desktop: Alt+wheel zooms, with a "zoom with scroll wheel" preference.
  Sources: https://gist.github.com/milnak/2dfe03c6eaa5a56c2fac29906ea5dd7a (Photopea shortcut list, Navigation section) · https://github.com/qitm2333/op-embedded-studio/blob/HEAD/packages/docs/reference/figma-compatibility.md · https://dev.aesclean.com/virtual-library/gPwRbh/5AD171/how__to__zoom-in_photoshop.pdf
- **Scrubby zoom.** With the Zoom tool, click-drag right zooms in continuously, left zooms out. Photopea implements the same gesture as **hold Z + drag**. Photoshop also offers marquee-zoom (drag a rectangle to fill the screen) when scrubby is off.
  Sources: http://www.photoshopforphotographers.com/3101-1901/Help_guide/tp/Zoom_tool.html · http://www.nphsphotography.org/wp-content/uploads/2020/10/Healing-Tools-Photopea.pdf
- **Zoom anchors at the cursor, not the centre.** Ctrl+Space+click and wheel-zoom magnify *the point under the pointer*; centre-zoom via Ctrl+`+`/`-` is the fallback users tolerate, not the one they reach for.
  Source: https://news.filehippo.com/2014/11/navigate-zoom-images-photoshop/ (contrasts centre zoom unfavourably with cursor-anchored Ctrl+Space zoom)
- **Navigator panel.** Photoshop's Navigator shows a thumbnail of the whole image with a red view-box you can drag, plus a zoom slider — the standard way to move around a large canvas at high zoom. Photopea does **not** document a Navigator panel in its Learn pages (checked 2026-10-08), so this is a Photoshop-side expectation, not a Photopea one.
  Source: https://dev.aesclean.com/virtual-library/gPwRbh/5AD171/how__to__zoom-in_photoshop.pdf
- **Zoom read-out with presets.** Photoshop shows zoom % at the document's lower-left; Photoshop on the web puts Zoom level in the header bar with Zoom in / Zoom out / Fit to screen.
  Source: https://helpx.adobe.com/sg/photoshop/using/workspace-web.html

### Our current state

- Zoom is a React state (0.05–8×) applied as CSS size to the canvas inside a scrollable workspace. The Zoom tool click multiplies by 1.25 (Alt+click divides). The status bar has zoom %, `−`/`+` buttons and a slider — that part matches pro expectations.
- **There is no wheel handler at all.** The mouse wheel only scrolls the workspace natively. No Ctrl/Alt+wheel zoom, in a browser editor, is the navigation gap users will feel first — Photopea and Figma both zoom with the wheel.
- **Zoom is effectively centre-anchored** (the frame is centred with `margin: auto`; scroll offsets are never adjusted on zoom), so zooming in on a corner detail requires zoom → scroll → scroll → correct.
- **No spacebar-hand.** We have a Hand tool (H) that drags the workspace scroll — the tool exists, the *temporary* spacebar version doesn't. Users must switch tools away from the brush just to pan.
- **No scrubby zoom** on the Zoom tool (click steps only).
- **View ▸ Zoom to Fit is hardcoded to 0.6** — it does not measure the document or the workspace. For a 4000px canvas it is wildly wrong; for a 200px icon it is wrong in the other direction. Zoom In/Out/100% menu items exist; **Ctrl+0 / Ctrl+1 / Ctrl+`+` / Ctrl+`-` are not bound**.
- **No navigator/minimap.**

**Verdict:** navigation is our weakest pro-parity area. Wheel-zoom-to-cursor + spacebar-hand are the two gestures every target user will try in the first minute, and both are absent.

---

## 4. Shortcut conflicts with the browser

### The hard constraint

Some browser shortcuts **cannot be intercepted by a web page at all** — `preventDefault()` does not stop them. The canonical set in Chromium browsers:

| Shortcut | Browser meaning | Photoshop meaning | Interceptable? |
|---|---|---|---|
| Ctrl/Cmd+N | New window | New document | **No** — Photopea issue: pressing Ctrl+N for a new document opens a new Chrome/Edge window instead |
| Ctrl/Cmd+W | Close tab | Close document | **No** — by design, so malicious pages can't trap users |
| Ctrl/Cmd+T | New tab | Free Transform | **No** |
| Ctrl/Cmd+Shift+N | Incognito window | New Layer (Photoshop) | No |
| Ctrl/Cmd+Tab / Ctrl+PageUp/Dn | Switch browser tab | Cycle documents | No |
| Ctrl/Cmd+`+` / `-` / `0` | Browser page zoom / reset | Zoom in / out / fit | These reach the page only in some browsers/contexts; pages usually *can* handle them in Chrome when the app has focus, but behaviour varies — do not rely on them silently |
| Ctrl/Cmd+D | Bookmark page | Deselect (Photoshop) | Yes, keydown is delivered and preventable |
| Ctrl/Cmd+S, Z, A, O* | Save page, —, Select-all-in-field, Open file | Save, Undo, Select All, Open | Yes (* Ctrl+O keydown is delivered; the file dialog only opens if the page doesn't handle it) |

Sources: https://github.com/photopea/photopea/issues/8268 (Ctrl+N opens a browser window in Photopea, reported against Chrome and Edge) · https://forum.babylonjs.com/t/how-prevent-default-of-c-w-t-n/44117 (maintainer answer: browsers are selective; no guarantee Ctrl+W can be overridden) · https://dev.to/tomj/should-web-browser-let-you-control-ctrlcmd-w-59c8 ("You can not take away control from the browser acting on these basic UI shortcuts")

Photopea's maintainer (Ivan Kutskir) summarised the problem in Photopea's own tracker: browsers have more problems than just Ctrl+W — it is also Ctrl+N for a new document and Ctrl+T for Free Transform.
Source: https://github.com/photopea/photopea/issues/154

### How the pros adapt

Photopea keeps Photoshop's shortcut map but **remaps the ones browsers eat**:

- Free Transform: **Alt+Ctrl+T** (not Ctrl+T)
- New Layer: **Ctrl+Shift+N** (carried over from Photoshop; unreliable in Chrome due to incognito, but kept)
- Duplicate layer: **Ctrl+J**; Group: **Ctrl+G**; Merge Down: **Ctrl+E** — all safe chords
- Preferences: Ctrl+K; **pressing `?` opens the full shortcut list in-app**
- Zoom: Ctrl+`+` / Ctrl+`-`

Sources: https://defkey.com/photopea-5-4-shortcuts · https://gist.github.com/milnak/2dfe03c6eaa5a56c2fac29906ea5dd7a · https://tutorialtactic.com/blog/photopea-shortcuts/

The other standard adaptation is **defence in depth for the un-interceptable keys**: since Ctrl+W can close the tab without warning, pro web editors pair it with aggressive autosave/recovery and (in desktop-class web apps) a `beforeunload` prompt while dirty.

### Audit of OUR shortcut set

Our handler (`App.tsx`, keydown effect) binds: Ctrl/Cmd+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+S (Shift+S = export dialog), Ctrl+A (guarded against form fields), Ctrl+D, single-letter tool keys, `[` / `]`, Delete/Backspace. Findings:

1. **P0 — The File menu advertises "Ctrl+N" for New… and that shortcut does not exist.** The menu item literally renders `shortcut: 'Ctrl+N'`, but there is no `n` binding in the handler. A user who trusts the menu and presses Ctrl+N gets a **new browser window** and thinks the app is broken. This is precisely the Photopea issue #8268 failure mode, except we wrote the trap ourselves. Fix is either removing the label or binding an interceptable alternative and labelling that.
2. **Grouped tool keys are broken.** `TOOLS.find(x => x.key === key)` returns the *first* match: **M always selects Rectangular Marquee (Ellipse Marquee unreachable by keyboard)** and **G always selects Paint Bucket (Gradient unreachable)**. Photoshop/Photopea cycle grouped tools with Shift+key (both marquees share M in Photopea's list). Users pressing M expecting Photoshop's cycle behaviour get a silent no-op the second time.
3. **Muscle-memory chords users will try are missing:** Ctrl+J (duplicate layer), Ctrl+Shift+N (new layer), Ctrl+G (group), Ctrl+E (merge down), Alt+Ctrl+T (Free Transform — we have numeric transform in Properties), Ctrl+`+`/`-`/`0`/`1` (zoom). All of these are interceptable and cheap to add; Ctrl+T itself must **not** be attempted (it opens a tab) — follow Photopea's Alt+Ctrl+T remap if transform gets a chord.
4. **Ctrl+D is a deliberate, correct trade-off:** we preventDefault it for Deselect (Photoshop behaviour), which costs the user the Bookmark shortcut while in the app. Photopea does the same. Fine — but it should be a conscious, documented choice; it currently isn't mentioned in our shortcuts dialog rationale.
5. **No `beforeunload` guard exists anywhere in `src/`.** Combined with an un-interceptable Ctrl+W and a 15-second autosave interval, an accidental tab close can lose up to ~15 s of work silently, and the recovery banner only helps if the user returns in the same browser profile. Pros pair autosave with a dirty-state unload prompt; we have only half of that pair.
6. **The shortcuts dialog is incomplete relative to the app itself** — it omits Ctrl+Y, Ctrl+Shift+S, `[`/`]` are listed, but Delete is listed as "Clear selection" while Ctrl+A/Ctrl+D appear; New/Open have no entries (correctly, since they don't exist) — after fixing finding 1, menu labels, dialog, and handler must be audited as one set.
7. Minor: tool letters fire whenever focus is on any non-field element (including buttons), which is standard for editors, but Alt+letter also switches tools (only Ctrl/Cmd is excluded via `!mod`). Low impact; note for the implementer.

**Verdict:** our *bound* set is clean (nothing we bind fights the browser), but our *displayed* set lies about Ctrl+N, grouped-tool keys silently strand two tools, and the un-interceptable close-tab risk is unmitigated.

---

## 5. Layer panel interactions users expect

### The expectations, with evidence

- **Drag to reorder.** Photopea's official lesson: "You can drag and drop layers inside the Layers panel" to reorder, drag into/out of folders, and drag multi-selections. Photoshop on the web: "Drag the layer up or down in the layer stack to change the front-to-back arrangement."
  Sources: https://www.photopea.com/learn/layers · https://helpx.adobe.com/my_en/photoshop/web/edit-images/manage-layers/work-with-layers.html
- **Double-click name → inline rename.** Photopea: double-click the name, type, Enter confirms, Escape cancels. Photoshop on the web/desktop: identical pattern (also double-click artboard names).
  Sources: https://www.photopea.com/learn/layers · http://helpx.adobe.com/photoshop/desktop/create-manage-layers/layout-design-tools/artboard-properties.html
- **Right-click context menu.** Photopea: most panel operations are "also available… by right-clicking a specific layer" — Duplicate (or Ctrl+J), Duplicate into another document, Merge Down / Merge Layers. Photoshop on the web: right-click opens the **Layer actions menu** (e.g. Flatten image).
  Sources: https://www.photopea.com/learn/layers · https://helpx.adobe.com/my_en/photoshop/web/edit-images/manage-layers/work-with-layers.html
- **Multi-select with Ctrl+click (and folder-selects-contents).** Photopea: Ctrl+click adds/removes layers from the selection; selecting a folder selects all its content.
  Source: https://www.photopea.com/learn/layers
- **Eye-icon drag.** In Photoshop you can press on one eye icon and **drag down/up the visibility column** to toggle many layers in one sweep; Alt+click an eye isolates that layer ("solo") and Alt+click again restores.
  Sources: http://faculty.fairfield.edu/mediacenter/tl_110/sg_ps_layers.html · https://www.creativebloq.com/photo-editing/photoshop-tips-and-fixes-612316/3
- **Color labels.** Photoshop lets you assign a color to a layer/group in the panel (a first-class field in the New Layer dialog, settable from the context menu), and the panel filter can then filter *by* color label. Photopea reads/writes PSD color labels as part of PSD fidelity, but its Learn pages do not document a label-editing UI — so treat labels as a Photoshop-side expectation.
  Sources: https://helpx.adobe.com/uk/photoshop/using/create-layers-groups.html ("Color — assigns a color to the layer or group in the Layers panel") · https://help.adobe.com/archive/fi/photoshop/cs6/photoshop_reference.pdf
- **Layer search/filter.** Photoshop desktop's filter row (top of panel) filters by name, kind, effect, mode, attribute, or color; Figma's layers panel similarly offers search. This is what makes 100+-layer documents navigable alongside folders.
  Source: https://help.adobe.com/archive/fi/photoshop/cs6/photoshop_reference.pdf

### Our current state — honest assessment

| Interaction | Ours | Gap |
|---|---|---|
| Reorder | **↑ / ↓ buttons that move the active layer one step** (plus a separate "Move active into:" dropdown + Move button for grouping) | The buttons *work* and are keyboard/screen-reader friendly — that is their one virtue. But reordering a layer across a 30-layer stack is ~29 clicks; pros drag. Grouping via a dropdown+button is a form, not a gesture. **This is the panel's biggest workflow gap.** |
| Rename | Double-click name → **`window.prompt()`** | Functionally a rename, experientially a browser dialog that leaves the app chrome, can't be styled, blocks the page, and offers no inline Escape/Enter-in-context feel. Photopea's inline edit is a small change with an outsized "real editor" feel. |
| Context menu | **None** (`onContextMenu` appears nowhere) | Right-clicking a layer does nothing app-specific. Duplicate/Delete/Mask — all things we *have* as commands — are unreachable from the row itself. |
| Multi-select | **None** — single `activeLayerId` only | No Ctrl+click, no bulk delete/duplicate/group. Our group command creates empty groups; there is no "group these layers" because there is no "these layers." |
| Eye toggle | Per-row button, click only | No drag-sweep, no Alt+click solo. |
| Group fold/unfold | **None** — groups always render fully expanded (indented 14px/depth) | A 5-group × 10-layer document is a 55-row scroll with no way to collapse. Photopea folders fold/unfold; this matters sooner than search does. |
| Color labels | None (no field in UI; not surfaced) | P2/P3 — Photoshop expectation, not Photopea-documented. |
| Search/filter | None | P2 — matters at high layer counts. |
| Thumbnails | Fake checkerboard (see §1) | Identification falls back to names only. |

**Verdict:** the layer *model* operations all exist as commands (duplicate, delete, group, reorder, mask) — the panel's *interaction vocabulary* is what's missing: drag, right-click, inline edit, multi-select, fold. Users judge an editor's professionalism by these gestures more than by feature lists.

---

## 6. Status & save communication

### What the pros do

- **Photoshop on the web:** the header bar contains a dedicated **"Saved"** element whose whole job is to show "the status of your cloud document being saved to Creative Cloud," next to the filename and a Version history control. Cloud documents "are automatically saved as you work" and each autosave creates a restorable version — saving is continuous and the UI's job is *reassurance + history*, not a Save button.
  Sources: https://helpx.adobe.com/sg/photoshop/using/workspace-web.html · https://helpx.adobe.com/creative-cloud/help/cloud-document-faqs.html · http://helpx.adobe.com/photoshop/using/manage-cloud-documents-photoshop.html
- **Photopea:** everything is stored **locally** in the browser — nothing is uploaded to a server. Its maintainer's stated recovery model: if Photopea crashes, work is recovered on next open; but if the user *closes and confirms* losing unsaved work, it is gone. I.e., local-first recovery + an explicit confirm at the dangerous moment.
  Sources: https://www.windowscentral.com/photopea-review-free-photoshop-alternative-works-through-your-browser · https://github.com/photopea/photopea/discussions/6270
- **Figma** (general product behaviour): continuous autosave with a visible save state near the filename and version history; users never press Ctrl+S. (Stated here as widely-known product behaviour; no URL is cited because the Figma help pages retrieved for this pass did not cover save state — treat as directional, not evidence.)

### Our current state

We are closer to the pros here than anywhere else:

- `saveState` text appears in **two places**: the menubar (next to `doc.name — WxH · state`) and the right end of the status bar. States: `Saved` (initial), `Unsaved changes` (on any command), `Saving…`, `Autosaved HH:MM:SS`, `Autosave failed (storage unavailable)`, and `Project saved` after an explicit Ctrl+S / File ▸ Save Project (.wpsc download).
- **IndexedDB autosave every 15 s when dirty**, plus a **recovery banner** on next load offering Restore/Dismiss with the saved timestamp. That is the Photopea recovery model, implemented.

Gaps, in order of user impact:

1. **The dangerous moment is unguarded** (see §4, finding 5): no `beforeunload` prompt while dirty. Photopea's model explicitly includes the confirm-at-close step; we skipped it.
2. **Two different "saved" meanings share one text slot.** "Autosaved 14:03:22" (IndexedDB, this browser only) and "Project saved" (a .wpsc file the user downloaded) look alike but mean very different things for durability. A user can believe their work is "saved" when it exists only in one browser's IndexedDB. Pros disambiguate with location language ("Saved to Creative Cloud" vs. local file). Ours should say e.g. "Autosaved locally 14:03:22" vs. "Project file saved".
3. **No visual channel** — the state is small grey text in both places. No dot/icon/color change (amber dot for dirty, spinner for saving, check for saved), and the doc name carries no dirty asterisk/dot. Photoshop-web dedicates a labelled header element to this; a coloured status dot is the low-effort equivalent.
4. **Failure is quiet and transient.** "Autosave failed (storage unavailable)" is plain text that the next edit overwrites back to "Unsaved changes," and the autosave will silently retry. A storage-full failure deserves a persistent banner with the actionable advice (Save Project .wpsc now) — we already have a banner component for recovery/errors to reuse.
5. **Autosave cadence:** 15 s is fine (better than Photoshop desktop's 10-minute recovery default), but it is interval-based, not change-debounced; a crash 14 s after a big edit loses the edit. Debounce-on-idle (e.g. save 3 s after the last command) closes most of that window cheaply.

**Verdict:** the state machine and recovery story are genuinely pro-shaped. What's missing is the guard at close, the local-vs-file distinction in wording, and any non-text visual signal.

---

## 7. Prioritized recommendations for OUR app

| # | Recommendation | Pro evidence | Our current state | Priority | Effort |
|---|---|---|---|---|---|
| 1 | Remove or fix the "Ctrl+N" label on File ▸ New… — never advertise a shortcut the browser will steal; either bind an interceptable alternative or show no shortcut | Ctrl+N opens a new browser window instead of a document in Photopea — https://github.com/photopea/photopea/issues/8268 ; maintainer on Ctrl+N/Ctrl+T/Ctrl+W conflicts — https://github.com/photopea/photopea/issues/154 | Menu renders "Ctrl+N" but no handler exists; pressing it opens a browser window | **P0** | S |
| 2 | Add a `beforeunload` prompt while dirty, and switch autosave from fixed 15 s interval to save-on-idle debounce (≈3 s after last command) | Ctrl+W cannot be intercepted by design — https://dev.to/tomj/should-web-browser-let-you-control-ctrlcmd-w-59c8 ; Photopea recovery model pairs local recovery with a confirm at close — https://github.com/photopea/photopea/discussions/6270 | No unload guard anywhere in src/; autosave every 15 s only | **P0** | S |
| 3 | Drag-to-reorder layers in the panel, including drag into/out of groups (keep ↑/↓ buttons as the accessible alternative) | Photopea: drag and drop to reorder and move between folders — https://www.photopea.com/learn/layers ; Photoshop web: drag layer up/down the stack — https://helpx.adobe.com/my_en/photoshop/web/edit-images/manage-layers/work-with-layers.html | ↑/↓ buttons move the active layer one step per click; grouping via dropdown + Move button | **P1** | M |
| 4 | Inline layer rename on double-click (input in the row, Enter confirms, Escape cancels) — retire `window.prompt()` | Photopea: double-click name, Enter/Escape semantics — https://www.photopea.com/learn/layers | Double-click opens a browser `prompt()` dialog | **P1** | S |
| 5 | Right-click context menu on layer rows: Rename, Duplicate, Delete, Add Mask, Merge Down, Move to Group | Photopea: panel operations available by right-clicking a layer — https://www.photopea.com/learn/layers ; Photoshop web right-click Layer actions menu — https://helpx.adobe.com/my_en/photoshop/web/edit-images/manage-layers/work-with-layers.html | No context menu anywhere in the app | **P1** | M |
| 6 | Wheel navigation: Alt+wheel (or Ctrl+wheel) zoom **anchored at the cursor**, plain wheel scrolls; add spacebar temporary Hand tool | Photopea: Alt+wheel zooms, Space = hold-for-Hand — https://gist.github.com/milnak/2dfe03c6eaa5a56c2fac29906ea5dd7a and https://defkey.com/photopea-5-4-shortcuts ; Photopea spacebar-hand in teaching docs — http://www.nphsphotography.org/wp-content/uploads/2020/10/Healing-Tools-Photopea.pdf | No wheel handler; zoom is centre-anchored via CSS size; Hand exists only as a switchable tool | **P1** | M |
| 7 | Real layer thumbnails: render each layer's actual content into its row thumbnail (downscaled, refreshed on command completion) | Photopea panel "contains the list of all layers and their thumbnails" — https://www.photopea.com/learn/layers ; Photoshop web Layers panel shows layer thumbnails — https://helpx.adobe.com/sg/photoshop/using/workspace-web.html | Every row shows the same static CSS checkerboard | **P1** | M |
| 8 | Selection modes: Add / Subtract / Intersect controls in the options bar for marquee and lasso, with Shift = add, Alt = subtract modifiers; remove the permanently-"Replace" status text | Photoshop marquee options bar: New/Add/Subtract/Intersect + Feather — https://helpx.adobe.com/photoshop/using/selectingmarqueetools | `selMode` is hardwired to 'replace' and never changes; modes do not exist | **P1** | M |
| 9 | Make Zoom to Fit compute the real fit from document size and workspace size; bind Ctrl+0 (fit) and Ctrl+1 (100%) | Photoshop conventions Ctrl+0 fit / Ctrl+1 actual pixels — https://dev.aesclean.com/virtual-library/gPwRbh/5AD171/how__to__zoom-in_photoshop.pdf ; Photoshop web header zoom offers Fit to screen — https://helpx.adobe.com/sg/photoshop/using/workspace-web.html | Zoom to Fit hardcodes 0.6 for every document; no zoom shortcuts bound | **P1** | S |
| 10 | Fix grouped tool keys: Shift+M cycles Rect ↔ Ellipse Marquee, Shift+G cycles Fill ↔ Gradient (second tools are currently keyboard-unreachable) | Photopea assigns both marquee tools to M and both fill tools to G, implying cycling — https://defkey.com/photopea-5-4-shortcuts | `TOOLS.find` returns the first match only; Ellipse Marquee and Gradient can never be selected by keyboard | **P1** | S |
| 11 | Multi-select layers (Ctrl+click), bulk Duplicate/Delete/Group, and group fold/unfold triangles | Photopea Ctrl+click multi-select; folders fold/unfold; selecting a folder selects contents — https://www.photopea.com/learn/layers | Single active layer only; groups always expanded | **P2** | M |
| 12 | Bind the safe muscle-memory chords: Ctrl+J duplicate, Ctrl+Shift+N new layer, Ctrl+G group, Ctrl+E merge down, Alt+Ctrl+T transform focus; document Ctrl+D's bookmark trade-off in the shortcuts dialog | Photopea's remapped map (Alt+Ctrl+T for Free Transform, Ctrl+J, Ctrl+G, Ctrl+E, `?` opens the list) — https://defkey.com/photopea-5-4-shortcuts | None of these chords bound; transform is numeric-only in Properties | **P2** | S |
| 13 | Eye-column gestures: drag across eye icons to toggle many layers; Alt+click eye = solo/unsolo | Photoshop visibility-column drag and Alt+click solo — http://faculty.fairfield.edu/mediacenter/tl_110/sg_ps_layers.html ; https://www.creativebloq.com/photo-editing/photoshop-tips-and-fixes-612316/3 | Click-per-layer only | **P2** | S |
| 14 | Options-bar depth for non-brush tools: Text gets font family + size in the bar; Shape gets fill/stroke choice before drawing; Gradient gets type + reverse; Crop becomes a staged state with ratio fields and Commit/Cancel | Photopea text bar: font, size, color, alignment — https://www.fahimai.com/how-to-use-photopea ; shape fill/outline choice — same source; Photoshop web contextual task bar pattern — https://helpx.adobe.com/sg/photoshop/using/workspace-web.html | Hint text only for these tools; crop commits irreversibly on mouse-release; no font-family control anywhere | **P2** | M |
| 15 | History panel: make states clickable to jump (our history engine already stores full states), highlight the current state, and let the section grow instead of a 110 px inner scroll | Photoshop/Photopea History panels are state navigators, not logs — https://www.smu.edu/-/media/site/oit/adminsys/adobe-handouts/beginners-photoshop/photoshop-reference-handout.pdf | History rows are non-interactive divs; only Undo/Redo buttons act | **P2** | S |
| 16 | Save-state clarity: coloured status dot (amber dirty / spinner saving / check saved) in menubar and status bar; label states "Autosaved locally HH:MM:SS" vs "Project file saved"; persistent banner with action on autosave failure | Photoshop web dedicates a header "Saved" element to save status — https://helpx.adobe.com/sg/photoshop/using/workspace-web.html ; cloud docs autosave continuously with versions — https://helpx.adobe.com/creative-cloud/help/cloud-document-faqs.html | Grey text only, duplicated in two places; local-autosave and file-save meanings conflated; failure is transient text | **P2** | S |
| 17 | Layer search/filter input at the top of the Layers section (filter by name; later by type) | Photoshop Layers filter row: name, kind, effect, mode, attribute, color — https://help.adobe.com/archive/fi/photoshop/cs6/photoshop_reference.pdf | No search or filter | **P2** | M |
| 18 | Panel ergonomics: collapsible sections and a resizable right rail (drag splitter), so Layers can take the full height on small screens | Photoshop tabbed panel groups + workspace reset — https://www.adobe.com/in/learn/photoshop/web/ps-basics-fundamentals ; Figma resizable sidebars (third-party ref) — https://github.com/qitm2333/op-embedded-studio/blob/HEAD/packages/docs/reference/figma-compatibility.md | Fixed 280 px, no collapse, no resize | **P3** | M |
| 19 | Scrubby zoom: Zoom-tool drag right/left zooms continuously (anchor at drag start point) | Photoshop Scrubby Zoom — http://www.photoshopforphotographers.com/3101-1901/Help_guide/tp/Zoom_tool.html ; Photopea hold-Z + drag — http://www.nphsphotography.org/wp-content/uploads/2020/10/Healing-Tools-Photopea.pdf | Zoom tool is click-step only (×1.25 / Alt ÷1.25) | **P3** | S |
| 20 | Navigator minimap in the right rail (thumbnail + view-box, drag to pan) for large documents at high zoom | Photoshop Navigator panel with view box and zoom slider — https://dev.aesclean.com/virtual-library/gPwRbh/5AD171/how__to__zoom-in_photoshop.pdf (note: Photopea does not document a Navigator; this is Photoshop-side expectation) | Absent | **P3** | M |
| 21 | Layer color labels (assign via context menu, shown as a name tint/dot) and filter-by-color once #17 lands | Photoshop: color is a layer property shown in the panel — https://helpx.adobe.com/uk/photoshop/using/create-layers-groups.html | Absent (not documented in Photopea's Learn pages, hence P3) | **P3** | M |
| 22 | Brush power keys: number keys set brush opacity, Shift+number sets flow, `{`/`}` with Shift adjusts hardness (extends our existing `[`/`]`) | Photoshop brush quick reference — https://phlearn.com/tutorial/photoshop-basics-the-brush-tool/ ; bracket resize shared with Photopea — http://www.nphsphotography.org/wp-content/uploads/2020/09/Photopea-Basic-Editing.pdf | `[`/`]` size only | **P3** | S |

### Suggested sequencing

1. **First hour:** #1 (Ctrl+N label) and #2 (beforeunload + debounce) — both are small, and together they remove the only two findings that actively mislead or lose work.
2. **Next wave:** #3, #4, #5, #10 (layer panel gestures + grouped-key fix) and #6, #9 (navigation) — the "feels like a real editor" wave; every item is something a Photoshop/Photopea user will attempt in their first session.
3. **Then:** #7 (thumbnails) and #8 (selection modes) — the two remaining functional-parity gaps.
4. **Polish queue:** the P2/P3 rows, roughly in table order.

### Method & source notes

- Photopea behaviours were verified against Photopea's own Learn pages (layers, other layers, moving selected data), its GitHub tracker/discussions, and two independent Photopea shortcut references (defkey, a community gist) that agree with each other. Where only secondary sources exist (e.g. Photopea's spacebar-hand, documented in teaching materials rather than the Learn pages), the table says so by the source it cites.
- Photoshop on the web behaviours come from Adobe Help (workspace overview, layers, cloud documents FAQ) retrieved 2026-10-08.
- Figma is cited only for chrome conventions (left layers / right properties / wheel-zoom keys) and only via a third-party compatibility reference, flagged inline; no recommendation depends solely on Figma evidence.
- Deliberately **not** claimed: a Photopea Navigator panel (not in its Learn pages), Photopea layer color-label editing UI (not documented), Figma save-state UI (not verified in this pass). If a future pass verifies them, priorities for #20/#21 can be revisited.
- All "our current state" entries were read from `src/ui/App.tsx` and `src/ui/styles.css` at the 2026-10-08 build (post Vite 6.4.4 upgrade), including the keydown handler, the File menu definition, the layer-row markup, the options bar, and the autosave effect.
