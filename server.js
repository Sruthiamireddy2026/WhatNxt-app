import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const client = new Anthropic();

/* ── PRIORITY RULES ─────────────────────────────────────────────────────── */
/*
  Sent as the system prompt on every Claude call.
  Marked cache_control: ephemeral so Anthropic caches it after the first
  request — subsequent calls read the cache at ~10% of the normal token cost.
*/
const PRIORITY_RULES = `You are an AI inbox assistant for busy moms. \
Your job is to classify incoming messages by urgency so the mom can act on what matters most first.

PRIORITY LEVELS:
- do-now   : Child health/safety issues, same-day appointments, genuine emergencies, anything that requires action within the hour
- do-today : Schedule changes, time-sensitive (today only) deals or reminders, family coordination needed before end of day
- can-wait : Newsletters, general promos, shipping notifications, community updates, anything that can wait 24+ hours

CLASSIFICATION RULES:
1. When in doubt between two levels, choose the higher urgency.
2. A message from a school nurse or doctor always starts at do-now unless obviously routine.
3. Retail promotions and Amazon shipment notices are always can-wait.
4. A message that requires a decision or reply by tonight is do-today at minimum.

OUTPUT FORMAT:
Reply with ONLY a valid JSON array — no markdown fences, no explanation. Each element must have exactly two fields:
  { "id": <number>, "priority": "<do-now|do-today|can-wait>" }

Example:
[{"id":1,"priority":"do-now"},{"id":2,"priority":"can-wait"}]`;

/* ── SCORE MESSAGES VIA CLAUDE ──────────────────────────────────────────── */
/*
  Sends all messages to Claude Haiku in a single batch.
  Returns an array of { id, priority } objects.
*/
async function scoreMessages(messages) {
  const messageList = messages
    .map(m =>
      `ID ${m.id} | Type: ${m.type} | From: "${m.sender}" | Subject: "${m.subject}" | Preview: "${m.preview}"`
    )
    .join('\n');

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: PRIORITY_RULES,
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

  const raw = response.content.find(b => b.type === 'text')?.text ?? '[]';
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

  /* API endpoint: score + return messages */
  if (req.method === 'GET' && req.url === '/api/messages') {
    try {
      console.log('→ /api/messages — scoring with Claude Haiku…');
      const raw = fs.readFileSync(path.join(__dirname, 'messages.json'), 'utf-8');
      const messages = JSON.parse(raw);

      const scores = await scoreMessages(messages);

      /* Merge Claude's priority back into each message object */
      const scored = messages.map(msg => {
        const hit = scores.find(s => Number(s.id) === msg.id);
        return { ...msg, priority: hit?.priority ?? msg.priority };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(scored));
    } catch (err) {
      console.error('Error scoring messages:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  /* Static file serving: index.html, messages.json, etc. */
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(__dirname, urlPath.split('?')[0]);

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
