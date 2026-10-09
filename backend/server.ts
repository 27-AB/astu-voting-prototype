import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import 'dotenv/config';
import cors from 'cors';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {
  getDb,
  executeQuery,
  executeQueryOne,
  executeRun,
  castAnonymousVote,
  performRollover
} from './db.js';

// ---------- Types ----------
interface StudentRecord {
  ugr_id: string;
  name: string;
  cgpa: number;
  department: string;
  password_hash: string;
  voter_type: 'STANDARD' | 'AUTHORITY';
  vote_weight: number;
}
interface CafeteriaRecord {
  is_active: number;
}
interface CandidateRecord {
  id: number;
  name: string;
  position: string;
  bio: string;
  manifesto: string;
}
interface AnnouncementRecord {
  id: number;
  title: string;
  body: string;
  date: string;
}
interface AdminUserRecord {
  username: string;
  password_hash: string;
  role: string;
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
const WINNING_POSITIONS = ['President', 'Vice President', 'Secretary'];

function getElectionWindow() {
  const start = process.env.ELECTION_START_TIME;
  const end = process.env.ELECTION_END_TIME;
  if (!start || !end) return null;

  const zonedIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
  if (!zonedIsoTimestamp.test(start) || !zonedIsoTimestamp.test(end)) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) return null;
  return { start, end, startMs, endMs };
}

function getElectionPhase() {
  const window = getElectionWindow();
  if (!window) return null;
  const now = Date.now();
  return {
    election_start_time: window.start,
    election_end_time: window.end,
    server_time: new Date(now).toISOString(),
    phase: now < window.startMs ? 'scheduled' : now < window.endMs ? 'open' : 'closed',
    is_open: now >= window.startMs && now < window.endMs
  };
}

function readCandidateResults() {
  return executeQuery<{
    candidate_id: number;
    name: string;
    position: string;
    votes: number;
  }>(`
    SELECT c.id AS candidate_id, c.name, c.position,
           COALESCE(SUM(v.vote_weight), 0) AS votes
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id
    ORDER BY c.position ASC, votes DESC, c.id ASC
  `);
}

app.use(cors());
app.use(express.json());

app.get('/api/election/status', (_req: Request, res: Response) => {
  const status = getElectionPhase();
  if (!status) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  res.json(status);
});

// ---------- In-memory sessions ----------
const studentSessions = new Map<string, { ugr_id: string; createdAt: number }>();
const adminSessions = new Map<string, { username: string; role: string; createdAt: number }>();

// ---------- Rate limiter ----------
interface RateLimitBucket {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitBucket>();

function rateLimiter(limit = 15, windowMs = 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip || 'anon'}_${req.path}`;
    const now = Date.now();
    let bucket = rateLimitMap.get(key);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }
    bucket.count += 1;
    rateLimitMap.set(key, bucket);

    if (bucket.count > limit) {
      res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
      return;
    }
    next();
  };
}

// ---------- Auth middlewares ----------
function requireStudentAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Login required' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const session = studentSessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    studentSessions.delete(token);
    res.status(401).json({ error: 'Session expired. Please log in again.' });
    return;
  }
  (req as any).studentUgrId = session.ugr_id;
  next();
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Admin login required' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const session = adminSessions.get(token);
  if (!session || Date.now() - session.createdAt > SESSION_TTL_MS) {
    adminSessions.delete(token);
    res.status(401).json({ error: 'Admin login required' });
    return;
  }
  (req as any).adminUser = session;
  next();
}

// ==========================================
// 1. STUDENT ENDPOINTS
// ==========================================

// POST /api/login
app.post('/api/login', rateLimiter(15, 60000), (req: Request, res: Response) => {
  const { ugr_id, password } = req.body || {};
  if (!ugr_id || !password || typeof ugr_id !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'UGR ID and password are required' });
    return;
  }

  const cleanUgrId = ugr_id.trim().toUpperCase();
  const student = executeQueryOne<StudentRecord>(
    'SELECT ugr_id, name, cgpa, department, password_hash, voter_type, vote_weight FROM registrar_students WHERE UPPER(ugr_id) = ?',
    [cleanUgrId]
  );

  if (!student || !bcrypt.compareSync(password, student.password_hash)) {
    res.status(401).json({ error: 'Invalid ID or password' });
    return;
  }

  const sessionToken = `stu_sess_${crypto.randomBytes(24).toString('hex')}`;
  studentSessions.set(sessionToken, { ugr_id: student.ugr_id, createdAt: Date.now() });

  res.json({
    token: sessionToken,
    student: {
      ugr_id: student.ugr_id,
      name: student.name,
      voter_type: student.voter_type,
      vote_weight: student.vote_weight
    }
  });
});

// GET /api/eligibility
app.get('/api/eligibility', requireStudentAuth, (req: Request, res: Response) => {
  const ugr_id = (req as any).studentUgrId as string;

  const student = executeQueryOne<StudentRecord>(
    'SELECT ugr_id, cgpa FROM registrar_students WHERE ugr_id = ?',
    [ugr_id]
  );
  if (!student) {
    res.status(404).json({ error: 'Student record not found' });
    return;
  }

  const cafeteria = executeQueryOne<CafeteriaRecord>(
    'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
    [ugr_id]
  );
  const registry = executeQueryOne<{ has_received_token: number }>(
    'SELECT has_received_token FROM voter_registry WHERE ugr_id = ?',
    [ugr_id]
  );

  const hasReceivedToken = registry?.has_received_token === 1;
  const isCafeteriaActive = cafeteria?.is_active === 1;
  const gpaOk = student.cgpa > 3.0; // exactly 3.00 is rejected
  const isEligible = gpaOk && isCafeteriaActive;

  let reason: string | null = null;
  if (!gpaOk && !isCafeteriaActive) reason = 'CGPA is below 3.0 and no active cafeteria access';
  else if (!gpaOk) reason = 'CGPA is below 3.0';
  else if (!isCafeteriaActive) reason = 'No active cafeteria access';

  res.json({
    eligible: isEligible,
    reason,
    has_received_token: hasReceivedToken
  });
});

// POST /api/token
app.post('/api/token', requireStudentAuth, rateLimiter(5, 60000), (req: Request, res: Response) => {
  const ugr_id = (req as any).studentUgrId as string;

  const student = executeQueryOne<Pick<StudentRecord, 'cgpa' | 'voter_type' | 'vote_weight'>>(
    'SELECT cgpa, voter_type, vote_weight FROM registrar_students WHERE ugr_id = ?',
    [ugr_id]
  );
  const cafeteria = executeQueryOne<CafeteriaRecord>(
    'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
    [ugr_id]
  );

  if (!student || !cafeteria) {
    res.status(404).json({ error: 'Student records not found' });
    return;
  }

  // Make sure a registry row exists so the "already received" flag always works
  executeRun('INSERT OR IGNORE INTO voter_registry (ugr_id, has_received_token) VALUES (?, 0)', [ugr_id]);
  const registry = executeQueryOne<{ has_received_token: number }>(
    'SELECT has_received_token FROM voter_registry WHERE ugr_id = ?',
    [ugr_id]
  );

  if (student.cgpa <= 3.0 || cafeteria.is_active !== 1) {
    res.status(403).json({ error: 'You are not eligible to vote' });
    return;
  }

  if (registry?.has_received_token === 1) {
    res.status(403).json({ error: 'You have already received a token' });
    return;
  }

  // Mark as claimed FIRST so a crash or double click can never issue two tokens
  executeRun('UPDATE voter_registry SET has_received_token = 1 WHERE ugr_id = ?', [ugr_id]);

  // 128-bit random token, e.g. 7F89-A21B-4C90-D3E1-....
  const hex = crypto.randomBytes(16).toString('hex').toUpperCase();
  const rawToken = hex.match(/.{4}/g)!.join('-');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Only the hash is stored, with NO link to the student
  executeRun(
    'INSERT INTO tokens (token_hash, is_used, vote_weight) VALUES (?, 0, ?)',
    [tokenHash, student.vote_weight]
  );

  res.json({ token: rawToken });
});

// ==========================================
// 2. PUBLIC / BALLOT ENDPOINTS
// ==========================================

// GET /api/candidates
app.get('/api/candidates', (_req: Request, res: Response) => {
  const candidates = executeQuery<CandidateRecord>(
    'SELECT id, name, position, bio, manifesto FROM candidates ORDER BY position ASC, name ASC'
  );
  res.json(candidates);
});

// POST /api/vote (anonymous token is the proof; vote weight comes from its server-side record)
app.post('/api/vote', rateLimiter(20, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase === 'scheduled') {
    res.status(403).json({ error: 'Election has not started' });
    return;
  }
  if (phase.phase === 'closed') {
    res.status(403).json({ error: 'Election Closed' });
    return;
  }

  const { token, candidate_id, votes } = req.body || {};

  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'Token is missing' });
    return;
  }

  const cleanToken = token.trim().toUpperCase();
  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

  // Accept a single candidate_id, or an array "votes" (one per position)
  const ids: number[] = [];
  if (Array.isArray(votes) && votes.length > 0 && votes.every(Number.isInteger)) {
    ids.push(...votes);
  } else if (candidate_id !== undefined && candidate_id !== null) {
    if (Number.isInteger(candidate_id)) ids.push(candidate_id);
  }

  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    res.status(400).json({ error: 'Candidate does not exist' });
    return;
  }

  const result = castAnonymousVote(tokenHash, ids);
  if (result.status === 'invalid-token') {
    res.status(400).json({ error: 'Invalid token' });
    return;
  }
  if (result.status === 'used-token') {
    res.status(400).json({ error: 'Token already used' });
    return;
  }
  if (result.status === 'invalid-candidate') {
    res.status(400).json({ error: 'Candidate does not exist' });
    return;
  }
  if (result.status === 'duplicate-position') {
    res.status(400).json({ error: 'Only one candidate per position is allowed' });
    return;
  }

  res.json({ message: 'Vote recorded', vote_weight: result.voteWeight });
});

// GET /api/announcements
app.get('/api/announcements', (_req: Request, res: Response) => {
  const announcements = executeQuery<AnnouncementRecord>(
    'SELECT id, title, body, date FROM announcements ORDER BY id DESC'
  );
  res.json(announcements);
});

// ==========================================
// 3. ADMIN ENDPOINTS
// ==========================================

// POST /api/admin/login
app.post('/api/admin/login', rateLimiter(10, 60000), (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password || typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Admin username and password are required' });
    return;
  }

  const admin = executeQueryOne<AdminUserRecord>(
    'SELECT * FROM admin_users WHERE username = ?',
    [username.trim()]
  );

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    res.status(401).json({ error: 'Invalid admin login' });
    return;
  }

  const adminToken = `adm_sess_${crypto.randomBytes(24).toString('hex')}`;
  adminSessions.set(adminToken, { username: admin.username, role: admin.role, createdAt: Date.now() });

  res.json({ token: adminToken });
});

// POST /api/admin/candidates
app.post('/api/admin/candidates', requireAdminAuth, (req: Request, res: Response) => {
  const { name, position, bio, manifesto } = req.body || {};
  if (!name || !position) {
    res.status(400).json({ error: 'Name and position are required' });
    return;
  }
  executeRun('INSERT INTO candidates (name, position, bio, manifesto) VALUES (?,?,?,?)', [
    name,
    position,
    bio || '',
    manifesto || ''
  ]);
  const id = executeQueryOne<{ id: number }>('SELECT last_insert_rowid() as id')!.id;
  res.status(201).json({ id, name, position, bio: bio || '', manifesto: manifesto || '' });
});

// PUT /api/admin/candidates/:id
app.put('/api/admin/candidates/:id', requireAdminAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const { name, position, bio, manifesto } = req.body || {};
  if (!executeQueryOne('SELECT id FROM candidates WHERE id = ?', [id])) {
    res.status(404).json({ error: 'Candidate does not exist' });
    return;
  }
  if (!name || !position) {
    res.status(400).json({ error: 'Name and position are required' });
    return;
  }
  executeRun('UPDATE candidates SET name = ?, position = ?, bio = ?, manifesto = ? WHERE id = ?', [
    name,
    position,
    bio || '',
    manifesto || '',
    id
  ]);
  res.json({ id, name, position, bio: bio || '', manifesto: manifesto || '' });
});

// DELETE /api/admin/candidates/:id
app.delete('/api/admin/candidates/:id', requireAdminAuth, (req: Request, res: Response) => {
  const id = Number(req.params.id);
  executeRun('DELETE FROM votes WHERE candidate_id = ?', [id]); // avoid orphan votes
  executeRun('DELETE FROM candidates WHERE id = ?', [id]);
  res.json({ message: 'Candidate deleted' });
});

// POST /api/admin/announcements
app.post('/api/admin/announcements', requireAdminAuth, (req: Request, res: Response) => {
  const { title, body } = req.body || {};
  if (!title || !body) {
    res.status(400).json({ error: 'Title and body are required' });
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  executeRun('INSERT INTO announcements (title, body, date) VALUES (?,?,?)', [title, body, date]);
  const id = executeQueryOne<{ id: number }>('SELECT last_insert_rowid() as id')!.id;
  res.status(201).json({ id, title, body, date });
});

// DELETE /api/admin/announcements/:id
app.delete('/api/admin/announcements/:id', requireAdminAuth, (req: Request, res: Response) => {
  executeRun('DELETE FROM announcements WHERE id = ?', [Number(req.params.id)]);
  res.json({ message: 'Announcement deleted' });
});

// GET /api/admin/results
app.get('/api/admin/results', requireAdminAuth, (_req: Request, res: Response) => {
  const eligibleVoters =
    executeQueryOne<{ count: number }>(`
      SELECT COUNT(*) as count
      FROM registrar_students s
      JOIN cafeteria_records c ON s.ugr_id = c.ugr_id
      WHERE s.cgpa > 3.00 AND c.is_active = 1
    `)?.count || 0;

  const tokensUsed =
    executeQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM tokens WHERE is_used = 1')?.count || 0;

  const candidateResults = readCandidateResults();

  const percent = eligibleVoters > 0 ? Number(((tokensUsed / eligibleVoters) * 100).toFixed(1)) : 0;

  res.json({
    turnout: {
      votes_cast: tokensUsed,
      eligible_voters: eligibleVoters,
      percent
    },
    results: candidateResults
  });
});

app.get('/api/results', requireStudentAuth, (_req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'closed') {
    res.status(403).json({ error: 'Final results are available after the election closes' });
    return;
  }

  const results = readCandidateResults();
  const winners = WINNING_POSITIONS.flatMap((position) => {
    const winner = results.find((candidate) => candidate.position.toLowerCase() === position.toLowerCase());
    return winner ? [{ ...winner, position }] : [];
  });
  res.json({ election_end_time: phase.election_end_time, winners, results });
});

// POST /api/admin/rollover
app.post('/api/admin/rollover', requireAdminAuth, (_req: Request, res: Response) => {
  try {
    performRollover();
    res.json({ message: 'New academic year started. Registry, tokens and votes reset.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Rollover failed: ' + err.message });
  }
});

// ---------- Start ----------
async function startServer() {
  await getDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ASTU Voting Backend] Running on port ${PORT}`);
  });
}

startServer();