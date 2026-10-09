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

function configuredAuthorityIds() {
  const rawIds = process.env.AUTHORITY_IDS || process.env.VIP_STUDENT_IDS;
  if (!rawIds) {
    throw new Error('AUTHORITY_IDS must be configured with exactly three registered authority IDs.');
  }

  const ids = rawIds.split(',').map((id) => id.trim().toUpperCase()).filter(Boolean);
  if (ids.length !== 3 || new Set(ids).size !== 3) {
    throw new Error('AUTHORITY_IDS must contain exactly three distinct authority IDs.');
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
      voter_type TEXT NOT NULL DEFAULT 'STANDARD' CHECK (voter_type IN ('STANDARD', 'AUTHORITY')),
      vote_weight INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3))
    );

    CREATE TABLE IF NOT EXISTS cafeteria_records (
      ugr_id TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
    );

    CREATE TABLE IF NOT EXISTS voter_registry (
      ugr_id TEXT PRIMARY KEY,
      has_received_token INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token_hash TEXT PRIMARY KEY,
      is_used INTEGER NOT NULL DEFAULT 0,
      vote_weight INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3))
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      position TEXT NOT NULL,
      bio TEXT NOT NULL,
      manifesto TEXT NOT NULL,
      department TEXT,
      photo_url TEXT
    );

    CREATE TABLE IF NOT EXISTS votes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      candidate_id INTEGER NOT NULL,
      vote_weight INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3)),
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
  addColumnIfMissing(db, 'registrar_students', 'vote_weight', 'INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3))');
  addColumnIfMissing(db, 'tokens', 'vote_weight', 'INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3))');
  addColumnIfMissing(db, 'votes', 'vote_weight', 'INTEGER NOT NULL DEFAULT 1 CHECK (vote_weight IN (1, 3))');
}

function applyAuthorityConfiguration(db) {
  const authorityIds = configuredAuthorityIds();
  if (authorityIds.length === 0) return;

  const placeholders = authorityIds.map(() => '?').join(', ');
  const registered = db.exec(
    `SELECT COUNT(*) FROM registrar_students WHERE UPPER(ugr_id) IN (${placeholders})`,
    authorityIds
  )[0].values[0][0];
  if (registered !== authorityIds.length) {
    throw new Error('Every ID in AUTHORITY_IDS must match a registered authority record.');
  }

  db.run("UPDATE registrar_students SET voter_type = 'STANDARD', vote_weight = 1");
  for (const id of authorityIds) {
    db.run(
      "UPDATE registrar_students SET voter_type = 'AUTHORITY', vote_weight = 3 WHERE UPPER(ugr_id) = ?",
      [id]
    );
  }
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

export function castAnonymousVote(tokenHash, candidateIds) {
  if (!dbInstance) throw new Error('Database not initialized');
  const db = dbInstance;

  db.run('BEGIN IMMEDIATE TRANSACTION');
  try {
    const token = executeQueryOne(
      'SELECT is_used, vote_weight FROM tokens WHERE token_hash = ?',
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

    db.run(
      'UPDATE tokens SET is_used = 1 WHERE token_hash = ? AND is_used = 0',
      [tokenHash]
    );
    if (db.getRowsModified() !== 1) {
      db.run('ROLLBACK');
      return { status: 'used-token' };
    }

    for (const candidateId of candidateIds) {
      db.run(
        'INSERT INTO votes (candidate_id, vote_weight) VALUES (?, ?)',
        [candidateId, token.vote_weight]
      );
    }

    db.run('COMMIT');
    saveDb(db);
    return { status: 'recorded', voteWeight: token.vote_weight };
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

  dbInstance.run('DELETE FROM votes');
  dbInstance.run('DELETE FROM tokens');
  dbInstance.run('UPDATE voter_registry SET has_received_token = 0');
  saveDb(dbInstance);

  return { resetVotesCount: voteCount, resetTokensCount: tokenCount, resetRegistryCount: registryCount };
}