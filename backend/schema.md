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
    password_hash TEXT NOT NULL            -- bcrypt hash of student password
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
    photo_url TEXT
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
