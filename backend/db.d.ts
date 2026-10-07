export function getDb(): Promise<any>;
export function saveDb(db?: any): void;
export function executeQuery<T = any>(sql: string, params?: any[]): T[];
export function executeQueryOne<T = any>(sql: string, params?: any[]): T | null;
export function executeRun(sql: string, params?: any[]): { changes: number };
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