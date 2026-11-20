// API Gateway (port 3000) - the ONLY server the client talks to.
// Built with Node's built-in http module, so no extra libraries are needed.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { GATEWAY_PORT, JOBS_PORT, APPLICANTS_PORT, GATEWAY_KEY } = require('../config');

// Routing table: public URL prefix  ->  hidden internal server + its internal path
const ROUTES = [
  { prefix: '/api/jobs', port: JOBS_PORT, target: '/jobs', name: 'Jobs Service' },
  { prefix: '/api/applicants', port: APPLICANTS_PORT, target: '/applicants', name: 'Applicants Service' },
];

function sendJson(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  // log every request when it finishes
  res.on('finish', () => {
    console.log(`[Gateway] ${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
  });

  // Test frontend: http://localhost:3000/
  if (pathname === '/' && req.method === 'GET') {
    return fs.readFile(path.join(__dirname, '..', 'frontend', 'index.html'), (err, html) => {
      if (err) return sendJson(res, 404, { error: 'Frontend not found (frontend/index.html)' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
  }

  // Info route
  if (pathname === '/api') {
    return sendJson(res, 200, {
      service: 'Job Portal API Gateway',
      routes: ROUTES.map((r) => r.prefix),
    });
  }

  // Find the matching route (exact prefix, or prefix followed by "/")
  const route = ROUTES.find(
    (r) => pathname === r.prefix || pathname.startsWith(r.prefix + '/')
  );
  if (!route) {
    return sendJson(res, 404, {
      error: `Route not found: ${req.method} ${pathname}`,
      hint: 'Valid routes are ' + ROUTES.map((r) => r.prefix).join(' and '),
    });
  }

  // Build the internal path, e.g. /api/jobs/5?x=1 -> /jobs/5?x=1
  const internalPath = route.target + pathname.slice(route.prefix.length) + url.search;

  // Copy the client's headers, replace the host, and set our own secret key
  // (any x-gateway-key sent by the client is overwritten).
  const headers = { ...req.headers, host: `127.0.0.1:${route.port}`, 'x-gateway-key': GATEWAY_KEY };

  const proxyReq = http.request(
    { host: '127.0.0.1', port: route.port, path: internalPath, method: req.method, headers, timeout: 5000 },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res); // send the service's answer back to the client
    }
  );

  // Service is down / refused the connection
  proxyReq.on('error', () => {
    if (!res.headersSent) {
      sendJson(res, 503, { error: `${route.name} is currently unavailable. Please try again later.` });
    }
  });

  // Service too slow
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) {
      sendJson(res, 504, { error: `${route.name} took too long to respond.` });
    }
  });

  req.pipe(proxyReq); // send the client's body to the service
});

server.listen(GATEWAY_PORT, () => {
  console.log(`[Gateway] running on http://localhost:${GATEWAY_PORT}`);
  console.log(`[Gateway] test frontend: http://localhost:${GATEWAY_PORT}/`);
  ROUTES.forEach((r) => console.log(`[Gateway]   ${r.prefix}  ->  hidden port ${r.port}`));
});