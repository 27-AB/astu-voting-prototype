import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'astu_voting.sqlite');

let dbInstance = null;

function hasColumn(db, table, column) {
  const result = db.exec(`PRAGMA table_info(${table})`);
  return result[0]?.values.some((row) => row[1] === column) ?? false;
}

function addColumnIfMissing(db, table, column, definition) {
  if (!hasColumn(db, table, column)) {
    db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function configuredJudgeIds() {
  const rawIds = process.env.STUDENT_AFFAIRS_JUDGE_IDS || process.env.AUTHORITY_IDS;
  if (!rawIds) {
    throw new Error('STUDENT_AFFAIRS_JUDGE_IDS must be configured with exactly two registered judge IDs.');
  }

  const ids = rawIds.split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
  if (ids.length !== 2 || new Set(ids).size !== 2) {
    throw new Error('STUDENT_AFFAIRS_JUDGE_IDS must contain exactly two distinct judge IDs.');
  }
  return ids;
}

function configuredParliamentIds() {
  const rawIds = process.env.PARLIAMENT_VOTER_IDS;
  if (!rawIds) {
    throw new Error('PARLIAMENT_VOTER_IDS must list 50 to 100 registered eligible parliament voters.');
  }
  const ids = rawIds.split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
  if (ids.length < 50 || ids.length > 100 || new Set(ids).size !== ids.length) {
    throw new Error('PARLIAMENT_VOTER_IDS must contain 50 to 100 distinct voter IDs.');
  }
  return ids;
}

// Demo accounts: IDs match docs/api.md. Password for all students: demo123
export const DEMO_ACCOUNTS = [
  { ugr_id: 'UGR/0001/15', name: 'Eyerusalem Melaku', cgpa: 3.88, department: 'Software Engineering', cafeteria_active: true, expected_status: 'Eligible' },
  { ugr_id: 'UGR/0002/15', name: 'Dawit Tadesse', cgpa: 2.45, department: 'Civil Engineering', cafeteria_active: true, expected_status: 'Rejected (CGPA is below 3.0)' },
  { ugr_id: 'UGR/0003/15', name: 'Natnael Getachew', cgpa: 3.82, department: 'Mechanical Engineering', cafeteria_active: false, expected_status: 'Rejected (No active cafeteria access)' },
  { ugr_id: 'UGR/0004/15', name: 'Chala Bekele', cgpa: 2.15, department: 'Chemical Engineering', cafeteria_active: false, expected_status: 'Rejected (Both reasons)' },
  { ugr_id: 'UGR/0005/15', name: 'Bethlehem Alemu', cgpa: 3.0, department: 'Electrical & Computer Engineering', cafeteria_active: true, expected_status: 'Rejected (CGPA exactly 3.0)' }
];

export async function getDb() {
  if (dbInstance) return dbInstance;
  const SQL = await initSqlJs();

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  let db;
  if (fs.existsSync(DB_FILE)) {
    try {
      db = new SQL.Database(fs.readFileSync(DB_FILE));
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  dbInstance = db;
  initializeTables(db);
  seedIfEmpty(db);
  applyAuthorityConfiguration(db);
  saveDb(db);
  return db;
}

export function saveDb(db) {
  const target = db || dbInstance;
  if (!target) return;
  try {
    fs.writeFileSync(DB_FILE, Buffer.from(target.export()));
  } catch (err) {
    console.error('Error saving SQLite database:', err);
  }
}

function initializeTables(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS registrar_students (
      ugr_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cgpa REAL NOT NULL,
      department TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      voter_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (voter_type IN ('STANDARD', 'AUTHORITY'))
    );

    CREATE TABLE IF NOT EXISTS cafeteria_records (
      ugr_id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
    );

    CREATE TABLE IF NOT EXISTS voter_registry (
      ugr_id TEXT PRIMARY KEY,
      has_received_token INTEGER NOT NULL DEFAULT 0,
      is_registered INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      is_used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      bio TEXT NOT NULL,
      manifesto TEXT NOT NULL,
      department TEXT,
      photo_url TEXT,
      student_ugr_id TEXT UNIQUE,
      FOREIGN KEY (student_ugr_id) REFERENCES registrar_students(ugr_id)
    );

    CREATE TABLE IF NOT EXISTS judge_scores (
      judge_ugr_id TEXT NOT NULL,
      candidate_id INTEGER NOT NULL,
      score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 20),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (judge_ugr_id, candidate_id),
      FOREIGN KEY (judge_ugr_id) REFERENCES registrar_students(ugr_id),
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      date TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'electoral_board'
    );
  `);

  addColumnIfMissing(db, 'registrar_students', 'voter_type', "TEXT NOT NULL DEFAULT 'STANDARD' CHECK (voter_type IN ('STANDARD', 'AUTHORITY'))");
  addColumnIfMissing(db, 'voter_registry', 'is_registered', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_registered IN (0, 1))');
  addColumnIfMissing(db, 'candidates', 'student_ugr_id', 'TEXT REFERENCES registrar_students(ugr_id)');
}

function applyAuthorityConfiguration(db) {
  const judgeIds = configuredJudgeIds();

  const placeholders = judgeIds.map(() => '?').join(', ');
  const registered = db.exec(
    `SELECT COUNT(*) FROM registrar_students WHERE UPPER(ugr_id) IN (${placeholders})`,
    judgeIds
  )[0].values[0][0];
  if (registered !== judgeIds.length) {
    throw new Error('Every ID in STUDENT_AFFAIRS_JUDGE_IDS must match a registered judge record.');
  }

  db.run("UPDATE registrar_students SET voter_type = 'STANDARD'");
  for (const id of judgeIds) {
    db.run(
      "UPDATE registrar_students SET voter_type = 'AUTHORITY' WHERE UPPER(ugr_id) = ?",
      [id]
    );
  }
}

export function getConfiguredParliamentIds() {
  return configuredParliamentIds();
}

function seedIfEmpty(db) {
  const count = Number(db.exec('SELECT COUNT(*) FROM registrar_students')[0].values[0][0]);
  if (count > 0) return;

  const studentHash = bcrypt.hashSync('demo123', 10);
  for (const a of DEMO_ACCOUNTS) {
    db.run(
      'INSERT INTO registrar_students (ugr_id, name, cgpa, department, password_hash) VALUES (?,?,?,?,?)',
      [a.ugr_id, a.name, a.cgpa, a.department, studentHash]
    );
    db.run('INSERT INTO cafeteria_records (ugr_id, is_active) VALUES (?,?)', [a.ugr_id, a.cafeteria_active ? 1 : 0]);
    db.run('INSERT INTO voter_registry (ugr_id, has_received_token) VALUES (?,0)', [a.ugr_id]);
  }

  db.run('INSERT INTO admin_users (username, password_hash, role) VALUES (?,?,?)', [
    'admin',
    bcrypt.hashSync('admin123', 10),
    'electoral_board'
  ]);

  const cands = [
    ['Abel Tesfaye', 'President', '4th year, Computer Science.', 'Better dorm internet and study spaces.'],
    ['Hana Bekele', 'President', '4th year, Electrical Eng.', 'Open student budget and cafeteria feedback.'],
    ['Samuel Girma', 'Vice President', '3rd year, Civil Eng.', 'Faster clearance and clubs support.'],
    ['Marta Alemu', 'Vice President', '3rd year, Software Eng.', 'Mentorship program for first years.'],
    ['Liya Abebe', 'Secretary', '3rd year, Computer Science.', 'Publish clear meeting notes and student decisions.'],
    ['Yonas Kebede', 'Secretary', '3rd year, Information Systems.', 'Make union communication timely and accessible.']
  ];
  for (const c of cands) {
    db.run('INSERT INTO candidates (name, position, bio, manifesto) VALUES (?,?,?,?)', c);
  }

  db.run('INSERT INTO announcements (title, body, date) VALUES (?,?,?)', [
    'Election date',
    'Voting opens on 10 October.',
    '2026-09-28'
  ]);
}

export function executeQuery(sql, params = []) {
  if (!dbInstance) throw new Error('Database not initialized');
  const stmt = dbInstance.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

export function executeQueryOne(sql, params = []) {
  const rows = executeQuery(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function executeRun(sql, params = []) {
  if (!dbInstance) throw new Error('Database not initialized');
  dbInstance.run(sql, params);
  const changes = dbInstance.getRowsModified();
  saveDb(dbInstance);
  return { changes };
}

export function getCandidateRankings() {
  const candidates = executeQuery(`
    SELECT c.id AS candidate_id, c.name, c.position,
           c.manifesto,
           AVG(CASE WHEN judges.voter_type = 'AUTHORITY' THEN js.score END) AS judge_score,
           COUNT(DISTINCT CASE WHEN judges.voter_type = 'AUTHORITY' THEN js.judge_ugr_id END) AS judge_count,
           COUNT(DISTINCT v.id) AS parliament_votes
    FROM candidates c
    LEFT JOIN judge_scores js ON js.candidate_id = c.id
    LEFT JOIN registrar_students judges ON judges.ugr_id = js.judge_ugr_id
    LEFT JOIN votes v ON c.id = v.candidate_id
    GROUP BY c.id
    ORDER BY c.position ASC, c.id ASC
  `);
  const votesByPosition = new Map();
  for (const candidate of candidates) {
    votesByPosition.set(
      candidate.position,
      (votesByPosition.get(candidate.position) || 0) + candidate.parliament_votes
    );
  }

  return candidates
    .map((candidate) => {
      const totalPositionVotes = votesByPosition.get(candidate.position) || 0;
      const judgeScore = candidate.judge_score === null ? null : Number(candidate.judge_score);
      const judgePoints = judgeScore === null ? 0 : (judgeScore / 20) * 30;
      const parliamentShare = totalPositionVotes === 0
        ? 0
        : (candidate.parliament_votes / totalPositionVotes) * 70;
      return {
        ...candidate,
        judge_score: judgeScore,
        judge_points: Number(judgePoints.toFixed(2)),
        parliament_share: Number(parliamentShare.toFixed(2)),
        final_score: Number((judgePoints + parliamentShare).toFixed(2)),
        votes: candidate.parliament_votes
      };
    })
    .sort((a, b) =>
      a.position.localeCompare(b.position) ||
      b.final_score - a.final_score ||
      a.candidate_id - b.candidate_id
    )
    .map((candidate, index, ranked) => ({
      ...candidate,
      rank: ranked.slice(0, index).filter((entry) => entry.position === candidate.position).length + 1
    }));
}

export function castAnonymousVote(tokenHash, candidateIds) {
  if (!dbInstance) throw new Error('Database not initialized');
  const db = dbInstance;

  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const token = executeQueryOne(
      'SELECT is_used FROM tokens WHERE token_hash = ?',
      [tokenHash]
    );
    if (!token) {
      db.run('ROLLBACK');
      return { status: 'invalid-token' };
    }
    if (token.is_used === 1) {
      db.run('ROLLBACK');
      return { status: 'used-token' };
    }

    const positions = new Set();
    for (const candidateId of candidateIds) {
      const candidate = executeQueryOne(
        'SELECT position FROM candidates WHERE id = ?',
        [candidateId]
      );
      if (!candidate) {
        db.run('ROLLBACK');
        return { status: 'invalid-candidate' };
      }
      if (positions.has(candidate.position)) {
        db.run('ROLLBACK');
        return { status: 'duplicate-position' };
      }
      positions.add(candidate.position);
    }
    if (!['President', 'Vice President', 'Secretary'].every((position) => positions.has(position))) {
      db.run('ROLLBACK');
      return { status: 'incomplete-ballot' };
    }

    db.run(
      'UPDATE tokens SET is_used = 1 WHERE token_hash = ? AND is_used = 0',
      [tokenHash]
    );
    if (db.getRowsModified() !== 1) {
      db.run('ROLLBACK');
      return { status: 'used-token' };
    }

    for (const candidateId of candidateIds) {
      db.run('INSERT INTO votes (candidate_id) VALUES (?)', [candidateId]);
    }

    db.run('COMMIT');
    saveDb(db);
    return { status: 'recorded' };
  } catch (error) {
    db.run('ROLLBACK');
    throw error;
  }
}

export function performRollover() {
  if (!dbInstance) throw new Error('Database not initialized');
  const voteCount = executeQueryOne('SELECT COUNT(*) as count FROM votes')?.count || 0;
  const tokenCount = executeQueryOne('SELECT COUNT(*) as count FROM tokens')?.count || 0;
  const registryCount = executeQueryOne('SELECT COUNT(*) as count FROM voter_registry WHERE has_received_token = 1')?.count || 0;

  dbInstance.run('DELETE FROM judge_scores');
  dbInstance.run('DELETE FROM votes');
  dbInstance.run('DELETE FROM tokens');
  dbInstance.run('UPDATE voter_registry SET has_received_token = 0, is_registered = 0');
  saveDb(dbInstance);

  return { resetVotesCount: voteCount, resetTokensCount: tokenCount, resetRegistryCount: registryCount };
}