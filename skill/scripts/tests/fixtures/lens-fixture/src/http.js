'use strict';
// Small helpers so the routes can stay framework-free.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SESSION_TTL_MINUTES } = require('./config');

const sessions = new Map();
const PUBLIC = path.join(__dirname, '..', 'public');

function withJson(res) {
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
}

function session(req, res) {
  const id = /sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const now = Date.now();
  let s = id && sessions.get(id);
  if (!s || now - s.seen > SESSION_TTL_MINUTES * 60_000) {
    s = { id: randomUUID(), seen: now };
    sessions.set(s.id, s);
    res.setHeader('set-cookie', `sid=${s.id}; HttpOnly; SameSite=Lax; Path=/`);
  }
  s.seen = now;
  req.session = s;
}

function jsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function serveStatic(req, res) {
  const rel = new URL(req.url, 'http://localhost').pathname.replace(/^\/+/, '') || 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.end(fs.readFileSync(file));
  return true;
}

module.exports = { withJson, session, jsonBody, serveStatic };
