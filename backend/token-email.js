import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

function getEncryptionKey(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('VOTING_TOKEN_SECRET must be at least 32 bytes of random secret material.');
  }
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export function generateVotingToken() {
  return crypto.randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');
}

export function encryptPendingToken(secret, rawToken) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex')
  };
}

export function decryptPendingToken(secret, pendingToken) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(secret),
    Buffer.from(pendingToken.iv, 'hex')
  );
  decipher.setAuthTag(Buffer.from(pendingToken.auth_tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(pendingToken.ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

export function getStudentEmailAddress(voterUgrId, domain = process.env.STUDENT_EMAIL_DOMAIN) {
  const normalizedDomain = typeof domain === 'string' ? domain.trim().toLowerCase() : '';
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalizedDomain) ||
      normalizedDomain.split('.').some((label) => !label || label.startsWith('-') || label.endsWith('-'))) {
    throw new Error('STUDENT_EMAIL_DOMAIN must be a valid email domain.');
  }
  const localPart = voterUgrId.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!localPart) throw new Error('Could not derive an email address from the voter ID.');
  return `${localPart}@${normalizedDomain}`;
}

export function createSmtpTransport(env = process.env) {
  const { SMTP_HOST: host, SMTP_USER: user, SMTP_PASS: pass } = env;
  if (!host || !user || !pass) {
    throw new Error('SMTP_HOST, SMTP_USER, and SMTP_PASS must be configured to send voting-token emails.');
  }
  const port = Number(env.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535.');
  }
  const from = env.SMTP_FROM || user;
  return {
    from,
    transporter: nodemailer.createTransport({
      host,
      port,
      secure: env.SMTP_SECURE === 'true',
      requireTLS: env.SMTP_SECURE !== 'true',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      auth: { user, pass }
    })
  };
}
