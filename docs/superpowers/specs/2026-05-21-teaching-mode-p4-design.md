# Teaching Mode P4 — AI as Skill Author

**Status:** Design — approved 2026-05-21. Plan to follow via `writing-plans`.
**Date:** 2026-05-21
**Builds on:** v1.5.0 (P3 replay + approval shipped 2026-05-20)
**Tracker:** [project_teaching_mode_roadmap.md](../../../../.claude/projects/-home-rickburp-Projects-HumanAIE/memory/project_teaching_mode_roadmap.md)

---

## Goal

Turn workflows into something an AI agent can browse, propose changes to, and flag for review — like a per-app skill library it co-maintains with the human. After P4, the AI can answer "what skills do I have for Instagram?" in one call, suggest fixes to existing flows when they degrade, and surface "this flow needs your eyes" without blocking its own work.

P3 made workflows consumable. P4 makes workflows **maintainable** with the human staying in the approval seat.

## Why now

P3 shipped the replay/approval loop. Real-world AI use will surface flows that drift (post button moves, app updates change selectors, step coords need amending). Without an edit path, the AI either keeps replaying a broken flow or has to propose an entirely new replacement — both worse than letting it suggest a precise fix the human approves with one click. Per-app grouping in the UI is the prerequisite that makes the growing flow library navigable as it scales past ~10 entries.

## The Loop (post-P4)

```
① AI starts on com.instagram.android       GET /flows/catalog?package=com.instagram.android
                                              │
② Server returns digest of all skills      { skills: [{id, name, intent, success_rate,
                                                       needs_review, ...}, ...] }
                                              │
③ AI matches an intent against the         (existing P3 path: GET /flows?intent=...)
   catalog OR falls back to /flows
                                              │
④ AI replays — replay fails at step 3      POST /workflows/wf-A/flag
   because button moved                      { reason: "step 3 tap missed target — UI moved" }
                                              │ (workflow keeps serving; ⚠ badge in UI)
                                              │
⑤ AI explores, finds new coords, calls     POST /workflows/wf-A/propose-edit
                                             { steps: [...amended...], reason: "..." }
                                              │
⑥ Server creates a sibling workflow         status:"proposed-edit", parent:"wf-A"
   with status proposed-edit                 Original wf-A keeps serving normally
                                              │
⑦ Human opens Flows tab, sees the           Click ✓ → wf-A's steps replaced in place,
   ⚠ flag + 'proposed edit pending'         sibling deleted
   under com.instagram.android section       Click ✕ → sibling deleted, original untouched
                                              │
⑧ Next AI run gets the amended flow         (via /flows or /flows/catalog)
```

---

## Architecture

### Layer split

| Layer | New / changed |
|---|---|
| `teach.js` | New `flagWorkflow(id, reason)`, `proposeWorkflowEdit(id, steps, reason)`, `applyEditToParent(editId)`. New endpoints: `GET /flows/catalog`, `POST /workflows/:id/flag`, `POST /workflows/:id/propose-edit`. Modified: `PATCH /workflows/:id/status` learns to handle `proposed-edit` workflows (approve replaces parent steps + deletes sibling; reject just deletes sibling). |
| `public/cam/index.html` | Flows tab gains per-app grouping (collapsible section per package). Each section shows app name + counts (approved / proposed / proposed-edit / flagged). Row-level UI surfaces ⚠ flag badge with reason on hover. Proposed-edit rows show a step diff (added/changed/removed) so the human can review what's changing before approving. |
| `README.md` | Catalog + propose-edit + flag are added to the AI agent contract section. Cultural rule: "if you replay a flow and it fails, flag it before falling back to exploration so the human knows the flow drifted." |

### File structure

No new files. All changes in `teach.js`, `public/cam/index.html`, `README.md`, `tests/teach.test.js`. Same modules as P3.

---

## Data Model

### Workflow status enum (extended)

P3 had: `proposed`, `approved`, `rejected`.
P4 adds: `proposed-edit`.

```json
{
  "id": "wf-1779...",
  "name": "Post a photo",
  "intent": "post a photo to instagram feed",
  "status": "approved" | "proposed" | "rejected" | "proposed-edit",  // NEW value
  "source_kind": "human-promoted" | "agent-proposed" | "agent-edit", // NEW value for edits
  "parent": "wf-original-..." | null,         // NEW — set only on proposed-edit
  "edit_reason": "post button moved..." | null,  // NEW — AI's explanation
  "flagged": false,                            // NEW — needs_review boolean
  "flag_reason": null,                         // NEW — set with flagged
  "flagged_at": null,                          // NEW — timestamp
  "package": "com.instagram.android",
  "activity": "com.instagram.mainactivity.InstagramMainActivity",
  "screen_w": 1080,
  "screen_h": 2340,
  "steps": [ ... ],
  "created_at": 1779...,
  "updated_at": 1779...,
  "source": "session-<id>",
  "use_count": int,
  "success_count": int,
  "rejected_reason": string | null
}
```

### Backward compatibility

The existing `withDefaults()` helper added by P3 gains four more defaults:

```javascript
parent:          wf.parent          ?? null,
edit_reason:     wf.edit_reason     ?? null,
flagged:         wf.flagged         ?? false,
flag_reason:     wf.flag_reason     ?? null,
flagged_at:      wf.flagged_at      ?? null,
```

P3 workflows on disk load unchanged with `flagged: false, parent: null`. The new `proposed-edit` status value never appears on existing data because only the new `proposeWorkflowEdit()` function writes it.

### Sibling lifecycle (proposed-edit workflows)

A proposed-edit workflow is a real on-disk workflow that lives in the same package/activity directory as its parent, with a unique slug like `<parent-slug>-edit-<ts>`. It is:

- **Not returned by** `GET /flows` (the AI's replay query) — only approved status comes back there by default.
- **Returned by** `GET /workflows?status=proposed-edit` and surfaced in the per-app UI grouping.
- **On approval**: the parent's `steps`, `screen_w`, `screen_h`, `updated_at` are overwritten with the edit's, then the sibling directory is deleted. The parent's id, name, intent, use_count, success_count, history are preserved.
- **On rejection**: the sibling directory is deleted; the parent is untouched.

Only one proposed-edit per parent can exist at a time. A second `POST /workflows/:id/propose-edit` while one is pending returns 409 with a pointer to the existing edit's id.

---

## Endpoints

### New

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/flows/catalog?package=&activity=` | — | `{ package, approved_count, proposed_count, proposed_edit_count, flagged_count, skills: [<skill-row>...] }` |
| `POST` | `/workflows/:id/flag` | `{ reason: string }` | `{ ok: true, workflow }` |
| `POST` | `/workflows/:id/unflag` | — | `{ ok: true, workflow }` — clears flag (human action after fix) |
| `POST` | `/workflows/:id/propose-edit` | `{ steps: [...], edit_reason: string, screen_w?: int, screen_h?: int }` | `{ ok: true, edit_workflow }` or 409 if pending edit exists |

`<skill-row>` shape (catalog item):
```json
{
  "id": "wf-...",
  "name": "Post a photo",
  "intent": "post a photo to feed",
  "activity": "MainActivity",
  "step_count": 8,
  "use_count": 7,
  "success_count": 5,
  "success_rate": 0.714,
  "flagged": false,
  "flag_reason": null,
  "has_pending_edit": false,
  "pending_edit_id": null,
  "updated_at": 1779...
}
```

Skills in the catalog are sorted by `(flagged desc, success_rate desc, updated_at desc)` so the human's attention items float up.

### Modified

| Method | Path | Change |
|---|---|---|
| `PATCH` | `/workflows/:id/status` | When the target workflow has `status === "proposed-edit"`: `approved` triggers `applyEditToParent(id)` (parent's steps replaced, sibling deleted); `rejected` deletes the sibling without touching parent. Other transitions on proposed-edit return 400. |

### Unchanged

`GET /flows`, `GET /workflows`, `POST /teach/sessions/:id/propose`, `POST /teach/sessions/:id/promote` — all unchanged. P3 contract preserved.

---

## UI (Flows tab)

### Per-app grouping

The right column of the Flows landing (currently three sub-sections: Approved / Proposed / Rejected, scoped to current Phone vs Web tab) gains an outer grouping by `package`:

```
📂 Flows · 📱 Phone
┌───────────────────────────────────┐
│ ▼ com.instagram.android (8) ⚠ 2  │  ← app group header, click toggles
│   ✅ Approved (5)                  │
│     ┌──────────────────────────┐  │
│     │ Post a photo  ⚠   (5×)   │  │  ← ⚠ badge = flagged, tooltip shows reason
│     │ Send DM           (12×)  │  │
│     │ Open story        (3×)   │  │
│     └──────────────────────────┘  │
│   🟡 Proposed (1)                  │
│   🟠 Proposed edits (1)           │  ← NEW sub-section
│     ┌──────────────────────────┐  │
│     │ Post a photo (edit)  ✓ ✕ │  │  ← inline approve/reject, click opens diff
│     └──────────────────────────┘  │
│   🗑 Rejected ▶                    │
│                                   │
│ ▼ com.android.chrome (2)          │
│   ✅ Approved (2)                  │
│   ...                             │
└───────────────────────────────────┘
```

App group headers:
- Counts: `(total approved)` and `⚠ <count>` shown only when flagged > 0
- Click toggles expand/collapse (collapsed state remembered in `state.flowsGroupOpen[package]`)
- Apps with all-empty sub-sections are not shown

### Proposed-edit diff view

Clicking a proposed-edit row opens an editor (same modal pattern as the existing workflow editor) showing a step-by-step diff:

```
Parent: "Post a photo" (wf-1779...)
Edit reason: "post button moved to (540, 1200)"

Step 1   tap (340, 200)        ← unchanged
Step 2   tap (450, 800)        ← unchanged
Step 3   tap (540, 1200)       ← CHANGED from (520, 1180)
Step 4   tap (700, 1500)       ← unchanged

[✓ Approve edit]   [✕ Reject edit]   [⏵ Open parent]
```

Approve calls `PATCH /workflows/<edit-id>/status { status: "approved" }` (handler does the merge). The Flows tab reloads showing the parent with updated steps + the edit row removed.

### Flag badge

Approved-row UI gains a ⚠ badge displayed inline with the (N×) counter when `workflow.flagged === true`. Hovering shows the `flag_reason`. Right-click (or long-press on touch) shows an "Unflag" option that calls `POST /workflows/:id/unflag` (used after the human verifies the flow is actually working again).

---

## AI Agent Integration

Three new contract additions in the README's AI agent section (under the existing P3 section):

```markdown
### Skill discovery (P4)

Before exploring a new app, query the catalog:

  GET /flows/catalog?package=com.instagram.android

Returns the full list of skills for that app (approved + proposed-edit + flagged
counts plus per-skill metadata: intent, success_rate, use_count, flagged status).
Use this to scan what's available; use /flows when you need to match a specific
intent.

### Flagging a degraded flow

If you replay a flow and it fails (a tap missed its target, a step landed on
unexpected content, you needed to call /waitfor-highlight mid-replay), flag
the flow so the human knows it drifted:

  POST /workflows/wf-.../flag
  { "reason": "step 3 tap at (520, 1180) missed the post button — got 'home' instead" }

The flow keeps serving but gets a ⚠ badge in the UI. Do this BEFORE trying to
explore your way around the failure — the human seeing the flag is the trigger
for them to either fix the flow themselves or ask you to propose an edit.

### Proposing an edit

If you've identified what's wrong and have a fix, propose an edit instead of
asking the human to make it:

  POST /workflows/wf-.../propose-edit
  {
    "steps": [...amended step array...],
    "edit_reason": "step 3 coord moved from (520, 1180) to (540, 1200) after IG v210 UI change"
  }

The edit lives as a sibling workflow with status:'proposed-edit'. Original
keeps serving until the human approves. After approval, the original's steps
are replaced in-place (id + name + history preserved). Cultural rule: only
propose an edit you've actually verified works — the human reviewing it should
not be the QA gate.

### Cultural rule (P4 amendment)

If you flag a flow more than 3 times for the same reason without proposing an
edit, you're failing the contract. Either propose an edit or call
/waitfor-highlight asking the human for the new coord.
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| AI POSTs propose-edit while a pending edit exists for the same parent | 409 `{ error: "pending edit exists", pending_edit_id: "wf-edit-..." }` |
| AI POSTs propose-edit with empty steps array | 400 `{ error: "steps array required" }` |
| AI POSTs propose-edit referencing non-existent parent | 404 `{ error: "parent not found" }` |
| Human approves a proposed-edit whose parent was deleted mid-flight | 410 `{ error: "parent no longer exists" }`; sibling left in place for human to manually convert if desired |
| AI POSTs /flag with no reason | 400 `{ error: "reason required" }` |
| Multiple AI flags in quick succession on the same flow | Last write wins for `flag_reason`; `flagged_at` updates each time. Not throttled. |
| Catalog query for unknown package | Returns `{ approved_count: 0, ..., skills: [] }` (no 404 — empty catalog is a valid state) |

---

## Testing

### Unit

- `flagWorkflow` sets flagged/flag_reason/flagged_at; round-trips through disk.
- `unflagWorkflow` clears all three fields back to defaults.
- `proposeWorkflowEdit` creates a sibling at `<pkg>/<act>/<parent-slug>-edit-<ts>/` with `status:proposed-edit, source_kind:agent-edit, parent:<id>`.
- `proposeWorkflowEdit` returns 409 when a pending edit already exists for the parent.
- `applyEditToParent` overwrites the parent's `steps`, `screen_w`, `screen_h`, `updated_at`; preserves `id`, `name`, `intent`, `use_count`, `success_count`; deletes the sibling.
- Rejected proposed-edit: PATCH status=rejected deletes the sibling, parent untouched.
- Backward compat: a P3-era workflow.json (no flagged/parent/edit_reason fields) loads with `flagged: false, parent: null, edit_reason: null` defaults.

### Endpoint smoke tests

- `GET /flows/catalog?package=` returns the right counts + skill list shape.
- `POST /workflows/:id/flag` then `GET /flows/catalog` → flagged appears in skill row, sorted to top.
- `POST /workflows/:id/propose-edit` → workflow visible at `GET /workflows?status=proposed-edit`.
- `PATCH /workflows/<edit-id>/status { approved }` → parent's steps changed; edit gone from `GET /workflows`.

### Manual E2E on `.90`

1. Approve one workflow if you don't already have one.
2. From the cam UI, fake the AI by curl: `POST /workflows/<id>/flag { reason: "drift test" }` → reload Flows tab → ⚠ badge appears with hover reason.
3. Curl: `POST /workflows/<id>/propose-edit { steps: [...modified...], edit_reason: "step 1 moved" }` → reload Flows tab → 🟠 Proposed edits sub-section appears under the app group with the edit row.
4. Click the edit row → diff view shows changed step highlighted.
5. Click ✓ Approve edit → parent's steps now match the edit; edit row gone; ⚠ badge cleared if your edit handler also calls unflag (it should).
6. Repeat with reject path → edit row disappears, parent unchanged.

---

## Scope Boundaries

### In P4

- `GET /flows/catalog` endpoint
- `POST /workflows/:id/flag` + `/unflag` endpoints
- `POST /workflows/:id/propose-edit` endpoint
- `proposed-edit` status value + sibling lifecycle + apply-on-approve behavior
- Backward-compat read defaults for new fields
- Flows tab per-app grouping with collapsible sections
- Flagged ⚠ badge with hover reason
- Proposed-edit diff view in the editor modal
- README AI agent contract additions
- One-edit-per-parent invariant (409 on conflict)

### Out of P4 (deferred)

- **Multi-edit branching** — only one proposed-edit per parent. An "alternate version" workflow (e.g., "Post a photo (landscape variant)") is a separate proposed flow via /teach/sessions/:id/propose, not an edit.
- **Edit history / undo** — once an edit is approved and merged into the parent, the previous step array is gone. No git-style history view.
- **AI-side auto-edit-on-failure** — the AI's decision logic for when to flag vs edit vs /waitfor is documented in README but not server-enforced.
- **Per-app skill sharing/export** — workflows stay local to this server's disk.
- **Vision-based step matching** — flag/edit still relies on the AI's own determination of "this flow is broken." No automated drift detection.
- **Web flows** — the existing Phone/Web sub-tab gains the per-app grouping treatment for Phone only. Web flows infrastructure still doesn't exist (separate phase).

---

## Risks

1. **Pending-edit blocking** — only one proposed-edit per parent. If the AI proposes an edit, then later finds a BETTER edit before the human reviews, it can't propose the second one. Mitigation: it should call `DELETE /workflows/<edit-id>` (existing endpoint) on its own pending edit first, then re-propose. Document in the README contract.
2. **Diff readability** — step diffs of long workflows (10+ steps) get hard to scan visually. Mitigation in P4: only show the changed steps prominently, collapse unchanged runs (`... 3 unchanged steps ...`). Spec keeps this loose; UI task can refine.
3. **AI flagging without proposing** — if the AI flags but never proposes a fix, the flag pile grows. README's "cultural rule" addresses it, but isn't enforced. If this turns into a real problem, P5 could add a "flagged for >7 days with no proposed edit" surfacing in the Flows tab.
4. **Approval-merges-blindly** — approving a proposed-edit overwrites the parent's steps without showing the human EVERY change. The diff view in the editor modal is the mitigation, but a human who clicks ✓ without reading can ship a bad edit. This is the trust trade-off for "user picked option 2" in the brainstorm — keep the diff visible and the click deliberate.

---

## Open Questions (resolved with reasonable defaults during design)

- **Should the diff view require the human to scroll through every step before the Approve button enables?** No — too friction-heavy. The diff is visible; if the human approves without reading, that's their call.
- **Should `/flag` increment a counter (flag_count) so we can show "flagged 7 times by AI"?** Not in P4. Single `flagged: bool` + `flag_reason` is enough signal. If patterns matter later, add it.
- **Should `flagged: true` workflows be excluded from `/flows` responses?** No — flagged flows are degraded, not broken, and still serve traffic. The flag is a hint for the human. An AI that wants to avoid flagged flows can filter via `/flows/catalog` then call `/flows` only for unflagged matches.
- **Pending-edit catalog row shape — show only parent, only edit, or both?** Parent row with `has_pending_edit: true, pending_edit_id: "wf-..."`. The edit isn't a separate skill; it's a proposed amendment.

---

## What ships at end of P4

Open 📂 Flows on `.90`, see workflows grouped by app: Instagram has 5 approved skills (one with a ⚠ badge from the AI flagging a missed-tap), Chrome has 2, WhatsApp has 4. Under Instagram, a 🟠 Proposed edits (1) sub-section shows the AI's amendment to "Post a photo". Click the edit row, see a diff with one changed step coord and the AI's reason. Click ✓ — parent's step 3 updates in place, edit row vanishes, ⚠ clears.

The AI's loop: query `/flows/catalog?package=com.instagram.android` once on session start, scan available skills, replay the matching one, flag if it fails mid-replay, propose an edit if it figures out the fix on its own. The human is asked to act only when the human is genuinely needed.

Result: workflows become a co-maintained skill library that gets better over time without you having to babysit every drift fix.
