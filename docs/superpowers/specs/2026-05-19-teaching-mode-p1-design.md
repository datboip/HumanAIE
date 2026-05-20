# Teaching Mode P1 — Capture, Stuck-Point Detection, and Workflow Annotation

**Status:** Design — awaiting user approval before plan/implementation.
**Date:** 2026-05-19
**Builds on:** v1.3.0 (HANDROID touch-gestures shipped 2026-05-19)
**Tracker:** [project_teaching_mode_roadmap.md](../../../../.claude/projects/-home-rickburp-Projects-HumanAIE/memory/project_teaching_mode_roadmap.md)

---

## Goal

Close the **learning loop** for the AI's phone work: it tries to do a task, the system captures what it did, the human reviews failures and corrections, and the captured + corrected runs become reusable *workflows* the AI consults next time. This eliminates the "AI takes 30 minutes to post on Instagram every time" problem by giving the agent persistent spatial+temporal memory of how to operate a specific app.

P1 ships the **capture** half of the loop and the **review/annotate** UI. P3 will ship the **consumption** half (AI fetches and replays a saved workflow). They are designed to compose.

---

## The Loop

```
① AI attempts task         → uses /android/tap, /android/swipe, /android/key as today
② Server auto-captures     → screenshot + action + coord per dispatch (no opt-in needed)
③ Session ends when:
     a. AI calls /teach/done       → marked ✓ succeeded
     b. AI hits /waitfor-highlight → marked ✕ stuck (with the help question text)
     c. 30s of no /android/* calls → marked ⏱ idle-timeout
④ Session appears in 🎓 Teach tab under "Recent sessions"
⑤ Human opens it → step-card editor → annotates, names steps, fixes stuck points
⑥ Human clicks "Save as workflow" → workflows/<pkg>/<activity>/<name>.json
⑦ (P3) Next time AI sees that (pkg, activity), it fetches the workflow and replays
```

The token-burn-on-retry problem the user flagged is addressed by **③b** and **⑦**:
- The spec mandates (but does not enforce) that agents call `/waitfor-highlight` after at most 3 failed attempts to locate an unknown UI element. This becomes a *cultural* rule for HumanAIE-consuming agents.
- Once a workflow is saved, P3's replay skips first-time exploration entirely — the agent reads the stored tap-coord and proceeds.

---

## Architecture

### Capture layer (`android.js`)

A teaching-session is bookkeeping around the existing `/android/*` dispatch path. No new dispatch logic — every `tap`, `swipe`, `key`, `type` (and the existing `/waitfor-highlight`) registers a step in the active session if one is open.

```
TeachingSession {
  id:           "teach-<unix-ms>",
  package:      string,            // captured at session start from /android/status
  activity:     string,            // ditto
  device:       string,            // adb serial
  screen_w/h:   int,               // from wm size (cached)
  started_at:   timestamp,
  ended_at:     timestamp | null,
  end_reason:   "done" | "stuck" | "idle" | "manual" | null,
  steps:        Step[],
  stuck_at:     int | null,        // index into steps where /waitfor fired
  help_question:string | null,     // the message the AI passed to /waitfor
  help_resolved:{ x, y, label } | null  // human's resolution
}

Step {
  index:      int,
  action:     "tap" | "swipe" | "key" | "type" | "waitfor-asked",
  args:       object,              // { x, y } for tap, { x1,y1,x2,y2,dur } for swipe, etc.
  screenshot: "step-NNNN.jpg",     // captured immediately AFTER the dispatch
  timestamp:  unix-ms,
  label:      string | null,       // null until human edits in the editor
  anchor:     { label, x, y } | null  // optional reference to a /highlight entry
}
```

**Session lifecycle:**

| Trigger | What happens |
|---|---|
| First `/android/*` after no active session | Create session, mark `started_at`, set `package`+`activity` from current status |
| Every subsequent `/android/*` | Append step, capture frame, reset idle timer |
| `POST /teach/done` | Close session with `end_reason: "done"`, persist to disk |
| `POST /waitfor-highlight` opens | Append a `waitfor-asked` step; set `stuck_at`, `help_question` |
| `/waitfor-highlight` resolves (human clicks) | Set `help_resolved`, close session with `end_reason: "stuck"` |
| 30s with no `/android/*` and no open waitfor | Close session with `end_reason: "idle"` |
| `POST /teach/cancel` | Discard the in-flight session without saving |

**Storage on disk:**

```
humanaie-sessions/teach-1779236627123/
  meta.json         ← TeachingSession minus steps array
  steps.jsonl       ← one Step per line, append-only
  step-0001.jpg     ← frame captured immediately after step 1's dispatch
  step-0002.jpg
  ...
```

Sessions older than 7 days that haven't been promoted to a workflow are deleted by a daily cleanup job (extends existing `pruneOldSessions` in `server.js`).

---

### Workflow layer (`android.js`)

A *workflow* is a finalized, named, human-curated version of a session.

```
workflows/<pkg>/<activity>/<slug>.json
```

```
Workflow {
  id:          "wf-<unix-ms>",
  name:        "Post a photo",
  package:     "com.instagram.android",
  activity:    "com.instagram.android.MainActivity",
  screen_w/h:  int,
  steps:       Step[],            // same Step shape as TeachingSession.steps, but every step has a label
  created_at:  ts,
  updated_at:  ts,
  source:      "session-<id>" | "manual",
  use_count:   int,                // incremented by P3 replay (zero in P1)
}
```

Note: screenshots are copied from the session directory into `workflows/<pkg>/<activity>/<slug>/step-NNNN.jpg` so the workflow is self-contained.

---

### Endpoints (new in P1)

| Method | Endpoint | Body / Returns |
|---|---|---|
| GET  | `/teach/sessions` | List of recent sessions: `[{id, package, activity, started_at, ended_at, end_reason, step_count}, ...]` |
| GET  | `/teach/sessions/:id` | Full session including step metadata (screenshots referenced by URL) |
| GET  | `/teach/sessions/:id/step-NNNN.jpg` | Step screenshot |
| POST | `/teach/done` | `{}` — close active session as succeeded |
| POST | `/teach/cancel` | `{}` — discard active session |
| DELETE | `/teach/sessions/:id` | Remove a draft session |
| POST | `/teach/sessions/:id/promote` | `{name}` — copy session to a workflow file |
| GET  | `/workflows` | `[{id, name, package, activity, step_count, use_count}, ...]` |
| GET  | `/workflows/:id` | Full workflow |
| PATCH | `/workflows/:id` | `{name?, steps?}` — rename or edit steps |
| DELETE | `/workflows/:id` | Remove |
| GET  | `/workflows?package=&activity=` | (P3 will use this) Filter to one app |

---

### UI layer (`public/cam/index.html`)

#### New tab in the tab bar

`🎓 Teach` sits next to `📱 HANDROID`. Click → activates teach mode UI (replaces viewport with the editor view). Like HANDROID, this tab is pinned and can't be closed.

#### Teach tab landing

Two columns (the mockup at `teach-v2.html`):

**Left — Recent sessions** (auto-refreshes every 5s while tab active)
- Each row: status icon (✓ / ✕ / ⏱), package, action count, "n minutes ago"
- ✕ rows show the help question text in yellow ("Asked: which is the post button?")
- Click a row → opens the session in the editor

**Right — Saved workflows**
- Each row: workflow name, package, step count, "used N times" (zero in P1)
- Click a row → opens the workflow in the same editor (read+edit mode)
- Bottom: hint pointing user to promote a session

#### Step editor (mockup `teach-mockup.html`)

Horizontal-scroll timeline. One card per step:

- **Screenshot** of the phone after the action fired (clickable to drop an anchor dot)
- **Action overlay**: yellow dot for `tap`, green dashed line for `swipe`, key icon for `key`, text bubble for `type`
- **Editable name** input (default: `tap @ x,y` / `swipe up` / `key BACK` / `type "..."`)
- **Coord readout** (read-only)
- **Anchor toggle** — `+ link to highlight`. Opens a small picker of existing `/highlight` entries near this coord. P2 will auto-link these.
- **Delete** ✕ removes the step from the workflow (doesn't touch the original session)

Stuck-point step has a red border and a banner: `⚠ AI asked here: "{help_question}"`. The human's resolution coords pre-fill an anchor.

#### "+ add manual step" slot

At the end of the timeline. Lets the human insert steps the recorder missed (`wait 2s`, `keypress BACK`, etc.) — important for replay correctness.

#### Save as workflow

Button below the timeline. Prompts for a name (defaults to a derived "verb the noun" like "tap-the-+"). POSTs `/teach/sessions/:id/promote`. On success, the editor switches to "viewing saved workflow" mode and the session entry moves to the Workflows column.

---

## Data flow (sequence)

```
AI agent          HumanAIE server           Cam UI               Filesystem
   │                   │                       │                      │
   │── tap 540,1500 ──>│                       │                      │
   │                   │── if no active sess:  │                      │
   │                   │     create teach-XXX  ├── meta.json          │
   │                   │   adb input tap       │                      │
   │                   │   screencap → JPEG    │                      │
   │                   │   append step + .jpg  ├── step-0001.jpg      │
   │                   │   reset idle timer    │                      │
   │<── ok ────────────│                       │                      │
   │                                                                  │
   │── waitfor-highlight {"q":"where post?"} ─>│                      │
   │                   │   append waitfor step ├── step-0002 (no jpg) │
   │                   │   set stuck_at=2      │                      │
   │                   │── show banner ───────>│                      │
   │                                           │                      │
   │                                           ├── user clicks @ 900,200
   │                                           │                      │
   │                   │<── coords ───────────│                      │
   │                   │   save help_resolved  │                      │
   │                   │   close session=stuck │                      │
   │<── coords ────────│                       │                      │
   │                                                                  │
   │   (later)                                                        │
   │                                           ├── user opens 🎓 Teach │
   │                                           ├── sees ✕ session     │
   │                                           ├── clicks → editor    │
   │                                           ├── annotates steps    │
   │                                           ├── clicks Save        │
   │                   │<── promote {name} ────│                      │
   │                   │   copy jpgs to wf dir ├── workflows/.../    │
   │                   │   write workflow.json │                      │
   │                   │── ok ────────────────>│                      │
```

---

## Error handling

| Scenario | Behavior |
|---|---|
| `/android/*` called when no phone connected | No session created; existing 503 error path |
| `screencap` fails mid-session | Step still recorded (with `screenshot: null`); editor shows "no frame" placeholder |
| Disk full | Step recorded, screenshot skipped; alert in editor |
| User opens a session whose JPEGs were pruned | Editor renders placeholders; the meta+steps are still intact |
| AI calls `/teach/done` with no active session | 400 `{error: "no active session"}` |
| Two `/android/*` calls in flight when session closes | Late call creates a new session |
| Workflow promote with a name that already exists | Server appends `-2`, `-3`, etc. |

---

## Scope boundaries

### In P1
- Auto-capture per dispatch (`tap`/`swipe`/`key`/`type`)
- Session lifecycle (start/end/cancel)
- `/waitfor-highlight` integration → stuck-point marker
- Storage: `humanaie-sessions/teach-<id>/` and `workflows/<pkg>/<activity>/<slug>.json`
- All endpoints listed above
- 🎓 Teach tab with the two-column landing + horizontal step editor
- Save-as-workflow flow
- 7-day auto-cleanup of unpromoted draft sessions

### Out of P1 (deferred)
- **Auto-anchoring steps to existing highlights** (P2). The `anchor` field is present in the schema but only filled if the user explicitly links it.
- **AI replay of saved workflows** (P3). The `/workflows` API is consumed by the UI in P1, not by AI agents. P3 will add `/workflows?package=&activity=&intent=` matching + a replay engine.
- **Branching / conditional steps** (P4). All P1 workflows are linear.
- **Per-app chat thread** (P4).
- **Export / import / share** (P5).

### Explicitly NOT in P1 (architectural decisions)
- **No subagent coordination layer**. The token-budget rule is a *guideline for agents*, not enforced by the server. Stays cheap and predictable.
- **No screencap on every poll** when not in a teaching session. Capture is only triggered by an actual `/android/*` dispatch — keeps the disk/CPU cost proportional to actual AI activity.

---

## Testing strategy

| Layer | Approach |
|---|---|
| Session lifecycle | `node:test` unit tests with a mocked `adbAsync`. Cover: start-on-first-dispatch, idle timeout, waitfor stuck, manual done/cancel, concurrent calls |
| Endpoints | Smoke tests via `spawn` of `server.js` + `fetch`, as in `tests/android.test.js`. Confirm POST→GET round-trips and JSON shapes |
| Step capture | Unit test that `recordStepInSession` writes the right meta entry given a mock screencap buffer |
| Storage | Test promote-to-workflow copies the right files and adjusts paths in `meta.json` |
| UI | Manual E2E checklist on `.90`: AI agent attempts a task, session appears in Teach tab, click → edit one step → save as workflow → workflow appears in right column |

---

## Risks

1. **Disk usage.** ~200 KB per JPEG × 50 steps/session × N sessions/day. Mitigated by 7-day prune. *Watch this in real use; may need quotas.*
2. **Screencap latency on the dispatch path.** Adds ~150 ms per `/android/tap` to capture the resulting frame. Acceptable for teaching, possibly noticeable for fast AI agents. Could move screencap async + reconcile by timestamp if it bites.
3. **Workflow path conflicts.** Two devices on the same server could write to `workflows/<pkg>/...`. P1 ignores this (single-device assumption). P5 (sharing) revisits.
4. **The h264 stream isn't the screenshot source.** Auto-capture uses dedicated `screencap -p` calls (not the live stream) because we want high-quality stills, not the 540p downscaled MJPEG. This is intentional but doubles ADB load while teaching is active. The `lastFrameTime` pause-the-screencap-loop optimization from `c45ca89` continues to work — teaching screencap is a separate call path.

---

## Open questions (none blocking — resolved with reasonable defaults during design)

- **Should the editor inline-display step screenshots at the streamed 540×1170, or scale up to native 1080×2340?** → Resolved: streamed 540×1170 (smaller, snappier UI; full-res available on click-to-zoom).
- **Should sessions be visible in the Teach tab while still in progress?** → Resolved: yes, with a `🔴 active` indicator. Editor disabled for active sessions; opens read-only-tail view.
- **Multi-device support?** → Single-device for P1. Workflow path includes serial-of-record but UI only shows current device's workflows.

---

## What the user sees, end-to-end

1. AI agent does something on Instagram via HumanAIE
2. After ~30s of working, they open the cam UI and see a new ✕ row in 🎓 Teach: *"AI asked: where is the post button?"*
3. They click it → see step cards for what AI did: opened app ✓, tapped a profile icon ✗ (wrong!), tapped another button ✗ (wrong!), got stuck
4. They rename step 1 to "Open Instagram" and add a dot on step 2's screenshot saying "TIS is the actual post button"
5. They click Save as workflow → name it "Post a photo"
6. Workflow appears in the right column with 5 steps
7. (P3, future) Next time AI is asked to post on Instagram, it fetches this workflow and executes the right taps in order, no exploration

---
