import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const originalCwd = process.cwd();
const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'astu-election-scoring-'));
let db;

before(async () => {
  process.chdir(tempDirectory);
  process.env.STUDENT_AFFAIRS_JUDGE_IDS = 'UGR/0001/15,UGR/0002/15';
  process.env.PARLIAMENT_VOTER_IDS = Array.from({ length: 50 }, (_, index) =>
    `UGR/${String(index + 1).padStart(4, '0')}/15`
  ).join(',');
  db = await import(pathToFileURL(path.resolve(originalCwd, 'db.js')).href);
  await db.getDb();
});

after(() => {
  process.chdir(originalCwd);
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('only the two configured student-affairs officeholders receive judge status', () => {
  const authorityAccounts = db.executeQuery(
    "SELECT voter_type FROM registrar_students WHERE voter_type = 'AUTHORITY'"
  );

  assert.equal(authorityAccounts.length, 2);
  assert.equal(db.executeQueryOne("SELECT COUNT(*) AS count FROM registrar_students WHERE voter_type = 'STANDARD'").count, 3);
});

test('parliament voter roster is restricted to 50 through 100 unique IDs', () => {
  const originalIds = process.env.PARLIAMENT_VOTER_IDS;
  try {
    process.env.PARLIAMENT_VOTER_IDS = 'UGR/0001/15';
    assert.throws(() => db.getConfiguredParliamentIds(), /50 to 100/);
    process.env.PARLIAMENT_VOTER_IDS = Array.from({ length: 101 }, (_, index) =>
      `UGR/${String(index + 1).padStart(4, '0')}/15`
    ).join(',');
    assert.throws(() => db.getConfiguredParliamentIds(), /50 to 100/);
    process.env.PARLIAMENT_VOTER_IDS = Array.from({ length: 50 }, () => 'UGR/0001/15').join(',');
    assert.throws(() => db.getConfiguredParliamentIds(), /distinct/);
  } finally {
    process.env.PARLIAMENT_VOTER_IDS = originalIds;
  }
});

test('parliamentary ballot records one unweighted vote per position and burns its token atomically', () => {
  const candidates = db.executeQuery(
    `SELECT id FROM candidates
     WHERE position IN ('President', 'Vice President', 'Secretary')
     GROUP BY position`
  );
  assert.equal(candidates.length, 3);
  const rawToken = 'test-parliament-token';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.executeRun('INSERT INTO tokens (token_hash, is_used) VALUES (?, 0)', [tokenHash]);

  const candidateIds = candidates.map((candidate) => candidate.id);
  const result = db.castAnonymousVote(tokenHash, candidateIds);
  assert.deepEqual(result, { status: 'recorded' });
  assert.equal(db.castAnonymousVote(tokenHash, candidateIds).status, 'used-token');

  assert.equal(db.executeQuery('SELECT candidate_id FROM votes').length, 3);
});

test('incomplete and duplicate-position ballots do not burn their token', () => {
  const samePositionCandidates = db.executeQuery(
    "SELECT id FROM candidates WHERE position = 'President' ORDER BY id LIMIT 2"
  );
  const rawToken = 'test-standard-token';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.executeRun('INSERT INTO tokens (token_hash, is_used) VALUES (?, 0)', [tokenHash]);

  assert.equal(
    db.castAnonymousVote(tokenHash, samePositionCandidates.map((candidate) => candidate.id)).status,
    'duplicate-position'
  );
  assert.equal(
    db.executeQueryOne('SELECT is_used FROM tokens WHERE token_hash = ?', [tokenHash]).is_used,
    0
  );
  assert.equal(db.castAnonymousVote(tokenHash, [samePositionCandidates[0].id]).status, 'incomplete-ballot');
  assert.equal(db.executeQueryOne('SELECT is_used FROM tokens WHERE token_hash = ?', [tokenHash]).is_used, 0);
});

test('judge scores are bounded to 0 through 20 and unique per candidate and judge', () => {
  const candidate = db.executeQueryOne('SELECT id FROM candidates ORDER BY id LIMIT 1');
  const judge = db.executeQueryOne("SELECT ugr_id FROM registrar_students WHERE voter_type = 'AUTHORITY'");
  db.executeRun(
    'INSERT INTO judge_scores (judge_ugr_id, candidate_id, score) VALUES (?, ?, ?)',
    [judge.ugr_id, candidate.id, 20]
  );
  assert.throws(() => db.executeRun(
    'INSERT INTO judge_scores (judge_ugr_id, candidate_id, score) VALUES (?, ?, ?)',
    [judge.ugr_id, candidate.id, 21]
  ));
});

test('final ranking combines the judge average at 30 percent and parliamentary vote share at 70 percent', () => {
  const presidentCandidates = db.executeQuery(
    "SELECT id FROM candidates WHERE position = 'President' ORDER BY id LIMIT 2"
  );
  const judges = db.executeQuery(
    "SELECT ugr_id FROM registrar_students WHERE voter_type = 'AUTHORITY' ORDER BY ugr_id"
  );
  const [first, second] = presidentCandidates;
  db.executeRun('DELETE FROM votes');

  for (const judge of judges) {
    db.executeRun(
      'INSERT INTO judge_scores (judge_ugr_id, candidate_id, score) VALUES (?, ?, ?) ON CONFLICT(judge_ugr_id, candidate_id) DO UPDATE SET score = excluded.score',
      [judge.ugr_id, first.id, 20]
    );
    db.executeRun(
      'INSERT INTO judge_scores (judge_ugr_id, candidate_id, score) VALUES (?, ?, ?) ON CONFLICT(judge_ugr_id, candidate_id) DO UPDATE SET score = excluded.score',
      [judge.ugr_id, second.id, 0]
    );
  }
  db.executeRun('INSERT INTO votes (candidate_id) VALUES (?)', [first.id]);
  db.executeRun('INSERT INTO votes (candidate_id) VALUES (?)', [first.id]);
  db.executeRun('INSERT INTO votes (candidate_id) VALUES (?)', [second.id]);

  const rankings = db.getCandidateRankings().filter((candidate) =>
    presidentCandidates.some((row) => row.id === candidate.candidate_id)
  );
  const firstRanked = rankings.find((candidate) => candidate.candidate_id === first.id);
  const secondRanked = rankings.find((candidate) => candidate.candidate_id === second.id);

  assert.equal(firstRanked.judge_score, 20);
  assert.equal(firstRanked.judge_points, 30);
  assert.equal(firstRanked.parliament_share, 46.67);
  assert.equal(firstRanked.final_score, 76.67);
  assert.equal(firstRanked.rank, 1);
  assert.equal(secondRanked.judge_score, 0);
  assert.equal(secondRanked.parliament_share, 23.33);
  assert.equal(secondRanked.final_score, 23.33);
  assert.equal(secondRanked.rank, 2);
});
