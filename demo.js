#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RECIPIENT_KEYS = ['displayName', 'email', 'id'];
const SESSION_KEYS = ['amountCents', 'currency', 'description', 'id', 'occurredAt', 'participantIds'];
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UTC_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function fail(message) { throw new Error(message); }
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function exactKeys(value, keys, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, i) => key !== keys[i])) fail(`${label} has missing or unknown fields`);
}
function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string`);
}
function parseUtc(value, label) {
  nonEmptyString(value, label);
  const match = UTC_RE.exec(value);
  if (!match) fail(`${label} must be an ISO-8601 UTC timestamp ending in Z`);
  const [, year, month, day, hour, minute, second, fraction = ''] = match;
  const millis = Number((fraction + '000').slice(0, 3));
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), millis));
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) || date.getUTCSeconds() !== Number(second) || date.getUTCMilliseconds() !== millis) {
    fail(`${label} is not a valid UTC timestamp`);
  }
  return date;
}
function addSafe(left, right, label) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(left + right)) fail(`${label} exceeds safe integer range`);
  return left + right;
}
function validateInput(input) {
  exactKeys(input, ['recipients', 'sessions'], 'input');
  if (!Array.isArray(input.recipients) || !Array.isArray(input.sessions)) fail('recipients and sessions must be arrays');
  const recipientIds = new Set();
  const recipientEmails = new Set();
  const recipients = input.recipients.map((recipient, index) => {
    exactKeys(recipient, RECIPIENT_KEYS, `recipients[${index}]`);
    nonEmptyString(recipient.id, `recipients[${index}].id`);
    nonEmptyString(recipient.displayName, `recipients[${index}].displayName`);
    nonEmptyString(recipient.email, `recipients[${index}].email`);
    if (!ID_RE.test(recipient.id)) fail(`recipients[${index}].id is unsafe`);
    if (!EMAIL_RE.test(recipient.email)) fail(`recipients[${index}].email is invalid`);
    if (recipientIds.has(recipient.id)) fail(`duplicate recipient id: ${recipient.id}`);
    if (recipientEmails.has(recipient.email)) fail(`duplicate recipient email: ${recipient.email}`);
    recipientIds.add(recipient.id);
    recipientEmails.add(recipient.email);
    return { ...recipient };
  });
  const sessionIds = new Set();
  const sessions = input.sessions.map((session, index) => {
    exactKeys(session, SESSION_KEYS, `sessions[${index}]`);
    nonEmptyString(session.id, `sessions[${index}].id`);
    nonEmptyString(session.description, `sessions[${index}].description`);
    const occurred = parseUtc(session.occurredAt, `sessions[${index}].occurredAt`);
    if (!Array.isArray(session.participantIds) || session.participantIds.length < 1) fail(`sessions[${index}].participantIds must contain at least one recipient`);
    if (!Number.isSafeInteger(session.amountCents) || session.amountCents < 0) fail(`sessions[${index}].amountCents must be a non-negative safe integer`);
    if (session.currency !== 'USD') fail(`sessions[${index}].currency must be USD`);
    if (sessionIds.has(session.id)) fail(`duplicate session id: ${session.id}`);
    sessionIds.add(session.id);
    const participants = new Set();
    for (const participantId of session.participantIds) {
      nonEmptyString(participantId, `sessions[${index}].participantIds item`);
      if (!recipientIds.has(participantId)) fail(`unknown participant id: ${participantId}`);
      if (participants.has(participantId)) fail(`duplicate participant id: ${participantId}`);
      participants.add(participantId);
    }
    return { ...session, occurred };
  });
  return { recipients, sessions };
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function money(cents) {
  const dollars = Math.floor(cents / 100);
  return `$${dollars.toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;
}
function formatDate(date) { return date.toISOString(); }
function buildStatements(data, start, end) {
  const inRange = data.sessions.filter(session => session.occurred.getTime() >= start.getTime() && session.occurred.getTime() < end.getTime());
  return data.recipients.slice().sort((a, b) => a.id.localeCompare(b.id)).map(recipient => {
    const sessions = inRange.filter(session => session.participantIds.includes(recipient.id)).sort((a, b) => a.occurred - b.occurred || a.id.localeCompare(b.id));
    let totalAmountCents = 0;
    for (const session of sessions) totalAmountCents = addSafe(totalAmountCents, session.amountCents, `total for ${recipient.id}`);
    return { recipient, sessions, totalAmountCents };
  });
}
function renderStatement(statement, start, end) {
  const rows = statement.sessions.map(session => `<tr><td>${escapeHtml(session.id)}</td><td>${escapeHtml(session.occurredAt)}</td><td>${escapeHtml(session.description)}</td><td>${escapeHtml(money(session.amountCents))}</td></tr>`).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Fictional local demo statement</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:880px;margin:32px auto;padding:0 20px;color:#1f2937}.label{display:inline-block;background:#fef3c7;color:#92400e;font-weight:700;padding:4px 9px;border-radius:4px}table{border-collapse:collapse;width:100%;margin-top:18px}th,td{border:1px solid #d1d5db;padding:8px;text-align:left}th{background:#f3f4f6}.note{color:#4b5563}</style></head><body><p class="label">FICTIONAL LOCAL DEMO</p><h1>Session statement</h1><p><strong>Recipient:</strong> ${escapeHtml(statement.recipient.displayName)} (${escapeHtml(statement.recipient.email)})</p><p><strong>Period:</strong> ${escapeHtml(formatDate(start))} through ${escapeHtml(formatDate(end))} (end exclusive)</p><p class="note">Each shared session's full amount is repeated here as informational session value for every participant. It is not an apportioned fee or an invoice or customer charge.</p><table><thead><tr><th>Session</th><th>Occurred at</th><th>Description</th><th>Informational session value</th></tr></thead><tbody>${rows}</tbody></table><p><strong>Sessions:</strong> ${statement.sessions.length}</p><p><strong>Total informational session value:</strong> ${escapeHtml(money(statement.totalAmountCents))}</p></body></html>\n`;
}
function parseArgs(args) {
  if (args.length !== 8) fail('usage: demo.js --input FILE --start UTC --end UTC --out DIRECTORY');
  const expected = ['--input', '--start', '--end', '--out'];
  const values = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (args[i * 2] !== expected[i]) fail('usage: demo.js --input FILE --start UTC --end UTC --out DIRECTORY');
    values[expected[i].slice(2)] = args[i * 2 + 1];
  }
  return values;
}
function validateOutput(out) {
  const resolved = path.resolve(out);
  const parent = path.dirname(resolved);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch { fail(`output parent is unavailable: ${parent}`); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('output parent must be a normal directory');
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('output must be a normal directory');
    if (fs.readdirSync(resolved).length !== 0) fail('output directory must be empty');
    return { resolved, exists: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { resolved, exists: false };
    throw error;
  }
}
function writeAtomically(output, statements, start, end) {
  const parent = path.dirname(output.resolved);
  const stage = path.join(parent, `.statement-stage-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    const manifest = { start: formatDate(start), end: formatDate(end), currency: 'USD', statements: [] };
    for (const statement of statements) {
      const file = `statement-${statement.recipient.id}.html`;
      fs.writeFileSync(path.join(stage, file), renderStatement(statement, start, end), 'utf8');
      manifest.statements.push({ recipientId: statement.recipient.id, file, sessionCount: statement.sessions.length, totalAmountCents: statement.totalAmountCents, sessionIds: statement.sessions.map(session => session.id) });
    }
    fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    if (output.exists) fs.rmdirSync(output.resolved);
    fs.renameSync(stage, output.resolved);
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* Preserve original failure. */ }
    throw error;
  }
}
function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputText = fs.readFileSync(args.input, 'utf8');
  let input;
  try { input = JSON.parse(inputText); } catch { fail('input must be valid JSON'); }
  const data = validateInput(input);
  const start = parseUtc(args.start, 'start');
  const end = parseUtc(args.end, 'end');
  if (start.getTime() >= end.getTime()) fail('start must be before end');
  const output = validateOutput(args.out);
  const statements = buildStatements(data, start, end);
  writeAtomically(output, statements, start, end);
}
try { main(); } catch (error) { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; }
