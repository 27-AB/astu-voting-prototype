# ASTU Voting Backend

Backend integration guide for the frontend. The API is an Express server backed by SQLite (`sql.js`); it does not use Prisma or PostgreSQL. See [`../docs/api.md`](../docs/api.md) for the broader API contract and [`./.env.example`](./.env.example) for election configuration.

## Run locally

From this directory:

```bash
npm install
npm run dev
```

The server listens on `http://localhost:3000` by default. Configure the election, voter roster, SMTP, email domain, and token secret environment variables before starting it; the backend returns `503` when election configuration is invalid and logs/retries token delivery if SMTP is unavailable. The SQLite database file is created under `backend/data/`.

### Scheduled email setup

1. Copy `.env.example` to `.env` and set the election timestamps and official parliament voter IDs.
2. Set SMTP connection details (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_FROM`).
3. Verify the university's UGR-to-email naming convention. The current configuration maps `UGR/0001/15` to `ugr-0001-15@astu.edu.et`; set `STUDENT_EMAIL_DOMAIN` accordingly.
4. Generate a high-entropy `VOTING_TOKEN_SECRET` with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and keep it stable and private across server restarts. It encrypts pending delivery data; it does not determine voter token values.

Registration closes exactly 12 hours before `ELECTION_START_TIME`, when the scheduled worker queues currently registered, eligible parliament voters and starts emailing their tokens. Failed deliveries retry every minute until the election starts. Run one backend instance for this SQLite-backed scheduler; if the process restarts before voting opens, it resumes pending deliveries. SMTP may accept a message immediately before an unexpected process crash, so a retry can deliver the same token email more than once.

## Frontend request conventions

- Send and receive JSON.
- For authenticated requests, use `Authorization: Bearer <token>`.
- Student login tokens are returned by `POST /api/login`; admin tokens are returned by `POST /api/admin/login`.
- Sessions are held in backend memory and expire after two hours. A server restart invalidates all sessions, so handle `401` by asking the user to sign in again.
- Errors use `{ "error": "Readable message" }`. Handle HTTP status codes, not just the message text.
- Election phases are `scheduled`, `open`, and `closed`; use the server's `server_time` and phase from `GET /api/election/status` rather than relying on the browser clock.
- Candidate positions are exactly `President`, `Vice President`, and `Secretary`.

## Roles and login response

All students use the same login form. `voter_type` identifies whether an account is an appointed judge (`AUTHORITY`) or a standard student (`STANDARD`). Standard students make one exclusive election choice (`CANDIDATE`, `VOTER`, or `NONE`) through the participation API; appointed judges receive the `JUDGE` election role.

```json
{
  "token": "student-session-token",
  "student": {
    "ugr_id": "UGR/1234/15",
    "name": "Student Name",
    "voter_type": "STANDARD",
    "is_candidate": false,
    "election_role": null
  }
}
```

Suggested frontend routing:

| Login data | Destination |
| --- | --- |
| `voter_type === "AUTHORITY"` | Judge dashboard |
| `election_role === "CANDIDATE"` | Candidate dashboard |
| `election_role === "VOTER"` | Voter eligibility / ballot flow |
| Otherwise | Election participation choice page |

The server enforces roles on protected endpoints; hiding a page in the UI is not authorization.

## Election flow

1. **Before start (`scheduled`)**: standard students choose candidate, voter, or no registration before the registration deadline (12 hours before the election). Voter choice requires eligibility and roster membership. Candidate choice creates a profile owned by the authenticated student; candidates can edit their position, bio, and manifesto until election start. Admins cannot create, edit, or delete candidate profiles. Judges score proposals, and admins can review individual judge scores.
2. **12 hours before start**: the backend worker snapshots registered, eligible parliament voters and emails each voter a cryptographically random, single-use token at the UGR-derived address. Failed deliveries are retried every minute until voting starts. The worker stores token hashes in the anonymous token table and temporarily encrypts raw tokens in the pending-mail queue for retries; after successful delivery, it erases the queue's token hash and encrypted value.
3. **Voting (`open`)**: only registered, eligible parliament voters can view proposals and their current judge averages. Voting is enabled only after both judges have scored every candidate and all three positions have candidates. A voter enters the emailed token and submits one complete ballot.
4. **At/after end (`closed`)**: vote and token endpoints reject voting. Judges can no longer revise scores. Final results are available once judging is complete.

The backend roster must contain 50–100 distinct, registered and eligible non-judge student IDs. Eligibility requires CGPA strictly greater than `3.0` and active cafeteria access. Election registration closes 12 hours before the election starts.

## API reference

### Public election endpoints

#### `GET /api/election/status`

No authentication. Poll this endpoint to update phase-dependent UI.

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

`judging_complete` is false until both configured judges have rated every candidate and candidates exist for all three positions.

#### `POST /api/login`

No authentication. Request:

```json
{ "ugr_id": "UGR/1234/15", "password": "..." }
```

Returns the login response shown above. Invalid credentials return `401`.

#### `GET /api/announcements`

No authentication. Returns an array of `{ id, title, body, date }`.

#### `GET /api/candidates`

- Before voting: requires a valid **admin** bearer token; returns candidate profile fields (`id`, `name`, `position`, `bio`, `manifesto`).
- While voting is open: requires a valid **student** bearer token for an eligible, registered parliament voter. Also returns `judge_score`, `judge_points`, `parliament_votes`, `parliament_share`, `final_score`, and `rank`.
- After voting: returns candidate profiles and result fields when judging is complete.

The score fields are not exposed to the public before the election opens. A non-registered user cannot use the open-phase endpoint to see candidate scores.

### Parliament voter endpoints

#### `GET /api/eligibility`

Requires a student bearer token. Returns:

```json
{
  "eligible": true,
  "reason": null,
  "has_received_token": false,
  "parliament_member": true,
  "registered_for_election": false
}
```

`eligible` reflects the parliament allowlist, CGPA, and cafeteria checks. Only a member of the configured parliament roster can register or vote.

#### `POST /api/election/register`

Requires a student bearer token; only available before the start time. No body required. Returns `201`:

```json
{ "message": "You are registered as a parliamentary voter" }
```

The account must be on the approved roster and meet the student eligibility checks.

#### `POST /api/token`

Requires a student bearer token; available during the open phase after registration and successful email delivery. No body required. This endpoint confirms delivery; it does not reveal or generate the token:

```json
{
  "email_sent": true,
  "message": "Your voting token was sent to your registered student email address."
}
```

The frontend should ask the voter to retrieve the token from their email and enter it on the ballot. The election token is single-use for casting a ballot. Only its SHA-256 hash remains in the anonymous token table.

#### `POST /api/vote`

No student session is required: the single-use token authorizes the anonymous ballot. The UI should collect one candidate ID for each of the three positions and send all three IDs:

```json
{ "token": "ABCD-EF01-2345-6789-...", "votes": [1, 3, 5] }
```

`votes` must contain exactly one valid candidate per position. On success, the token is consumed and the response is:

```json
{ "message": "Vote recorded" }
```

Incomplete ballots, duplicate positions, invalid candidates, invalid/used tokens, judging-incomplete state, and out-of-window voting are rejected. Token consumption and all three vote insertions happen in one transaction. The ballot is one vote per selected candidate (no VIP or weighted ballots).

### Judge endpoints

Judge accounts sign in through `POST /api/login` and use the resulting student bearer token.

#### `GET /api/judge/candidates`

Returns candidate proposals plus `my_score` (an integer from 0 to 20 or `null`) for the authenticated judge.

#### `PUT /api/judge/scores/:candidateId`

Request:

```json
{ "score": 17 }
```

Creates or revises the judge's score for that candidate. Scores must be integers from 0 through 20. Judges can revise scores until the election end time. The frontend should refresh election status and disable score editing once `phase === "closed"`.

### Candidate endpoint

#### `GET /api/candidate/dashboard`

Requires the candidate's student bearer token and a candidate profile linked to that account. Before results are published:

```json
{
  "candidate_id": 1,
  "phase": "open",
  "results_published": false,
  "standings": [],
  "own_standing": null
}
```

After the election closes and judging is complete, `results_published` becomes true; `standings` contains the rankings and score breakdown for all candidates, and `own_standing` is the candidate's own row (or `null` if unavailable). The dashboard should keep a path to voter eligibility because a candidate can also belong to parliament.

### Final results endpoint

#### `GET /api/results`

No authentication. Returns `403` until after the election end time and `503` if judging is incomplete. Success:

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
  "results": []
}
```

`winners` contains the highest-ranked candidate for each position when one exists. `results` contains the full candidate ranking rows.

The final score is calculated per position:

- Judge component: average of both judges' scores out of 20, scaled to 30 points.
- Parliament component: candidate's share of valid votes for that position, scaled to 70 points.
- Final score: judge points plus parliament points, out of 100.

The ranking is deterministic; ties are broken by candidate ID.

### Admin endpoints

Admin bearer tokens come from `POST /api/admin/login` with `{ "username": "...", "password": "..." }`. The success response is `{ "token": "..." }`.

| Method and path | Purpose |
| --- | --- |
| `GET /api/admin/judging-results` | View proposals and individual judge scores before voting starts. |
| `GET /api/admin/results` | View candidate result breakdown and turnout. |
| `POST`, `PUT`, `PATCH`, `DELETE /api/admin/candidates...` | Explicitly denied for authenticated admins (403). |
| `POST /api/admin/announcements` | Create an announcement using `{ "title": "...", "body": "..." }`. |
| `DELETE /api/admin/announcements/:id` | Delete an announcement. |
| `POST /api/admin/rollover` | Reset election registration, tokens, judge scores, and votes for a new academic year. |

`GET /api/election/participation` returns the student's saved choice, eligibility, candidate profile, and whether selection remains open. `POST /api/election/participation` saves one of `CANDIDATE`, `VOTER`, or `NONE`. Candidate creation uses the authenticated student's registrar name and validates position, biography, and manifesto. `GET` and `PUT /api/candidate/profile` are owner-scoped; edits are allowed only until election start. There are no admin vote-edit endpoints.

## Frontend implementation checklist

- [ ] Use `GET /api/election/status` as the source of truth for phase and timing.
- [ ] Route judge and candidate accounts using `voter_type` and `election_role` from login; send students with no saved role to the participation-choice page.
- [ ] For parliament users: choose `VOTER` before `registration_deadline` → receive the token by email 12 hours before the election → enter the emailed token and select all three positions during voting. `POST /api/token` confirms delivery but never returns the secret.
- [ ] Use `registration_open` from election status to disable registration at the 12-hour deadline.
- [ ] Gate ballot display until `phase === "open"` and `judging_complete === true`.
- [ ] After the end time, remove/disable ballot controls and load `GET /api/results` for final winners.
- [ ] Show scores to registered parliament voters only during the open phase; display final standings on the candidate dashboard only when `results_published` is true.
- [ ] Handle `401` by re-authenticating, `403` as a role/phase/eligibility denial, `429` as rate limited, and `503` as unavailable/invalid election configuration or incomplete judging.

## Important integration boundaries

- Token generation and email delivery are backend responsibilities. The worker schedules delivery for 12 hours before `ELECTION_START_TIME`, retries failed deliveries once per minute until voting opens, and does not send late tokens after the election starts. If the server is offline at the scheduled time, it catches up on startup if the election has not started yet.
- Voter email addresses are derived as a lowercase UGR ID with separators replaced by hyphens, followed by `@STUDENT_EMAIL_DOMAIN`; for example, `UGR/0001/15` becomes `ugr-0001-15@astu.edu.et`. Confirm that this matches the institution's actual email convention before enabling live email.
- SMTP and `VOTING_TOKEN_SECRET` must be configured in the backend environment. See `.env.example`; never commit actual SMTP credentials or the token secret. Generate a stable, high-entropy token secret and keep it unchanged across restarts for the election.
- A token email is retried if SMTP delivery fails. SMTP can accept an email immediately before the server crashes, so a retry may send the same token again; the token itself remains stable and single-use.
- If email settings are missing or invalid, token delivery is logged and retried. Tokens are not exposed through the API; delivery state is reported only after SMTP accepts the email.
- Sessions are in-memory, not persistent JWTs. Keep tokens in session storage (or equivalent short-lived client storage) and handle expiry.
- The voting token is generated with a cryptographically secure random generator and hashed with SHA-256 in the anonymous token table. Its encrypted retry copy and associated hash are erased from the voter-specific mail queue after successful delivery (or invalidated if never delivered by election start); ballot records do not contain a voter ID.
- Do not send weighted-vote values from the browser. The supported parliament ballot gives one vote to each of the three selected candidates.
