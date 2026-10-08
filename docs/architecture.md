# Architecture

Classification (Adaptive Execution Protocol): **highly complex** — 37 nominal
agent roles in the master prompt are consolidated into 5 workstreams with
disjoint file ownership and one integration owner (the lead), because the
prompt's own §95 dependency graph is a tree, not 37 independent silos.

## Workstreams & ownership
| Stream | Owns | Delivers |
|---|---|---|
| Lead (Agent 0/36) | `src/core/**`, `src/ui/**`, docs, integration | contracts, document model, commands, history, renderer, UI shell |
| A | `src/engine/color`, `blend`, `raster` | color math, W3C blend modes + compositing, pixel-buffer ops |
| B | `src/engine/selection`, `transform`, `filters` | selection algebra, affine transforms, filters |
| C | `src/engine/brush`, `gradient`, `shapes`, `text` | brush engine, gradients, shape rasterizer, text layout |
| D | `src/storage/**`, `src/engine/filters/adjustments.ts` | `.wpsc` project format, autosave/recovery, adjustments |

## Contracts
`src/core/contracts.ts` is the single binding contract: non-premultiplied RGBA
`PixelBuffer`, single-channel `MaskBuffer`, `Layer`/`EditorDocument` model,
`Command` interface, resource `LIMITS`. No stream may change it unilaterally (§96).

## Data flow
UI → Command → History.execute → Document model (source of truth) →
`compositeDocument` renderer → Canvas2D display (+ text overlay). Tools never
mutate state outside commands (§8); selection/view state lives outside history (§9).

## Testing
Vitest unit/contract tests per engine (pixel-level fixtures, §51), integration
tests in `tests/` for the §122 acceptance workflow at model level, typecheck +
production build as the merge gate (§99 adapted: no CI service is assumed for a
local repo; the same pipeline runs locally).
