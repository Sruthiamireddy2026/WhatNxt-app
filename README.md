# ⚡ What Nxt — Noise vs Signal
## Why This Exists

Most inbox prioritization tools optimize for AI automation.

What Nxt was designed around a different problem:
High-volume communication workflows create operational noise long before people consciously recognize overload.

The issue is rarely the number of messages.
The issue is identifying what actually matters without losing user control.

The product philosophy behind What Nxt is:
- AI should reduce cognitive filtering effort
- users should retain final prioritization authority
- workflow rules should adapt to human context, not override it

This principle led to the "User Exception Layer" architecture, where custom user rules always take precedence over system-generated scoring.

What Nxt connects to Gmail via OAuth, scores each message with Claude AI, and sorts everything into three buckets: **Do Now**, **Do Today**, and **Can Wait**.
> AI-powered priority inbox. You decide what matters.

## 🔗 Live Demo
👉 [Try the interactive demo](https://sruthiamireddy2026.github.io/WhatNxt-app/demo.html)

## 🗺️ Roadmap
| Phase | Status | What |
|-------|--------|------|
| Phase 1 — Mock UI + Claude AI | ✅ Done | Working dashboard |
| Phase 2 — Real Gmail + Calendar | ✅ Done | AI reads real inbox and calendar data |
| Phase 3 — Deploy + Beta Users | 🔄 Now | App goes online |
| Phase 4 — Multiple Personas | ⏳ Soon | Teachers, Counselors, Lawyers |

## 👩‍💻 Built By
Product concept, workflow logic, and architecture by Sruthi Amireddy
Built with Claude Code · April 2026

---

## Running locally

```bash
npm install
node server.js
# → http://localhost:3000
```

Requires a `.env` file with:
```
ANTHROPIC_API_KEY=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

---

## Architecture

### Stack
- **Backend:** Node.js plain HTTP server (no framework), ES modules
- **AI:** Anthropic Claude Haiku via `@anthropic-ai/sdk` with prompt caching
- **Auth:** Google OAuth 2.0 → Gmail API (metadata-only, last 20 inbox messages)
- **Frontend:** Single `index.html`, vanilla JS, no build step

### Request flow
1. Browser loads `index.html`
2. JS calls `GET /api/messages[?rules=...]`
3. Server fetches last 20 emails from Gmail (or falls back to `messages.json`)
4. Server sends messages to Claude for priority scoring
5. Scored messages returned as JSON; JS renders three priority sections

---

## Core Architecture Principle

### "User Exception Layer"

**Custom rules are always evaluated first, before any system logic runs.**

This is intentional and permanent. It is the core product philosophy: **"You Decide What Matters."**

#### Evaluation order (intentional by design)

| Step | What runs | Outcome |
|------|-----------|---------|
| **1** | User's custom rules | Match found → assign priority, **skip Step 2 entirely** |
| **2** | System default rules | Runs **only** if Step 1 found no match |

#### Why this matters

The system default rules include marketing filters, unsubscribe detection, and sender trust tiers. These are good defaults but they are not infallible. A user might write:

> `Pinterest = DO NOW`

That email normally has an unsubscribe link, which the system would cap at **Can Wait**. The user's rule must win — always.

#### Implementation

In `server.js → scoreMessages()`, when custom rules are present, the Claude prompt is structured as:

```
STEP 1 — USER'S CUSTOM RULES (evaluate these first):
<user rules>
→ If matched, STOP. Do not apply Step 2.

STEP 2 — DEFAULT RULES (fallback only):
<system scoring rules>
```

**Do not restructure this prompt order.** Placing system rules before custom rules allows hard caps (marketing filters) to override user intent — that is the exact bug this architecture was designed to prevent.

Any future change to the scoring logic that moves or weakens Step 1 should be made only after revisiting the underlying product philosophy.

*Principle established: April 30 2026 — Sruthi Amireddy*

---

## Custom Rules feature

Users can write plain-English rules in the **⚙️ My Rules** panel (top-right of the header). Rules are stored in `localStorage` and sent to the server as a `?rules=` query parameter on each load.

Example rules:
```
Anything from my kid's school = always DO NOW
Calendar changes from healthcare providers = DO TODAY
Promotional emails = always CAN WAIT
```

---

## Gmail OAuth flow

1. User clicks **Connect Gmail** → `GET /auth/login` → redirects to Google consent screen
2. Google redirects back to `GET /auth/callback?code=...`
3. Server exchanges code for tokens, saves to `tokens.json` (gitignored)
4. Subsequent requests use stored tokens; expired access tokens are auto-refreshed

If Gmail is not connected, the server falls back to `messages.json` for demo data.

---

## Priority levels

| Level | Key | When to use |
|-------|-----|-------------|
| 🔴 Do Now | `do-now` | Health/safety, same-day appointments, emergencies |
| 🟡 Do Today | `do-today` | Schedule changes, time-sensitive decisions |
| 🟢 Can Wait | `can-wait` | Newsletters, promos, shipping notices |
