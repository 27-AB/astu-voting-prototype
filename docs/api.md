
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
    "is_candidate": false,
    "election_role": "JUDGE"
  }
}
```
`AUTHORITY` identifies one of the two appointed proposal judges. Judges are not parliamentary voters and do not receive a ballot token.

### GET /api/election/participation
Requires student login. Returns the student's saved role (`CANDIDATE`, `VOTER`, `NONE`, `JUDGE`, or `null`), their linked candidate profile, voter eligibility, and whether role selection is open.

### POST /api/election/participation
Requires student login and is available until the registration deadline, 12 hours before election start. Standard students must choose exactly one role: `CANDIDATE`, `VOTER`, or `NONE`. Candidate names come from the authenticated registrar record; candidate choice requires a position, 2–500 character bio, and 20–5000 character manifesto. Voter choice requires roster membership, CGPA greater than 3.0, and active cafeteria access. A student's latest choice replaces their earlier choice. Switching away from a candidate with recorded votes is rejected.

Candidate request:
```json
{
  "choice": "CANDIDATE",
  "position": "President",
  "bio": "Candidate biography",
  "manifesto": "A proposal with at least twenty characters."
}
```
Voter or no-registration requests use `{ "choice": "VOTER" }` or `{ "choice": "NONE" }`.
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
  "registered_for_election": false,
  "election_role": null
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
Needs login header. During voting, confirms that this eligible, registered parliament voter received their single-use token by email. It never returns the token itself. Judges, non-roster students, unregistered students, and voters whose token email has not been delivered are denied.

Success (200):
```json
{
  "email_sent": true,
  "message": "Your voting token was sent to your registered student email address."
}
```

The backend schedules cryptographically random token generation and email delivery for 12 hours before `ELECTION_START_TIME`. Token emails are sent to the address derived from the UGR ID and `STUDENT_EMAIL_DOMAIN`; failed SMTP deliveries are retried until voting starts. This endpoint confirms delivery but never returns the secret token.

The isolated presentation runner sets `demo_mode: true` and returns a synthetic `demo_token` only for its synthetic local account. It binds to loopback, uses a separate demo database, and does not send email. Never enable this mode for a real election.

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
Legacy voter-registration endpoint. Requires student login, remains available before `registration_deadline`, and cannot override a saved candidate or no-registration choice. New clients should use `POST /api/election/participation` with `choice: "VOTER"`.

Success (201): `{ "message": "You are registered as a parliamentary voter" }`.

### GET /api/election/status
Returns election timing from the server clock. `phase` is `scheduled`, `open`, or `closed`. `judging_complete` is true only when both current judges have scored every candidate.

Success (200):
```json
{
  "election_start_time": "2026-11-01T09:00:00Z",
  "election_end_time": "2026-11-01T17:00:00Z",
  "registration_deadline": "2026-10-31T21:00:00.000Z",
  "registration_open": false,
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
- `GET /api/candidate/dashboard`: authenticated candidate's own and all candidates' current scores/ranks. The login account must have selected the candidate role and own the linked profile.
- `GET /api/candidate/profile`: returns the authenticated candidate's own profile.
- `PUT /api/candidate/profile`: candidate-owned profile edit for position, bio, and manifesto until election start. The server derives the candidate name from the registrar record; another student's profile cannot be edited.

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

Candidate create, update, and delete methods under `/api/admin/candidates` return 403 for authenticated admins. Candidate profiles are created by student role selection and can only be edited by their owner through `PUT /api/candidate/profile`.

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
- `STUDENT_EMAIL_DOMAIN`: domain appended to normalized UGR IDs, e.g. `astu.edu.et` (`UGR/0001/15` becomes `ugr-0001-15@astu.edu.et`).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM`: backend SMTP delivery settings.
- `VOTING_TOKEN_SECRET`: stable, private secret of at least 32 random bytes used to derive tokens without storing raw token values.

### POST /api/admin/rollover
Simulates a new academic year. No request body.

Success (200):
```json
{ "message": "New academic year started. Registry, tokens, email deliveries and votes reset." }
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
