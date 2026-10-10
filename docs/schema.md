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
   - `votes` stores candidate selections, one row per selected candidate. There is **no student ID, no token hash, and no fine-grained timestamp** in the votes table.

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
        CHECK (voter_type IN ('STANDARD', 'AUTHORITY'))
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
    is_registered INTEGER NOT NULL DEFAULT 0,       -- Explicit parliament voter registration
    FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
);
```

### 4. `tokens`
Stores one-way cryptographic hashes of generated voting tokens.
```sql
CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,          -- SHA-256 hash of the 128-bit random token
    is_used INTEGER NOT NULL DEFAULT 0    -- 0 = Valid / Unspent, 1 = Expended / Voted
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
    photo_url TEXT,
    student_ugr_id TEXT UNIQUE REFERENCES registrar_students(ugr_id)
);
```

### `judge_scores`
One proposal score per appointed judge and candidate.
```sql
CREATE TABLE judge_scores (
    judge_ugr_id TEXT NOT NULL REFERENCES registrar_students(ugr_id),
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 20),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (judge_ugr_id, candidate_id)
);
```

### 6. `votes`
The digital ballot box.
```sql
CREATE TABLE votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id)
);
```
*Security Invariant:*
- NO `ugr_id` column.
- NO `token_hash` column.
- NO timestamp column (prevents timing correlation with token claim or request logs).
- Each candidate selection is stored as one unweighted vote row. Historical databases may retain unused `vote_weight` columns from the earlier prototype; current vote and ranking logic ignores them.

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

## Judge evaluation and parliamentary voting

This repository uses Express with `sql.js` and SQLite. The two Student Affairs officeholders configured by `STUDENT_AFFAIRS_JUDGE_IDS` (legacy `AUTHORITY_IDS` is accepted as an alias) are judges, not weighted voters. Their student records are marked `AUTHORITY`; the judges cannot register for parliament voting or request a ballot. Configure exactly two distinct, registered IDs.

`PARLIAMENT_VOTER_IDS` is the authoritative allowlist and must contain 50–100 distinct, registered, eligible non-judge voter IDs. Each voter must explicitly register before election start. Registration and the one-time token claim are recorded in `voter_registry`; the token itself is hashed and unlinked from the voter. Every valid parliamentary ballot selects exactly one candidate for each of President, Vice President, and Secretary. Each selection counts as one vote.

`judge_scores` stores one integer score from 0 through 20 for each judge/candidate pair. Judges may revise their scores until election end. All judges must score every candidate before a ballot is accepted. The average judge score contributes up to 30 points: `average / 20 * 30`. Parliamentary share contributes up to 70 points: `candidate votes / all votes cast for that position * 70`. The final ranking is the sum of those components, sorted within each position with candidate ID as a deterministic tie-breaker.

Judge scores are admin-only before voting starts, visible to voters during the election, and included in public final results after close. Candidate accounts are linked to candidate profiles by `candidates.student_ugr_id`; their dashboard shows all current ranks and score components. Admin candidate setup must link each candidate to their official student account.

`ELECTION_START_TIME` and `ELECTION_END_TIME` must be timezone-qualified ISO-8601 timestamps. The public election-status endpoint reports the server clock; ballots are rejected before the start and at or after the end. Final results become public after the end time.

The current SQLite prototype is a single-process local database and is not suitable for horizontally scaled production deployments. Multi-instance production deployment requires migrating this transaction and schema to a shared transactional database such as PostgreSQL.
