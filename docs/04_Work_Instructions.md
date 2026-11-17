# Motion Logic — Work Instructions (from 2026-11-15 onward)

Read this first in a new session. Then read [CLAUDE.md](../CLAUDE.md), which has the working rules. Background documents:
- [01_計画仕様書.md](01_計画仕様書.md): the spec, in Japanese.
- [03_1c_受け入れ試験結果.md](03_1c_受け入れ試験結果.md): why the priorities below were chosen.
- [Motion_Logic_Modeling_Codex_Handoff.md](Motion_Logic_Modeling_Codex_Handoff.md): the original idea and the research links.

Reply to the user in Japanese. The user wants blunt, realistic reports: keep **verified by running it**, **not verified**, and **proposal** visibly separate. Do not claim the AI "understood" the staging unless measurements or renders back it up.

---

## 0. Where things stand (commit `83bb0df`)

- **M0** (connection and rendering): done and verified with the Claude Code CLI and with a Code-tab session in the desktop app.
- **M1** (comparing source and simplified versions): all editing features are verified in the browser and through MCP. Five bugs were fixed in the last session: comparison-export frame counts, an export crash near the end of the source, short files when overwriting under OneDrive, the UI losing live updates after a server restart, and an unreachable rotate handle.
- **1c acceptance test**: run on a **synthetic** 10 s kinetic-type clip only, with an overall SSIM of 0.95 and 12 gaps listed in doc 03. **Real footage has never been through the app.**
- **Claude Desktop (plain chat)**: `motion-logic` was added to `%APPDATA%\Claude\claude_desktop_config.json`, with a backup at `claude_desktop_config.json.bak-mlm-20261115`. The connection has **not** been tested, because it needs a full Claude restart.
- **MCP tools (12)**: `get_guide`, `list_projects`, `create_project`, `import_media`, `get_project_state`, `update_scene`, `get_frames`, `render_preview`, `detect_cuts`, `get_history`, `revert_revision`, `delete_project`.
- **Remaining project data**: `p_mwfolntskift` (synthetic clip with audio) and `p_mwh3s99t2w85` (the 1c test project). The 1c sample video and `ground_truth.json` are in `C:\Users\kinos\mlm_samples\`, outside the repo. Regenerate them with `python samples/make_kinetic_sample.py <dir>`.

## 1. Session start checklist

1. Run `git status` and `git log --oneline -3`, and confirm you are on top of `83bb0df` or later.
2. Run `npm run stop`, then `npm run dev`. A stale server on port 4517 is the most common cause of "my change has no effect".
3. Run `npm test` and `npm run typecheck`. Both must pass before and after every change.
4. If MCP tools are missing in a desktop-app session, `npm install` was not run before the app connected. Restart Claude to fix it; `/mcp reconnect` is not available in that app.
5. Test the API with Node scripts, not PowerShell `Invoke-RestMethod`, which garbles Japanese UTF-8. Git Bash `curl` with Japanese in the body also garbles it, so use Node or Python.

---

## 2. Work plan by phase (in priority order)

The order was changed after the 1c test: relation-level description, beats, and measurement come **before** the research decomposers. The reasoning is in doc 03 §3. If real footage (Phase F) shows measurement is the main blocker, move Phase D ahead of B and C.

### Phase A — Claude Desktop (plain chat) connection check (small, user-assisted)

- [ ] Ask the user to quit Claude fully, including from the tray, and reopen it. Restarting ends any Code-tab session, so the user must do this step.
- [ ] In a plain chat: "motion-logic のツールで demo プロジェクトを作り、get_frames で画像を見せて、update_scene で色を変えてもう一度見せて".
- [ ] Record the result in spec §3.4: whether the tools appear, whether images arrive, and any errors. Known risk: Claude Desktop on Windows has reports of large `tools/list` responses or large arguments being silently dropped.
- [ ] Optional, and only if the user asks: Codex CLI via `~/.codex/config.toml` (see the README). This edits a global config, so ask before doing it.

### Phase B — M2a: relation-level scene description (schema v2)

**Goal:** store relations (stagger, beat-relative timing, repetition) instead of baked keyframes, so that changing the tempo or the stagger is a one-value edit. This is also the raw material for M3 rules and M4 re-timing.

Keep the scope tight. Add only what the 1c test proved necessary.

- [ ] **Design first.** Write a short design note in the spec §4.3 before coding, and get the user's OK on the shape. Proposed shape, open to change:
  - Text split: a `text` element gets `split: "char" | "word"` plus `stagger: { interval, order?: "forward"|"reverse"|"center"|"random", seed? }`. The element's transform keys apply to each unit, offset by `index * interval`.
  - Beat-relative time: a scene-level `tempo: { bpm, offset }`, or better, a reference to beat markers. Key times may be written as `{ beat: n }` or `{ bar, beat }` in addition to seconds. **Seconds stay the stored truth for measured data**: beat-relative times are a description choice, not rounding (CLAUDE.md rule).
  - Repetition: `repeat: { every: <seconds or beats>, count?, until? }` on a keyframe track, for "pulse every beat".
  - Anchor: `anchorX`, `anchorY` (the pivot for scale and rotation, in local px), matching the After Effects anchor point.
  - Font: `fontFamily`. Note that the browser (Chromium) and the server (Skia via @napi-rs/canvas) must resolve the same font. Register font files explicitly on the server.
  - Optional, decide with the user: `opacityInherit` on groups, or a scene-level fade.
- [ ] Bump `SCHEMA_VERSION` to 2. Write a v1→v2 migration, so that a v1 scene is still valid or is auto-upgraded on load.
- [ ] Implement the expansion in `packages/core/src/evaluate.ts`, so the browser and the server share it. Hit testing and trajectories must work on the expanded units.
- [ ] Unit tests in `packages/core`: stagger timing per index, beat→seconds conversion, repeat expansion, anchor math, and v1 migration.
- [ ] Update the MCP `get_guide` text (`apps/mcp/src/index.ts`) and spec §4.3, as CLAUDE.md requires. Keep the tool list small: no new tools are needed for this.
- [ ] UI: the Inspector JSON editing already works. Add at most a stagger-interval field and a split toggle. The timeline should show the expanded per-unit keys, read-only.
- [ ] **Acceptance:** rewrite the 1c scene (`p_mwh3s99t2w85`) with v2. Targets: far fewer elements than 44 and far less JSON than 22 KB, the same look (SSIM per section within about 0.01 of the v1 scene), and a change from 120 to 100 BPM that moves the beat-based motion. Record the numbers in doc 03 or a new doc.

### Phase B (parallel-safe) — M2b: beat estimation, the first Python worker

**Goal:** estimated beats and tempo from the source audio, shown as `beat` markers with `origin: "estimated"`.

- [ ] Create `workers/beats/` with its own `uv` project (`pyproject.toml`, pinned versions). Keep it out of the Node dependencies.
- [ ] Contract: the server spawns `uv run --project workers/beats python -m beats <audio.wav> <out.json>`. The output JSON holds `{ bpm, beats: [s...], downbeats?: [s...], onsets?: [s...], tool, version, params }`. Record the tool, version and parameters (spec rule: record which analysis produced which data).
- [ ] The server extracts audio with FFmpeg into the project `cache/`, runs the worker, and writes `beat` markers. Re-running replaces the old estimated beats and keeps manual ones (same rule as `detect_cuts`).
- [ ] Exposure: an HTTP endpoint, a UI button, and an MCP tool `detect_beats`. That makes 13 tools, so keep the description short.
- [ ] **Acceptance:** on the 1c sample, it finds 120 BPM and beats within ±1 frame of `ground_truth.json`, and shows the missing kicks during the 4.0–4.5 s hold. Then try it on a real song.
- [ ] Next step, later: All-In-One for section labels (intro/verse/chorus). The original has Windows/NATTEN issues; use the inference fork if it gets stuck (see the download list).

### Phase C — M2c: measurement tools for the AI

**Goal:** let the AI measure positions and timings from frames instead of guessing from thumbnails.

- [ ] `get_frames`: add a `region` crop (x, y, w, h in source px) and an optional coordinate grid or ruler overlay, so the AI can read pixel positions. Keep it inside the existing tool by adding parameters, not a new tool.
- [ ] Region tracking: a Python worker (`workers/track/`, OpenCV, CPU) that takes a region at a time and returns per-frame center, scale and rotation estimates, plus a confidence.
- [ ] Curve fitting, our own code: convert a per-frame trajectory into a few keys plus easing (cubic-bezier fit). Store the raw track as an **observation** (`observations.json`, introduced here) and the fitted keys in the scene. Keep the two separate.
- [ ] `compare_segment` (HTTP plus an MCP tool, or extend `get_frames`): per-section SSIM, cut-time differences, and later per-element position error. The 1c SSIM was computed by hand with FFmpeg `ssim`; automate exactly that first.
- [ ] **Acceptance:** track one letter in the 1c sample and auto-fit keys that match `ground_truth.json` timing within about 1 frame and position within a few px.

### Phase D — M2d: confirm or reject estimated markers (small)

- [ ] UI: on the timeline, click an estimated cut or beat to confirm it (it becomes `manual`) or delete it. Add a bulk "clear estimated" action.
- [ ] MCP: this can go through `update_scene` `setMarkers`. Only add a tool if that proves clumsy.
- [ ] **Acceptance:** remove the two false cuts (4.567 s and 4.6 s) on the 1c sample in a few clicks.

### Phase E — real-footage acceptance test (the real 1c)

- [ ] Ask the user for a real reference clip, about 10 s, 2D, mostly text and shapes. **Do not download copyrighted videos yourself.** The user supplies the file, or explicitly picks a source whose license allows it.
- [ ] Import it, detect cuts and beats, measure with the Phase C tools, and rebuild the scene with v2. Use `compare_segment`.
- [ ] Write the results the same way as doc 03: what was reproduced, the gaps ranked, and what you **could not** judge.
- [ ] Re-prioritize F to I based on the results, and tell the user before starting them.

### Phase F — decomposer comparison (only if Phase E shows simple tracking is not enough)

- [ ] Measure VRAM first (`nvidia-smi` while running). The GPU is an **RTX 4060 Laptop with 8 GB**.
- [ ] SAM 3.1 is **already installed**: code is in `C:\Users\kinos\AppData\Local\vrecon\src\sam3`, weights are in `~\.cache\huggingface\hub\models--facebook--sam3.1` (`sam3.1_multiplex.pt`, 3.5 GB), and the uv environment is `vrecon\envs\observe` (Python 3.12.9, torch 2.10.0). It belongs to another project (vrecon): **do not modify that environment**. Reference it read-only, or build `workers/sam3/` with its own environment that points at the same weights.
- [ ] Fast Sprite Decomposition and Motion Vectorization: clone them into `external/` (git-ignored), each in an isolated environment. Run each one's own sample first, then the Phase E clip. Compare speed, VRAM, and how well the motion maps onto our schema.
- [ ] Record the commit, weights, dependency versions and license of each candidate in the spec.

### Phase G — job management (when clips get longer than about 1 minute)

- [ ] Track progress, cancel, failure reasons, and resumable artifacts for export and analysis. Today a 10 s export takes a few seconds, so this is not needed until longer material arrives.

### Phase H — M3: hypotheses and rules

- [ ] `hypotheses.json` and `motion_rules.json`. Rules should reference v2 relations (stagger, beat-relative timing, hold), not raw keys.
- [ ] Keep observation (measured), hypothesis (why) and rule (generative) in separate files (spec §1 and CLAUDE.md).
- [ ] Variant generation for comparison: no hold, short hold, and long hold.

### Phase I — M4 re-composition for another song, and M5 After Effects export

- [ ] M4: import a new song, run beats and sections, map the rules, and always compare against baselines (global speed change only, beat retiming only, a fixed template).
- [ ] M5: the AE MCP server is already connected on this machine (`mcp__after-effects__*`). A first prototype can build an AE comp from the common scene through that MCP. Map v2 stagger to AE Text Animators and beat-relative timing to expressions or keys. Do not call an MP4 import "editable export".

---

## 3. Downloads and installs

Nothing in this list has been downloaded yet, except where marked as installed. Download only when the phase needs it. **Ask the user before each download, giving the name, source and approximate size** (this is a standing rule for this assistant). Keep research repos in `external/` and Python dependencies in per-worker `uv` environments under `workers/`.

| When | What | Source | Notes |
|---|---|---|---|
| Phase B | `librosa` (+ `numpy`, `soundfile`) | PyPI, into `workers/beats` | CPU only. Small. Pin the versions. |
| Phase B (later) | All-In-One | https://github.com/mir-aidj/all-in-one | Sections and downbeats. NATTEN/Windows issues are expected. |
| Phase B (fallback) | All-In-One-Infer | https://github.com/openmirlab/all-in-one-infer | Pure-PyTorch inference fork. Check that its results match the original on a short clip. |
| Phase B (optional) | Demucs or similar source separation | PyPI | Only if beats are unreliable on full mixes. GPU helps. Measure VRAM. |
| Phase C | `opencv-python` (or `opencv-contrib-python` for CSRT/KCF trackers) | PyPI, into `workers/track` | CPU only. |
| Phase C | `scikit-image` (optional) | PyPI | Only if FFmpeg `ssim` is not enough. |
| Phase F | Fast Sprite Decomposition | https://github.com/CyberAgentAILab/sprite-decompose | Python 3.10 / CUDA 11.3 era. Archived. MIT. Isolated environment. |
| Phase F | Motion Vectorization | https://github.com/sxzhang25/MotionVectorization-ProgramTransformation | Python 3.8 / PyTorch 2.0.1 / CUDA 12.0. RAFT dependency. MIT. Isolated environment. |
| Phase F | SAM 3.1 | **Already installed** (see Phase F) | No download needed. Upstream is 2 trivial commits ahead; do not pull without asking the user. |
| Phase F (optional) | PySceneDetect | PyPI | Only if FFmpeg `scdet` gives too many false cuts on real footage. |
| Phase F (optional) | PaddleOCR | https://github.com/PaddlePaddle/PaddleOCR | Text region and content detection. Decorative fonts may fail. |
| Phase F (optional) | CoTracker | https://github.com/facebookresearch/co-tracker | Point tracking. Mostly CC-BY-NC: check before making it a required dependency. |
| Phase F (optional) | LayerD | https://github.com/CyberAgentAILab/LayerD | Layer decomposition of single frames. Archived. Apache-2.0. |
| Phase H/I (optional) | MusiCue | https://github.com/cedarconnor/MusiCue | Music → event curves and AE output. Many dependencies; compare before adopting. |
| Phase B (fonts) | Font files for `fontFamily` | System fonts (`C:\Windows\Fonts`) or open-licensed fonts (e.g. Google Fonts) | Register the same file in the browser and on the server. Check the license before bundling any font into the repo. |
| Phase E | A real reference clip | **Provided by the user** | Never fetch copyrighted footage yourself. Keep it out of git (`data/` is ignored). |

Already present on this machine: Node 24.15, npm 11.12, Python 3.11.9, uv 0.12.3, FFmpeg/ffprobe (a 2024-01 build at `C:\ffmpeg-master-latest-win64-gpl\bin`), Git 2.47, Pillow 12.2, numpy 1.26 (system Python), the After Effects / Blender / Unity / Roblox MCP servers, and SAM 3.1 (see above).

---

## 4. Rules and pitfalls (read before coding)

- **State lives only in `apps/server`.** The UI and MCP go through HTTP. Every mutation goes through `commit()` in `apps/server/src/store.ts` with `baseRevision`.
- **One renderer:** `drawFrame` in `packages/core`. Never write a second renderer for the server or the browser.
- **Times are real seconds.** Never round to frames or beats when storing. Beat-relative descriptions in v2 must not destroy measured offsets.
- **Separate estimated, measured and manual data** (`origin`), and separate observation from hypothesis.
- **No empty stubs.** Add UI or files only when real data flows through them.
- **Node runs `.ts` directly:** imports need the `.ts` extension, and there are no enums or parameter properties (`erasableSyntaxOnly`).
- **MCP stdout is the protocol.** Log only with `console.error`. Keep tool descriptions short and put detail in `get_guide`.
- **FFmpeg lessons learned (2026-11-15):**
  - Do not combine a pipe input and a file input in one `tpad`+`hstack` graph. The output length varied from run to run, which was reproducible with FFmpeg alone. The comparison export is therefore 4 steps: render → cut out the source clip → stack → mux audio with `-c:v copy`.
  - Cut ranges with `trim`/`atrim` in the filter graph, not with input `-ss`/`-t`.
  - Fix the length with `-frames:v`, not `-shortest`.
  - Under OneDrive, overwriting a file with `-y` sometimes produced short files. Write to a temp name and rename (`replaceFile` in `export.ts`).
- **The SSE stream can silently die** when the server restarts behind the Vite proxy. The UI now has a 25 s watchdog on the 10 s server ping. Keep the ping if you touch `/api/events`.
- **PowerShell 5.1** garbles UTF-8 JSON, so use Node or Python for API tests.
- **GPU is 8 GB.** Measure VRAM before adopting any model.
- **OneDrive:** big data can move out with `MLM_DATA_DIR`. Generated sample media lives in `C:\Users\kinos\mlm_samples\`.
- **ChatGPT app is out of scope.** It needs a public HTTPS MCP endpoint, which conflicts with the local-only principle.

## 5. Reporting and committing

- After each phase: run tests and typecheck. Verify in the browser where the change is visible, and through MCP where tools changed. Update the spec (§5, §6, §7) and the README when behavior or commands change.
- Write the results as **verified** (what was run, on which data, with what numbers), **not verified**, and **next**.
- Commit only when the user asks. Use one commit per phase. End commit messages with the attribution line the environment provides.
- Ask the user once at each decision point: the v2 schema shape (Phase B), every download (section 3), and the real clip (Phase E).
