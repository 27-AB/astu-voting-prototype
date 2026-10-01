# ASTU Voting System: API Contract

This file is the agreement between Person A (backend) and Person B (frontend).
Both sides follow it exactly. If anything changes, update this file FIRST, then tell the other person.

---

## General rules

- Base URL: `http://localhost:3000` (change the port if needed)
- All requests and responses use JSON.
- Protected requests send the login token in this header:
  `Authorization: Bearer <token>`
- Errors always look like this, with the right HTTP status (400, 401, 403, 404, 429, 500):
  ```json
  { "error": "Short readable message" }
  ```
- All field names use `snake_case` (example: `ugr_id`, not `ugrId`).

---

## Student endpoints

### POST /api/login
Login with UGR ID and password.

Request:
```json
{ "ugr_id": "UGR/1234/15", "password": "abc123" }
```
Success (200):
```json
{ "token": "jwt-string-here" }
```
Error (401):
```json
{ "error": "Invalid ID or password" }
```

### GET /api/eligibility
Needs login header. Tells the student if they can vote.

Success, eligible (200):
```json
{ "eligible": true, "reason": null, "has_received_token": false }
```
Success, not eligible (200):
```json
{ "eligible": false, "reason": "CGPA is below 3.0", "has_received_token": false }
```
Possible reasons:
- `"CGPA is below 3.0"`
- `"No active cafeteria access"`
- `"CGPA is below 3.0 and no active cafeteria access"`

### POST /api/token
Needs login header. Creates ONE anonymous voting token. The plain token is shown only once.

Success (200):
```json
{ "token": "a8f3-92kd-xxxx-xxxx" }
```
Errors:
```json
{ "error": "You are not eligible to vote" }
```
```json
{ "error": "You have already received a token" }
```

### GET /api/candidates
Success (200):
```json
[
  {
    "id": 1,
    "name": "Candidate Name",
    "position": "President",
    "bio": "Short bio text",
    "manifesto": "Manifesto text"
  }
]
```

### POST /api/vote
Does not need login. The token is the proof.

Request:
```json
{ "token": "a8f3-92kd-xxxx-xxxx", "candidate_id": 1 }
```
Success (200):
```json
{ "message": "Vote recorded" }
```
Errors:
```json
{ "error": "Token is missing" }
```
```json
{ "error": "Invalid token" }
```
```json
{ "error": "Token already used" }
```
```json
{ "error": "Candidate does not exist" }
```

### GET /api/announcements
Success (200):
```json
[
  { "id": 1, "title": "Election date", "body": "Voting opens on ...", "date": "2026-10-10" }
]
```

---

## Admin endpoints

All admin endpoints need the admin token in the `Authorization` header.
Without it the answer is 401 `{ "error": "Admin login required" }`.

### POST /api/admin/login
Request:
```json
{ "username": "admin", "password": "admin123" }
```
Success (200):
```json
{ "token": "admin-jwt-string" }
```
Error (401):
```json
{ "error": "Invalid admin login" }
```

### POST /api/admin/candidates
Add a candidate.

Request:
```json
{ "name": "...", "position": "President", "bio": "...", "manifesto": "..." }
```
Success (201):
```json
{ "id": 9, "name": "...", "position": "President", "bio": "...", "manifesto": "..." }
```

### PUT /api/admin/candidates/:id
Edit a candidate. Same request body as POST.

Success (200): the updated candidate (same shape as above).

### DELETE /api/admin/candidates/:id
Success (200):
```json
{ "message": "Candidate deleted" }
```

### POST /api/admin/announcements
Request:
```json
{ "title": "...", "body": "..." }
```
Success (201):
```json
{ "id": 4, "title": "...", "body": "...", "date": "2026-09-30" }
```
(The server sets the date.)

### GET /api/admin/results
Success (200):
```json
{
  "turnout": { "votes_cast": 42, "eligible_voters": 80, "percent": 52.5 },
  "results": [
    { "candidate_id": 1, "name": "Candidate Name", "position": "President", "votes": 20 }
  ]
}
```

### POST /api/admin/rollover
Simulates a new academic year. No request body.

Success (200):
```json
{ "message": "New academic year started. Registry, tokens and votes reset." }
```

---

## Mock demo accounts (agree on these too)

Person A seeds these, Person B uses them in the demo. Fill in the real IDs.

| Case | UGR ID | Password | Expected result |
| --- | --- | --- | --- |
| Eligible student | UGR/0001/15 | demo123 | Eligible, can get token |
| Low CGPA | UGR/0002/15 | demo123 | Not eligible: CGPA is below 3.0 |
| No cafeteria | UGR/0003/15 | demo123 | Not eligible: No active cafeteria access |
| Both fail | UGR/0004/15 | demo123 | Not eligible: both reasons |
| CGPA exactly 3.0 | UGR/0005/15 | demo123 | Not eligible: CGPA is below 3.0 |
| Admin | (username) admin | admin123 | Admin dashboard |

---

## Change log

- Day 1: first version.
