# ASTU Voting System — REST API Specification (docs/api.md)

**Base URL:** `/api`  
**Authentication Schemes:**
- **Student Auth:** Bearer Token (Session JWT) issued upon `/api/login`
- **Admin Auth:** Bearer Token (Admin JWT) issued upon `/api/admin/login`
- **Voting Auth:** Blind Anonymous One-Time Voting Token (passed in vote payload)

---

## 1. Student Authentication & Eligibility

### `POST /api/login`
Authenticates a student using their UGR ID and credentials.
- **Request Body:**
  ```json
  {
    "ugr_id": "UGR/1005/14",
    "password": "password123"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "token": "stu_sess_abc123...",
    "student": {
      "ugr_id": "UGR/1005/14",
      "name": "Eyerusalem Melaku",
      "cgpa": 3.82,
      "department": "Software Engineering"
    }
  }
  ```
- **Response (401 Unauthorized):**
  ```json
  { "error": "Invalid UGR ID or password" }
  ```

---

### `GET /api/eligibility`
Checks the authenticated student's eligibility against ASTU election rules:
1. Cumulative GPA must be strictly greater than 3.00 (`cgpa > 3.00`). *Note: CGPA of exactly 3.00 is rejected.*
2. Student must possess an active campus residency status in `cafeteria_records` (`is_active = 1`).
3. Checks whether a ballot token has already been claimed (`has_received_token`).

- **Headers:** `Authorization: Bearer <student_token>`
- **Response (200 OK - Eligible):**
  ```json
  {
    "eligible": true,
    "has_received_token": false,
    "reason": "You satisfy all eligibility criteria (CGPA 3.82 > 3.00 and active campus status)."
  }
  ```
- **Response (200 OK - Ineligible):**
  ```json
  {
    "eligible": false,
    "has_received_token": false,
    "reason": "CGPA requirement failed: Your CGPA is 3.00. Election code mandates CGPA strictly greater than 3.00."
  }
  ```

---

### `POST /api/token`
Generates a cryptographically strong, anonymous voting token for an eligible student.
- **Rules:**
  - Verifies eligibility (`cgpa > 3.00` and `cafeteria.is_active = 1`).
  - Rejects if `has_received_token` is already `true`.
  - Generates a 32-character high-entropy secret.
  - Computes `SHA-256(raw_token)` and saves `token_hash` into `tokens` table.
  - Updates `voter_registry.has_received_token = 1`.
  - Returns `token` to the student ONLY ONCE. The server discards the raw token from memory immediately.
- **Headers:** `Authorization: Bearer <student_token>`
- **Response (200 OK):**
  ```json
  {
    "token": "ASTU-VOTE-7F89-A21B-4C90-D3E1",
    "message": "Token generated successfully. Save this token now! It will not be shown again."
  }
  ```
- **Response (403 Forbidden):**
  ```json
  { "error": "Token has already been issued for this UGR ID. Each voter can only claim one token." }
  ```

---

## 2. Public & Ballot APIs

### `GET /api/candidates`
Retrieves the list of running candidates.
- **Response (200 OK):**
  ```json
  [
    {
      "id": 1,
      "name": "Abdi Gemechu",
      "position": "President",
      "bio": "4th year Software Engineering student with 2 years of student council leadership.",
      "manifesto": "Digital campus services, 24/7 library power backups, and enhanced cafeteria hygiene.",
      "department": "Software Engineering"
    }
  ]
  ```

---

### `POST /api/vote`
Submits an anonymous ballot using the one-time token.
- **Privacy Assurance:** No UGR ID or Authorization header is required or accepted for this call.
- **Request Body:**
  ```json
  {
    "token": "ASTU-VOTE-7F89-A21B-4C90-D3E1",
    "candidate_id": 1
  }
  ```
  *(Or multiple positions: `{"token": "...", "votes": [1, 3, 5]}`)*
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Your vote has been cast anonymously and recorded in the digital ballot box."
  }
  ```
- **Response (400 Bad Request):**
  ```json
  { "error": "Invalid or already-expended voting token. Ballots can only be cast once." }
  ```

---

### `GET /api/announcements`
Lists announcements issued by the Electoral Board.
- **Response (200 OK):**
  ```json
  [
    {
      "id": 1,
      "title": "2026 ASTU Student Union Elections Officially Open",
      "body": "Voting runs from 8:00 AM to 6:00 PM. Please verify your eligibility early.",
      "date": "2026-09-30"
    }
  ]
  ```

---

## 3. Electoral Board (Admin) APIs

### `POST /api/admin/login`
- **Request Body:**
  ```json
  {
    "username": "admin",
    "password": "adminpassword"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "token": "adm_sess_xyz987...",
    "user": { "username": "admin", "role": "electoral_board" }
  }
  ```

---

### `POST /api/admin/candidates` / `PUT /api/admin/candidates/:id` / `DELETE /api/admin/candidates/:id`
Administrative management of candidate profiles.
- **Headers:** `Authorization: Bearer <admin_token>`

---

### `POST /api/admin/announcements` / `DELETE /api/admin/announcements/:id`
Administrative broadcast publishing.
- **Headers:** `Authorization: Bearer <admin_token>`

---

### `GET /api/admin/results`
Returns real-time ballot tally and turnout statistics.
- **Headers:** `Authorization: Bearer <admin_token>`
- **Response (200 OK):**
  ```json
  {
    "turnout": {
      "total_students": 65,
      "eligible_voters": 42,
      "tokens_issued": 28,
      "votes_cast": 26,
      "turnout_percentage": 61.9
    },
    "results_by_position": {
      "President": [
        { "id": 1, "name": "Abdi Gemechu", "votes": 16, "percentage": 61.5 },
        { "id": 2, "name": "Selamawit Desta", "votes": 10, "percentage": 38.5 }
      ]
    }
  }
  ```

---

### `POST /api/admin/rollover`
Simulates a new academic year.
- **Actions performed:**
  1. Wipes `votes` table completely.
  2. Wipes `tokens` table completely.
  3. Resets `voter_registry.has_received_token = 0` for all students.
  4. Advances student academic year and recalculates eligible cohort numbers.
- **Headers:** `Authorization: Bearer <admin_token>`
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Academic year rollover completed. Election tables reset for 2026/2027.",
    "new_eligible_count": 45
  }
  ```

---

## 4. Committee Proof & Demo Endpoints

### `GET /api/admin/db-inspect`
Inspects raw database tables live to prove zero linkage between voter identity and cast votes.
- **Headers:** `Authorization: Bearer <admin_token>`

### `GET /api/demo/accounts`
Returns predefined test cases for committee presentation (Low GPA, Exactly 3.00 GPA, Inactive Cafeteria, Eligible Voter, Admin).
