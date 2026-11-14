# Motion Logic — Handoff for the Next Session

Written 2026-11-14. Read this first, then [CLAUDE.md](../CLAUDE.md) (working rules) and [01_計画仕様書.md](01_計画仕様書.md) (plan and spec, in Japanese). Project background is in [Motion_Logic_Modeling_Codex_Handoff.md](Motion_Logic_Modeling_Codex_Handoff.md).

The user wants blunt, realistic reporting: separate what was actually run and verified from what is untested or only proposed. Reply to the user in Japanese.

## 1. What this project is

Motion Logic Modeling (MLM) aims to extract the *motion and staging rules* of a reference motion-graphics / lyric video, and reuse them for a different song and material. The app, "Motion Logic", is the workbench: it reduces a reference video to a simplified scene of plain shapes, lets a human (browser UI) and an AI (MCP) edit the same project, and compares the simplified version against the source.

Phases (details in the spec, §5): 0 connection and rendering → 1 source-vs-simplified comparison → 2 decomposition and simplification support → 3 music relation and staging model → 4 re-composition for another song → 5 editable export to After Effects etc.

## 2. Current state in one paragraph

Phase 0 is complete and verified. Phase 1 has a working skeleton plus most editing features. The last round of work (section 4 below) was **stopped by the user mid-verification**: the code is written, tests and typecheck pass, the server-side parts were verified through the HTTP API, but several UI interactions were never exercised in the browser and the docs were not updated for that round. Nothing has been committed; the repository only has `git init`.

## 3. Architecture (decided, working)

- TypeScript monorepo, npm workspaces, Node 24 running `.ts` directly (no build step for server or MCP).
- `packages/core` — scene schema (Zod, unknown keys rejected), evaluation at time `t`, Canvas 2D drawing, scene ops, hit testing. Shared by browser and server, so the preview and the images returned to the AI come from the same `drawFrame`.
- `apps/server` — Hono HTTP API on `127.0.0.1:4517`. The only owner of state. Projects are JSON on disk under `data/projects/<id>/` with integer revisions, per-revision history, and SSE change events. FFmpeg for probing, frame extraction, waveform, cut detection and MP4 export. `@napi-rs/canvas` for server-side rendering.
- `apps/mcp` — stdio MCP adapter. Stateless; only calls the HTTP API. Auto-starts the server if it is not running.
- `apps/web` — React + Vite UI on port 5173.
- Every mutation requires `baseRevision`; a stale one is rejected with 409.
- Times are stored as real seconds, never rounded to frames or beats.

Commands: `npm run dev`, `npm run stop`, `npm test`, `npm run typecheck`, `npm run build`.

## 4. Verification status

### Verified by actually running it

- Core tests (11) and typecheck for all packages pass.
- MCP round trip from two real Claude hosts: the Claude Code CLI (`claude -p --mcp-config .mcp.json`) and a Claude desktop-app Code-tab session. The model saw the returned images, changed a shape's color through `update_scene`, and confirmed the change in a new image. Stale revisions and unknown keys were rejected with readable errors.
- Browser UI: project selection, synced playback of source and simplified version, seek, frame step, side-by-side / overlay / simplified-only views, live update when the AI changes the scene, element selection, drag-to-move on the canvas (saved as one revision), history list.
- Media: import by path, import through the upload API, variable-frame-rate warning (simple heuristic), MP4 export of the simplified scene with source audio.
- Added in the last round and verified **through the HTTP API only**:
  - Cut-candidate detection (`POST /api/projects/:id/detect-cuts`, FFmpeg `scdet`). On a synthetic clip with cuts at 2.0 s and 3.5 s it returned exactly those two. Re-running replaces earlier estimated cut markers and keeps manual markers.
  - Waveform peaks (`GET /api/projects/:id/waveform`).
  - Side-by-side comparison export (`layout: "compare"`): produced a 1280x360 file with audio.
  - The waveform row and the "detect cuts" button render in the UI.

### Written but NOT verified — check these first

1. **Export length fix.** Exports came out a few frames short (57 of 60, 88 of 89) because of `-shortest`. It was replaced with `-frames:v <frameCount>` in `apps/server/src/export.ts`. This change has not been run. Export both layouts and confirm the frame count with ffprobe.
2. **Scale and rotate handles** on the canvas (`apps/web/src/Stage.tsx`). The handles are drawn on the selected element (seen in a screenshot), but dragging them was never tested. The math is in `scaleElementOps` / `rotateElementOps` in core, which are unit-tested.
3. **Dragging keyframes on the timeline** to change their time (`apps/web/src/Timeline.tsx`, `shiftKeyTimeOps` in core). Core function is unit-tested; the UI drag is untested.
4. **Loop range, In/Out buttons (keys I / O), playback speed** in `apps/web/src/App.tsx`. Untested.
5. **Trajectory display** for the selected element (dots are per frame, so spacing shows speed). Appeared in one screenshot; not checked carefully.
6. **Trash a project** — `DELETE /api/projects/:id` moves the folder to `data/trash/`; UI button and SSE handling exist. Untested.
7. **New MCP tools** `detect_cuts`, `delete_project`, and the `layout` parameter of `render_preview`. Untested through MCP. The tool list is now 12 tools; keep it small (see CLAUDE.md).
8. Never tested at all: the file-picker upload button in the UI, dragging an element that has a parent in the UI, videos longer than a few seconds, a real reference video.

All testing so far used 2–5 second clips synthesized with FFmpeg. No real motion-graphics footage has been through the app.

## 5. Docs that are out of date

[01_計画仕様書.md](01_計画仕様書.md) and [README.md](../README.md) do not yet describe the last round. Update them once section 4's unverified items are confirmed:

- Spec §3.4: tool count (12) and the new tools.
- Spec §5 Phase 1: scale/rotate handles, timeline key drag, loop range, speed, trajectory, waveform, comparison export, trash.
- Spec §5 Phase 2: cut-candidate detection is done with FFmpeg `scdet` (no Python worker needed yet); PySceneDetect remains an option if `scdet` proves too noisy on real footage.
- Spec §6 and §7: verified list and task list.
- README: tool list, key bindings, "not yet available" list.
- The MCP guide text in `apps/mcp/src/index.ts` (`GUIDE`) was already updated for `detect_cuts`.

## 6. Recommended order of work

1. Run `npm run stop`, then `npm run dev`, and verify the items in section 4 ("Written but NOT verified"). Fix what breaks. Then update the docs (section 5).
2. Clean up: six test projects remain in `data/projects/`. They are disposable; trash them through the API or UI once that path is verified.
3. Commit. The user has been offered a commit several times and has not explicitly said yes or no — ask once.
4. **Manual reproduction with real footage** — the real acceptance test for Phase 1. Ask the user for a ~10 second 2D clip dominated by text and shapes. Import it, detect cuts, and build the simplified scene together through MCP. Record which expressions and operations are missing; let that result set the next priorities.
5. Then, per the spec §7: job management for long operations, decomposer comparison (Fast Sprite Decomposition vs Motion Vectorization) in isolated environments under `external/`, audio analysis (beats and sections) as the first Python worker under `workers/`.

## 7. Things that will bite you

- **Stale server.** The MCP adapter auto-starts the server detached, and it survives after the dev server stops. If server changes seem to have no effect, an old process is still on port 4517. Run `npm run stop`, then start again. In PowerShell, `Get-NetTCPConnection -State Listen` did not find the listener on this machine; use the stop command or look up the node process by command line.
- **MCP connection inside the desktop app.** If the app tries to connect before `npm install` has run, the server stays in a failed state, and `/mcp reconnect` is not available in that app. Restarting Claude fixes it.
- **GPU is an RTX 4060 Laptop with 8 GB**, not the 4070 / 12 GB stated in the original handoff. Measure VRAM before adopting any model.
- **The repo lives under OneDrive.** No problem so far, but `node_modules` and video data are being synced. `MLM_DATA_DIR` can move the data outside.
- **PowerShell 5.1** mis-decodes UTF-8 JSON from the API (Japanese paths turn into mojibake). Use a small Node script for API tests instead of `Invoke-RestMethod`.
- **ChatGPT app is out of scope for now**: it needs a public HTTPS MCP endpoint, which conflicts with the local-only principle. Claude clients and Codex CLI are the targets. Claude Desktop (plain chat) and Codex CLI configs are documented in the README but have not been tried; they require editing the user's global config, so ask before doing it.
- The scene schema deliberately lacks paths, masks, particles, camera/3D, and per-character text animation. Extend it only when real footage shows the need, and bump `SCHEMA_VERSION` for breaking changes.

## 8. Loose ends at the moment of handoff

- Dev server (`npm run dev`) was left running from the previous session's browser preview.
- Working tree is entirely uncommitted.
- Test project `p_mwfolntskift` ("MCP往復テスト") has a source video with audio and is convenient for checking the UI items in section 4.
