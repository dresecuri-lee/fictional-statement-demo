#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'statement-demo-test-'));
const demo = path.join(__dirname, 'demo.js');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));
const start = '2026-08-01T00:00:00.000Z';
const end = '2026-09-01T00:00:00.000Z';
let passed = 0;

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function writeInput(name, value) {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
  return file;
}
function run(input, out, extra = []) {
  return childProcess.spawnSync(process.execPath, [demo, '--input', input, '--start', start, '--end', end, '--out', out, ...extra], { encoding: 'utf8' });
}
function expectFailure(name, input, out = path.join(root, `${name}-out`)) {
  const result = run(writeInput(name, input), out);
  assert.notEqual(result.status, 0, `${name} should fail`);
  assert.match(result.stderr, /Error:/);
  assert.equal(fs.existsSync(out), false, `${name} left partial output`);
}
function check(name, action) { action(); passed += 1; }

try {
  check('normal CLI writes both previews and deterministic manifest', () => {
    const input = writeInput('normal', fixture);
    const outA = path.join(root, 'normal-a');
    const outB = path.join(root, 'normal-b');
    assert.equal(run(input, outA).status, 0);
    assert.equal(run(input, outB).status, 0);
    const manifest = JSON.parse(fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, { start, end, currency: 'USD', statements: [
      { recipientId: 'alex', file: 'statement-alex.html', sessionCount: 2, totalAmountCents: 17500, sessionIds: ['shared-opening', 'alex-followup'] },
      { recipientId: 'river', file: 'statement-river.html', sessionCount: 1, totalAmountCents: 12500, sessionIds: ['shared-opening'] }
    ] });
    assert.equal(fs.readFileSync(path.join(outA, 'manifest.json'), 'utf8'), fs.readFileSync(path.join(outB, 'manifest.json'), 'utf8'));
    const html = fs.readFileSync(path.join(outA, 'statement-alex.html'), 'utf8');
    assert.match(html, /FICTIONAL LOCAL DEMO/);
    assert.match(html, /<style>/);
    assert.match(html, /not an apportioned fee or an invoice or customer charge/);
  });

  check('start is included and end is excluded', () => {
    const out = path.join(root, 'boundary');
    assert.equal(run(writeInput('boundary', fixture), out).status, 0);
    const html = fs.readFileSync(path.join(out, 'statement-river.html'), 'utf8');
    assert.match(html, /shared-opening/);
    assert.doesNotMatch(html, /excluded-ending/);
  });

  check('HTML input is escaped', () => {
    const out = path.join(root, 'escape');
    assert.equal(run(writeInput('escape', fixture), out).status, 0);
    const html = fs.readFileSync(path.join(out, 'statement-alex.html'), 'utf8');
    assert.match(html, /&lt;script&gt;alert\(&#39;demo&#39;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  check('duplicate session id fails without output', () => {
    const input = clone(fixture);
    input.sessions.push({ ...input.sessions[1], occurredAt: '2026-08-20T00:00:00.000Z' });
    expectFailure('duplicate-session', input);
  });

  check('unknown and duplicate participants fail', () => {
    const unknown = clone(fixture);
    unknown.sessions[0].participantIds = ['nobody'];
    expectFailure('unknown-participant', unknown);
    const duplicate = clone(fixture);
    duplicate.sessions[0].participantIds = ['alex', 'alex'];
    expectFailure('duplicate-participant', duplicate);
  });

  check('schema, timestamps, cents, currency, and totals are strict', () => {
    const cases = [];
    const missing = clone(fixture); delete missing.recipients[0].email; cases.push(missing);
    const extra = clone(fixture); extra.sessions[0].unexpected = true; cases.push(extra);
    const nonUtc = clone(fixture); nonUtc.sessions[0].occurredAt = '2026-08-01T00:00:00+00:00'; cases.push(nonUtc);
    const decimal = clone(fixture); decimal.sessions[0].amountCents = 1.5; cases.push(decimal);
    const unsafe = clone(fixture); unsafe.sessions[0].amountCents = Number.MAX_SAFE_INTEGER + 1; cases.push(unsafe);
    const nonUsd = clone(fixture); nonUsd.sessions[0].currency = 'EUR'; cases.push(nonUsd);
    const overflow = clone(fixture); overflow.sessions = [
      { ...overflow.sessions[0], id: 'huge-a', participantIds: ['alex'], amountCents: Number.MAX_SAFE_INTEGER },
      { ...overflow.sessions[1], id: 'huge-b', participantIds: ['alex'], amountCents: 1 }
    ]; cases.push(overflow);
    cases.forEach((input, index) => expectFailure(`strict-${index}`, input));
  });

  check('unsafe paths, symlink, non-empty output, and write failure preserve output', () => {
    const input = writeInput('path-cases', fixture);
    const pathId = clone(fixture); pathId.recipients[0].id = '../escape';
    expectFailure('unsafe-id', pathId);
    const nonEmpty = path.join(root, 'non-empty'); fs.mkdirSync(nonEmpty); fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'keep');
    const nonEmptyResult = run(input, nonEmpty); assert.notEqual(nonEmptyResult.status, 0); assert.equal(fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8'), 'keep');
    const target = path.join(root, 'symlink-target'); fs.mkdirSync(target);
    const link = path.join(root, 'output-link'); fs.symlinkSync(target, link);
    const symlinkResult = run(input, link); assert.notEqual(symlinkResult.status, 0); assert.equal(fs.readdirSync(target).length, 0);
    const blockedParent = path.join(root, 'blocked-parent'); fs.mkdirSync(blockedParent); fs.writeFileSync(path.join(blockedParent, 'keep.txt'), 'keep');
    fs.chmodSync(blockedParent, 0o500);
    try {
      const ioResult = run(input, path.join(blockedParent, 'out'));
      assert.notEqual(ioResult.status, 0); assert.equal(fs.existsSync(path.join(blockedParent, 'out')), false);
    } finally {
      fs.chmodSync(blockedParent, 0o700);
    }
    assert.equal(fs.readFileSync(path.join(blockedParent, 'keep.txt'), 'utf8'), 'keep');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

process.stdout.write(`7 meaningful tests passed (${passed}/7).\n`);
