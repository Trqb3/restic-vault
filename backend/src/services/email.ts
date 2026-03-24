import nodemailer from 'nodemailer';
import { getDb } from '../db';
import { decrypt } from './crypto.js';
import type { EmailProviderRow } from '../types/db.js';
import type { Database } from 'better-sqlite3';

export type EmailProvider = 'smtp' | 'sendgrid' | 'mailgun' | 'resend' | 'ses';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
  fromName: string;
}

export interface SendgridConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
}

export interface MailgunConfig {
  apiKey: string;
  domain: string;
  region: 'us' | 'eu';
  fromAddress: string;
  fromName: string;
}

export interface ResendConfig {
  apiKey: string;
  fromAddress: string;
  fromName: string;
}

export interface SesConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  fromAddress: string;
  fromName: string;
}

export interface SendEmailOptions {
  to: string[];
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(
  providerId: number,
  options: SendEmailOptions
): Promise<void> {
  const db: Database = getDb();
  const row = db.prepare('SELECT * FROM email_providers WHERE id = ? AND enabled = 1')
    .get(providerId) as EmailProviderRow | undefined;
  if (!row) throw new Error('Email provider not found or disabled');

  const config = JSON.parse(decrypt(row.config)) as unknown;

  switch (row.provider as EmailProvider) {
    case 'smtp':
      await sendViaSMTP(config as SmtpConfig, options);
      break;
    case 'sendgrid':
      await sendViaSendgrid(config as SendgridConfig, options);
      break;
    case 'mailgun':
      await sendViaMailgun(config as MailgunConfig, options);
      break;
    case 'resend':
      await sendViaResend(config as ResendConfig, options);
      break;
    case 'ses':
      await sendViaSES(config as SesConfig, options);
      break;
    default:
      throw new Error(`Unknown provider: ${row.provider}`);
  }
}

async function sendViaSMTP(config: SmtpConfig, options: SendEmailOptions): Promise<void> {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
  });
  await transporter.verify();
  await transporter.sendMail({
    from: `"${config.fromName}" <${config.fromAddress}>`,
    to: options.to.join(', '),
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
}

async function sendViaSendgrid(config: SendgridConfig, options: SendEmailOptions): Promise<void> {
  const res: Response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: options.to.map((email: string) => ({ email })) }],
      from: { email: config.fromAddress, name: config.fromName },
      subject: options.subject,
      content: [
        { type: 'text/plain', value: options.text ?? options.html.replace(/<[^>]+>/g, '') },
        { type: 'text/html', value: options.html },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Sendgrid error: ${res.status} ${await res.text()}`);
}

async function sendViaMailgun(config: MailgunConfig, options: SendEmailOptions): Promise<void> {
  const baseUrl = config.region === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net';
  const form = new URLSearchParams({
    from: `${config.fromName} <${config.fromAddress}>`,
    to: options.to.join(', '),
    subject: options.subject,
    html: options.html,
    text: options.text ?? '',
  });
  const res: Response = await fetch(`${baseUrl}/v3/${config.domain}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${Buffer.from(`api:${config.apiKey}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`Mailgun error: ${res.status} ${await res.text()}`);
}

async function sendViaResend(config: ResendConfig, options: SendEmailOptions): Promise<void> {
  const res: Response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${config.fromName} <${config.fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    }),
  });
  if (!res.ok) throw new Error(`Resend error: ${res.status} ${await res.text()}`);
}

async function sendViaSES(config: SesConfig, options: SendEmailOptions): Promise<void> {
  const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
  const client = new SESClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  await client.send(new SendEmailCommand({
    Source: `${config.fromName} <${config.fromAddress}>`,
    Destination: { ToAddresses: options.to },
    Message: {
      Subject: { Data: options.subject },
      Body: {
        Html: { Data: options.html },
        Text: { Data: options.text ?? '' },
      },
    },
  }));
}

export function getDefaultProviderId(): number | null {
  const db: Database = getDb();
  const row = db.prepare('SELECT id FROM email_providers WHERE is_default = 1 AND enabled = 1')
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

export async function sendAndLog(
  ruleId: number | null,
  providerId: number,
  options: SendEmailOptions
): Promise<void> {
  const db: Database = getDb();
  try {
    await sendEmail(providerId, options);
    db.prepare(`
      INSERT INTO notification_log (rule_id, provider_id, recipients, subject, status)
      VALUES (?, ?, ?, ?, 'sent')
    `).run(ruleId, providerId, JSON.stringify(options.to), options.subject);
  } catch (err) {
    const msg: string = err instanceof Error ? err.message : String(err);
    db.prepare(`
      INSERT INTO notification_log (rule_id, provider_id, recipients, subject, status, error_message)
      VALUES (?, ?, ?, ?, 'failed', ?)
    `).run(ruleId, providerId, JSON.stringify(options.to), options.subject, msg);
    throw err;
  }
}
