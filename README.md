# HCM Lite — AI-assisted Human Capital Management

Saylani Hackathon · 24 October 2026 · Web app for **Admin, HR and Employees** with attendance, leave, payroll, dashboards and an AI assistant that answers only from real data.

The system **starts empty** — there is no seed or dummy data. A fresh install opens the first-run setup; Admin creates the company, HR registers employees, and every number on every dashboard comes from what people do in the app.

| | |
|---|---|
| Live app | _add hosted frontend URL_ |
| API | _add hosted backend URL_ (`/api/health`) |
| Requirements & design | [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) |

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite, React Router, TanStack Query, Tailwind CSS 4, Recharts, sonner, lucide-react, face-api.js (`@vladmandic/face-api`) |
| Backend | Node.js (≥ 20) + Express 5, zod validation, JWT (`jsonwebtoken`), bcrypt (`bcryptjs`), helmet, CORS, rate limiting, pdfkit (payslip PDF), csv-parse/csv-stringify, multer, geolib (Haversine) |
| Database | Supabase **Postgres** used as a plain Postgres database through `pg` (SQL schema in `server/sql/`). The browser never talks to Supabase; Row Level Security is enabled with no public policies. |
| AI | Google Gemini (`gemini-3.5-flash-lite`, fallback `gemini-3.1-flash-lite`) through the OpenAI-compatible chat-completions API with **tool calling**. Any OpenAI-compatible provider works (e.g. Groq) by changing three env vars. |
| Tests | Vitest + supertest (52 tests: business rules + API/RBAC/AI guardrails) |

```
.
├─ client/          React web app (role-based menus, dashboards, AI chat, camera check-in, PWA)
├─ server/
│  ├─ sql/          01_schema.sql — tables, constraints, triggers, fn_daily_status(), RLS
│  ├─ scripts/      dbSetup.js (apply schema), schema.js
│  ├─ src/
│  │  ├─ config/    env validation
│  │  ├─ lib/       db, audit, notify, time, pdf, rules/ (attendance, leave calendar, payroll, tax)
│  │  ├─ middleware/ authenticate, password gate, requireRole, validate, errorHandler
│  │  └─ modules/   auth, org, employees, attendance, leave, payroll, analytics, comms, ai/
│  └─ tests/        rules.test.js, api.test.js
├─ docs/REQUIREMENTS.md
└─ render.yaml      backend blueprint (client/vercel.json for the frontend)
```

## Run it locally (≈ 5 minutes)

Prerequisites: **Node.js 20+** and a **Postgres database** (a free Supabase project is enough).

```bash
# 1. Backend
cd server
cp .env.example .env          # then fill in DATABASE_URL, JWT_SECRET and AI_API_KEY (see below)
npm install
npm run db:setup              # creates all tables, triggers and SQL functions (safe to re-run)
npm run dev                   # API on http://localhost:4000/api

# 2. Frontend (new terminal)
cd client
cp .env.example .env          # VITE_API_URL=http://localhost:4000/api
npm install
npm run dev                   # open http://localhost:5173
```

### Database connection (Supabase)
In Supabase click **Connect → Method: Session pooler** and copy the URI into `DATABASE_URL`, replacing `[YOUR-PASSWORD]`. URL-encode special characters in the password (for example `+` becomes `%2B`). Use the **pooler** host (`aws-0-<region>.pooler.supabase.com`): the direct `db.<ref>.supabase.co` host is IPv6-only and does not work from many networks or from Render.

### How to create the first Admin
Either:
- **Setup wizard (default):** open the app — a fresh install shows *Welcome to HCM Lite*. Enter the company name, office hours, grace time, weekend and the Admin's name, email and password. You are signed in as Admin. The wizard can never run again (`409 SETUP_ALREADY_DONE`).
- **From env:** set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `server/.env` before the first start. The Admin account is created on boot; the wizard then only asks for company details and you sign in with those credentials.

Then, as Admin: *Organization* → add departments and click **Add standard types** (Annual 14, Sick 8, Casual 10, Unpaid), optionally holidays; *Company settings* → office location and radius; *Users & logins* → **Create HR login**. HR registers employees from *Employees → Add employee* (or CSV import). Every new login gets a **temporary password shown once**, which must be changed at first sign-in.

### How to set the AI key
In `server/.env`:
```
AI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
AI_MODEL=gemini-3.5-flash-lite
AI_FALLBACK_MODEL=gemini-3.1-flash-lite
AI_REASONING_EFFORT=low
AI_API_KEY=<your Google AI Studio key>
```
The key lives **only** in the backend environment; the browser only calls our `/api/ai/*` endpoints. For Groq instead: `AI_BASE_URL=https://api.groq.com/openai/v1`, `AI_MODEL=llama-3.3-70b-versatile`, `AI_FALLBACK_MODEL=`, `AI_REASONING_EFFORT=`. Without a key the app still works and the AI features show a friendly fallback.

### Useful scripts (server)
| Command | What it does |
|---|---|
| `npm run db:setup` | Create / upgrade the schema (idempotent; runs on every deploy) |
| `npm run db:reset` | **Drops all HCM Lite tables and data** and recreates them empty — use to start judging from a fresh install |
| `npm test` | 18 rule tests + 34 API tests. API tests use a throwaway `hcm_test` schema in the same database, never your data |

### Deploying
- **Backend (Render):** `render.yaml` blueprint — root `server`, build `npm ci && npm run db:setup`, start `npm start`. Set `DATABASE_URL`, `AI_API_KEY`, `CLIENT_ORIGIN` (your frontend URL) in the Render dashboard.
- **Frontend (Vercel):** root `client`, framework Vite, env `VITE_API_URL=https://<backend>/api`. `client/vercel.json` rewrites routes to the SPA.
- Only `.env.example` files are committed; real secrets stay in the hosting provider's environment settings.

---

## Roles and access

Access is checked **on the server for every request** (role + data scope); the AI assistant runs with the same access as the user.

| | Admin | HR | Employee |
|---|---|---|---|
| Company setup, settings, office location, departments, leave types, holidays | Manage | View | — |
| Create HR logins, deactivate / reset any login | Manage | — | — |
| Register & edit employees, CSV import/export, salary structures | View | Manage | Own phone & address |
| Attendance board & calendars | All | All | Own |
| Check in / out, corrections, leave requests | — | Own (+ approve others) | Own |
| Approve leave & corrections | View | Approve (never their own) | — |
| Payroll draft / finalize | View / **Finalize (locks)** | Create & review | — |
| Payslips (PDF) | All | All | Own, finalized only |
| Dashboards | Company | HR | Personal |
| AI assistant | All data | HR data | Own data + policy |
| Announcements | Post | Post | Read |
| Audit log, AI logs | View | — | — |

## Business rules implemented
- **Attendance:** server stamps the time; one record per employee per day (second check-in → **409**); late after office start + grace (09:15:00 on time, 09:15:01 late); half day if worked < 5 h; absent = working day with no record and no approved leave; missing checkout = checked in, never checked out. Settings apply to **new records only** (each record stores a rule snapshot).
- **Leave:** working days only (weekends + public holidays skipped); quotas Annual 14, Sick 8, Casual 10, Unpaid unlimited; overlap or over-balance → **422**; balance is computed, so cancelling restores it.
- **Payroll:** gross = 1.5 × basic (HRA 40 %, medical 10 %); per day = gross ÷ working days; deductions = absent + unpaid + 0.5 × half days (+ optional late penalty: 3 lates = 0.5 day); joiners/leavers prorated; tax slab on gross × 12 (0 → 600k; 5 % to 1.2M; 30k + 15 % to 2.4M; 210k + 25 % to 3.6M; 510k + 35 % above), monthly = yearly ÷ 12. HR drafts, **only Admin finalizes**; finalized runs are locked by the API (**423**) and by a database trigger.
- **Dashboards:** every number is a SQL aggregation on the server, filterable by date range and department. One SQL function, `fn_daily_status()`, decides each employee-day's status and is shared by the attendance board, calendar, dashboards, payroll and AI tools — so AI answers match the dashboards.
- **Audit:** every create / update / approve / finalize / login records actor, action, entity and before/after JSON. The table is **append-only** (database trigger blocks update/delete).

## AI assistant (M8)
- `POST /api/ai/chat` — the model chooses from role-allowed tools: `get_headcount`, `get_attendance_summary`, `get_late_comers`, `get_leave_summary`, `get_my_leave_balance`, `get_payroll_summary`, `search_employees` (+ `draft_leave_request`, which only prepares a form). Tools call the same services as the REST API; employee tools are forced to the caller's own `employee_id`, and tools a role may not use are never sent to the model.
- **Dashboard summary** (Admin/HR): the server builds the KPI JSON for the current filters; the model returns 3–5 bullets using only those numbers.
- **Smart leave:** "I need next Monday and Tuesday off for my sister's wedding" → validated `{type, start, end, reason}` → pre-filled leave form the user confirms. The AI never saves data.
- **Policy Q&A** from the business rules in the system prompt; otherwise "I don't know".
- **Guardrails:** key server-only; JSON validated, retry once, then fallback to the normal form; 15 s timeout with a friendly message; 20 requests per user per hour (429); every call logged in `ai_logs` (Admin → *AI logs*); answers labelled **AI-generated**; understands and replies in Roman Urdu.

## Demo script (5 minutes)
1. Fresh install → setup wizard (company + Admin) → Organization: department + standard leave types → Company settings: office location → Users: create HR login.
2. HR signs in (changes temporary password) → Employees → Add employee ×2 (CSV dry-run optional).
3. Employee signs in, changes password, **Check in** on the dashboard → Assistant: "I need next Monday and Tuesday off for my sister's wedding" → confirm pre-filled form.
4. HR → Leave approvals → approve → HR dashboard → **Summarize** → ask "Who is on leave on Monday?" → Payroll → Run payroll for the month.
5. Admin → Payroll → **Finalize** → Employee downloads the payslip PDF and asks "What is <colleague>'s salary?" (politely refused) → Admin shows the **Audit log**.

## What is done
All 25 functionalities of the brief's checklist (§8), all business rules (§3), all metrics and the three dashboards (§7), the AI assistant with tools, dashboard summary, smart leave and policy Q&A (§4), and the guardrails.

**Bonus:** camera check-in in the web app (face-api.js face detection — exactly one face; GPS accuracy ≤ 100 m; Haversine distance to the office checked on the server; only the result is stored, never a photo; failures fall back to an HR correction) · face match against an enrolled 128-number face descriptor + blink liveness (Admin toggle) · attrition risk score · absence anomaly flags · late penalty rule (Admin toggle) · Roman Urdu · dark mode · PWA (manifest + service worker).

## What is not done / known limitations
- No native mobile app (camera check-in runs in the mobile browser instead).
- No email/SMS delivery: temporary passwords are shown once on screen (and in the CSV import credentials file).
- Single company per installation; timezone fixed to Asia/Karachi; currency PKR.
- The tax slab is the brief's illustrative slab, not a real tax calculation.
- The JWT is kept in `localStorage` (hackathon trade-off; there is no HTML injection path in the UI).
