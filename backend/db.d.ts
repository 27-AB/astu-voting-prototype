export function getDb(): Promise<any>;
export function saveDb(db?: any): void;
export function executeQuery<T = any>(sql: string, params?: any[]): T[];
export function executeQueryOne<T = any>(sql: string, params?: any[]): T | null;
export function executeRun(sql: string, params?: any[]): { changes: number };
export function getConfiguredParliamentIds(): string[];
export function chooseElectionParticipation(
  ugrId: string,
  choice: 'CANDIDATE' | 'VOTER' | 'NONE',
  profile?: { name: string; position: string; bio: string; manifesto: string } | null
): {
  status: 'saved' | 'candidate-has-votes';
  choice?: 'CANDIDATE' | 'VOTER' | 'NONE';
  candidate_id?: number | null;
  changed?: boolean;
};
export function hasTokenEmailDeliveryRecord(electionStartTime: string, voterId: string): boolean;
export function createPendingTokenEmailDelivery(
  electionStartTime: string,
  voterId: string,
  tokenHash: string,
  encryptedToken: { iv: string; ciphertext: string; authTag: string }
): boolean;
export function getPendingTokenEmailDeliveries(electionStartTime: string): {
  voter_ugr_id: string;
  attempts: number;
  token_hash: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
}[];
export function isTokenEmailDelivered(electionStartTime: string, voterId: string): boolean;
export function recordTokenEmailAttempt(electionStartTime: string, voterId: string, errorMessage?: string | null): void;
export function markTokenEmailDelivered(electionStartTime: string, voterId: string): void;
export function discardPendingTokenEmailDeliveries(electionStartTime: string): number;
export function getCandidateRankings(): {
  candidate_id: number;
  name: string;
  position: string;
  manifesto: string;
  judge_score: number | null;
  judge_count: number;
  parliament_votes: number;
  judge_points: number;
  parliament_share: number;
  final_score: number;
  votes: number;
  rank: number;
}[];
export function castAnonymousVote(
  tokenHash: string,
  candidateIds: number[]
):
  | { status: 'invalid-token' }
  | { status: 'used-token' }
  | { status: 'invalid-candidate' }
  | { status: 'duplicate-position' }
  | { status: 'incomplete-ballot' }
  | { status: 'recorded' };
export function performRollover(): {
  resetVotesCount: number;
  resetTokensCount: number;
  resetRegistryCount: number;
};
export const DEMO_ACCOUNTS: {
  ugr_id: string;
  name: string;
  cgpa: number;
  department: string;
  cafeteria_active: boolean;
  expected_status: string;
}[];