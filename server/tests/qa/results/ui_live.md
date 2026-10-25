# UI (browser) checks and live AI smoke test

Run 25 Oct 2026. UI checks used a separate copy of the app (API on :4100 with schema `qa_ui`, frontend on :5174), seeded with the §2 baseline by `tests/qa/ui_seed.mjs` — never the real data. Driven in Chrome (no Playwright installed). Live AI used the real Gemini key against the local dev server (read-only questions; smart leave saves nothing).

## UI checks

| ID | Status | Evidence | Notes |
|---|---|---|---|
| M1-01 | FAIL → fixed | Signed in through the login form as Ali | Landed on "404 — Page not found" at `/login`. Fixed in `client/src/App.jsx` (signed-in `/login` and `/setup` redirect to `/dashboard`); re-test lands on the employee dashboard |
| M1-05 | PASS | Sign out, then browser Back | Token removed from storage (only `theme` remains); Back shows the sign-in page, no app data |
| M1-21 | PASS (after fix) | Menus read for A, H, E | Each role sees only its items. HR lacked "My profile" (HR can edit own phone/address) — added in `client/src/layout.jsx` |
| M1-22 | PASS | E opened `/users`, `/audit`, `/settings`, `/payroll`, `/employees`, `/ai-logs` | Each shows "403 — Not allowed", no data rendered |
| M1-23 | PASS | Reload on `/leave` | Still signed in on the same page |
| M3-15 | PASS | HR searched "zzz-nobody" | "No employees match these filters" |
| M9-06 / X-09 | PASS | Announcement with `<script>` and `<img onerror>` | Shown as literal text; 0 injected `script`/`img` elements; 0 alerts fired |
| X-01 | PASS | 12 pages in a 375 px frame | `scrollWidth` = 375 on every page (no horizontal scroll) |
| X-02 | PASS | API stopped, dashboard opened | "Cannot reach the server" with a "Try again" button (not blank) |
| B-18 | PASS | Toggled theme, reloaded | Choice persisted (`localStorage.theme`) and applied before first paint |
| M7-21 | MANUAL | — | Hover tooltips on charts: a human should hover bars/lines on the HR and Admin dashboards |
| X-03..X-07 | MANUAL | — | Form feedback, double-submit (buttons disable while pending), refresh mid-flow, Urdu text in PDF, message tone |
| B-07 | MANUAL | — | Deny camera then location permission on `/attendance/camera` |
| B-11 (photo) | MANUAL | — | Hold a photo to the camera: blink check should never pass |
| B-19 | MANUAL | — | Service worker registers only in the production build: `npm run build && npx vite preview`, then install + go offline |

## Live AI smoke (real key)

| ID | Status | Evidence | Notes |
|---|---|---|---|
| M8-01 | PASS | HR: "How many active employees are in Engineering?" → tool `get_headcount`, answer 2 = dashboard (Engineering filter) | 4.2 s |
| M8-08 | PASS | E: sick leaves left → `get_my_leave_balance`, 8 = `/leave/balance` | 3.6 s |
| M8-09 | PASS | E: "What is Hina HR's salary?" → "Sorry, I can only share your own information.", no tool called | 2.1 s |
| M8-28 | PASS (numbers) | E: "Need next Monday and Tuesday off for a wedding" → `draft_leave_request` CASUAL 2026-10-26 → 2026-10-27, 2 working days | Answer was in Roman Urdu for an English question — bug LIVE-1 |
| M8-38 | PASS (content) | "What time does the office start?" → 09:00, late after 09:15 | Answer in Hindi (Devanagari) for an English question — bug LIVE-1 |
| B-16 | PASS | "Aaj kaun chutti par hai?" → `get_leave_summary`, Roman Urdu answer | 3.2 s |
| B-17 | PASS | Smart leave "Mujhe agle Monday aur Tuesday ki chutti chahiye shadi ke liye" → CASUAL 26–27 Oct, 2 days | 3.3 s |

All answers carried `aiGenerated: true`.

## Bugs

| # | Title | IDs | Severity | Status |
|---|---|---|---|---|
| UI-1 | Signing in from `/login` shows a 404 page | M1-01 | High | Fixed (`client/src/App.jsx`) |
| UI-2 | HR menu has no "My profile" link | M1-21, M3-08 | Low | Fixed (`client/src/layout.jsx`) |
| LIVE-1 | Assistant sometimes replies in Roman Urdu or Hindi to English questions | M8-28, M8-38 | Medium | See QA_REPORT.md |
