import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astu-weighted-vote-'));
let db;

before(async () => {
  process.chdir(tempDirectory);
  process.env.AUTHORITY_IDS = 'UGR/0001/15,UGR/0002/15,UGR/0003/15';
  db = await import(pathToFileURL(path.resolve(originalCwd, 'db.js')).href);
  await db.getDb();
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('only the three configured authorities receive authority weight', () => {
  const authorityAccounts = db.executeQuery(
    "SELECT voter_type, vote_weight FROM registrar_students WHERE voter_type = 'AUTHORITY'"
  );
  const standardAccounts = db.executeQuery(
    "SELECT voter_type, vote_weight FROM registrar_students WHERE voter_type = 'STANDARD'"
  );

  assert.equal(authorityAccounts.length, 3);
  assert.ok(authorityAccounts.every((account) => account.vote_weight === 3));
  assert.ok(standardAccounts.every((account) => account.vote_weight === 1));
});

test('vote weight is taken from the anonymous token and the token is consumed atomically', () => {
  const candidate = db.executeQueryOne('SELECT id FROM candidates ORDER BY id LIMIT 1');
  const rawToken = 'test-authority-token';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.executeRun('INSERT INTO tokens (token_hash, is_used, vote_weight) VALUES (?, 0, 3)', [tokenHash]);

  const result = db.castAnonymousVote(tokenHash, [candidate.id]);
  assert.deepEqual(result, { status: 'recorded', voteWeight: 3 });
  assert.equal(db.castAnonymousVote(tokenHash, [candidate.id]).status, 'used-token');

  const recordedVote = db.executeQueryOne(
    'SELECT vote_weight FROM votes WHERE candidate_id = ?',
    [candidate.id]
  );
  assert.equal(recordedVote.vote_weight, 3);
  assert.equal(
    db.executeQueryOne('SELECT SUM(vote_weight) AS total FROM votes WHERE candidate_id = ?', [candidate.id]).total,
    3
  );
});

test('invalid multi-position ballots do not burn their token', () => {
  const samePositionCandidates = db.executeQuery(
    "SELECT id FROM candidates WHERE position = 'President' ORDER BY id LIMIT 2"
  );
  const rawToken = 'test-standard-token';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.executeRun('INSERT INTO tokens (token_hash, is_used, vote_weight) VALUES (?, 0, 1)', [tokenHash]);

  assert.equal(
    db.castAnonymousVote(tokenHash, samePositionCandidates.map((candidate) => candidate.id)).status,
    'duplicate-position'
  );
  assert.equal(
    db.executeQueryOne('SELECT is_used FROM tokens WHERE token_hash = ?', [tokenHash]).is_used,
    0
  );
});
