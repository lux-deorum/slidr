'use strict';
// Live Q&A — tiny, dependency-free Node server.
// Holds sessions in memory and pushes live updates with Server-Sent Events.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const sessions = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const newCode = () => {
  let c;
  do c = Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  while (sessions.has(c));
  return c;
};
const newId = () => crypto.randomBytes(6).toString('hex');
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

// ---------- data helpers ----------

function cleanQuestion(q) {
  if (!q || typeof q !== 'object') return null;
  const text = clip(q.text, 300);
  const options = (Array.isArray(q.options) ? q.options : []).map(o => clip(o, 120)).filter(Boolean).slice(0, 5);
  if (!text || options.length < 2) return null;
  const type = q.type === 'quiz' ? 'quiz' : 'poll';
  let correct = null;
  if (type === 'quiz') {
    correct = Number(q.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) correct = 0;
  }
  return { text, type, options, correct };
}

function createSession({ code, key, title, questions }) {
  const s = {
    code, key,
    title: clip(title, 100) || 'My session',
    questions: [],
    qa: [],
    current: null,        // what the screen view shows: null | {kind:'q'|'qa', id}
    clients: new Set(),
    touched: Date.now(),
  };
  for (const q of Array.isArray(questions) ? questions.slice(0, 100) : []) {
    const c = cleanQuestion(q);
    if (c) s.questions.push({ id: clip(q.id, 20) || newId(), ...c, status: 'draft', votes: new Map() });
  }
  sessions.set(code, s);
  return s;
}

const counts = q => {
  const a = q.options.map(() => 0);
  for (const v of q.votes.values()) if (a[v] !== undefined) a[v]++;
  return a;
};

function presenterView(s) {
  return {
    code: s.code, title: s.title, current: s.current,
    questions: s.questions.map(q => ({
      id: q.id, text: q.text, type: q.type, options: q.options, correct: q.correct,
      status: q.status, counts: counts(q), total: q.votes.size,
    })),
    qa: s.qa,
  };
}

// Participants never see drafts, and only see counts / correct answers once results are shown.
function participantView(s, voter) {
  return {
    code: s.code, title: s.title,
    questions: s.questions.filter(q => q.status !== 'draft').map(q => {
      const closed = q.status === 'closed';
      return {
        id: q.id, text: q.text, type: q.type, options: q.options, status: q.status,
        myVote: q.votes.has(voter) ? q.votes.get(voter) : null,
        counts: closed ? counts(q) : null,
        total: closed ? q.votes.size : null,
        correct: closed && q.type === 'quiz' ? q.correct : null,
      };
    }),
  };
}

// ---------- live updates ----------

function send(c, s) {
  const data = c.role === 'presenter' ? presenterView(s) : participantView(s, c.voter);
  c.res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// who: 'all' = everyone; 'presenter' = presenter screens (+ one voter's own devices if given)
function notify(s, who, voter) {
  s.touched = Date.now();
  for (const c of s.clients) {
    if (who === 'all' || c.role === 'presenter' || (voter && c.voter === voter)) send(c, s);
  }
}

function openEvents(req, res, s, url) {
  const role = url.searchParams.get('role') === 'presenter' ? 'presenter' : 'participant';
  if (role === 'presenter' && url.searchParams.get('key') !== s.key) return json(res, 403, { error: 'Not allowed' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const c = { res, role, voter: clip(url.searchParams.get('voter'), 64) };
  s.clients.add(c);
  send(c, s);
  req.on('close', () => s.clients.delete(c));
}

// Keep connections alive through proxies, and forget sessions idle for 2 days.
setInterval(() => {
  for (const s of sessions.values()) for (const c of s.clients) c.res.write(': ping\n\n');
}, 25000);
setInterval(() => {
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const [code, s] of sessions) if (!s.clients.size && s.touched < cutoff) sessions.delete(code);
}, 3600 * 1000);

// ---------- http ----------

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 200000) { reject(new Error('Too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Bad JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // Everything that isn't /api is the single-page app.
    if (parts[0] !== 'api') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(INDEX_HTML);
    }

    // Create a session, or reconnect/restore one (the presenter's browser keeps a copy of the setup,
    // so if the server restarted, the session comes back with the same code).
    if (parts[1] === 'session' && parts.length === 2 && req.method === 'POST') {
      const b = await readBody(req);
      const code = clip(b.code, 10).toUpperCase();
      const existing = code && sessions.get(code);
      if (existing) {
        if (existing.key !== b.key) return json(res, 403, { error: 'That code belongs to another session.' });
        return json(res, 200, { code, key: existing.key });
      }
      if (code && /^[A-Z2-9]{5}$/.test(code) && typeof b.key === 'string' && b.key.length >= 16) {
        createSession({ code, key: clip(b.key, 64), title: b.title, questions: b.questions });
        return json(res, 200, { code, key: b.key, restored: true });
      }
      const s = createSession({ code: newCode(), key: crypto.randomBytes(16).toString('hex'), title: b.title, questions: b.questions });
      return json(res, 200, { code: s.code, key: s.key });
    }

    const s = sessions.get(clip(parts[1], 10).toUpperCase());
    if (!s) return json(res, 404, { error: 'No session with that code.' });
    const action = parts[2] || '';

    if (req.method === 'GET' && action === 'events') return openEvents(req, res, s, url);
    if (req.method === 'GET' && action === 'check') return json(res, 200, { title: s.title });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed' });

    const b = await readBody(req);

    // ----- audience actions -----
    if (action === 'vote') {
      const q = s.questions.find(x => x.id === b.id);
      if (!q || q.status !== 'live') return json(res, 409, { error: 'Voting is closed for this question.' });
      const option = Number(b.option);
      const voter = clip(b.voter, 64);
      if (!voter || !Number.isInteger(option) || option < 0 || option >= q.options.length) throw new Error('Invalid vote');
      q.votes.set(voter, option);
      notify(s, 'presenter', voter);
      return json(res, 200, { ok: true });
    }

    if (action === 'ask') {
      const text = clip(b.text, 500);
      if (!text) throw new Error('Your question is empty.');
      if (s.qa.length >= 2000) return json(res, 429, { error: 'This session has reached its question limit.' });
      s.qa.push({ id: newId(), text, name: clip(b.name, 60), answered: false, ts: Date.now() });
      notify(s, 'presenter');
      return json(res, 200, { ok: true });
    }

    // ----- presenter actions -----
    if (b.key !== s.key) return json(res, 403, { error: 'Not allowed' });
    const q = s.questions.find(x => x.id === b.id);
    const isCurrent = id => s.current && s.current.id === id;

    switch (action) {
      case 'save': {
        const c = cleanQuestion(b.question);
        if (!c) throw new Error('A question needs text and at least 2 options.');
        const existing = b.question.id && s.questions.find(x => x.id === b.question.id);
        if (existing) {
          if (existing.status !== 'draft') throw new Error('Reset this question before editing it.');
          Object.assign(existing, c);
        } else {
          if (s.questions.length >= 100) throw new Error('That’s a lot of questions! The limit is 100.');
          s.questions.push({ id: newId(), ...c, status: 'draft', votes: new Map() });
        }
        notify(s, 'presenter');
        break;
      }
      case 'delete':
        if (!q) throw new Error('Question not found');
        s.questions = s.questions.filter(x => x !== q);
        if (isCurrent(q.id)) s.current = null;
        notify(s, q.status === 'draft' ? 'presenter' : 'all');
        break;
      case 'live':
        if (!q) throw new Error('Question not found');
        q.status = 'live';
        s.current = { kind: 'q', id: q.id };
        notify(s, 'all');
        break;
      case 'close':
        if (!q) throw new Error('Question not found');
        q.status = 'closed';
        s.current = { kind: 'q', id: q.id };
        notify(s, 'all');
        break;
      case 'reset':
        if (!q) throw new Error('Question not found');
        q.status = 'draft';
        q.votes.clear();
        if (isCurrent(q.id)) s.current = null;
        notify(s, 'all');
        break;
      case 'answered': {
        const item = s.qa.find(x => x.id === b.id);
        if (!item) throw new Error('Question not found');
        item.answered = !item.answered;
        notify(s, 'presenter');
        break;
      }
      case 'screen': {
        const c = b.current;
        if (!c) s.current = null;
        else if (c.kind === 'q' && s.questions.some(x => x.id === c.id)) s.current = { kind: 'q', id: c.id };
        else if (c.kind === 'qa' && s.qa.some(x => x.id === c.id)) s.current = { kind: 'qa', id: c.id };
        else throw new Error('Nothing to show');
        notify(s, 'presenter');
        break;
      }
      default:
        return json(res, 404, { error: 'Unknown action' });
    }
    return json(res, 200, { ok: true });
  } catch (err) {
    if (!res.headersSent) json(res, 400, { error: err.message || 'Bad request' });
  }
});

server.listen(PORT, () => console.log(`Live Q&A running on http://localhost:${PORT}`));
