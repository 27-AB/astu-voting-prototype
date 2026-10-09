# ASTU Voting System — Database Schema Specification (docs/schema.md)

**System:** Adama Science and Technology University (ASTU) Student Union Voting Prototype  
**Architect:** Person A (Backend & Security)  
**Database Engine:** SQLite 3  

---

## Architecture Overview & Anonymity Model

The primary security requirement of the ASTU voting system is **Unconditional Voter Privacy (Zero Linkage)**. 
At no point can any administrative entity, database administrator, or network observer correlate a cast ballot back to a student's UGR ID.

### The Three Isolated Domains:
1. **Identity & Eligibility Domain:** `registrar_students` + `cafeteria_records`  
   Holds student academic credentials and campus residency status.
2. **Token Issuance Domain:** `voter_registry`  
   Tracks *whether* an eligible student has claimed their one-time ballot token (`has_received_token = 1`), but **never stores the token or token hash**.
3. **Ballot Box Domain:** `tokens` + `votes`  
   - `tokens` stores only the SHA-256 hash of tokens without any user references.
   - `votes` stores only `candidate_id`. There is **no student ID, no token hash, and no fine-grained timestamp** in the votes table.

```
+--------------------------+
|   registrar_students     |
|   (ugr_id, cgpa, ...)    |
+------------+-------------+
             |
             v  [Eligibility Gate: CGPA > 3.00 & Cafeteria Active]
+------------+-------------+
|    cafeteria_records     |
|    (ugr_id, is_active)   |
+------------+-------------+
             |
             v  [Token Claimed]
+------------+-------------+           [Cryptographic Air-Gap]
|     voter_registry       | = = = = = = = = = = = = = = = = = = = => [Student receives raw token]
| (ugr_id, has_received)   |                                                     |
+--------------------------+                                                     |
                                                                                 v
                                                +------------------+     +---------------+
                                                |      tokens      |     |     votes     |
                                                | (token_hash,     |     | (candidate_id)|
                                                |  is_used)        |     +---------------+
                                                +------------------+       NO FOREIGN KEY!
```

---

## Table Definitions

### 1. `registrar_students`
Official university records supplied by the ASTU Office of the Registrar.
```sql
CREATE TABLE registrar_students (
    ugr_id TEXT PRIMARY KEY,               -- e.g. 'UGR/1001/14'
    name TEXT NOT NULL,                    -- Student full name
    cgpa REAL NOT NULL,                    -- Cumulative GPA (must be strictly > 3.00 to vote)
    department TEXT NOT NULL,              -- Academic department / School
    password_hash TEXT NOT NULL,           -- bcrypt hash of student password
    voter_type TEXT NOT NULL DEFAULT 'STANDARD'
        CHECK (voter_type IN ('STANDARD', 'AUTHORITY')),
    vote_weight INTEGER NOT NULL DEFAULT 1
        CHECK (vote_weight IN (1, 3))
);
```

### 2. `cafeteria_records`
Campus residency and cafeteria meal authentication status from ASTU Student Services.
```sql
CREATE TABLE cafeteria_records (
    ugr_id TEXT PRIMARY KEY,               -- References UGR ID
    is_active INTEGER NOT NULL DEFAULT 0,  -- 1 = Registered & active on campus, 0 = Inactive / Non-resident
    FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
);
```

### 3. `voter_registry`
Tracks election participation status per academic year without linking to cast ballots.
```sql
CREATE TABLE voter_registry (
    ugr_id TEXT PRIMARY KEY,
    has_received_token INTEGER NOT NULL DEFAULT 0, -- 1 = Token already claimed, 0 = Not claimed
    FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
);
```

### 4. `tokens`
Stores one-way cryptographic hashes of generated voting tokens.
```sql
CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,          -- SHA-256 hash of the 128-bit random token
    is_used INTEGER NOT NULL DEFAULT 0,   -- 0 = Valid / Unspent, 1 = Expended / Voted
    vote_weight INTEGER NOT NULL DEFAULT 1
        CHECK (vote_weight IN (1, 3))    -- Copied from voter roster; no student ID stored
);
```
*Note:* No student identifier exists in this table. When a student generates a token, the server computes `SHA256(raw_token)`, inserts `token_hash`, and immediately gives `raw_token` to the student. The server discards `raw_token` from memory.

### 5. `candidates`
Nominated student leaders running for union leadership.
```sql
CREATE TABLE candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    position TEXT NOT NULL,               -- e.g. 'President', 'Vice President', 'Academic Affairs'
    bio TEXT NOT NULL,
    manifesto TEXT NOT NULL,
    department TEXT,
    photo_url TEXT
);
```

### 6. `votes`
The digital ballot box.
```sql
CREATE TABLE votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    vote_weight INTEGER NOT NULL DEFAULT 1
        CHECK (vote_weight IN (1, 3)),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);
```
*Security Invariant:*
- NO `ugr_id` column.
- NO `token_hash` column.
- NO timestamp column (prevents timing correlation with token claim or request logs).
- Vote weight is copied from the anonymous, single-use token and is not accepted from the request body.

### 7. `announcements`
Broadcast updates from the ASTU Electoral Board.
```sql
CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT NOT NULL                    -- e.g. '2026-09-30'
);
```

### 8. `admin_users`
Authorized electoral committee officers.
```sql
CREATE TABLE admin_users (
    username TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'electoral_board'
);
```

## Weighted authority ballots

This repository currently runs Express with `sql.js` and a local SQLite file; it does not use Prisma or PostgreSQL. Startup migrations add `voter_type`, `vote_weight` and token/ledger weight columns to existing SQLite files while preserving older standard ballots as weight 1.

Set `AUTHORITY_IDS` in `backend/.env` to exactly three distinct, already-registered authority IDs. The code also accepts the legacy `VIP_STUDENT_IDS` value for compatibility. On startup, the backend validates all three IDs, marks only those authority records as `AUTHORITY` with weight 3, and resets all other roster entries to `STANDARD` with weight 1. A login response includes the server-sourced `voter_type` and `vote_weight` for routing/display. The vote handler ignores any client-supplied weight, consumes the token and appends each weighted candidate row in one SQLite transaction. Result tallies use `SUM(vote_weight)`.

`ELECTION_START_TIME` and `ELECTION_END_TIME` must be timezone-qualified ISO-8601 timestamps. The public election-status endpoint reports the server clock; votes are rejected before the start and at or after the end. Final results are returned to authenticated students only after the end time.

The current SQLite prototype is a single-process local database and is not suitable for horizontally scaled production deployments. Multi-instance production deployment requires migrating this transaction and schema to a shared transactional database such as PostgreSQL.
