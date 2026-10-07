import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'astu_voting.sqlite');

let dbInstance = null;

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
      password_hash TEXT NOT NULL
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
      is_used INTEGER NOT NULL DEFAULT 0
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
    ['Marta Alemu', 'Vice President', '3rd year, Software Eng.', 'Mentorship program for first years.']
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