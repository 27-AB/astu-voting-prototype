# ASTU Voting System — Frontend & Backend Integration Guide (docs/integration_guide.md)

**Target Audience:** Person A (Backend & Security) and Person B (Frontend & Demo)  
**Project:** Adama Science and Technology University (ASTU) Student Union Voting Prototype  

---

## 1. How the Frontend Connects to the Backend

### The Big Picture
Your backend is an Express server running at `http://localhost:3000` (or `APP_URL`).  
It exposes clean REST endpoints under the `/api` prefix.

Person B’s frontend will make HTTP requests (`fetch` or `axios`) to these endpoints:

```
[ Person B's Frontend (React/HTML/JS) ]
                 │
                 │ 1. POST /api/login { ugr_id, password }
                 ▼
[ Person A's Backend (Express + SQLite) ]
                 │
                 │ 2. Returns { token: "stu_sess_...", student: {...} }
                 ▼
[ Person B's Frontend stores token in memory/localStorage ]
                 │
                 │ 3. GET /api/eligibility
                 │    Header: "Authorization: Bearer stu_sess_..."
                 ▼
[ Person A's Backend verifies GPA > 3.00 & Cafeteria ]
```

---

## 2. GitHub Collaboration Workflow (Day 1 Agreement)

### Repo Structure
```text
astu-voting-system/
├── backend/            <-- Person A's work (server.ts, db.ts, sqlite, seed, tests)
├── frontend/           <-- Person B's work (React components, styles, ballot UI)
├── docs/               <-- Shared documentation
│   ├── schema.md       <-- Agreed DB schema
│   ├── api.md          <-- Agreed API contract
│   └── integration_guide.md
├── README.md
└── package.json
```

### Git Branching Rules:
1. **Never commit directly to `main`**:
   - Person A works on branch: `git checkout -b person-a-backend`
   - Person B works on branch: `git checkout -b person-b-frontend`
2. **Pushing changes to GitHub:**
   ```bash
   git add .
   git commit -m "feat(backend): implement token issuance and vote replay protection"
   git push origin person-a-backend
   ```
3. **Merging via Pull Request (PR):**
   - On GitHub, Person A creates a PR from `person-a-backend` into `main`.
   - Person B reviews the PR, checks that the API matches `docs/api.md`, and approves.
   - Person B pulls latest `main` into their branch:
     ```bash
     git checkout person-b-frontend
     git pull origin main
     ```

---

## 3. Frontend Integration Code Snippets (Share this with Person B!)

Here is the exact code Person B can copy-paste into their frontend components:

### Configuration: API Base URL
In Person B's frontend project:
```javascript
// config.js or api.js
export const API_BASE = 'http://localhost:3000/api'; 
// Or relative '/api' if proxy/monorepo is used
```

---

### Step 1: Student Login (`POST /api/login`)
```javascript
async function loginStudent(ugr_id, password) {
  const response = await fetch(`${API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ugr_id, password })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Login failed');
  }

  // data = { token: "stu_sess_...", student: { ugr_id, name, cgpa, department } }
  // Save token for subsequent requests:
  localStorage.setItem('student_token', data.token);
  return data;
}
```

---

### Step 2: Check Eligibility (`GET /api/eligibility`)
```javascript
async function checkEligibility() {
  const token = localStorage.getItem('student_token');
  const response = await fetch(`${API_BASE}/eligibility`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  // data = {
  //   eligible: true / false,
  //   has_received_token: true / false,
  //   cgpa: 3.88,
  //   cafeteria_active: true,
  //   reason: "..."
  // }
  return data;
}
```

---

### Step 3: Generate Anonymous Token (`POST /api/token`)
```javascript
async function generateToken() {
  const token = localStorage.getItem('student_token');
  const response = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Token request denied');
  }

  // data = { token: "ASTU-XXXX-XXXX-XXXX-XXXX", message: "..." }
  return data.token;
}
```

---

### Step 4: Fetch Candidate List (`GET /api/candidates`)
```javascript
async function getCandidates() {
  const response = await fetch(`${API_BASE}/candidates`);
  return await response.json(); // Array of candidates with position, bio, manifesto
}
```

---

### Step 5: Submit Anonymous Ballot (`POST /api/vote`)
*Note: Do NOT send any Authorization header or Student ID here! The vote is 100% anonymous.*
```javascript
async function castVote(votingToken, candidateId) {
  const response = await fetch(`${API_BASE}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: votingToken,
      candidate_id: candidateId
    })
  });

  const data = await response.json();
  if (!response.ok) {
    // If token already used or invalid: returns HTTP 400 with clear message
    throw new Error(data.error);
  }
  return data; // { success: true, message: "..." }
}
```

---

### Step 6: Electoral Admin Login & Results
```javascript
// Admin Login:
async function loginAdmin(username, password) {
  const response = await fetch(`${API_BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }) // e.g. admin / admin123
  });
  const data = await response.json();
  localStorage.setItem('admin_token', data.token);
  return data;
}

// Fetch Live Results & Turnout:
async function getLiveResults() {
  const adminToken = localStorage.getItem('admin_token');
  const response = await fetch(`${API_BASE}/admin/results`, {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  return await response.json();
}
```

---

## 4. Day 6 Integration Checklist (End-to-End Test with Person B)

When Person B finishes the screens on Day 6, sit down together and verify these 5 test cases:

| # | Action | Account | Expected Frontend Result |
|---|--------|---------|-------------------------|
| 1 | Low GPA Login | `UGR/1001/14` / `password123` | Red "Not Eligible" screen: displays `CGPA 2.45 <= 3.00` |
| 2 | Edge Case Boundary | `UGR/1002/14` / `password123` | Red "Not Eligible" screen: strictly rejected (Art. 4.2: `CGPA > 3.00`) |
| 3 | No Cafeteria | `UGR/1003/14` / `password123` | Red "Not Eligible" screen: inactive cafeteria residency |
| 4 | Eligible Voter | `UGR/1005/14` / `password123` | Green "Eligible" screen: allows generating token and voting |
| 5 | Replay Test | Same token as Step 4 | Submitting ballot second time shows error popup: "Token already expended" |
| 6 | Live Admin Update | `admin` / `admin123` | Live results chart increments by 1 and turnout % recalculates |
| 7 | Anonymity Verification | DB Inspector / Terminal | Run `SELECT * FROM votes;` $\rightarrow$ prove zero student or token columns |

---

## 5. Automated Verification
Person A has created an automated test script. At any time, you can verify your backend is functioning with:
```bash
npm run test:api
```
All 17 automated security and functional tests will execute and confirm 100% pass status.
