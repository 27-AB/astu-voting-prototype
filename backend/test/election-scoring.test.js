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
let tokenEmail;

before(async () => {
  process.chdir(tempDirectory);
  process.env.STUDENT_AFFAIRS_JUDGE_IDS = 'UGR/0001/15,UGR/0002/15';
  process.env.VOTING_TOKEN_SECRET = 'a'.repeat(64);
  process.env.STUDENT_EMAIL_DOMAIN = 'astu.edu.et';
  process.env.PARLIAMENT_VOTER_IDS = Array.from({ length: 50 }, (_, index) =>
    `UGR/${String(index + 1).padStart(4, '0')}/15`
  ).join(',');
  db = await import(pathToFileURL(path.resolve(originalCwd, 'db.js')).href);
  await db.getDb();
  tokenEmail = await import(pathToFileURL(path.resolve(originalCwd, 'token-email.js')).href);
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

test('scheduled voting tokens are cryptographically random and encrypted retries round-trip', () => {
  const firstToken = tokenEmail.generateVotingToken();
  const secondToken = tokenEmail.generateVotingToken();
  assert.match(firstToken, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);
  assert.notEqual(firstToken, secondToken);
  const encrypted = tokenEmail.encryptPendingToken(process.env.VOTING_TOKEN_SECRET, firstToken);
  assert.equal(tokenEmail.decryptPendingToken(process.env.VOTING_TOKEN_SECRET, {
    iv: encrypted.iv,
    ciphertext: encrypted.ciphertext,
    auth_tag: encrypted.authTag
  }), firstToken);
  assert.throws(() => tokenEmail.decryptPendingToken(process.env.VOTING_TOKEN_SECRET, {
    ...encrypted,
    auth_tag: '00'.repeat(16)
  }));
  assert.equal(
    tokenEmail.getStudentEmailAddress('UGR/0003/15'),
    'ugr-0003-15@astu.edu.et'
  );
  assert.throws(
    () => tokenEmail.encryptPendingToken('short', firstToken),
    /at least 32 bytes/
  );
  assert.throws(
    () => tokenEmail.getStudentEmailAddress('UGR/0003/15', 'not a domain'),
    /valid email domain/
  );
  assert.throws(
    () => tokenEmail.createSmtpTransport({}),
    /SMTP_HOST, SMTP_USER, and SMTP_PASS/
  );
  const { transporter } = tokenEmail.createSmtpTransport({
    SMTP_HOST: 'smtp.example.edu.et',
    SMTP_PORT: '587',
    SMTP_USER: 'elections@example.edu.et',
    SMTP_PASS: 'test-password'
  });
  assert.equal(transporter.options.requireTLS, true);
  transporter.close();
});

test('token email delivery state is persisted without linking voter IDs to the anonymous token ledger', () => {
  const electionStartTime = '2026-11-01T09:00:00Z';
  const voterId = 'UGR/0003/15';
  const rawToken = tokenEmail.generateVotingToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const encryptedToken = tokenEmail.encryptPendingToken(process.env.VOTING_TOKEN_SECRET, rawToken);
  db.executeRun('UPDATE voter_registry SET is_registered = 1 WHERE ugr_id = ?', [voterId]);
  assert.equal(
    db.createPendingTokenEmailDelivery(electionStartTime, voterId, tokenHash, encryptedToken),
    true
  );
  assert.deepEqual(db.getPendingTokenEmailDeliveries(electionStartTime), [
    {
      voter_ugr_id: voterId,
      attempts: 0,
      token_hash: tokenHash,
      ciphertext: encryptedToken.ciphertext,
      iv: encryptedToken.iv,
      auth_tag: encryptedToken.authTag
    }
  ]);
  db.recordTokenEmailAttempt(electionStartTime, voterId);
  db.markTokenEmailDelivered(electionStartTime, voterId);

  assert.equal(db.isTokenEmailDelivered(electionStartTime, voterId), true);
  assert.deepEqual(db.getPendingTokenEmailDeliveries(electionStartTime), []);
  assert.equal(
    db.executeQueryOne('SELECT has_received_token FROM voter_registry WHERE ugr_id = ?', [voterId]).has_received_token,
    1
  );
  assert.equal(
    db.executeQueryOne('SELECT token_hash FROM tokens WHERE token_hash = ?', [tokenHash]).token_hash,
    tokenHash
  );
  assert.deepEqual(
    db.executeQueryOne(
      `SELECT token_hash, token_ciphertext, token_iv, token_auth_tag
       FROM token_email_deliveries WHERE voter_ugr_id = ?`,
      [voterId]
    ),
    { token_hash: null, token_ciphertext: null, token_iv: null, token_auth_tag: null }
  );
  assert.equal(
    db.executeQuery('PRAGMA table_info(tokens)').some((column) => column.name === 'voter_ugr_id'),
    false
  );
});

test('undelivered voting tokens are removed from the anonymous ledger at election start', () => {
  const electionStartTime = '2026-11-02T09:00:00Z';
  const voterId = 'UGR/0004/15';
  const rawToken = tokenEmail.generateVotingToken();
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const encryptedToken = tokenEmail.encryptPendingToken(process.env.VOTING_TOKEN_SECRET, rawToken);
  db.createPendingTokenEmailDelivery(electionStartTime, voterId, tokenHash, encryptedToken);

  assert.equal(
    db.executeQueryOne('SELECT token_hash FROM tokens WHERE token_hash = ?', [tokenHash]).token_hash,
    tokenHash
  );
  assert.equal(db.discardPendingTokenEmailDeliveries(electionStartTime), 1);
  assert.equal(db.isTokenEmailDelivered(electionStartTime, voterId), false);
  assert.equal(
    db.executeQueryOne('SELECT token_hash FROM tokens WHERE token_hash = ?', [tokenHash]),
    null
  );
});
