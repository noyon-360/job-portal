// Applicants Service - internal server (port 4002). Clients never call this directly.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { APPLICANTS_PORT, GATEWAY_PORT, GATEWAY_KEY } = require('../config');

const DB_FILE = path.join(__dirname, 'applicants.json');
const app = express();

// ---------- JSON file "database" helpers ----------
function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(db) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function parseId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
function validateApplicant(body, requireAll) {
  const errors = [];
  if (body.name === undefined) {
    if (requireAll) errors.push("'name' is required");
  } else if (typeof body.name !== 'string' || body.name.trim() === '') {
    errors.push("'name' must be a non-empty string");
  }
  if (body.email === undefined) {
    if (requireAll) errors.push("'email' is required");
  } else if (typeof body.email !== 'string' || !/^\S+@\S+\.\S+$/.test(body.email)) {
    errors.push("'email' must be a valid email address");
  }
  if (body.jobId === undefined) {
    if (requireAll) errors.push("'jobId' is required");
  } else if (!Number.isInteger(body.jobId) || body.jobId < 1) {
    errors.push("'jobId' must be a positive whole number");
  }
  return errors;
}
function methodNotAllowed(allowed) {
  return (req, res) =>
    res.status(405).set('Allow', allowed).json({
      error: `Method ${req.method} not allowed on ${req.originalUrl}`,
      allowed: allowed.split(', '),
    });
}

// Service-to-service check. Even this internal call goes THROUGH the gateway,
// so all communication stays gateway-controlled.
// Returns true / false, or null if the Jobs service cannot be reached.
async function jobExists(jobId) {
  try {
    const r = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/api/jobs/${jobId}`);
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    return null;
  } catch {
    return null;
  }
}

// ---------- middleware ----------
app.use(express.json());

app.use((req, res, next) => {
  if (req.get('x-gateway-key') !== GATEWAY_KEY) {
    return res.status(403).json({ error: 'Forbidden: access only through the API Gateway' });
  }
  next();
});

// ---------- routes ----------
app.get('/applicants', (req, res) => {
  let list = readDb().applicants;
  // optional filter: /api/applicants?jobId=1
  if (req.query.jobId !== undefined) {
    const jobId = parseId(String(req.query.jobId));
    if (jobId === null) return res.status(400).json({ error: 'jobId filter must be a number' });
    list = list.filter((a) => a.jobId === jobId);
  }
  res.json(list);
});

app.get('/applicants/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Applicant id must be a number' });
  const applicant = readDb().applicants.find((a) => a.id === id);
  if (!applicant) return res.status(404).json({ error: `Applicant ${id} not found` });
  res.json(applicant);
});

app.post('/applicants', async (req, res) => {
  const body = req.body || {};
  const errors = validateApplicant(body, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const exists = await jobExists(body.jobId);
  if (exists === null) return res.status(503).json({ error: 'Cannot verify job: Jobs service unavailable' });
  if (!exists) return res.status(404).json({ error: `Job ${body.jobId} does not exist` });

  const db = readDb();
  const applicant = {
    id: db.nextId++,
    name: body.name.trim(),
    email: body.email.trim(),
    jobId: body.jobId,
  };
  db.applicants.push(applicant);
  writeDb(db);
  res.status(201).json(applicant);
});

app.put('/applicants/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Applicant id must be a number' });
  const body = req.body || {};
  if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Request body is empty' });
  const errors = validateApplicant(body, false);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  if (body.jobId !== undefined) {
    const exists = await jobExists(body.jobId);
    if (exists === null) return res.status(503).json({ error: 'Cannot verify job: Jobs service unavailable' });
    if (!exists) return res.status(404).json({ error: `Job ${body.jobId} does not exist` });
  }

  const db = readDb();
  const applicant = db.applicants.find((a) => a.id === id);
  if (!applicant) return res.status(404).json({ error: `Applicant ${id} not found` });

  for (const f of ['name', 'email', 'jobId']) {
    if (body[f] !== undefined) applicant[f] = typeof body[f] === 'string' ? body[f].trim() : body[f];
  }
  writeDb(db);
  res.json(applicant);
});

app.delete('/applicants/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Applicant id must be a number' });
  const db = readDb();
  const index = db.applicants.findIndex((a) => a.id === id);
  if (index === -1) return res.status(404).json({ error: `Applicant ${id} not found` });
  const [removed] = db.applicants.splice(index, 1);
  writeDb(db);
  res.json({ message: `Applicant ${id} deleted`, deleted: removed });
});

// ---------- known path, wrong method -> 405 ----------
app.all('/applicants', methodNotAllowed('GET, POST'));
app.all('/applicants/:id', methodNotAllowed('GET, PUT, DELETE'));

// ---------- unknown route -> 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(APPLICANTS_PORT, '127.0.0.1', () => {
  console.log(`[Applicants Service] running on internal port ${APPLICANTS_PORT}`);
});