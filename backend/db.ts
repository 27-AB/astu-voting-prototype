import initSqlJs, { Database } from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';

const DB_DIR = path.resolve(process.cwd(), 'data');
const DB_FILE = path.join(DB_DIR, 'astu_voting.sqlite');

let dbInstance: Database | null = null;

export interface StudentRecord {
  ugr_id: string;
  name: string;
  cgpa: number;
  department: string;
  password_hash: string;
}

export interface CafeteriaRecord {
  ugr_id: string;
  is_active: number;
}

export interface CandidateRecord {
  id: number;
  name: string;
  position: string;
  bio: string;
  manifesto: string;
  department?: string;
  photo_url?: string;
}

export interface AnnouncementRecord {
  id: number;
  title: string;
  body: string;
  date: string;
}

export interface AdminUserRecord {
  username: string;
  password_hash: string;
  role: string;
}

export const DEMO_ACCOUNTS = [
  {
    ugr_id: 'UGR/1001/14',
    name: 'Dawit Tadesse',
    cgpa: 2.45,
    department: 'Civil Engineering',
    cafeteria_active: true,
    expected_status: 'Rejected (Low CGPA)'
  },
  {
    ugr_id: 'UGR/1002/14',
    name: 'Bethlehem Alemu',
    cgpa: 3.00,
    department: 'Electrical & Computer Engineering',
    cafeteria_active: true,
    expected_status: 'Rejected (CGPA = 3.00 Edge Case)'
  },
  {
    ugr_id: 'UGR/1003/14',
    name: 'Natnael Getachew',
    cgpa: 3.82,
    department: 'Mechanical Engineering',
    cafeteria_active: false,
    expected_status: 'Rejected (Inactive Cafeteria)'
  },
  {
    ugr_id: 'UGR/1004/14',
    name: 'Chala Bekele',
    cgpa: 2.15,
    department: 'Chemical Engineering',
    cafeteria_active: false,
    expected_status: 'Rejected (Dual Failure)'
  },
  {
    ugr_id: 'UGR/1005/14',
    name: 'Eyerusalem Melaku',
    cgpa: 3.88,
    department: 'Software Engineering',
    cafeteria_active: true,
    expected_status: 'Eligible'
  }
];

export async function getDb(): Promise<Database> {
  if (dbInstance) return dbInstance;
  const SQL = await initSqlJs();

  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  let db: Database;
  if (fs.existsSync(DB_FILE)) {
    try {
      const fileBuffer = fs.readFileSync(DB_FILE);
      db = new SQL.Database(fileBuffer);
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  dbInstance = db;
  initializeTables(db);
  saveDb(db);
  return db;
}

export function saveDb(db?: Database) {
  const target = db || dbInstance;
  if (!target) return;
  try {
    const data = target.export();
    fs.writeFileSync(DB_FILE, Buffer.from(data));
  } catch (err) {
    console.error('Error saving SQLite database:', err);
  }
}

function initializeTables(db: Database) {
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

export function executeQuery<T = any>(sql: string, params: any[] = []): T[] {
  if (!dbInstance) throw new Error('Database not initialized');
  const stmt = dbInstance.prepare(sql);
  if (params && params.length > 0) stmt.bind(params);
  const results: T[] = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject() as T);
  }
  stmt.free();
  return results;
}

export function executeQueryOne<T = any>(sql: string, params: any[] = []): T | null {
  const rows = executeQuery<T>(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export function executeRun(sql: string, params: any[] = []): { changes: number } {
  if (!dbInstance) throw new Error('Database not initialized');
  dbInstance.run(sql, params);
  saveDb(dbInstance);
  return { changes: dbInstance.getRowsModified() };
}

export function performRollover() {
  if (!dbInstance) throw new Error('Database not initialized');
  const voteCount = executeQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM votes')?.count || 0;
  const tokenCount = executeQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM tokens')?.count || 0;
  const registryCount = executeQueryOne<{ count: number }>('SELECT COUNT(*) as count FROM voter_registry WHERE has_received_token = 1')?.count || 0;

  dbInstance.run('DELETE FROM votes');
  dbInstance.run('DELETE FROM tokens');
  dbInstance.run('UPDATE voter_registry SET has_received_token = 0');
  saveDb(dbInstance);

  return {
    resetVotesCount: voteCount,
    resetTokensCount: tokenCount,
    resetRegistryCount: registryCount
  };
}
