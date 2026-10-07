// =====================================================================
// api.js: the ONLY file that talks to the backend.
// Pages call these functions and never use fetch() directly.
// To connect to Person A's real server: set USE_MOCK = false.
// All shapes follow docs/api.md.
// =====================================================================

export const USE_MOCK = false;
const BASE_URL = "http://localhost:3000";

// ---------- Saved login tokens (cleared when the tab closes) ----------
const getSaved = (key) => sessionStorage.getItem(key);
const save = (key, value) => sessionStorage.setItem(key, value);
export const logout = () => sessionStorage.clear();

// ---------- Real requests ----------
// Sends the request, adds the Authorization header when needed,
// and throws an Error with the server's message if something fails.
async function request(path, method = "GET", body, tokenKey) {
  const headers = { "Content-Type": "application/json" };
  if (tokenKey) headers.Authorization = `Bearer ${getSaved(tokenKey)}`;

  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Server error");
  return data;
}

// ---------- Mock data (fake, in memory) ----------
const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const mockStudents = {
  "UGR/0001/15": { eligible: true, reason: null },
  "UGR/0002/15": { eligible: false, reason: "CGPA is below 3.0" },
  "UGR/0003/15": { eligible: false, reason: "No active cafeteria access" },
  "UGR/0004/15": {
    eligible: false,
    reason: "CGPA is below 3.0 and no active cafeteria access",
  },
  "UGR/0005/15": { eligible: false, reason: "CGPA is below 3.0" },
};
const gotToken = new Set(); // students who already took a token
const issuedTokens = new Set(); // tokens that can still vote
const usedTokens = new Set();

let mockCandidates = [
  { id: 1, name: "Abel Tesfaye", position: "President", bio: "4th year, Computer Science.", manifesto: "Better dorm internet and study spaces." },
  { id: 2, name: "Hana Bekele", position: "President", bio: "4th year, Electrical Eng.", manifesto: "Open student budget and cafeteria feedback." },
  { id: 3, name: "Samuel Girma", position: "Vice President", bio: "3rd year, Civil Eng.", manifesto: "Faster clearance and clubs support." },
  { id: 4, name: "Marta Alemu", position: "Vice President", bio: "3rd year, Software Eng.", manifesto: "Mentorship program for first years." },
];
let mockAnnouncements = [
  { id: 1, title: "Election date", body: "Voting opens on 10 October.", date: "2026-09-28" },
  { id: 2, title: "Candidate debate", body: "Debate in the main hall at 3 PM.", date: "2026-09-29" },
];
let mockVotes = {}; // candidate_id -> count

// ---------- Student functions ----------
export async function login(ugr_id, password) {
  if (USE_MOCK) {
    await wait();
    if (!mockStudents[ugr_id] || password !== "demo123")
      throw new Error("Invalid ID or password");
    save("ugr_id", ugr_id);
    save("student_token", "mock-jwt-" + ugr_id);
    return { token: "mock-jwt-" + ugr_id };
  }
  const data = await request("/api/login", "POST", { ugr_id, password });
  save("student_token", data.token);
  return data;
}

export async function getEligibility() {
  if (USE_MOCK) {
    await wait();
    const id = getSaved("ugr_id");
    return { ...mockStudents[id], has_received_token: gotToken.has(id) };
  }
  return request("/api/eligibility", "GET", null, "student_token");
}

export async function requestToken() {
  if (USE_MOCK) {
    await wait();
    const id = getSaved("ugr_id");
    if (!mockStudents[id].eligible) throw new Error("You are not eligible to vote");
    if (gotToken.has(id)) throw new Error("You have already received a token");
    gotToken.add(id);
    const token = Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6);
    issuedTokens.add(token);
    return { token };
  }
  return request("/api/token", "POST", null, "student_token");
}

export async function getCandidates() {
  if (USE_MOCK) {
    await wait(200);
    return [...mockCandidates];
  }
  return request("/api/candidates");
}

export async function castVote(token, candidate_id) {
  if (USE_MOCK) {
    await wait();
    if (!token) throw new Error("Token is missing");
    if (usedTokens.has(token)) throw new Error("Token already used");
    if (!issuedTokens.has(token)) throw new Error("Invalid token");
    if (!mockCandidates.find((c) => c.id === candidate_id))
      throw new Error("Candidate does not exist");
    usedTokens.add(token);
    mockVotes[candidate_id] = (mockVotes[candidate_id] || 0) + 1;
    return { message: "Vote recorded" };
  }
  return request("/api/vote", "POST", { token, candidate_id });
}

export async function getAnnouncements() {
  if (USE_MOCK) {
    await wait(200);
    return [...mockAnnouncements];
  }
  return request("/api/announcements");
}

// ---------- Admin functions ----------
export async function adminLogin(username, password) {
  if (USE_MOCK) {
    await wait();
    if (username !== "admin" || password !== "admin123")
      throw new Error("Invalid admin login");
    save("admin_token", "mock-admin-jwt");
    return { token: "mock-admin-jwt" };
  }
  const data = await request("/api/admin/login", "POST", { username, password });
  save("admin_token", data.token);
  return data;
}

export async function addCandidate(c) {
  if (USE_MOCK) {
    await wait(200);
    const created = { ...c, id: Date.now() };
    mockCandidates.push(created);
    return created;
  }
  return request("/api/admin/candidates", "POST", c, "admin_token");
}

export async function updateCandidate(id, c) {
  if (USE_MOCK) {
    await wait(200);
    mockCandidates = mockCandidates.map((x) => (x.id === id ? { ...x, ...c } : x));
    return mockCandidates.find((x) => x.id === id);
  }
  return request(`/api/admin/candidates/${id}`, "PUT", c, "admin_token");
}

export async function deleteCandidate(id) {
  if (USE_MOCK) {
    await wait(200);
    mockCandidates = mockCandidates.filter((x) => x.id !== id);
    return { message: "Candidate deleted" };
  }
  return request(`/api/admin/candidates/${id}`, "DELETE", null, "admin_token");
}

export async function postAnnouncement(title, body) {
  if (USE_MOCK) {
    await wait(200);
    const a = { id: Date.now(), title, body, date: new Date().toISOString().slice(0, 10) };
    mockAnnouncements.unshift(a);
    return a;
  }
  return request("/api/admin/announcements", "POST", { title, body }, "admin_token");
}

export async function getResults() {
  if (USE_MOCK) {
    await wait(200);
    const eligible = Object.values(mockStudents).filter((s) => s.eligible).length + 75;
    const votes_cast = Object.values(mockVotes).reduce((a, b) => a + b, 0);
    return {
      turnout: { votes_cast, eligible_voters: eligible, percent: Math.round((votes_cast / eligible) * 1000) / 10 },
      results: mockCandidates.map((c) => ({
        candidate_id: c.id, name: c.name, position: c.position, votes: mockVotes[c.id] || 0,
      })),
    };
  }
  return request("/api/admin/results", "GET", null, "admin_token");
}

export async function rollover() {
  if (USE_MOCK) {
    await wait();
    gotToken.clear(); issuedTokens.clear(); usedTokens.clear(); mockVotes = {};
    return { message: "New academic year started. Registry, tokens and votes reset." };
  }
  return request("/api/admin/rollover", "POST", null, "admin_token");
}