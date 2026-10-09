const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4173);
const HOST = '0.0.0.0';
const TEACHER_PASSWORD = process.env.SSTATE_TEACHER_PASSWORD || '';
const DATA_FILE = process.env.SSTATE_DATA_FILE || path.join(__dirname, 'journal-data.json');
const TEACHER_PAGE = fs.readFileSync(path.join(__dirname, 'S.State.html'));
const PUPIL_PAGE = fs.readFileSync(path.join(__dirname, 'pupil.html'));
const sessions = new Map();
const loginAttempts = new Map();

function parseJsonEnv(key, fallback) {
  try { return JSON.parse(process.env[key] || JSON.stringify(fallback)); }
  catch { throw new Error(`${key} must be valid JSON`); }
}
const roster = parseJsonEnv('SSTATE_STUDENTS', []);
const pupilPasswords = parseJsonEnv('SSTATE_STUDENT_PASSWORDS', {});
if (!Array.isArray(roster) || roster.length === 0) throw new Error('Set SSTATE_STUDENTS to a JSON array of {id,name} records.');
if (new Set(roster.map(s => s.id)).size !== roster.length || new Set(roster.map(s => s.name)).size !== roster.length) throw new Error('Student IDs and names must be unique.');
for (const student of roster) {
  if (!/^[a-z0-9_-]{3,80}$/i.test(student.id) || typeof student.name !== 'string' || !student.name.trim()) throw new Error('Each student needs a safe URL id and a name.');
  if (typeof pupilPasswords[student.id] !== 'string' || pupilPasswords[student.id].length < 12) throw new Error(`Set a student password of at least 12 characters for ${student.id}.`);
}
if (TEACHER_PASSWORD.length < 12) throw new Error('Set SSTATE_TEACHER_PASSWORD to a password of at least 12 characters.');

function readDb() {
  try { const value = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); return { students: value.students || {}, homeworks: Array.isArray(value.homeworks) ? value.homeworks : [] }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; return { students: {}, homeworks: [] }; }
}
let db = readDb();
for (const student of roster) if (!db.students[student.name]) db.students[student.name] = { days: {} };
function writeDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const temp = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', ...extra });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function constantTimeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a)).digest();
  const right = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(left, right);
}
function getSession(req) {
  const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('sstate_session='))?.slice('sstate_session='.length);
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(token); return null; }
  return session;
}
function originIsSame(req) {
  if (!req.headers.origin) return false;
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  try { return new URL(req.headers.origin).host.toLowerCase() === host; } catch { return false; }
}
function tooManyAttempts(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const record = loginAttempts.get(ip) || { count: 0, started: Date.now() };
  if (Date.now() - record.started > 15 * 60 * 1000) { record.count = 0; record.started = Date.now(); }
  record.count++;
  loginAttempts.set(ip, record);
  return record.count > 20;
}
function validateJournal(incoming) {
  if (!incoming || typeof incoming !== 'object' || !incoming.students || typeof incoming.students !== 'object' || !Array.isArray(incoming.homeworks)) return false;
  const allowedNames = new Set(roster.map(s => s.name));
  for (const [name, student] of Object.entries(incoming.students)) {
    if (!allowedNames.has(name) || !student || typeof student.days !== 'object') return false;
    for (const item of Object.values(student.days)) {
      if (!item || typeof item !== 'object') return false;
      if (item.grade !== null && item.grade !== undefined && (!Number.isInteger(item.grade) || item.grade < 1 || item.grade > 10)) return false;
      if (!['present', 'absent', 'sick', 'other'].includes(item.status)) return false;
      if (typeof (item.comment || '') !== 'string' || (item.comment || '').trim().split(/\s+/).filter(Boolean).length > 500) return false;
    }
  }
  return incoming.homeworks.every(x => x && typeof x.text === 'string' && x.text.length <= 2000);
}
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function classBands() {
  const scores = roster.map(s => Number(db.students[s.name]?.days?.[todayKey()]?.grade) || 0).filter(n => n > 0);
  return [{ label: 'Высшие (7–10)', low: 7, high: 10 }, { label: 'Средние (5–6)', low: 5, high: 6 }, { label: 'Низшие (1–4)', low: 1, high: 4 }].map(group => {
    const grades = scores.filter(score => score >= group.low && score <= group.high);
    const frequency = new Map();
    for (const grade of grades) frequency.set(grade, (frequency.get(grade) || 0) + 1);
    const popular = [...frequency].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] || null;
    return { label: group.label, count: grades.length, popular };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const session = getSession(req);
  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'POST' && !originIsSame(req)) return send(res, 403, JSON.stringify({ error: 'Cross-origin request denied.' }));
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (tooManyAttempts(req)) return send(res, 429, JSON.stringify({ error: 'Too many login attempts. Try again later.' }));
      try {
        const body = await readBody(req);
        let principal = null;
        if (body.role === 'teacher' && constantTimeEqual(body.password || '', TEACHER_PASSWORD)) principal = { role: 'teacher' };
        if (body.role === 'student' && roster.some(s => s.id === body.id) && constantTimeEqual(body.password || '', pupilPasswords[body.id] || '')) principal = { role: 'student', id: body.id };
        if (!principal) return send(res, 401, JSON.stringify({ error: 'Неверный пароль.' }));
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, { ...principal, expires: Date.now() + 12 * 60 * 60 * 1000 });
        const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
        return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8', { 'Set-Cookie': `sstate_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
      } catch { return send(res, 400, JSON.stringify({ error: 'Invalid login request.' })); }
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.cookie || '').match(/(?:^|;\s*)sstate_session=([^;]+)/)?.[1];
      if (token) sessions.delete(token);
      return send(res, 200, JSON.stringify({ ok: true }), 'application/json; charset=utf-8', { 'Set-Cookie': 'sstate_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (url.pathname === '/api/journal' && req.method === 'GET') {
      if (session?.role !== 'teacher') return send(res, 401, JSON.stringify({ error: 'Teacher login required.' }));
      const students = Object.fromEntries(roster.map(s => [s.name, db.students[s.name] || { days: {} }]));
      const studentIds = Object.fromEntries(roster.map(s => [s.name, s.id]));
      return send(res, 200, JSON.stringify({ students, studentIds, homeworks: db.homeworks }));
    }
    if (url.pathname === '/api/journal' && req.method === 'POST') {
      if (session?.role !== 'teacher') return send(res, 401, JSON.stringify({ error: 'Teacher login required.' }));
      try {
        const incoming = await readBody(req);
        if (!validateJournal(incoming)) return send(res, 400, JSON.stringify({ error: 'Invalid journal data.' }));
        db = { students: Object.fromEntries(roster.map(s => [s.name, incoming.students[s.name] || { days: {} }])), homeworks: incoming.homeworks };
        writeDb();
        return send(res, 200, JSON.stringify({ ok: true }));
      } catch { return send(res, 400, JSON.stringify({ error: 'Invalid journal data.' })); }
    }
    const pupilRoute = url.pathname.match(/^\/api\/student\/([a-z0-9_-]{3,80})$/i);
    if (pupilRoute && req.method === 'GET') {
      const student = roster.find(s => s.id === pupilRoute[1]);
      if (!student || session?.role !== 'student' || session.id !== student.id) return send(res, 403, JSON.stringify({ error: 'Student access denied.' }));
      return send(res, 200, JSON.stringify({ name: student.name, days: db.students[student.name]?.days || {}, homeworks: db.homeworks, classBands: classBands() }));
    }
    return send(res, 404, JSON.stringify({ error: 'Not found.' }));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'GET, HEAD' });
  const isPupil = url.pathname.startsWith('/sstate-for-pupils/current/') && url.pathname.endsWith('/view/account');
  const page = isPupil ? PUPIL_PAGE : TEACHER_PAGE;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'" });
  res.end(req.method === 'HEAD' ? undefined : page);
});
server.listen(PORT, HOST, () => console.log(`S.State Group listening on ${HOST}:${PORT}`));
