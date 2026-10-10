
# ASTU Voting System: API Contract

This file documents the ASTU voting backend and frontend API contract.

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
{
  "token": "opaque-session-token",
  "student": {
    "ugr_id": "UGR/1234/15",
    "name": "Student Name",
    "voter_type": "AUTHORITY",
    "is_candidate": false
  }
}
```
`AUTHORITY` identifies one of the two appointed proposal judges. Judges are not parliamentary voters and do not receive a ballot token.
Error (401):
```json
{ "error": "Invalid ID or password" }
```

### GET /api/eligibility
Needs login header. Tells the student if they can vote.

Success, eligible (200):
```json
{
  "eligible": true,
  "reason": null,
  "has_received_token": false,
  "parliament_member": true,
  "registered_for_election": false
}
```
Success, not eligible (200):
```json
{ "eligible": false, "reason": "CGPA is below 3.0", "has_received_token": false }
```
Possible reasons:
- `"CGPA is below 3.0"`
- `"No active cafeteria access"`
- `"CGPA is below 3.0 and no active cafeteria access"`
- `"Not on the approved parliament voter roster"`

### POST /api/token
Needs login header. Creates one anonymous token for an eligible parliament voter who has explicitly registered. Judges and non-roster students are denied.

Success (200):
```json
{ "token": "a8f3-92kd-xxxx-xxxx" }
```
Errors include a 403 for non-roster, ineligible, unregistered, or repeat token requests.

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
After voting opens, only registered parliamentary voters may access this route. Candidate entries then include `judge_score` (the average of both judges' 0–20 scores), `judge_points` (up to 30), current `rank`, `parliament_votes`, `parliament_share` (up to 70), and `final_score`. The score fields are withheld before voting starts.

### POST /api/election/register
Requires student login and is only available before election start. The account must be among the configured 50–100 eligible parliament voter IDs. Registration is one account per eligible voter.

Success (201): `{ "message": "You are registered as a parliamentary voter" }`.

### GET /api/election/status
Returns election timing from the server clock. `phase` is `scheduled`, `open`, or `closed`. `judging_complete` is true only when both current judges have scored every candidate.

Success (200):
```json
{
  "election_start_time": "2026-11-01T09:00:00Z",
  "election_end_time": "2026-11-01T17:00:00Z",
  "server_time": "2026-11-01T09:00:01.000Z",
  "phase": "open",
  "is_open": true,
  "judging_complete": true
}
```

Voting is denied with 403 before the start and at or after the end. If either timestamp is missing or invalid, status and voting return 503 (fail closed).

### POST /api/vote
Does not need login. The single-use token is the proof. It must select exactly one candidate for each of President, Vice President, and Secretary. Each selection is one parliamentary vote.

Request:
```json
{ "token": "a8f3-92kd-xxxx-xxxx", "votes": [1, 3, 5] }
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

### GET /api/results
Public after the server election clock reaches `election_end_time`. Before close it returns 403. Final standings combine the judges' average (30 points maximum) and the candidate's share of parliament votes for that position (70 points maximum).

Success (200):
```json
{
  "election_end_time": "2026-11-01T17:00:00Z",
  "winners": [
    {
      "candidate_id": 1,
      "name": "Candidate Name",
      "position": "President",
      "judge_score": 18,
      "judge_points": 27,
      "parliament_votes": 30,
      "parliament_share": 42,
      "final_score": 69,
      "rank": 1
    }
  ],
  "results": ["all candidates with scores and position rank"]
}
```

### Judge endpoints

Student Affairs judges authenticate using normal student login.

- `GET /api/judge/candidates`: list candidate proposals and the authenticated judge's own saved score.
- `PUT /api/judge/scores/:candidateId` with `{ "score": 0 }` through `{ "score": 20 }`: save or revise a score until election end. Each judge must score every candidate before votes are accepted.
- `GET /api/candidate/dashboard`: authenticated candidate's own and all candidates' current scores/ranks. The login account must be linked to a candidate profile by the admin.

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
{ "name": "...", "position": "President", "bio": "...", "manifesto": "...", "student_ugr_id": "UGR/1234/15" }
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
  "turnout": { "votes_cast": 42, "eligible_voters": 75, "percent": 56 },
  "results": [
    {
      "candidate_id": 1,
      "name": "Candidate Name",
      "position": "President",
      "judge_score": 18,
      "judge_points": 27,
      "parliament_votes": 30,
      "parliament_share": 42,
      "final_score": 69,
      "rank": 1
    }
  ]
}
```
`GET /api/admin/judging-results` returns individual judge scores to admins, including before election start. Public candidate ratings remain hidden until voting opens.

### Election environment

- `STUDENT_AFFAIRS_JUDGE_IDS`: exactly two distinct, registered judge accounts (Student Affairs President and Vice President).
- `PARLIAMENT_VOTER_IDS`: 50–100 distinct registered, eligible non-judge UGR IDs.
- `ELECTION_START_TIME` / `ELECTION_END_TIME`: timezone-qualified ISO-8601 timestamps.

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
