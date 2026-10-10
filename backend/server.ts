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
  getConfiguredParliamentIds,
  getCandidateRankings,
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
  student_ugr_id?: string | null;
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
  const candidateCount = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM candidates'
  )?.count || 0;
  const missingPositions = executeQueryOne<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT position
      FROM candidates
      WHERE position IN ('President', 'Vice President', 'Secretary')
      GROUP BY position
    )
  `)?.count !== WINNING_POSITIONS.length;
  const incompleteJudging = executeQueryOne<{ count: number }>(`
    SELECT COUNT(*) AS count
    FROM candidates c
    WHERE (
      SELECT COUNT(DISTINCT js.judge_ugr_id)
      FROM judge_scores js
      JOIN registrar_students judges ON judges.ugr_id = js.judge_ugr_id
      WHERE js.candidate_id = c.id AND judges.voter_type = 'AUTHORITY'
    ) < 2
  `)?.count || 0;
  return {
    election_start_time: window.start,
    election_end_time: window.end,
    server_time: new Date(now).toISOString(),
    phase: now < window.startMs ? 'scheduled' : now < window.endMs ? 'open' : 'closed',
    is_open: now >= window.startMs && now < window.endMs,
    judging_complete: candidateCount > 0 && !missingPositions && incompleteJudging === 0
  };
}

function getParliamentVoterIds(res: Response) {
  try {
    const ids = getConfiguredParliamentIds();
    const placeholders = ids.map(() => '?').join(', ');
    const eligible = executeQuery<{ ugr_id: string }>(
      `SELECT s.ugr_id
       FROM registrar_students s
       JOIN cafeteria_records c ON c.ugr_id = s.ugr_id
       WHERE UPPER(s.ugr_id) IN (${placeholders})
         AND s.voter_type = 'STANDARD'
         AND s.cgpa > 3
         AND c.is_active = 1`,
      ids
    );
    if (eligible.length !== ids.length) {
      res.status(503).json({ error: 'Parliament roster must contain only registered, eligible non-judge voters' });
      return null;
    }
    return ids;
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : 'Parliament roster is invalid' });
    return null;
  }
}

function readCandidateResults() {
  return getCandidateRankings();
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

function requireJudgeAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const sessionToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const ugrId = studentSessions.get(sessionToken)?.ugr_id;
  if (!ugrId) {
    res.status(401).json({ error: 'Judge login required' });
    return;
  }
  const judge = executeQueryOne<{ voter_type: string }>(
    'SELECT voter_type FROM registrar_students WHERE ugr_id = ?',
    [ugrId]
  );
  if (judge?.voter_type !== 'AUTHORITY') {
    res.status(403).json({ error: 'Only appointed student affairs judges may score proposals' });
    return;
  }
  (req as any).judgeUgrId = ugrId;
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
    'SELECT ugr_id, name, cgpa, department, password_hash, voter_type FROM registrar_students WHERE UPPER(ugr_id) = ?',
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
      is_candidate: Boolean(executeQueryOne('SELECT id FROM candidates WHERE student_ugr_id = ?', [student.ugr_id]))
    }
  });
});

// GET /api/eligibility
app.get('/api/eligibility', requireStudentAuth, (req: Request, res: Response) => {
  const ugr_id = (req as any).studentUgrId as string;

  const student = executeQueryOne<Pick<StudentRecord, 'ugr_id' | 'cgpa'>>(
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
  const registry = executeQueryOne<{ has_received_token: number; is_registered: number }>(
    'SELECT has_received_token, is_registered FROM voter_registry WHERE ugr_id = ?',
    [ugr_id]
  );
  const parliamentIds = getParliamentVoterIds(res);
  if (!parliamentIds) return;

  const hasReceivedToken = registry?.has_received_token === 1;
  const isCafeteriaActive = cafeteria?.is_active === 1;
  const gpaOk = student.cgpa > 3.0; // exactly 3.00 is rejected
  const isParliamentMember = parliamentIds.includes(ugr_id.toUpperCase());
  const isEligible = gpaOk && isCafeteriaActive && isParliamentMember;

  let reason: string | null = null;
  if (!gpaOk && !isCafeteriaActive) reason = 'CGPA is below 3.0 and no active cafeteria access';
  else if (!gpaOk) reason = 'CGPA is below 3.0';
  else if (!isCafeteriaActive) reason = 'No active cafeteria access';
  else if (!isParliamentMember) reason = 'Not on the approved parliament voter roster';

  res.json({
    eligible: isEligible,
    reason,
    has_received_token: hasReceivedToken,
    parliament_member: isParliamentMember,
    registered_for_election: registry?.is_registered === 1
  });
});

app.post('/api/election/register', requireStudentAuth, rateLimiter(5, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Voter registration has closed' });
    return;
  }

  const ugrId = (req as any).studentUgrId as string;
  const memberIds = getParliamentVoterIds(res);
  if (!memberIds) return;
  if (!memberIds.includes(ugrId.toUpperCase())) {
    res.status(403).json({ error: 'You are not on the registered parliament voter list' });
    return;
  }
  const student = executeQueryOne<{ cgpa: number; voter_type: string }>(
    'SELECT cgpa, voter_type FROM registrar_students WHERE ugr_id = ?',
    [ugrId]
  );
  const cafeteria = executeQueryOne<{ is_active: number }>(
    'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
    [ugrId]
  );
  if (!student || student.voter_type !== 'STANDARD' || student.cgpa <= 3 || cafeteria?.is_active !== 1) {
    res.status(403).json({ error: 'Only eligible parliamentary voters may register' });
    return;
  }

  executeRun(
    'INSERT OR IGNORE INTO voter_registry (ugr_id, has_received_token, is_registered) VALUES (?, 0, 1)',
    [ugrId]
  );
  const registration = executeQueryOne<{ is_registered: number }>(
    'SELECT is_registered FROM voter_registry WHERE ugr_id = ?',
    [ugrId]
  );
  if (registration?.is_registered !== 1) {
    executeRun('UPDATE voter_registry SET is_registered = 1 WHERE ugr_id = ?', [ugrId]);
  }
  res.status(201).json({ message: 'You are registered as a parliamentary voter' });
});

// POST /api/token
app.post('/api/token', requireStudentAuth, rateLimiter(5, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'open' || !phase.judging_complete) {
    res.status(403).json({ error: 'Voting tokens are issued only while voting is open and judging is complete' });
    return;
  }
  const ugr_id = (req as any).studentUgrId as string;
  const parliamentIds = getParliamentVoterIds(res);
  if (!parliamentIds) return;
  if (!parliamentIds.includes(ugr_id.toUpperCase())) {
    res.status(403).json({ error: 'Only configured parliament voters may request a ballot token' });
    return;
  }

  const student = executeQueryOne<Pick<StudentRecord, 'cgpa' | 'voter_type'>>(
    'SELECT cgpa, voter_type FROM registrar_students WHERE ugr_id = ?',
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
  const registry = executeQueryOne<{ has_received_token: number; is_registered: number }>(
    'SELECT has_received_token, is_registered FROM voter_registry WHERE ugr_id = ?',
    [ugr_id]
  );

  if (student.cgpa <= 3.0 || cafeteria.is_active !== 1 || student.voter_type !== 'STANDARD') {
    res.status(403).json({ error: 'You are not eligible to vote as a parliamentary member' });
    return;
  }

  if (registry?.is_registered !== 1) {
    res.status(403).json({ error: 'Register as an eligible parliamentary voter before requesting a ballot' });
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
    'INSERT INTO tokens (token_hash, is_used) VALUES (?, 0)',
    [tokenHash]
  );

  res.json({ token: rawToken });
});

// ==========================================
// 2. PUBLIC / BALLOT ENDPOINTS
// ==========================================

// GET /api/candidates
app.get('/api/candidates', (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase === 'scheduled') {
    const authHeader = req.headers.authorization;
    const adminToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const adminSession = adminSessions.get(adminToken);
    if (!adminSession || Date.now() - adminSession.createdAt > SESSION_TTL_MS) {
      res.status(403).json({ error: 'Candidate proposals are available to admins before voting opens' });
      return;
    }
    res.json(executeQuery<CandidateRecord>(
      'SELECT id, name, position, bio, manifesto FROM candidates ORDER BY position ASC, name ASC'
    ));
    return;
  }
  if (phase.phase === 'closed' && !phase.judging_complete) {
    res.status(503).json({ error: 'Candidate evaluation results are unavailable because judging is incomplete' });
    return;
  }

  const candidates = executeQuery<CandidateRecord>(
    'SELECT id, name, position, bio, manifesto FROM candidates ORDER BY position ASC, name ASC'
  );
  if (phase.phase === 'open') {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const session = studentSessions.get(token);
    const allowedIds = getParliamentVoterIds(res);
    if (!allowedIds) return;
    const activeSession = session && Date.now() - session.createdAt <= SESSION_TTL_MS ? session : null;
    if (session && !activeSession) studentSessions.delete(token);
    const registration = activeSession
      ? executeQueryOne<{ is_registered: number }>(
        'SELECT is_registered FROM voter_registry WHERE ugr_id = ?',
        [activeSession.ugr_id]
      )
      : null;
    if (!activeSession || !allowedIds.includes(activeSession.ugr_id.toUpperCase()) || registration?.is_registered !== 1) {
      res.status(403).json({ error: 'Only registered parliament voters may view live proposal scores' });
      return;
    }
  }
  const results = readCandidateResults();
  res.json(candidates.map((candidate) => ({
    ...candidate,
    ...(results.find((result) => result.candidate_id === candidate.id) || {})
  })));
});

// POST /api/vote (the anonymous token represents one complete parliamentary ballot)
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
  if (!phase.judging_complete) {
    res.status(403).json({ error: 'Judges must score every candidate before voting opens' });
    return;
  }

  const { token, candidate_id, votes } = req.body || {};

  if (!token || typeof token !== 'string' || !token.trim()) {
    res.status(400).json({ error: 'Token is missing' });
    return;
  }

  const cleanToken = token.trim().toUpperCase();
  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

  // Accept the full candidate selection array; a single selection is rejected below.
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
  if (result.status === 'incomplete-ballot') {
    res.status(400).json({ error: 'Select one candidate for President, Vice President, and Secretary' });
    return;
  }

  res.json({ message: 'Vote recorded' });
});

app.get('/api/judge/candidates', requireJudgeAuth, (req: Request, res: Response) => {
  const judgeUgrId = (req as any).judgeUgrId as string;
  const candidates = executeQuery<CandidateRecord>(
    `SELECT c.id, c.name, c.position, c.bio, c.manifesto,
            js.score AS my_score
     FROM candidates c
     LEFT JOIN judge_scores js ON js.candidate_id = c.id AND js.judge_ugr_id = ?
     ORDER BY c.position, c.name`,
    [judgeUgrId]
  );
  res.json(candidates);
});

app.put('/api/judge/scores/:candidateId', requireJudgeAuth, rateLimiter(30, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase === 'closed') {
    res.status(403).json({ error: 'Judge scoring is closed' });
    return;
  }
  const candidateId = Number(req.params.candidateId);
  const { score } = req.body || {};
  if (!Number.isInteger(candidateId) || !Number.isInteger(score) || score < 0 || score > 20) {
    res.status(400).json({ error: 'Candidate ID and an integer score from 0 to 20 are required' });
    return;
  }
  if (!executeQueryOne('SELECT id FROM candidates WHERE id = ?', [candidateId])) {
    res.status(404).json({ error: 'Candidate does not exist' });
    return;
  }
  const judgeUgrId = (req as any).judgeUgrId as string;
  executeRun(
    `INSERT INTO judge_scores (judge_ugr_id, candidate_id, score, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(judge_ugr_id, candidate_id)
     DO UPDATE SET score = excluded.score, updated_at = CURRENT_TIMESTAMP`,
    [judgeUgrId, candidateId, score]
  );
  res.json({ candidate_id: candidateId, score });
});

app.get('/api/candidate/dashboard', requireStudentAuth, (req: Request, res: Response) => {
  const ugrId = (req as any).studentUgrId as string;
  const candidate = executeQueryOne<{ id: number }>(
    'SELECT id FROM candidates WHERE student_ugr_id = ?',
    [ugrId]
  );
  if (!candidate) {
    res.status(403).json({ error: 'No candidate profile is linked to this account' });
    return;
  }
  const phase = getElectionPhase();
  if (phase?.phase !== 'closed' || !phase.judging_complete) {
    if (phase?.phase === 'closed' && !phase.judging_complete) {
      res.status(503).json({ error: 'Candidate rankings are unavailable because judging is incomplete' });
      return;
    }
    res.json({
      candidate_id: candidate.id,
      phase: phase?.phase || 'unconfigured',
      results_published: false,
      standings: [],
      own_standing: null
    });
    return;
  }
  const rankings = readCandidateResults().filter((row) =>
    WINNING_POSITIONS.includes(row.position)
  );
  res.json({
    candidate_id: candidate.id,
    phase: phase?.phase || 'unconfigured',
    results_published: true,
    standings: rankings,
    own_standing: rankings.find((row) => row.candidate_id === candidate.id) || null
  });
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
  const phase = getElectionPhase();
  if (!phase || phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Candidates can only be added before the election starts' });
    return;
  }
  if (executeQueryOne('SELECT 1 FROM judge_scores LIMIT 1')) {
    res.status(403).json({ error: 'Candidate roster is locked after judges begin scoring' });
    return;
  }
  const { name, position, bio, manifesto, student_ugr_id: studentUgrId } = req.body || {};
  if (!name || !WINNING_POSITIONS.includes(position) || typeof studentUgrId !== 'string') {
    res.status(400).json({ error: 'Name, a valid position, proposal, and candidate student ID are required' });
    return;
  }
  const candidateStudent = executeQueryOne<{ ugr_id: string; voter_type: string }>(
    'SELECT ugr_id, voter_type FROM registrar_students WHERE UPPER(ugr_id) = ?',
    [studentUgrId.trim().toUpperCase()]
  );
  if (!candidateStudent || candidateStudent.voter_type !== 'STANDARD') {
    res.status(400).json({ error: 'Candidate student must be a registered non-judge voter' });
    return;
  }
  if (executeQueryOne('SELECT id FROM candidates WHERE student_ugr_id = ?', [candidateStudent.ugr_id])) {
    res.status(409).json({ error: 'This student already has a candidate profile' });
    return;
  }
  executeRun('INSERT INTO candidates (name, position, bio, manifesto, student_ugr_id) VALUES (?,?,?,?,?)', [
    name,
    position,
    bio || '',
    manifesto || '',
    candidateStudent.ugr_id
  ]);
  const id = executeQueryOne<{ id: number }>('SELECT last_insert_rowid() as id')!.id;
  res.status(201).json({ id, name, position, bio: bio || '', manifesto: manifesto || '', student_ugr_id: candidateStudent.ugr_id });
});

// PUT /api/admin/candidates/:id
app.put('/api/admin/candidates/:id', requireAdminAuth, (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase || phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Candidate profiles are locked once the election starts' });
    return;
  }
  const id = Number(req.params.id);
  const { name, position, bio, manifesto, student_ugr_id: studentUgrId } = req.body || {};
  if (!executeQueryOne('SELECT id FROM candidates WHERE id = ?', [id])) {
    res.status(404).json({ error: 'Candidate does not exist' });
    return;
  }
  if (executeQueryOne('SELECT 1 FROM judge_scores LIMIT 1')) {
    res.status(403).json({ error: 'Candidate proposals are locked after judges begin scoring' });
    return;
  }
  if (!name || !WINNING_POSITIONS.includes(position) || typeof studentUgrId !== 'string') {
    res.status(400).json({ error: 'Name, a valid position, proposal, and candidate student ID are required' });
    return;
  }
  const candidateStudent = executeQueryOne<{ ugr_id: string; voter_type: string }>(
    'SELECT ugr_id, voter_type FROM registrar_students WHERE UPPER(ugr_id) = ?',
    [studentUgrId.trim().toUpperCase()]
  );
  if (!candidateStudent || candidateStudent.voter_type !== 'STANDARD') {
    res.status(400).json({ error: 'Candidate student must be a registered non-judge voter' });
    return;
  }
  if (executeQueryOne(
    'SELECT id FROM candidates WHERE student_ugr_id = ? AND id != ?',
    [candidateStudent.ugr_id, id]
  )) {
    res.status(409).json({ error: 'This student already has another candidate profile' });
    return;
  }
  executeRun('UPDATE candidates SET name = ?, position = ?, bio = ?, manifesto = ?, student_ugr_id = ? WHERE id = ?', [
    name,
    position,
    bio || '',
    manifesto || '',
    candidateStudent.ugr_id,
    id
  ]);
  res.json({ id, name, position, bio: bio || '', manifesto: manifesto || '', student_ugr_id: candidateStudent.ugr_id });
});

// DELETE /api/admin/candidates/:id
app.delete('/api/admin/candidates/:id', requireAdminAuth, (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase || phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Candidate profiles are locked once the election starts' });
    return;
  }
  const id = Number(req.params.id);
  if (
    executeQueryOne('SELECT 1 FROM votes WHERE candidate_id = ? LIMIT 1', [id]) ||
    executeQueryOne('SELECT 1 FROM judge_scores WHERE candidate_id = ? LIMIT 1', [id])
  ) {
    res.status(409).json({ error: 'A candidate with votes or judge scores cannot be removed from the election record' });
    return;
  }
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
  const eligibleVoters = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) AS count FROM voter_registry WHERE is_registered = 1'
  )?.count || 0;

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

app.get('/api/admin/judging-results', requireAdminAuth, (_req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Admin pre-election judging review is only available before voting opens' });
    return;
  }
  const results = executeQuery<{
    candidate_id: number;
    candidate_name: string;
    position: string;
    manifesto: string;
    judge_ugr_id: string;
    judge_name: string;
    score: number;
    updated_at: string;
  }>(`
    SELECT c.id AS candidate_id, c.name AS candidate_name, c.position, c.manifesto,
           js.judge_ugr_id, s.name AS judge_name, js.score, js.updated_at
    FROM candidates c
    LEFT JOIN judge_scores js ON js.candidate_id = c.id
    LEFT JOIN registrar_students s ON s.ugr_id = js.judge_ugr_id
    ORDER BY c.position, c.name, js.judge_ugr_id
  `);
  res.json({ judging_complete: getElectionPhase()?.judging_complete || false, results });
});

app.get('/api/results', (_req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'closed') {
    res.status(403).json({ error: 'Final results are available after the election closes' });
    return;
  }
  if (!phase.judging_complete) {
    res.status(503).json({ error: 'Final results are unavailable until both judges score every candidate' });
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