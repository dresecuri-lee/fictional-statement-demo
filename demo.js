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
function displayDate(date) {
  return new Intl.DateTimeFormat('en-US', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date);
}
function buildStatements(data, start, end) {
  const inRange = data.sessions.filter(session => session.occurred.getTime() >= start.getTime() && session.occurred.getTime() < end.getTime());
  return data.recipients.slice().sort((a, b) => a.id.localeCompare(b.id)).map(recipient => {
    const sessions = inRange.filter(session => session.participantIds.includes(recipient.id)).sort((a, b) => a.occurred - b.occurred || a.id.localeCompare(b.id));
    let totalAmountCents = 0;
    for (const session of sessions) totalAmountCents = addSafe(totalAmountCents, session.amountCents, `total for ${recipient.id}`);
    return { recipient, sessions, totalAmountCents };
  });
}
function renderStatementBase(statement, start, end) {
  const rows = statement.sessions.map(session => `<tr><td class="date"><time datetime="${escapeHtml(session.occurredAt)}" title="${escapeHtml(session.occurredAt)}">${escapeHtml(displayDate(session.occurred))}</time><small>${escapeHtml(session.occurredAt)}</small></td><td class="session" title="${escapeHtml(session.id)}">${escapeHtml(session.id)}</td><td class="description">${escapeHtml(session.description)}</td><td class="value">${escapeHtml(money(session.amountCents))}</td></tr>`).join('');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Automated Session Statement — Fictional local demo</title><style>:root{color:#101828;background:#fff;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}*{box-sizing:border-box}body{margin:0;font-size:16px;line-height:1.5}.page{max-width:980px;margin:0 auto;padding:48px 28px 28px}.eyebrow{display:inline-block;margin:0 0 26px;padding:4px 8px;border:1px solid #cbd5e1;border-radius:999px;color:#2457ff;font-size:11px;font-weight:750;letter-spacing:.09em}.masthead{display:flex;justify-content:space-between;gap:32px;padding-bottom:30px;border-bottom:2px solid #101828}.masthead h1{max-width:620px;margin:0;color:#101828;font-size:clamp(38px,7vw,72px);line-height:.98;letter-spacing:-.06em}.period{min-width:170px;margin:0;color:#475467;font-size:13px;line-height:1.45;text-align:right}.period strong{display:block;color:#101828;font-size:15px}.recipient{display:grid;grid-template-columns:170px 1fr;gap:16px;padding:27px 0;border-bottom:1px solid #dbe4f0}.recipient .label{color:#667085;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.recipient strong{display:block;font-size:20px;letter-spacing:-.02em}.recipient span{color:#475467}.metrics{display:grid;grid-template-columns:1fr 1fr;gap:1px;margin:30px 0;background:#dbe4f0;border:1px solid #dbe4f0}.metric{padding:20px 22px;background:#f7faff}.metric small{display:block;color:#475467;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.metric strong{display:block;margin-top:7px;color:#2457ff;font-size:clamp(30px,5vw,48px);letter-spacing:-.055em;line-height:1}.note{margin:0 0 20px;color:#475467;font-size:14px}.table-wrap{overflow-x:auto;border-top:2px solid #101828;border-bottom:1px solid #dbe4f0}table{width:100%;min-width:640px;border-collapse:collapse;table-layout:fixed}th{padding:12px 10px;color:#667085;font-size:11px;letter-spacing:.08em;text-align:left;text-transform:uppercase}td{padding:16px 10px;border-top:1px solid #e5eaf1;vertical-align:top;overflow-wrap:anywhere}th:first-child,td:first-child{padding-left:0}.date{width:140px;color:#344054}.date small{display:block;margin-top:3px;color:#98a2b3;font-size:11px}.session{width:150px;color:#475467;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}.description{width:auto;color:#101828}.value{width:128px;color:#101828;font-variant-numeric:tabular-nums;font-weight:750;text-align:right;white-space:nowrap}th:last-child{text-align:right}.value{padding-right:0}.value+td{padding-right:0}.closing{margin:28px 0 0;padding-top:18px;border-top:1px solid #dbe4f0;color:#2457ff;font-weight:700}.footer{margin:42px 0 0;color:#667085;font-size:13px}@media(max-width:640px){.page{padding:28px 18px 22px}.masthead{display:block}.period{margin-top:20px;text-align:left}.recipient{grid-template-columns:1fr;gap:4px}.metrics{grid-template-columns:1fr}.table-wrap{margin-right:-18px;padding-right:18px}.value{padding-right:10px}}</style></head><body><main class="page"><p class="eyebrow">FICTIONAL LOCAL DEMO</p><header class="masthead"><h1>Automated Session Statement</h1><p class="period"><strong>Reporting period</strong><time datetime="${escapeHtml(formatDate(start))}" title="${escapeHtml(formatDate(start))}">${escapeHtml(displayDate(start))}</time> — <time datetime="${escapeHtml(formatDate(end))}" title="${escapeHtml(formatDate(end))}">${escapeHtml(displayDate(end))}</time><br>End exclusive · UTC</p></header><section class="recipient" aria-label="Recipient"><span class="label">Prepared for</span><div><strong>${escapeHtml(statement.recipient.displayName)}</strong><span>${escapeHtml(statement.recipient.email)}</span></div></section><section class="metrics" aria-label="Statement totals"><div class="metric"><small>Sessions</small><strong>${statement.sessions.length}</strong></div><div class="metric"><small>Total informational value</small><strong>${escapeHtml(money(statement.totalAmountCents))}</strong></div></section><p class="note">Each shared session's full amount is repeated here as informational session value for every participant. It is not an apportioned fee or an invoice or customer charge.</p><div class="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th>Description</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div><p class="closing">Validated input. Precise periods. Recipient-ready reports.</p><footer class="footer">Need this adapted to your data and workflow? Let’s scope the integration.</footer></main></body></html>\n`;
}
function renderStatement(statement, start, end) {
  return renderStatementBase(statement, start, end).replace('</div><p class="closing">', '</div><p style="margin:10px 0 0;color:#667085;font-size:12px">The sample includes HTML-like text to demonstrate safe escaping.</p><p class="closing">');
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
