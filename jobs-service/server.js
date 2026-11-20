// Jobs Service - internal server (port 4001). Clients never call this directly.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { JOBS_PORT, GATEWAY_KEY } = require('../config');

const DB_FILE = path.join(__dirname, 'jobs.json');
const app = express();

// ---------- JSON file "database" helpers ----------
function readDb() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDb(db) {
  // write to a temp file, then rename: a crash never leaves a half-written file.
  // (All file calls are synchronous, so two requests can never interleave.)
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function parseId(raw) {
  return /^\d+$/.test(raw) ? Number(raw) : null;
}
function validateJob(body, requireAll) {
  const errors = [];
  for (const f of ['title', 'company', 'location']) {
    if (body[f] === undefined) {
      if (requireAll) errors.push(`'${f}' is required`);
    } else if (typeof body[f] !== 'string' || body[f].trim() === '') {
      errors.push(`'${f}' must be a non-empty string`);
    }
  }
  if (body.salary !== undefined && (typeof body.salary !== 'number' || body.salary < 0)) {
    errors.push("'salary' must be a number, 0 or more");
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

// ---------- middleware ----------
app.use(express.json());

// Only accept requests that came through the gateway
app.use((req, res, next) => {
  if (req.get('x-gateway-key') !== GATEWAY_KEY) {
    return res.status(403).json({ error: 'Forbidden: access only through the API Gateway' });
  }
  next();
});

// ---------- routes ----------
app.get('/jobs', (req, res) => {
  res.json(readDb().jobs);
});

app.get('/jobs/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Job id must be a number' });
  const job = readDb().jobs.find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: `Job ${id} not found` });
  res.json(job);
});

app.post('/jobs', (req, res) => {
  const body = req.body || {};
  const errors = validateJob(body, true);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const db = readDb();
  const job = {
    id: db.nextId++,
    title: body.title.trim(),
    company: body.company.trim(),
    location: body.location.trim(),
    salary: body.salary,
  };
  db.jobs.push(job);
  writeDb(db);
  res.status(201).json(job);
});

app.put('/jobs/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Job id must be a number' });
  const body = req.body || {};
  if (Object.keys(body).length === 0) return res.status(400).json({ error: 'Request body is empty' });
  const errors = validateJob(body, false);
  if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

  const db = readDb();
  const job = db.jobs.find((j) => j.id === id);
  if (!job) return res.status(404).json({ error: `Job ${id} not found` });

  for (const f of ['title', 'company', 'location', 'salary']) {
    if (body[f] !== undefined) job[f] = typeof body[f] === 'string' ? body[f].trim() : body[f];
  }
  writeDb(db);
  res.json(job);
});

app.delete('/jobs/:id', (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: 'Job id must be a number' });
  const db = readDb();
  const index = db.jobs.findIndex((j) => j.id === id);
  if (index === -1) return res.status(404).json({ error: `Job ${id} not found` });
  const [removed] = db.jobs.splice(index, 1);
  writeDb(db);
  res.json({ message: `Job ${id} deleted`, deleted: removed });
});

// ---------- known path, wrong method -> 405 ----------
app.all('/jobs', methodNotAllowed('GET, POST'));
app.all('/jobs/:id', methodNotAllowed('GET, PUT, DELETE'));

// ---------- unknown route -> 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ---------- malformed JSON and any other error ----------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// Bind to 127.0.0.1 only, so the port is not reachable from other machines
app.listen(JOBS_PORT, '127.0.0.1', () => {
  console.log(`[Jobs Service] running on internal port ${JOBS_PORT}`);
});