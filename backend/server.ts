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
  chooseElectionParticipation,
  hasTokenEmailDeliveryRecord,
  createPendingTokenEmailDelivery,
  getPendingTokenEmailDeliveries,
  isTokenEmailDelivered,
  recordTokenEmailAttempt,
  markTokenEmailDelivered,
  discardPendingTokenEmailDeliveries,
  getCandidateRankings,
  performRollover
} from './db.js';
import {
  createSmtpTransport,
  decryptPendingToken,
  encryptPendingToken,
  generateVotingToken,
  getStudentEmailAddress
} from './token-email.js';

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
const TOKEN_EMAIL_LEAD_MS = 12 * 60 * 60 * 1000;
const TOKEN_EMAIL_RETRY_MS = 60 * 1000;
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
    registration_deadline: new Date(window.startMs - TOKEN_EMAIL_LEAD_MS).toISOString(),
    registration_open: now < window.startMs - TOKEN_EMAIL_LEAD_MS,
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

function isCandidateAccount(ugrId: string) {
  return Boolean(executeQueryOne(
    `SELECT c.id
     FROM candidates c
     JOIN election_participation ep ON ep.ugr_id = c.student_ugr_id
     JOIN registrar_students s ON s.ugr_id = c.student_ugr_id
     WHERE c.student_ugr_id = ? AND ep.choice = 'CANDIDATE' AND s.voter_type = 'STANDARD'`,
    [ugrId]
  ));
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
  const participation = executeQueryOne<{ choice: string }>(
    'SELECT choice FROM election_participation WHERE ugr_id = ?',
    [student.ugr_id]
  );
  const isCandidate = Boolean(executeQueryOne(
    'SELECT id FROM candidates WHERE student_ugr_id = ?',
    [student.ugr_id]
  ));

  res.json({
    token: sessionToken,
    student: {
      ugr_id: student.ugr_id,
      name: student.name,
      voter_type: student.voter_type,
      election_role: student.voter_type === 'AUTHORITY' ? 'JUDGE' : participation?.choice || null,
      is_candidate: isCandidate
    }
  });
});

app.get('/api/election/participation', requireStudentAuth, (req: Request, res: Response) => {
  const ugrId = (req as any).studentUgrId as string;
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  const student = executeQueryOne<{ name: string; voter_type: string }>(
    'SELECT name, voter_type FROM registrar_students WHERE ugr_id = ?',
    [ugrId]
  );
  if (!student) {
    res.status(404).json({ error: 'Student record not found' });
    return;
  }
  const participation = executeQueryOne<{ choice: string; updated_at: string }>(
    'SELECT choice, updated_at FROM election_participation WHERE ugr_id = ?',
    [ugrId]
  );
  const profile = isCandidateAccount(ugrId)
    ? executeQueryOne<{
      id: number; name: string; position: string; bio: string; manifesto: string;
    }>(
      'SELECT id, name, position, bio, manifesto FROM candidates WHERE student_ugr_id = ?',
      [ugrId]
    )
    : null;
  const parliamentIds = getParliamentVoterIds(res);
  if (!parliamentIds) return;
  const cafeteria = executeQueryOne<{ is_active: number }>(
    'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
    [ugrId]
  );
  const eligibleVoter = student.voter_type === 'STANDARD' &&
    parliamentIds.includes(ugrId.toUpperCase()) &&
    Boolean(executeQueryOne<{ cgpa: number }>(
      'SELECT cgpa FROM registrar_students WHERE ugr_id = ? AND cgpa > 3',
      [ugrId]
    )) &&
    cafeteria?.is_active === 1;
  res.json({
    election_role: student.voter_type === 'AUTHORITY' ? 'JUDGE' : participation?.choice || null,
    choice_updated_at: participation?.updated_at || null,
    eligible_voter: eligibleVoter,
    candidate_profile: profile,
    can_change_choice: student.voter_type === 'STANDARD' &&
      phase.phase === 'scheduled' && phase.registration_open,
    can_edit_candidate_profile: Boolean(profile) && phase.phase === 'scheduled'
  });
});

app.post('/api/election/participation', requireStudentAuth, rateLimiter(10, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'scheduled' || !phase.registration_open) {
    res.status(403).json({ error: 'Election role selection closes 12 hours before the election starts' });
    return;
  }

  const ugrId = (req as any).studentUgrId as string;
  const student = executeQueryOne<{ name: string; voter_type: string; cgpa: number }>(
    'SELECT name, voter_type, cgpa FROM registrar_students WHERE ugr_id = ?',
    [ugrId]
  );
  if (!student) {
    res.status(404).json({ error: 'Student record not found' });
    return;
  }
  if (student.voter_type !== 'STANDARD') {
    res.status(403).json({ error: 'Appointed judges do not select a candidate or voter role' });
    return;
  }

  const { choice, position, bio, manifesto } = req.body || {};
  if (!['CANDIDATE', 'VOTER', 'NONE'].includes(choice)) {
    res.status(400).json({ error: 'Choose candidate, voter, or no election registration' });
    return;
  }
  if (choice === 'CANDIDATE' && (
    !WINNING_POSITIONS.includes(position) ||
    typeof bio !== 'string' || bio.trim().length < 2 || bio.trim().length > 500 ||
    typeof manifesto !== 'string' || manifesto.trim().length < 20 || manifesto.trim().length > 5000
  )) {
    res.status(400).json({ error: 'Candidate profile requires a position, a 2–500 character bio, and a 20–5000 character manifesto' });
    return;
  }
  if (choice === 'VOTER') {
    const parliamentIds = getParliamentVoterIds(res);
    if (!parliamentIds) return;
    const cafeteria = executeQueryOne<{ is_active: number }>(
      'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
      [ugrId]
    );
    if (
      !parliamentIds.includes(ugrId.toUpperCase()) ||
      student.cgpa <= 3 ||
      cafeteria?.is_active !== 1
    ) {
      res.status(403).json({ error: 'Only approved parliament members with CGPA above 3.0 and active cafeteria access may register as voters' });
      return;
    }
  }

  const result = chooseElectionParticipation(
    ugrId,
    choice,
    choice === 'CANDIDATE'
      ? { name: student.name, position, bio: bio.trim(), manifesto: manifesto.trim() }
      : null
  );
  if (result.status === 'candidate-has-votes') {
    res.status(409).json({ error: 'A candidate with recorded votes cannot change election roles' });
    return;
  }
  res.json({
    election_role: result.choice,
    candidate_id: result.candidate_id,
    message: 'Election participation choice saved'
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
  const participation = executeQueryOne<{ choice: string }>(
    'SELECT choice FROM election_participation WHERE ugr_id = ?',
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
    registered_for_election: registry?.is_registered === 1 && participation?.choice === 'VOTER',
    election_role: participation?.choice || null,
    demo_mode: process.env.DEMO_MODE === 'true'
  });
});

app.post('/api/election/register', requireStudentAuth, rateLimiter(5, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'scheduled' || !phase.registration_open) {
    res.status(403).json({ error: 'Parliament voter registration closes 12 hours before the election starts' });
    return;
  }

  const ugrId = (req as any).studentUgrId as string;
  const participation = executeQueryOne<{ choice: string }>(
    'SELECT choice FROM election_participation WHERE ugr_id = ?',
    [ugrId]
  );
  if (participation && participation.choice !== 'VOTER') {
    res.status(409).json({ error: 'Your selected election role is not voter. Change your role before the registration deadline.' });
    return;
  }
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

  chooseElectionParticipation(ugrId, 'VOTER');
  res.status(201).json({ message: 'You are registered as a parliamentary voter' });
});

// POST /api/token
app.post('/api/token', requireStudentAuth, rateLimiter(5, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'open') {
    res.status(403).json({ error: 'Voting tokens are available only during the election' });
    return;
  }
  const ugr_id = (req as any).studentUgrId as string;
  const parliamentIds = getParliamentVoterIds(res);
  if (!parliamentIds) return;
  if (!parliamentIds.includes(ugr_id.toUpperCase())) {
    res.status(403).json({ error: 'Only configured parliament voters may request a ballot token' });
    return;
  }
  const participation = executeQueryOne<{ choice: string }>(
    'SELECT choice FROM election_participation WHERE ugr_id = ?',
    [ugr_id]
  );
  if (participation?.choice !== 'VOTER') {
    res.status(403).json({ error: 'Select and register as a voter before requesting a ballot token' });
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

  // Ensure the participant has a registry row before checking registration and delivery.
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
    res.status(403).json({ error: 'Register as an eligible parliamentary voter before requesting a ballot token' });
    return;
  }
  const electionWindow = getElectionWindow();
  if (!electionWindow || !isTokenEmailDelivered(electionWindow.start, ugr_id)) {
    res.status(503).json({ error: 'Your voting token email has not been delivered yet. Contact the election administrator if voting is open.' });
    return;
  }

  res.json({
    email_sent: true,
    message: process.env.DEMO_MODE === 'true'
      ? 'Synthetic demo token ready. No email was sent.'
      : 'Your voting token was sent to your registered student email address.',
    demo_mode: process.env.DEMO_MODE === 'true',
    ...(process.env.DEMO_MODE === 'true' && process.env.DEMO_VOTING_TOKEN
      ? { demo_token: process.env.DEMO_VOTING_TOKEN }
      : {})
  });
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
  if (!isCandidateAccount(ugrId)) {
    res.status(403).json({ error: 'This account has not selected the candidate role' });
    return;
  }
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

app.get('/api/candidate/profile', requireStudentAuth, (req: Request, res: Response) => {
  const ugrId = (req as any).studentUgrId as string;
  if (!isCandidateAccount(ugrId)) {
    res.status(403).json({ error: 'Candidate profile access is restricted to its student owner' });
    return;
  }
  const profile = executeQueryOne<{
    id: number; name: string; position: string; bio: string; manifesto: string;
  }>(
    'SELECT id, name, position, bio, manifesto FROM candidates WHERE student_ugr_id = ?',
    [ugrId]
  );
  if (!profile) {
    res.status(403).json({ error: 'No candidate profile is linked to this account' });
    return;
  }
  res.json(profile);
});

app.put('/api/candidate/profile', requireStudentAuth, rateLimiter(10, 60000), (req: Request, res: Response) => {
  const phase = getElectionPhase();
  if (!phase) {
    res.status(503).json({ error: 'Election schedule is not configured correctly' });
    return;
  }
  if (phase.phase !== 'scheduled') {
    res.status(403).json({ error: 'Candidate profiles are locked once the election starts' });
    return;
  }
  const ugrId = (req as any).studentUgrId as string;
  if (!isCandidateAccount(ugrId)) {
    res.status(403).json({ error: 'Candidate profiles can only be edited by their student owner' });
    return;
  }
  const profile = executeQueryOne<{ id: number }>(
    'SELECT id FROM candidates WHERE student_ugr_id = ?',
    [ugrId]
  );
  if (!profile) {
    res.status(403).json({ error: 'Candidates may edit only their own linked profile' });
    return;
  }
  const { position, bio, manifesto } = req.body || {};
  if (
    !WINNING_POSITIONS.includes(position) ||
    typeof bio !== 'string' || bio.trim().length < 2 || bio.trim().length > 500 ||
    typeof manifesto !== 'string' || manifesto.trim().length < 20 || manifesto.trim().length > 5000
  ) {
    res.status(400).json({ error: 'Candidate profile requires a valid position, a 2–500 character bio, and a 20–5000 character manifesto' });
    return;
  }
  executeRun(
    'UPDATE candidates SET position = ?, bio = ?, manifesto = ? WHERE id = ? AND student_ugr_id = ?',
    [position, bio.trim(), manifesto.trim(), profile.id, ugrId]
  );
  res.json({
    id: profile.id,
    name: executeQueryOne<{ name: string }>(
      'SELECT name FROM registrar_students WHERE ugr_id = ?',
      [ugrId]
    )?.name,
    position,
    bio: bio.trim(),
    manifesto: manifesto.trim()
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

app.all(['/api/admin/candidates', '/api/admin/candidates/:id'], requireAdminAuth, (_req: Request, res: Response) => {
  res.status(403).json({ error: 'Candidate profiles can only be created or edited by their candidate owners; deletion is not permitted' });
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
    res.json({ message: 'New academic year started. Registry, tokens, email deliveries and votes reset.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Rollover failed: ' + err.message });
  }
});

// ---------- Scheduled token email delivery ----------
let tokenEmailRetryTimer: ReturnType<typeof setInterval> | undefined;
let tokenEmailDispatchInProgress = false;
let tokenEmailDeliveriesComplete = false;

function invalidateUndeliveredTokenEmails(electionStartTime: string) {
  try {
    const discarded = discardPendingTokenEmailDeliveries(electionStartTime);
    if (discarded > 0) {
      console.error(`[Token email] ${discarded} undelivered token(s) were invalidated at election start.`);
    }
  } catch (error) {
    console.error('[Token email] Could not invalidate pending tokens at election start:', error);
  }
}

function getRegisteredTokenEmailRecipients() {
  const voterIds = getConfiguredParliamentIds();
  const placeholders = voterIds.map(() => '?').join(', ');
  const eligibleIds = executeQuery<{ ugr_id: string }>(
    `SELECT s.ugr_id
     FROM registrar_students s
     JOIN cafeteria_records c ON c.ugr_id = s.ugr_id
     WHERE UPPER(s.ugr_id) IN (${placeholders})
       AND s.voter_type = 'STANDARD'
       AND s.cgpa > 3
       AND c.is_active = 1`,
    voterIds
  );
  if (eligibleIds.length !== voterIds.length) {
    throw new Error('Parliament roster must contain only registered, eligible non-judge voters.');
  }
  const registeredIds = executeQuery<{ ugr_id: string }>(
    `SELECT ugr_id FROM voter_registry
     WHERE is_registered = 1 AND UPPER(ugr_id) IN (${placeholders})`,
    voterIds
  );
  return registeredIds.map((row) => row.ugr_id);
}

async function dispatchScheduledTokenEmails(electionStartTime: string, electionStartMs: number) {
  if (tokenEmailDispatchInProgress) return;
  if (Date.now() >= electionStartMs) {
    console.error('[Token email] Election start reached before all scheduled token emails were delivered.');
    return;
  }
  tokenEmailDispatchInProgress = true;
  let transporter: ReturnType<typeof createSmtpTransport>['transporter'] | undefined;
  try {
    const secret = process.env.VOTING_TOKEN_SECRET || '';
    encryptPendingToken(secret, 'configuration-check');
    getStudentEmailAddress('UGR/0001/15');
    const smtp = createSmtpTransport();
    transporter = smtp.transporter;

    const voterIds = getRegisteredTokenEmailRecipients();
    for (const voterId of voterIds) {
      if (hasTokenEmailDeliveryRecord(electionStartTime, voterId)) continue;
      const rawToken = generateVotingToken();
      const encryptedToken = encryptPendingToken(secret, rawToken);
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      createPendingTokenEmailDelivery(electionStartTime, voterId, tokenHash, encryptedToken);
    }
    if (voterIds.length === 0) {
      console.warn('[Token email] No eligible parliament voters had registered by the registration deadline.');
      tokenEmailDeliveriesComplete = true;
      return;
    }

    const pendingDeliveries = getPendingTokenEmailDeliveries(electionStartTime);
    for (const delivery of pendingDeliveries) {
      if (Date.now() >= electionStartMs) {
        console.error('[Token email] Stopping delivery because the election has started.');
        break;
      }
      const rawToken = decryptPendingToken(secret, delivery);
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      if (!crypto.timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(delivery.token_hash, 'hex'))) {
        throw new Error(`Pending token integrity check failed for ${delivery.voter_ugr_id}.`);
      }
      const recipient = getStudentEmailAddress(delivery.voter_ugr_id);
      try {
        await transporter.sendMail({
          from: smtp.from,
          to: recipient,
          subject: 'Your ASTU Student Union Election Voting Token',
          text: [
            `Your single-use ASTU parliamentary voting token is: ${rawToken}`,
            '',
            'Keep this token secret. Enter it on the election ballot page during the voting period.',
            'It can be used once to select one candidate for President, Vice President, and Secretary.'
          ].join('\n')
        });
        recordTokenEmailAttempt(electionStartTime, delivery.voter_ugr_id);
        markTokenEmailDelivered(electionStartTime, delivery.voter_ugr_id);
        console.log(`[Token email] Delivered voting token to ${recipient}.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown SMTP delivery error';
        recordTokenEmailAttempt(electionStartTime, delivery.voter_ugr_id, message);
        console.error(`[Token email] Delivery failed for ${delivery.voter_ugr_id}; it will be retried: ${message}`);
      }
    }
    tokenEmailDeliveriesComplete = getPendingTokenEmailDeliveries(electionStartTime).length === 0;
  } catch (error) {
    console.error('[Token email] Scheduled delivery could not run; it will be retried:', error);
  } finally {
    transporter?.close();
    tokenEmailDispatchInProgress = false;
    if (Date.now() >= electionStartMs) {
      if (tokenEmailRetryTimer) clearInterval(tokenEmailRetryTimer);
      tokenEmailRetryTimer = undefined;
      invalidateUndeliveredTokenEmails(electionStartTime);
    }
  }
}

function startTokenEmailScheduler() {
  const electionWindow = getElectionWindow();
  if (!electionWindow) {
    console.error('[Token email] Scheduler not started because the election schedule is invalid.');
    return;
  }

  const dispatchTime = electionWindow.startMs - TOKEN_EMAIL_LEAD_MS;
  const now = Date.now();
  if (now >= electionWindow.startMs) {
    if (now >= dispatchTime) {
      console.error('[Token email] Server started after the election began; missed token emails will not be sent late.');
      invalidateUndeliveredTokenEmails(electionWindow.start);
    }
    return;
  }

  const retryPending = () => {
    if (tokenEmailDeliveriesComplete) {
      if (tokenEmailRetryTimer) clearInterval(tokenEmailRetryTimer);
      tokenEmailRetryTimer = undefined;
      return;
    }
    if (Date.now() >= electionWindow.startMs) {
      if (tokenEmailDispatchInProgress) return;
      if (tokenEmailRetryTimer) clearInterval(tokenEmailRetryTimer);
      tokenEmailRetryTimer = undefined;
      invalidateUndeliveredTokenEmails(electionWindow.start);
      return;
    }
    void dispatchScheduledTokenEmails(electionWindow.start, electionWindow.startMs);
  };

  if (now >= dispatchTime) {
    retryPending();
    tokenEmailRetryTimer = setInterval(retryPending, TOKEN_EMAIL_RETRY_MS);
    return;
  }

  const scheduleUntilDispatch = () => {
    const remaining = dispatchTime - Date.now();
    if (remaining <= 0) {
      retryPending();
      tokenEmailRetryTimer = setInterval(retryPending, TOKEN_EMAIL_RETRY_MS);
      return;
    }
    setTimeout(
      scheduleUntilDispatch,
      Math.min(remaining, 2_147_000_000)
    );
  };
  scheduleUntilDispatch();
}

// ---------- Start ----------
async function startServer() {
  await getDb();
  if (process.env.DEMO_MODE !== 'true') startTokenEmailScheduler();
  const host = process.env.DEMO_MODE === 'true' ? '127.0.0.1' : '0.0.0.0';
  app.listen(PORT, host, () => {
    console.log(`[ASTU Voting Backend] Running on port ${PORT}`);
  });
}

startServer();