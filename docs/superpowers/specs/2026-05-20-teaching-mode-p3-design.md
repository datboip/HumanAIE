# Teaching Mode P3 — Replay + Approval

**Status:** Design — approved 2026-05-20, plan to follow via `writing-plans`.
**Date:** 2026-05-20
**Builds on:** v1.4.0 (Teaching Mode P1 shipped 2026-05-19)
**Tracker:** [project_teaching_mode_roadmap.md](../../../../.claude/projects/-home-rickburp-Projects-HumanAIE/memory/project_teaching_mode_roadmap.md)

---

## Goal

Close the Teaching Mode learning loop. P1 captured AI activity and let humans curate captured sessions into named workflows. P3 makes those workflows **actually consulted** before the AI acts, with an approval gate so only human-blessed flows become canonical.

After P3, the "AI takes 30 minutes to post on Instagram every time" problem is solved: the AI fetches the approved flow first, executes its steps surgically, and only falls back to exploration when no matching flow exists.

## Why now

P1 shipped the capture half. The user reviewed it and asked "how does this actually help me — the AI still re-explores every time." That's exactly right: until P3, captured workflows are inert data. P3 turns them into behavior.

---

## The Loop (post-P3)

```
① AI about to do a task              GET /flows?package=com.instagram.android
                                          &intent=post%20a%20photo
                                         │
② Server fuzzy-matches               { workflow: { steps:[...] }, confidence: 0.9 }
   against approved workflows           OR { workflow: null } (no match → explore)
                                         │
③ AI executes the plan:               POST /android/tap { x, y, replay_of:"wf-..." }
   step-by-step                         POST /android/swipe { ..., replay_of:"wf-..." }
                                          ...
                                         │
④ AI calls /teach/done on success     server increments wf.success_count
   or /waitfor-highlight if stuck      (same lifecycle as P1)
                                         │
⑤ If AI explored (no matching flow):  POST /teach/sessions/:id/propose
   on success, auto-proposes              { name, intent }
                                          → workflow.status = "proposed"
                                         │
⑥ Human reviews "Proposed" column      PATCH /workflows/:id/status
   in 📂 Flows tab → ✓ Approve            { status: "approved" }
   or ✕ Reject                            → next AI query gets this flow back
```

---

## Architecture

### Layer split

| Layer | New | Touched |
|---|---|---|
| `teach.js` | `matchIntent(workflow, queryIntent) → 0..1`, the `/flows` query endpoint, `POST /teach/sessions/:id/propose`, `PATCH /workflows/:id/status` | Existing workflow read/write path gets `status`, `intent`, `source_kind`, `success_count`, `rejected_reason` defaults on load |
| `android.js` | Recognize `replay_of` in tap/swipe body and forward to `teach.captureStep` so sessions record their replay source | No dispatch behavior change |
| `public/cam/index.html` (Flows tab) | Three-section workflows column: 🟡 Proposed (with ✓/✕ buttons), ✅ Approved, 🗑 Rejected (collapsed). Status badge on each row. Editor for proposed shows the source session steps and approve/reject buttons. | No new tab; same `📂 Flows` UI from P1 |
| `README.md` | New "AI agent integration" section telling agents to call `/flows` first and `/teach/sessions/:id/propose` on success-without-match | — |

### File structure

| File | Disposition |
|---|---|
| `teach.js` | **Modify** — add status/intent/source_kind fields throughout, new endpoints, matchIntent |
| `tests/teach.test.js` | **Modify** — unit tests for matchIntent, smoke tests for new endpoints, P1 backward-compat test |
| `android.js` | **Modify** — pass `replay_of` from body into `captureStep` metadata |
| `public/cam/index.html` | **Modify** — three-section workflows column + approve/reject UI |
| `README.md` | **Modify** — AI agent integration guidance |

No new files. No new dependencies. No new on-disk storage paths (status lives inside the existing `workflow.json`).

---

## Data Model

### Updated `workflow.json` schema

```json
{
  "id":            "wf-1779...",
  "name":          "Post a photo",
  "intent":        "post a photo to instagram feed",     // NEW
  "status":        "approved",                            // NEW: proposed|approved|rejected
  "source_kind":   "human-promoted" | "agent-proposed",   // NEW
  "package":       "com.instagram.android",
  "activity":      "com.instagram.android.MainActivity",
  "screen_w":      1080,
  "screen_h":      2340,
  "steps":         [ ... ],                               // unchanged from P1
  "created_at":    1779...,
  "updated_at":    1779...,
  "source":        "session-<id>",
  "use_count":     int,                                   // existing — bumped per replay attempt
  "success_count": int,                                   // NEW — bumped per /teach/done after replay
  "rejected_reason": string | null                        // NEW
}
```

### Backward compatibility

A P1 workflow.json may not have `status`, `intent`, `source_kind`, `success_count`, or `rejected_reason`. The read path (`readWorkflow`, `listWorkflows`) defaults missing fields:

```javascript
status:        wf.status        ?? 'approved',     // existing P1 workflows are implicitly approved (human clicked Save)
intent:        wf.intent        ?? wf.name ?? '',  // fall back to name as intent text
source_kind:   wf.source_kind   ?? 'human-promoted',
success_count: wf.success_count ?? 0,
rejected_reason: wf.rejected_reason ?? null,
```

Migration is read-time, lazy. The first PATCH or rewrite of a workflow persists the new fields to disk. No batch migration job.

### Session metadata gets `replay_of`

The existing P1 session `meta.json` gains an optional field:

```json
{ ..., "replay_of": "wf-..." | null }
```

Populated by `teach.captureStep` when the `replay_of` arg is supplied (which `/android/tap` and `/android/swipe` forward from the request body).

---

## Endpoints

### New

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/flows?package=&activity=&intent=&min_status=approved` | — | `{workflow: <obj>\|null, confidence: 0..1, reason?: string}` |
| `POST` | `/teach/sessions/:id/propose` | `{name, intent}` | `{ok: true, workflow}` — like `/promote` but writes `status:"proposed", source_kind:"agent-proposed"` |
| `PATCH` | `/workflows/:id/status` | `{status, rejected_reason?}` | `{ok: true, workflow}` — `status` must be `proposed`/`approved`/`rejected` |

### Modified (existing P1 endpoints)

| Method | Path | Change |
|---|---|---|
| `GET` | `/workflows?package=&activity=&status=` | Adds optional `status` filter. Default unfiltered (returns all). |
| `POST` | `/teach/sessions/:id/promote` | Behavior unchanged. Writes `status:"approved", source_kind:"human-promoted"` (the existing semantic — human explicitly clicked Save). |
| `POST` | `/android/tap`, `/android/swipe` | Accept optional `replay_of: <workflow-id>` in body. Forward to `teach.captureStep` so the session links back to the source workflow. |

### Match algorithm (`/flows`)

```javascript
function matchIntent(workflow, queryIntent) {
  if (!queryIntent) return 0.5;
  const text = ((workflow.name || '') + ' ' + (workflow.intent || '')).toLowerCase();
  const q = queryIntent.toLowerCase();
  if (text.includes(q)) return 0.9;
  const tokens = q.split(/\W+/).filter(t => t.length >= 3);
  if (tokens.length === 0) return 0.4;
  const hits = tokens.filter(t => text.includes(t)).length;
  return hits / tokens.length;
}

// /flows handler
function flowsHandler(query) {
  const candidates = listWorkflows({ package: query.package })
    .filter(w => (w.status || 'approved') === (query.min_status || 'approved'))
    .filter(w => !query.activity || w.activity === query.activity);
  if (candidates.length === 0) return { workflow: null, reason: 'no candidates' };
  const ranked = candidates.map(w => ({ w, score: matchIntent(w, query.intent) }))
                           .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (best.score < 0.4) return { workflow: null, reason: 'low confidence', confidence: best.score };
  return { workflow: best.w, confidence: best.score };
}
```

Threshold `0.4` chosen so single-token intent matches squeak through (e.g., intent "post" matches a flow named "Post a photo" via the substring path = 0.9; a flow named "Send DM" with no overlap would score 0.0 and be rejected).

---

## UI (📂 Flows tab)

The right-hand workflows column splits into three sub-sections, each collapsible. Visual treatment:

```
┌─────────────────────────────┐  ┌─────────────────────────────┐
│ Recent attempts             │  │ Approved flows              │
│ (unchanged from P1)         │  │ (what AI references)        │
│ ✓ session-...               │  │ ✅ Post a photo  (5×)        │
│ ✕ session-...               │  │ ✅ Send DM       (12×)       │
│ ⏱ session-...               │  │                              │
│                             │  │ 🟡 Proposed (review)   ▶    │
│                             │  │ [Open story]  [✓] [✕]       │
│                             │  │ [Save reel]   [✓] [✕]       │
│                             │  │                              │
│                             │  │ 🗑 Rejected             ▶    │
│                             │  │ (collapsed by default)       │
└─────────────────────────────┘  └─────────────────────────────┘
```

- **Proposed row**: name + inline `[✓ Approve]` `[✕ Reject]` buttons. Click ✓ → PATCH status:"approved", row moves to Approved section. Click ✕ → prompt for optional reason, PATCH status:"rejected", row moves to Rejected.
- **Approved row**: name + `(N×)` usage counter (success_count). Click → opens editor for inspection/edit (same as P1).
- **Rejected row**: collapsed section. When expanded, each row has a `[Un-reject]` button that re-proposes the workflow.

Status badge on each row matches the section icon: 🟡 / ✅ / 🗑.

---

## AI Agent Integration

A new section in `README.md` documenting the contract:

```markdown
## AI Agents using HumanAIE for phone control

Before performing a multi-step task on a connected phone, query for an approved flow:

  GET /flows?package=com.instagram.android&intent=post%20a%20photo

If a flow comes back (workflow + confidence ≥ 0.4), execute its steps in order
via /android/tap or /android/swipe, passing replay_of:<workflow.id> in each
request body so the captured session links back. Call /teach/done when the task
completes successfully.

If no flow comes back, explore the app normally. When you finish successfully,
auto-propose your session:

  POST /teach/sessions/:id/propose
  { "name": "Post a photo", "intent": "post a photo to instagram feed" }

The session becomes a "proposed" workflow that the human can approve, after
which subsequent AI runs will pick it up via /flows.

If you get stuck mid-replay or mid-exploration, call /waitfor-highlight with
a question. The human's resolution is captured as part of the session.
```

This is human-readable guidance, not code-enforced. Agents that ignore the contract still get correct behavior — they just won't benefit from learning.

---

## Error Handling

| Scenario | Behavior |
|---|---|
| No matching workflow for `(package, intent)` | `GET /flows` → `{workflow: null, reason: "no candidates"}`. AI explores. |
| Match confidence below 0.4 | `GET /flows` → `{workflow: null, reason: "low confidence", confidence: 0.31}`. AI explores. |
| Approved flow exists but `screen_w/h` mismatch | Returned anyway with `warning: "screen-dim-mismatch"`. AI decides whether to replay (likely won't on major mismatch). |
| AI POSTs `/android/tap` with `replay_of` referencing a non-existent workflow | Tap still dispatched (don't break dispatch on metadata issues). Session's `replay_of` field is set to whatever the AI passed — server doesn't validate workflow existence on the hot path. |
| Human approves a zero-step workflow | Allowed. Replay is a no-op. Edge case, not blocking. |
| PATCH `/workflows/:id/status` with invalid status | 400 `{error: "status must be proposed/approved/rejected"}`. |
| Two flows match same intent equally well | Higher `success_count` wins tiebreaker; if also tied, most recently `updated_at` wins. |
| Workflow promoted, then phone changes (new app version with different layout) | The flow's step coords are still served. AI may fail mid-replay, calls /waitfor, human can amend the flow or reject it. No automatic invalidation in P3. |

---

## Testing

### Unit

- `matchIntent`: package-only (no intent) → 0.5; substring match → 0.9; partial token match → fraction; empty/no overlap → 0.0 → 0.4 floor; case insensitive.
- `readWorkflow` backward compat: load a P1-style workflow.json (no status field), confirm `status === 'approved'` and `success_count === 0` on the in-memory shape.

### Endpoint smoke tests (spawn server, `fetch`)

- `POST /teach/sessions/:id/propose` → workflow created with `status:"proposed"`, `source_kind:"agent-proposed"`.
- `PATCH /workflows/:id/status {status:"approved"}` → status updated; subsequent `GET /workflows/:id` reflects it.
- `GET /flows?package=&intent=` → returns `null` when no candidates, returns workflow when one matches above threshold.
- `GET /flows?min_status=proposed` → returns proposed flows (used by Flows tab UI to populate the proposed column).
- `POST /android/tap {x,y,replay_of:"wf-xyz"}` → session's `meta.json` has `replay_of:"wf-xyz"`.

### Manual E2E on `.90`

1. AI agent (or curl-based script) GET /flows for an unfamiliar app → null
2. Drive a successful session manually
3. AI script POST /teach/sessions/:id/propose → flow appears in 🟡 Proposed
4. Human clicks ✓ Approve → moves to ✅ Approved
5. AI agent GET /flows again → now gets the workflow back
6. AI runs through the steps via /android/tap with `replay_of`
7. AI calls /teach/done → success_count increments
8. Verify in Flows tab the (5×) counter on the row

---

## Scope Boundaries

### In P3

- Status field (proposed/approved/rejected) on workflows
- `intent` field + fuzzy matcher
- `GET /flows` query endpoint
- `POST /teach/sessions/:id/propose` (AI-driven auto-propose)
- `PATCH /workflows/:id/status` (human approval action)
- Backward-compat read defaults for P1 workflows
- `replay_of` field forwarding through `/android/{tap,swipe}` into session metadata
- Flows tab three-section UI (Approved / Proposed / Rejected)
- README section: AI agent integration guidance
- `success_count` tracking on /teach/done after replay

### Out of P3 (deferred)

- **P4 — branching/conditional steps:** all P3 workflows are linear sequences.
- **P4 — per-app teaching chat:** human ↔ AI dialog thread attached to each (package, activity). Useful for nuance ("on this app, always tap the second post button"). Big enough to be its own phase.
- **Vision-based matching:** compare step-0 screenshot against current phone screen for high-fidelity match. Significant infrastructure; current intent-string match is the cheaper 80% solution.
- **Auto-rollback / undo:** if mid-replay an AI tap lands somewhere unexpected, no automatic recovery. AI agent decides when to abort via /waitfor.
- **Workflow versioning:** edits PATCH in place. No history. (If user wants undo, they can manually duplicate-then-edit.)
- **Sharing / export:** P5 territory. Workflow.json is portable but no curated export flow.

---

## Risks

1. **Intent-string discoverability.** Agents need to phrase intent in a way that overlaps with stored flow names. Examples in the README cover common shapes. If matching fails systematically, we'd add a vision fallback in a P3.5 follow-up — not in this scope.
2. **Approval bottleneck.** If AI proposes many flows and the human doesn't review them, the Proposed column piles up. Mitigation: each session that triggers /waitfor is auto-marked as stuck-and-fixed-by-human (already in P1), so the human is presumed to have already engaged. Proposals lacking human attention rot in the Proposed list until pruned — same 7-day cleanup as P1 sessions can apply (not implementing in P3, noted as future polish).
3. **Replay drift.** A flow's stored coords reflect the phone screen at capture time. If the app updates and a button moves, replay fires the tap at the old location. Detection: AI's next /waitfor-highlight tells the human "this used to be the post button — where is it now?" The human's resolution amends the flow. Manual loop; sufficient for v1.
4. **`replay_of` metadata leakage to non-replay calls.** The cam UI's own pointerup handler doesn't pass `replay_of`, so human-driven taps continue to log without a replay marker. AI agents that forget to pass `replay_of` just lose the linkage — no crash. Low blast radius.

---

## Open Questions (resolved with reasonable defaults during design)

- **Should /flows return the top match or top N?** Top match for v1. Multiple matches with similar confidence would just shift the disambiguation burden to the AI; cleaner to make the server pick. If this proves limiting we'll add `?limit=N` later.
- **Default `min_status` for /flows?** `approved`. Surfacing proposed flows in replay queries would let unvetted AI behavior compound on itself.
- **Confidence threshold 0.4 — magic number?** Yes. Tuned around the observation that single-token intent matches via substring score 0.9, while partial token coverage drops fast. Worth revisiting after a week of real use.
- **What if AI proposes the same flow twice?** Dedup by name (slug collision) — second proposal becomes `name-2`. P1's slug-dedup handles this. We could instead detect "same steps array" and reuse; left as later optimization.

---

## What ships at end of P3

The user opens 📂 Flows on `.90`, sees an "Approved" column populated by their previous P1 work, plus a "Proposed (review)" column where AI agents are dropping new candidates. They click ✓ on the ones that look right. Next time the AI tries the same task, it consults `/flows`, gets back the approved plan, and executes it in one shot.

Concretely: "Post on Instagram" goes from "AI explores for 30 minutes" → "AI fetches the approved flow + executes 8 steps in ~10 seconds." That's the headline outcome the entire Teaching Mode roadmap was built for.
