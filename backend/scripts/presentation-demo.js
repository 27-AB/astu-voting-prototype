import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const demoDirectory = path.join(backendDirectory, 'demo-data');
const phase = process.argv[2] || 'scheduled';

if (!['scheduled', 'open', 'closed'].includes(phase)) {
  throw new Error('Usage: npm run demo -- [scheduled|open|closed]');
}

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}
await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once('error', (error) => reject(new Error(`Demo port ${port} is unavailable: ${error.message}`)));
  probe.listen(port, '127.0.0.1', () => {
    probe.close((error) => error ? reject(error) : resolve());
  });
});

fs.mkdirSync(demoDirectory, { recursive: true });
process.chdir(demoDirectory);
fs.rmSync(path.join(demoDirectory, 'data', 'astu_voting.sqlite'), { force: true });

const judgeIds = ['UGR/0001/15', 'UGR/0002/15'];
const voterIds = Array.from({ length: 50 }, (_, index) =>
  `UGR/${String(1000 + index).padStart(4, '0')}/26`
);
const candidateId = 'UGR/2000/26';
const demoToken = 'DEMO-ONLY-SINGLE-USE-TOKEN';
const now = Date.now();
for (const key of [
  'DOTENV_CONFIG_PATH',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_SECURE'
]) {
  delete process.env[key];
}
const electionStart = phase === 'scheduled'
  ? new Date(now + 36 * 60 * 60 * 1000).toISOString()
  : new Date(now - 5 * 60 * 1000).toISOString();
const electionEnd = phase === 'closed'
  ? new Date(now - 60 * 1000).toISOString()
  : phase === 'open'
    ? new Date(now + 2 * 60 * 60 * 1000).toISOString()
    : new Date(now + 44 * 60 * 60 * 1000).toISOString();

Object.assign(process.env, {
  DEMO_MODE: 'true',
  PORT: process.env.PORT || '3000',
  STUDENT_AFFAIRS_JUDGE_IDS: judgeIds.join(','),
  PARLIAMENT_VOTER_IDS: voterIds.join(','),
  ELECTION_START_TIME: electionStart,
  ELECTION_END_TIME: electionEnd,
  STUDENT_EMAIL_DOMAIN: 'example.invalid',
  VOTING_TOKEN_SECRET: crypto.randomBytes(32).toString('hex'),
  DEMO_VOTING_TOKEN: demoToken
});

const database = await import(pathToFileURL(path.join(backendDirectory, 'db.js')).href);
const tokenEmail = await import(pathToFileURL(path.join(backendDirectory, 'token-email.js')).href);
await database.getDb();

const passwordHash = bcrypt.hashSync('demo123', 10);
for (const ugrId of [...voterIds, candidateId]) {
  if (database.executeQueryOne('SELECT ugr_id FROM registrar_students WHERE ugr_id = ?', [ugrId])) continue;
  database.executeRun(
    `INSERT INTO registrar_students (ugr_id, name, cgpa, department, password_hash)
     VALUES (?, ?, 3.75, 'Synthetic Demo Department', ?)`,
    [ugrId, ugrId === candidateId ? 'Demo Candidate' : `Demo Voter ${ugrId.slice(4, 8)}`, passwordHash]
  );
  database.executeRun('INSERT INTO cafeteria_records (ugr_id, is_active) VALUES (?, 1)', [ugrId]);
  database.executeRun('INSERT INTO voter_registry (ugr_id, has_received_token, is_registered) VALUES (?, 0, 0)', [ugrId]);
}

database.chooseElectionParticipation(candidateId, 'CANDIDATE', {
  name: 'Demo Candidate',
  position: 'President',
  bio: 'Synthetic candidate profile for the ASTU prototype presentation.',
  manifesto: 'This proposal and all voter records in this presentation environment are synthetic.'
});

if (phase !== 'scheduled') {
  for (const voterId of voterIds) {
    database.chooseElectionParticipation(voterId, 'VOTER');
  }

  const candidates = database.executeQuery('SELECT id FROM candidates');
  for (const judgeId of judgeIds) {
    for (const candidate of candidates) {
      database.executeRun(
        `INSERT INTO judge_scores (judge_ugr_id, candidate_id, score)
         VALUES (?, ?, 17)
         ON CONFLICT(judge_ugr_id, candidate_id) DO UPDATE SET score = excluded.score`,
        [judgeId, candidate.id]
      );
    }
  }

  const ballotVoter = voterIds[0];
  const tokenHash = crypto.createHash('sha256').update(demoToken).digest('hex');
  database.createPendingTokenEmailDelivery(
    electionStart,
    ballotVoter,
    tokenHash,
    tokenEmail.encryptPendingToken(process.env.VOTING_TOKEN_SECRET, demoToken)
  );
  database.markTokenEmailDelivered(electionStart, ballotVoter);

  if (phase === 'closed') {
    for (const candidate of candidates) {
      database.executeRun('INSERT INTO votes (candidate_id) VALUES (?)', [candidate.id]);
    }
  }
}

console.log(`ASTU synthetic presentation demo (${phase} phase)`);
console.log('Synthetic data only. No real student details or SMTP credentials are used.');
console.log(`Student password: demo123`);
console.log(`Candidate account: ${candidateId}`);
console.log(`Voter account: ${voterIds[0]}${phase === 'open' ? `; demo-only ballot token: ${demoToken}` : ''}`);
console.log(`Judge accounts: ${judgeIds.join(', ')}`);
console.log('Admin account: admin (password: admin123)');
console.log(`API: http://localhost:${process.env.PORT}`);
console.log('Stop the demo with Ctrl+C. Its database is isolated under backend/demo-data/.');

await import(pathToFileURL(path.join(backendDirectory, 'server.ts')).href);
