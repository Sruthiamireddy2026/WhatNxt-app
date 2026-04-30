import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { google } from 'googleapis';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TOKENS_PATH = path.join(__dirname, 'tokens.json');
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const client = new Anthropic();

/* ── PRIORITY RULES ─────────────────────────────────────────────────────── */
const PRIORITY_RULES = `You are an AI inbox assistant for busy moms. \
Your job is to classify incoming messages by urgency so the mom can act on what matters most first.

PRIORITY LEVELS:
- do-now   : Child health/safety issues, same-day appointments, genuine emergencies, anything that requires action within the hour
- do-today : Schedule changes, time-sensitive (today only) deals or reminders, family coordination needed before end of day
- can-wait : Newsletters, general promos, shipping notifications, community updates, anything that can wait 24+ hours

SENDER TRUST TIERS (evaluate this first, before applying any other rule):
- PERSONAL   : sender domain is gmail.com, yahoo.com, hotmail.com, outlook.com, icloud.com, me.com, or aol.com
- AUTOMATED  : sender address starts with noreply@, no-reply@, or donotreply@, OR domain belongs to a known marketing platform (mailchimp, sendgrid, klaviyo, constantcontact, hubspot, salesforce, marketo, etc.)
- UNKNOWN    : everything else (company domains, school addresses, etc.)

CLASSIFICATION RULES:
1. When in doubt between two levels, choose the higher urgency.
2. A message from a school nurse or doctor always starts at do-now unless obviously routine.
3. Retail promotions and Amazon shipment notices are always can-wait.
4. A message that requires a decision or reply by tonight is do-today at minimum.
5. If the subject line contains any urgency signal — including but not limited to "ASAP", "urgent", "important", "time-sensitive", "action required", "immediate", "deadline", "emergency", "help", "call me", or "please respond" — score at minimum do-today, even if the body seems routine.
6. PERSONAL sender + urgency signal in subject → ALWAYS score do-now, no exceptions. Do not let the subject topic (e.g. "Job Opening", "Party", "Quick question") override this — a real person writing ASAP to you is always urgent.
7. Rules 8 and 9 below (marketing/unsubscribe demotions) apply ONLY to AUTOMATED or UNKNOWN senders. They NEVER apply to PERSONAL senders.
8. If the sender is AUTOMATED or UNKNOWN AND the preview contains "unsubscribe" → treat as marketing, cap priority at can-wait.
9. If the sender is AUTOMATED or UNKNOWN AND the subject contains urgency words AND the preview contains "unsubscribe" → the urgency words are a dark pattern, ignore them, cap at can-wait.
10. AUTOMATED senders with no unsubscribe signal → lower priority by one level from what it would otherwise be, but never below can-wait.

OUTPUT FORMAT:
Reply with ONLY a valid JSON array — no markdown fences, no explanation. Each element must have exactly two fields:
  { "id": <number>, "priority": "<do-now|do-today|can-wait>" }

Example:
[{"id":1,"priority":"do-now"},{"id":2,"priority":"can-wait"}]`;

/* ── GOOGLE OAUTH HELPERS ───────────────────────────────────────────────── */
function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000/auth/callback'
  );
}

function loadTokens() {
  try {
    return fs.existsSync(TOKENS_PATH)
      ? JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'))
      : null;
  } catch {
    return null;
  }
}

/* ── FETCH LAST 20 INBOX EMAILS ─────────────────────────────────────────── */
/*
  1. Uses stored OAuth tokens to authenticate with the Gmail API.
  2. Calls messages.list to get the 20 newest INBOX message IDs.
  3. Fetches metadata-only (From, Subject, Date + snippet) for each.
  4. Returns the array in the same shape as messages.json so the rest of
     the pipeline (Claude scoring → frontend rendering) is unchanged.
*/
async function fetchGmailMessages(tokens) {
  const auth = makeOAuthClient();
  auth.setCredentials(tokens);

  /* Auto-refresh expired access tokens and persist the new ones */
  auth.on('tokens', updated => {
    const merged = { ...tokens, ...updated };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged));
  });

  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 20,
    labelIds: ['INBOX'],
  });

  const ids = listRes.data.messages ?? [];
  if (ids.length === 0) return [];

  const messages = await Promise.all(
    ids.map(async ({ id }, index) => {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date'],
      });

      const headers   = msg.data.payload?.headers ?? [];
      const getHeader = name => headers.find(h => h.name === name)?.value ?? '';

      const rawFrom    = getHeader('From');
      const nameMatch  = rawFrom.match(/^"?([^"<]+?)"?\s*</);
      const sender     = nameMatch ? nameMatch[1].trim() : rawFrom;
      const emailMatch = rawFrom.match(/<([^>]+)>/);
      const senderEmail = emailMatch ? emailMatch[1] : rawFrom;

      const subject   = getHeader('Subject') || '(no subject)';
      const snippet   = (msg.data.snippet ?? '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));

      const rawDate   = getHeader('Date');
      const d         = new Date(rawDate);
      const timestamp = isNaN(d.getTime())
        ? rawDate
        : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

      return {
        id:        index + 1,
        gmailId:   id,           /* stable Gmail message ID — used as localStorage cache key */
        type:      'email',
        sender,
        senderEmail,
        subject,
        preview:   snippet,
        timestamp,
        priority:  'can-wait',  /* placeholder; Claude will override */
      };
    })
  );

  return messages;
}

/* ── FETCH TODAY'S CALENDAR EVENTS ──────────────────────────────────────── */
async function fetchCalendarEvents(tokens) {
  const auth = makeOAuthClient();
  auth.setCredentials(tokens);
  auth.on('tokens', updated => {
    const merged = { ...tokens, ...updated };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(merged));
  });

  const cal  = google.calendar({ version: 'v3', auth });
  const now  = new Date();

  /* Midnight-to-midnight window in local time, expressed as ISO strings */
  const timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();

  const listRes = await cal.events.list({
    calendarId:  'primary',
    timeMin,
    timeMax,
    singleEvents: true,   /* expands recurring events into individual instances */
    orderBy:      'startTime',
    maxResults:   20,
  });

  const fmt = d => d.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

  return (listRes.data.items ?? [])
    .filter(e => e.start?.dateTime)   /* skip all-day events (they have start.date, not dateTime) */
    .map(e => {
      const start      = new Date(e.start.dateTime);
      const end        = new Date(e.end.dateTime);
      const minsUntil  = (start - now) / 60000;

      return {
        id:             e.id,
        title:          e.summary || '(No title)',
        startTime:      fmt(start),
        endTime:        fmt(end),
        attendees:      (e.attendees ?? []).length,
        hasDescription: !!(e.description?.trim()),
        location:       e.location  || null,
        /* true when the meeting hasn't started yet and is within 2 hours */
        prepNeeded:     minsUntil > 0 && minsUntil < 120,
      };
    });
}

/*
 * ═══════════════════════════════════════════════
 * CORE ARCHITECTURE PRINCIPLE — DO NOT CHANGE
 * "User Exception Layer"
 * ═══════════════════════════════════════════════
 *
 * Custom rules are ALWAYS evaluated FIRST before
 * any system logic runs. This is intentional and
 * permanent — it is the core product philosophy:
 * "You Decide What Matters"
 *
 * EVALUATION ORDER — NEVER CHANGE THIS:
 * Step 1: User custom rules → checked FIRST
 *         Match found = execute immediately
 *         Skip ALL system rules for this message
 *
 * Step 2: System rules → only run if Step 1
 *         finds NO matching custom rule
 *
 * WHY: Users are always the final authority on
 * what is signal vs noise in their inbox.
 * System rules are defaults — user rules are law.
 *
 * ADDED: April 30 2026 — Sruthi Amireddy
 * ═══════════════════════════════════════════════
 */
/* ── SCORE MESSAGES VIA CLAUDE ──────────────────────────────────────────── */
async function scoreMessages(messages, userRules = '') {
  const messageList = messages
    .map(m =>
      `ID ${m.id} | Type: ${m.type} | From: "${m.sender}${m.senderEmail ? ` <${m.senderEmail}>` : ''}" | Subject: "${m.subject}" | Preview: "${m.preview}"`
    )
    .join('\n');

  /* Custom rules are checked first; default rules are fallback only.
     Placing them before PRIORITY_RULES with an explicit early-exit stops
     marketing caps (rules 8-9) from overriding what the user typed. */
  const systemText = userRules.trim()
    ? `STEP 1 — USER'S CUSTOM RULES (evaluate these first):
${userRules.trim()}

If any custom rule above matches the message → assign that priority and STOP. Do not apply any rule from Step 2 to this message.

STEP 2 — DEFAULT RULES (apply ONLY when no custom rule from Step 1 matched):
${PRIORITY_RULES}`
    : PRIORITY_RULES;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' }
      }
    ],
    messages: [
      {
        role: 'user',
        content: `Classify each message below and return ONLY the JSON array.\n\n${messageList}`
      }
    ]
  });

  const raw  = response.content.find(b => b.type === 'text')?.text ?? '[]';
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } = response.usage;
  console.log(
    `  Claude usage — input: ${input_tokens}, ` +
    `cache_write: ${cache_creation_input_tokens ?? 0}, ` +
    `cache_read: ${cache_read_input_tokens ?? 0}`
  );

  return JSON.parse(text);
}

/* ── REQUEST HANDLER ────────────────────────────────────────────────────── */
async function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  /* ── Auth: redirect browser to Google consent screen ── */
  if (url.pathname === '/auth/login') {
    const authUrl = makeOAuthClient().generateAuthUrl({
      access_type: 'offline',
      scope: GMAIL_SCOPES,
      prompt: 'consent',      /* always ask so we get a refresh_token */
    });
    res.writeHead(302, { Location: authUrl });
    return res.end();
  }

  /* ── Auth: Google redirects back here with ?code=… ── */
  if (url.pathname === '/auth/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400);
      return res.end('Missing code parameter');
    }
    try {
      const { tokens } = await makeOAuthClient().getToken(code);
      fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens));
      console.log('  Gmail tokens saved to tokens.json');
      res.writeHead(302, { Location: '/' });
      return res.end();
    } catch (err) {
      console.error('OAuth token exchange failed:', err.message);
      res.writeHead(500);
      return res.end('OAuth failed: ' + err.message);
    }
  }

  /* ── Auth status: lets the frontend know if we're connected ── */
  if (url.pathname === '/auth/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ connected: !!loadTokens() }));
  }

  /* ── Logout: delete stored tokens ── */
  if (url.pathname === '/auth/logout') {
    if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
    res.writeHead(302, { Location: '/' });
    return res.end();
  }

  /* ── API: score + return messages ── */
  if (req.method === 'GET' && url.pathname === '/api/messages') {
    try {
      const tokens = loadTokens();
      let messages;

      if (tokens) {
        console.log('→ /api/messages — fetching last 20 emails from Gmail…');
        messages = await fetchGmailMessages(tokens);
      } else {
        console.log('→ /api/messages — Gmail not connected, using messages.json fallback…');
        const raw = fs.readFileSync(path.join(__dirname, 'messages.json'), 'utf-8');
        messages = JSON.parse(raw);
      }

      if (messages.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([]));
      }

      const userRules = url.searchParams.get('rules') ?? '';
      /* cachedIds: Gmail message IDs the client already has scores for */
      const cachedSet = new Set(
        (url.searchParams.get('cached') ?? '').split(',').filter(Boolean)
      );

      /* Split: messages with no cached score need Claude; the rest are skipped */
      const toScore = messages.filter(m => !m.gmailId || !cachedSet.has(m.gmailId));
      const skipped = messages.filter(m =>  m.gmailId &&  cachedSet.has(m.gmailId));

      const scoreMap = {};
      if (toScore.length > 0) {
        /* Re-index 1…N so Claude always sees a clean sequential list */
        const forClaude = toScore.map((m, i) => ({ ...m, id: i + 1 }));
        console.log(
          `  Scoring ${toScore.length} message(s) with Claude Haiku` +
          (skipped.length ? ` — ${skipped.length} served from client cache` : '') +
          (userRules ? ' + custom rules' : '') + '…'
        );
        const rawScores = await scoreMessages(forClaude, userRules);
        forClaude.forEach(m => {
          const hit = rawScores.find(s => Number(s.id) === m.id);
          scoreMap[m.gmailId ?? m.id] = hit?.priority ?? 'can-wait';
        });
      } else {
        console.log(`  All ${messages.length} message(s) served from client cache — skipping Claude`);
      }

      const scored = messages.map(msg => ({
        ...msg,
        /* null = tell the client to fill in from localStorage */
        priority: (msg.gmailId && cachedSet.has(msg.gmailId))
          ? null
          : (scoreMap[msg.gmailId ?? msg.id] ?? msg.priority),
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(scored));
    } catch (err) {
      console.error('Error in /api/messages:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  /* ── API: today's calendar events ── */
  if (req.method === 'GET' && url.pathname === '/api/calendar') {
    try {
      const tokens = loadTokens();
      if (!tokens) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([]));
      }
      console.log('→ /api/calendar — fetching today\'s events…');
      const events = await fetchCalendarEvents(tokens);
      console.log(`  Found ${events.length} event(s) today`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(events));
    } catch (err) {
      console.error('Error in /api/calendar:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  /* ── Static file serving ── */
  const filePath = path.join(__dirname, url.pathname === '/' ? '/index.html' : url.pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json',
      '.js':   'text/javascript',
      '.css':  'text/css'
    };
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    return fs.createReadStream(filePath).pipe(res);
  }

  res.writeHead(404);
  res.end('Not found');
}

/* ── START SERVER ───────────────────────────────────────────────────────── */
const PORT = process.env.PORT ?? 3000;
http.createServer(handleRequest).listen(PORT, () => {
  console.log(`What Nxt server → http://localhost:${PORT}`);
});
