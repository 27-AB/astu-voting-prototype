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
2. **Token Delivery Domain:** `voter_registry` + `token_email_deliveries`
   Tracks explicit registration and email delivery status. The delivery queue temporarily stores an encrypted token and its hash only while SMTP delivery is pending; these fields are erased when delivery succeeds or the election starts.
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
             v  [Registered and email delivery status]
+------------+-------------+           [Cryptographic Air-Gap]
|     voter_registry       | = = = = = = = = = = = = = = = = = = = => [Student receives raw token]
| (ugr_id, has_received)   |                                                     |
+--------------------------+                                                     |
             |                                                                   |
             v                                                                   |
 +--------------------------+                                                    |
 | token_email_deliveries   |                                                    |
 | (voter ID, send status)  |                                                    |
 +--------------------------+                                                    |
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
    has_received_token INTEGER NOT NULL DEFAULT 0, -- 1 = Token email delivered, 0 = Not delivered
    is_registered INTEGER NOT NULL DEFAULT 0,       -- Explicit parliament voter registration
    FOREIGN KEY (ugr_id) REFERENCES registrar_students(ugr_id)
);
```

### 4. `election_participation`
Stores each standard student's single mutually exclusive election role. The primary key enforces one choice per student; the application updates it transactionally with the candidate profile or voter registry.
```sql
CREATE TABLE election_participation (
    ugr_id TEXT PRIMARY KEY REFERENCES registrar_students(ugr_id),
    choice TEXT NOT NULL CHECK (choice IN ('CANDIDATE', 'VOTER', 'NONE')),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```
Existing linked candidate profiles and registered voters are backfilled during database initialization. Candidate profiles are created from the student's authenticated role choice, with `candidates.student_ugr_id` as the ownership link; only that student can update the profile, and only before election start. Admin candidate mutation routes are explicitly denied.

### 5. `token_email_deliveries`
Durable retry state for scheduled email delivery. This table stores retry metadata. While delivery is pending, it temporarily holds an encrypted raw token and its hash; both are cleared after successful delivery or invalidated at election start.
```sql
CREATE TABLE token_email_deliveries (
    election_start_time TEXT NOT NULL,
    voter_ugr_id TEXT NOT NULL REFERENCES registrar_students(ugr_id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    mailed_at TEXT,
    token_hash TEXT,                      -- Cleared after successful delivery
    token_ciphertext TEXT,                -- AES-256-GCM encrypted, cleared after delivery
    token_iv TEXT,
    token_auth_tag TEXT,
    PRIMARY KEY (election_start_time, voter_ugr_id)
);
```

### 6. `tokens`
Stores one-way cryptographic hashes of generated voting tokens.
```sql
CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,          -- SHA-256 hash of the 128-bit token
    is_used INTEGER NOT NULL DEFAULT 0    -- 0 = Valid / Unspent, 1 = Expended / Voted
);
```
*Note:* No student identifier exists in this table. Twelve hours before election start, the backend generates a random 128-bit token, computes `SHA256(raw_token)`, and emails the raw token. Until SMTP accepts the email, an AES-256-GCM encrypted retry copy and its hash are held in `token_email_deliveries`; both are erased from that voter-specific queue after successful delivery. The token table retains only the hash, with no voter reference.

### 7. `candidates`
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

### 8. `judge_scores`
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

### 9. `votes`
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

### 8. `announcements`
Broadcast updates from the ASTU Electoral Board.
```sql
CREATE TABLE announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    date TEXT NOT NULL                    -- e.g. '2026-09-30'
);
```

### 9. `admin_users`
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

`PARLIAMENT_VOTER_IDS` is the authoritative allowlist and must contain 50–100 distinct, registered, eligible non-judge voter IDs. Each voter must explicitly register before the deadline 12 hours before election start. At that deadline, the backend queues registered voters for email token delivery; delivery state is tracked separately from the anonymous token hash. The token itself is hashed and unlinked from the voter in the ballot tables. Every valid parliamentary ballot selects exactly one candidate for each of President, Vice President, and Secretary. Each selection counts as one vote.

`judge_scores` stores one integer score from 0 through 20 for each judge/candidate pair. Judges may revise their scores until election end. All judges must score every candidate before a ballot is accepted. The average judge score contributes up to 30 points: `average / 20 * 30`. Parliamentary share contributes up to 70 points: `candidate votes / all votes cast for that position * 70`. The final ranking is the sum of those components, sorted within each position with candidate ID as a deterministic tie-breaker.

Judge scores are admin-only before voting starts, visible to voters during the election, and included in public final results after close. Candidate accounts are linked to candidate profiles by `candidates.student_ugr_id`; their dashboard shows all current ranks and score components. The authenticated student creates and owns this profile through the candidate participation choice.

`ELECTION_START_TIME` and `ELECTION_END_TIME` must be timezone-qualified ISO-8601 timestamps. The public election-status endpoint reports the server clock; ballots are rejected before the start and at or after the end. Final results become public after the end time.

The current SQLite prototype is a single-process local database and is not suitable for horizontally scaled production deployments. Multi-instance production deployment requires migrating this transaction and schema to a shared transactional database such as PostgreSQL.
