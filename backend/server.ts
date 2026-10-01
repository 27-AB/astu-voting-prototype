import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import {
  getDb,
  saveDb,
  executeQuery,
  executeQueryOne,
  executeRun,
  performRollover,
  DEMO_ACCOUNTS,
  StudentRecord,
  CafeteriaRecord,
  CandidateRecord,
  AnnouncementRecord,
  AdminUserRecord
} from './db.js';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(cors());
app.use(express.json());

// In-memory sessions store
const studentSessions = new Map<string, { ugr_id: string; createdAt: number }>();
const adminSessions = new Map<string, { username: string; role: string; createdAt: number }>();

// Rate Limiter
interface RateLimitBucket {
  count: number;
  resetAt: number;
}
const rateLimitMap = new Map<string, RateLimitBucket>();

function rateLimiter(limit = 15, windowMs = 60 * 1000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${req.ip || 'anon'}_${req.path}`;
    const now = Date.now();
    const bucket = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };

    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }

    bucket.count += 1;
    rateLimitMap.set(key, bucket);

    if (bucket.count > limit) {
      res.status(429).json({
        error: 'Too many requests. Please wait a minute before retrying.',
        retryAfter: Math.ceil((bucket.resetAt - now) / 1000)
      });
      return;
    }
    next();
  };
}

// Authentication Middlewares
function requireStudentAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Student session token required' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const session = studentSessions.get(token);
  if (!session) {
    res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
    return;
  }
  (req as any).studentUgrId = session.ugr_id;
  next();
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized: Electoral Board admin credentials required' });
    return;
  }
  const token = authHeader.split(' ')[1];
  const session = adminSessions.get(token);
  if (!session) {
    res.status(401).json({ error: 'Admin session expired or invalid' });
    return;
  }
  (req as any).adminUser = session;
  next();
}

// ==========================================
// 1. STUDENT AUTH & ELIGIBILITY ENDPOINTS
// ==========================================

// POST /api/login: Verify UGR ID and password
app.post('/api/login', rateLimiter(15, 60000), async (req: Request, res: Response) => {
  const { ugr_id, password } = req.body;
  if (!ugr_id || !password) {
    res.status(400).json({ error: 'UGR ID and password are required' });
    return;
  }

  const cleanUgrId = ugr_id.trim().toUpperCase();
  const student = executeQueryOne<StudentRecord>(
    'SELECT * FROM registrar_students WHERE UPPER(ugr_id) = ?',
    [cleanUgrId]
  );

  if (!student) {
    res.status(401).json({ error: 'No student found with this UGR ID in ASTU Registrar records.' });
    return;
  }

  const pwMatch = bcrypt.compareSync(password, student.password_hash);
  if (!pwMatch) {
    res.status(401).json({ error: 'Invalid password. For demo accounts, the default password is password123' });
    return;
  }

  const sessionToken = `stu_sess_${crypto.randomBytes(24).toString('hex')}`;
  studentSessions.set(sessionToken, {
    ugr_id: student.ugr_id,
    createdAt: Date.now()
  });

  res.json({
    token: sessionToken,
    student: {
      ugr_id: student.ugr_id,
      name: student.name,
      cgpa: student.cgpa,
      department: student.department
    }
  });
});

// GET /api/eligibility: Joint evaluation of registrar & cafeteria records
app.get('/api/eligibility', requireStudentAuth, async (req: Request, res: Response) => {
  const ugr_id = (req as any).studentUgrId as string;

  const student = executeQueryOne<StudentRecord>(
    'SELECT ugr_id, name, cgpa, department FROM registrar_students WHERE ugr_id = ?',
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

  const hasReceivedToken = (registry?.has_received_token === 1);
  const isCafeteriaActive = (cafeteria?.is_active === 1);
  const cgpa = student.cgpa;

  // ASTU Election Bylaw Rules:
  // 1. CGPA strictly > 3.00. (Edge case 3.00 must be rejected!)
  // 2. Active campus cafeteria status.
  const gpaEligible = cgpa > 3.00;
  const isEligible = gpaEligible && isCafeteriaActive;

  let reason = '';
  const violations: string[] = [];

  if (isEligible) {
    reason = `Fully Eligible: Meets academic threshold (CGPA ${cgpa.toFixed(2)} > 3.00) and active on-campus cafeteria residency.`;
  } else {
    if (cgpa === 3.00) {
      violations.push('CGPA is exactly 3.00. ASTU Election Code Article 4.2 strictly mandates CGPA strictly greater than 3.00 (CGPA > 3.00). Equal-to 3.00 is rejected.');
    } else if (cgpa < 3.00) {
      violations.push(`CGPA requirement deficit: Current CGPA is ${cgpa.toFixed(2)}, which is below the minimum required 3.01.`);
    }

    if (!isCafeteriaActive) {
      violations.push('Cafeteria meal registry check failed: You do not have an active on-campus boarding/cafeteria profile for the current academic semester.');
    }

    reason = violations.join(' ');
  }

  res.json({
    ugr_id: student.ugr_id,
    name: student.name,
    cgpa: student.cgpa,
    department: student.department,
    cafeteria_active: isCafeteriaActive,
    eligible: isEligible,
    has_received_token: hasReceivedToken,
    reason,
    violations
  });
});

// POST /api/token: Generate one anonymous token for eligible student
app.post('/api/token', requireStudentAuth, rateLimiter(5, 60000), async (req: Request, res: Response) => {
  const ugr_id = (req as any).studentUgrId as string;

  const student = executeQueryOne<StudentRecord>(
    'SELECT cgpa FROM registrar_students WHERE ugr_id = ?',
    [ugr_id]
  );
  const cafeteria = executeQueryOne<CafeteriaRecord>(
    'SELECT is_active FROM cafeteria_records WHERE ugr_id = ?',
    [ugr_id]
  );
  const registry = executeQueryOne<{ has_received_token: number }>(
    'SELECT has_received_token FROM voter_registry WHERE ugr_id = ?',
    [ugr_id]
  );

  if (!student || !cafeteria) {
    res.status(404).json({ error: 'Student records not found in registrar' });
    return;
  }

  if (registry?.has_received_token === 1) {
    res.status(403).json({
      error: 'Token has already been issued for this UGR ID. Each voter can only claim one voting token per academic year.'
    });
    return;
  }

  if (student.cgpa <= 3.00 || cafeteria.is_active !== 1) {
    res.status(403).json({
      error: 'Eligibility criteria not met. Only students with CGPA > 3.00 and active cafeteria service can receive a token.'
    });
    return;
  }

  // Generate CSPRNG token
  const randomHex = crypto.randomBytes(12).toString('hex').toUpperCase();
  const rawToken = `ASTU-${randomHex.slice(0, 4)}-${randomHex.slice(4, 8)}-${randomHex.slice(8, 12)}-${randomHex.slice(12, 16)}`;

  // Compute SHA-256 hash
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

  // Insert token_hash into tokens table (NO student link!)
  executeRun('INSERT INTO tokens (token_hash, is_used) VALUES (?, 0)', [tokenHash]);

  // Mark voter registry as having claimed their token
  executeRun('UPDATE voter_registry SET has_received_token = 1 WHERE ugr_id = ?', [ugr_id]);

  res.json({
    token: rawToken,
    token_hash_preview: `${tokenHash.substring(0, 10)}...${tokenHash.substring(tokenHash.length - 6)}`,
    message: 'Token generated successfully. Save this token immediately! It will NEVER be shown again and cannot be retrieved.'
  });
});

// ==========================================
// 2. BALLOT & VOTING ENDPOINTS
// ==========================================

// GET /api/candidates: List all candidates
app.get('/api/candidates', async (_req: Request, res: Response) => {
  const candidates = executeQuery<CandidateRecord>(
    'SELECT * FROM candidates ORDER BY position ASC, name ASC'
  );
  res.json(candidates);
});

// POST /api/vote: Submit token and candidate_id (Zero Student Linkage!)
app.post('/api/vote', rateLimiter(20, 60000), async (req: Request, res: Response) => {
  const { token, candidate_id, votes } = req.body;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'Voting token is required.' });
    return;
  }

  const cleanToken = token.trim();
  const tokenHash = crypto.createHash('sha256').update(cleanToken).digest('hex');

  const tokenRecord = executeQueryOne<{ token_hash: string; is_used: number }>(
    'SELECT token_hash, is_used FROM tokens WHERE token_hash = ?',
    [tokenHash]
  );

  if (!tokenRecord) {
    res.status(400).json({
      error: 'Invalid voting token. This token was not recognized in the ballot pool.'
    });
    return;
  }

  if (tokenRecord.is_used === 1) {
    res.status(400).json({
      error: 'Token has already been expended. Each token can only cast one ballot.'
    });
    return;
  }

  const candidateIdsToVote: number[] = [];
  if (Array.isArray(votes) && votes.length > 0) {
    for (const id of votes) {
      if (typeof id === 'number') candidateIdsToVote.push(id);
    }
  } else if (candidate_id && typeof candidate_id === 'number') {
    candidateIdsToVote.push(candidate_id);
  }

  if (candidateIdsToVote.length === 0) {
    res.status(400).json({ error: 'No valid candidate selected.' });
    return;
  }

  for (const cid of candidateIdsToVote) {
    const exists = executeQueryOne('SELECT id FROM candidates WHERE id = ?', [cid]);
    if (!exists) {
      res.status(400).json({ error: `Candidate ID ${cid} does not exist.` });
      return;
    }
  }

  // Record votes in digital ballot box: NO voter identity, NO token hash, NO precise timestamp!
  for (const cid of candidateIdsToVote) {
    executeRun('INSERT INTO votes (candidate_id) VALUES (?)', [cid]);
  }

  // Mark token as expended
  executeRun('UPDATE tokens SET is_used = 1 WHERE token_hash = ?', [tokenHash]);

  res.json({
    success: true,
    message: 'Your ballot has been cast successfully and anonymously into the digital ballot box.',
    ballotsCast: candidateIdsToVote.length
  });
});

// GET /api/announcements: List announcements
app.get('/api/announcements', async (_req: Request, res: Response) => {
  const announcements = executeQuery<AnnouncementRecord>(
    'SELECT * FROM announcements ORDER BY id DESC'
  );
  res.json(announcements);
});

// ==========================================
// 3. ELECTORAL BOARD (ADMIN) ENDPOINTS
// ==========================================

// POST /api/admin/login
app.post('/api/admin/login', rateLimiter(10, 60000), async (req: Request, res: Response) => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: 'Admin username and password are required' });
    return;
  }

  const admin = executeQueryOne<AdminUserRecord>(
    'SELECT * FROM admin_users WHERE username = ?',
    [username.trim()]
  );

  if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
    res.status(401).json({ error: 'Invalid admin credentials. (Default: admin / admin123)' });
    return;
  }

  const adminToken = `adm_sess_${crypto.randomBytes(24).toString('hex')}`;
  adminSessions.set(adminToken, {
    username: admin.username,
    role: admin.role,
    createdAt: Date.now()
  });

  res.json({
    token: adminToken,
    user: {
      username: admin.username,
      role: admin.role
    }
  });
});

// GET /api/admin/results: Live tally and turnout
app.get('/api/admin/results', requireAdminAuth, async (_req: Request, res: Response) => {
  const totalStudents = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM registrar_students'
  )?.count || 0;

  const eligibleVoters = executeQueryOne<{ count: number }>(`
    SELECT COUNT(*) as count 
    FROM registrar_students s
    JOIN cafeteria_records c ON s.ugr_id = c.ugr_id
    WHERE s.cgpa > 3.00 AND c.is_active = 1
  `)?.count || 0;

  const tokensIssued = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM voter_registry WHERE has_received_token = 1'
  )?.count || 0;

  const tokensUsed = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM tokens WHERE is_used = 1'
  )?.count || 0;

  const totalVotesCast = executeQueryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM votes'
  )?.count || 0;

  const candidateResults = executeQuery<{
    id: number;
    name: string;
    position: string;
    department: string;
    photo_url: string;
    vote_count: number;
  }>(`
    SELECT 
      c.id, c.name, c.position, c.department, c.photo_url,
      COUNT(v.id) as vote_count
    FROM candidates c
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id
    ORDER BY c.position ASC, vote_count DESC
  `);

  const byPosition: Record<string, any[]> = {};
  for (const cand of candidateResults) {
    if (!byPosition[cand.position]) byPosition[cand.position] = [];
    byPosition[cand.position].push(cand);
  }

  const formattedPositions: Record<string, { total: number; candidates: any[] }> = {};
  for (const pos in byPosition) {
    const list = byPosition[pos];
    const posTotal = list.reduce((sum, item) => sum + item.vote_count, 0);
    formattedPositions[pos] = {
      total: posTotal,
      candidates: list.map(c => ({
        ...c,
        percentage: posTotal > 0 ? Number(((c.vote_count / posTotal) * 100).toFixed(1)) : 0
      }))
    };
  }

  const turnoutPercentage = eligibleVoters > 0 
    ? Number(((tokensUsed / eligibleVoters) * 100).toFixed(1)) 
    : 0;

  res.json({
    turnout: {
      total_students: totalStudents,
      eligible_voters: eligibleVoters,
      tokens_issued: tokensIssued,
      tokens_used: tokensUsed,
      votes_cast: totalVotesCast,
      turnout_percentage: turnoutPercentage
    },
    results_by_position: formattedPositions
  });
});

// POST /api/admin/rollover
app.post('/api/admin/rollover', requireAdminAuth, async (_req: Request, res: Response) => {
  try {
    const report = performRollover();
    res.json({
      success: true,
      message: 'Simulated academic year rollover completed successfully.',
      report
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Rollover failed: ' + err.message });
  }
});

// Start Server
async function startServer() {
  await getDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ASTU Voting Backend] Running on port ${PORT}`);
  });
}

startServer();
