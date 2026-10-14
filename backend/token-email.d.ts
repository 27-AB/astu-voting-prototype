import type { Transporter } from 'nodemailer';

export function generateVotingToken(): string;
export function encryptPendingToken(secret: string, rawToken: string): {
  iv: string;
  ciphertext: string;
  authTag: string;
};
export function decryptPendingToken(
  secret: string,
  pendingToken: { iv: string; ciphertext: string; auth_tag: string }
): string;
export function getStudentEmailAddress(voterUgrId: string, domain?: string): string;
export function createSmtpTransport(env?: NodeJS.ProcessEnv): {
  from: string;
  transporter: Transporter;
};
