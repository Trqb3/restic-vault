export interface BackupFailedData {
  repoName: string;
  repoPath: string;
  errorMessage: string;
  timestamp: Date;
}

export interface AuditDigestData {
  period: 'weekly' | 'monthly';
  periodLabel: string;
  totalBackups: number;
  failedBackups: number;
  totalSnapshots: number;
  totalSize: string;
  repos: Array<{
    name: string;
    snapshotCount: number;
    lastBackup: Date | null;
    status: string;
  }>;
  topFailures: Array<{ repo: string; error: string; time: Date }>;
  auditEvents: number;
  failedLogins: number;
}

const BASE_STYLE = `
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #0a0a0f; color: #e2e8f0; margin: 0; padding: 0;
`;

const CARD_STYLE = `
  background: #111827; border: 1px solid #1f2937;
  border-radius: 12px; padding: 20px; margin-bottom: 16px;
`;

function baseLayout(content: string, title: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${title}</title></head>
<body style="${BASE_STYLE}">
  <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">
    <!-- Header -->
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 32px;">
      <div style="background: rgba(59,130,246,0.2); border: 1px solid rgba(59,130,246,0.3);
                  border-radius: 10px; width: 36px; height: 36px; display: flex;
                  align-items: center; justify-content: center; font-size: 18px;">🔒</div>
      <span style="font-size: 18px; font-weight: 600; color: #fff;">ResticVault</span>
    </div>
    ${content}
    <!-- Footer -->
    <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #1f2937;
                font-size: 12px; color: #4b5563; text-align: center;">
      Gesendet von ResticVault · Einstellungen unter Admin → Benachrichtigungen
    </div>
  </div>
</body>
</html>`;
}

export function backupFailedTemplate(data: BackupFailedData): { subject: string; html: string; text: string } {
  const subject = `❌ Backup fehlgeschlagen: ${data.repoName}`;
  const html = baseLayout(`
    <div style="${CARD_STYLE} border-color: rgba(239,68,68,0.3);">
      <div style="color: #f87171; font-size: 14px; font-weight: 600; margin-bottom: 8px;">
        Backup fehlgeschlagen
      </div>
      <h2 style="color: #fff; margin: 0 0 16px;">${data.repoName}</h2>
      <table style="width: 100%; font-size: 13px;">
        <tr><td style="color: #6b7280; padding: 4px 0;">Repository</td>
            <td style="color: #d1d5db; font-family: monospace;">${data.repoPath}</td></tr>
        <tr><td style="color: #6b7280; padding: 4px 0;">Zeitpunkt</td>
            <td style="color: #d1d5db;">${data.timestamp.toLocaleString('de-DE')}</td></tr>
      </table>
      <div style="margin-top: 16px; background: rgba(239,68,68,0.1); border-radius: 8px;
                  padding: 12px; font-family: monospace; font-size: 12px; color: #fca5a5;">
        ${data.errorMessage}
      </div>
    </div>
  `, subject);
  const text = `Backup fehlgeschlagen: ${data.repoName}\nPfad: ${data.repoPath}\nZeit: ${data.timestamp.toLocaleString('de-DE')}\nFehler: ${data.errorMessage}`;
  return { subject, html, text };
}

export function agentDisconnectedTemplate(data: { sourceName: string; hostname: string; lastSeen: Date }): { subject: string; html: string; text: string } {
  const subject = `⚠️ Agent getrennt: ${data.sourceName}`;
  const html = baseLayout(`
    <div style="${CARD_STYLE} border-color: rgba(234,179,8,0.3);">
      <div style="color: #fbbf24; font-size: 14px; font-weight: 600; margin-bottom: 8px;">Agent nicht erreichbar</div>
      <h2 style="color: #fff; margin: 0 0 16px;">${data.sourceName}</h2>
      <table style="width: 100%; font-size: 13px;">
        <tr><td style="color: #6b7280; padding: 4px 0;">Hostname</td>
            <td style="color: #d1d5db; font-family: monospace;">${data.hostname}</td></tr>
        <tr><td style="color: #6b7280; padding: 4px 0;">Zuletzt gesehen</td>
            <td style="color: #d1d5db;">${data.lastSeen.toLocaleString('de-DE')}</td></tr>
      </table>
    </div>
  `, subject);
  const text = `Agent getrennt: ${data.sourceName} (${data.hostname})\nZuletzt gesehen: ${data.lastSeen.toLocaleString('de-DE')}`;
  return { subject, html, text };
}

export function auditDigestTemplate(data: AuditDigestData): { subject: string; html: string; text: string } {
  const subject = `📊 ResticVault ${data.period === 'weekly' ? 'Wochen' : 'Monats'}bericht: ${data.periodLabel}`;

  const repoRows = data.repos.map(r => `
    <tr>
      <td style="padding: 8px 12px; color: #d1d5db;">${r.name}</td>
      <td style="padding: 8px 12px; color: #9ca3af; text-align: center;">${r.snapshotCount}</td>
      <td style="padding: 8px 12px; color: #9ca3af;">${r.lastBackup ? r.lastBackup.toLocaleDateString('de-DE') : '—'}</td>
      <td style="padding: 8px 12px; text-align: center;">
        <span style="font-size: 11px; padding: 2px 8px; border-radius: 20px;
          background: ${r.status === 'ok' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)'};
          color: ${r.status === 'ok' ? '#34d399' : '#f87171'};">
          ${r.status}
        </span>
      </td>
    </tr>
  `).join('');

  const statCards = [
    { label: 'Backups gesamt',  value: data.totalBackups,   color: '#60a5fa' },
    { label: 'Fehlgeschlagen',  value: data.failedBackups,  color: data.failedBackups > 0 ? '#f87171' : '#34d399' },
    { label: 'Snapshots',       value: data.totalSnapshots, color: '#a78bfa' },
  ].map(s => `
    <div style="${CARD_STYLE} text-align: center; margin-bottom: 0;">
      <div style="font-size: 24px; font-weight: 700; color: ${s.color};">${s.value}</div>
      <div style="font-size: 11px; color: #6b7280; margin-top: 4px;">${s.label}</div>
    </div>
  `).join('');

  const html = baseLayout(`
    <h2 style="color: #fff; margin: 0 0 8px;">${data.period === 'weekly' ? 'Wochenbericht' : 'Monatsbericht'}</h2>
    <p style="color: #6b7280; margin: 0 0 24px; font-size: 14px;">${data.periodLabel}</p>
    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 24px;">
      ${statCards}
    </div>
    <div style="${CARD_STYLE}">
      <div style="font-size: 11px; color: #6b7280; font-weight: 600;
                  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;">
        Repositories
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 1px solid #1f2937;">
            <th style="text-align: left; padding: 6px 12px; color: #4b5563; font-weight: 500;">Name</th>
            <th style="text-align: center; padding: 6px 12px; color: #4b5563; font-weight: 500;">Snapshots</th>
            <th style="text-align: left; padding: 6px 12px; color: #4b5563; font-weight: 500;">Letztes Backup</th>
            <th style="text-align: center; padding: 6px 12px; color: #4b5563; font-weight: 500;">Status</th>
          </tr>
        </thead>
        <tbody>${repoRows}</tbody>
      </table>
    </div>
    ${data.failedLogins > 0 ? `
    <div style="${CARD_STYLE} border-color: rgba(234,179,8,0.3);">
      <div style="font-size: 11px; color: #fbbf24; font-weight: 600;
                  text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;">
        Sicherheitshinweise
      </div>
      <p style="color: #d1d5db; font-size: 13px; margin: 0;">
        ${data.failedLogins} fehlgeschlagene Anmeldeversuche im Berichtszeitraum.
      </p>
    </div>` : ''}
  `, subject);

  const text = `${subject}\n\nBackups: ${data.totalBackups} gesamt, ${data.failedBackups} fehlgeschlagen\nSnapshots: ${data.totalSnapshots}\nFehlgeschlagene Logins: ${data.failedLogins}`;
  return { subject, html, text };
}

export function loginFailureAlertTemplate(data: { username: string; ip: string; attempts: number; timestamp: Date }): { subject: string; html: string; text: string } {
  const subject = `🔐 Verdächtige Anmeldeversuche erkannt`;
  const html = baseLayout(`
    <div style="${CARD_STYLE} border-color: rgba(234,179,8,0.3);">
      <div style="color: #fbbf24; font-size: 14px; font-weight: 600; margin-bottom: 16px;">
        Mehrere fehlgeschlagene Anmeldeversuche
      </div>
      <table style="width: 100%; font-size: 13px;">
        <tr><td style="color: #6b7280; padding: 4px 0;">Benutzername</td>
            <td style="color: #d1d5db; font-family: monospace;">${data.username}</td></tr>
        <tr><td style="color: #6b7280; padding: 4px 0;">IP-Adresse</td>
            <td style="color: #d1d5db; font-family: monospace;">${data.ip}</td></tr>
        <tr><td style="color: #6b7280; padding: 4px 0;">Versuche</td>
            <td style="color: #f87171; font-weight: 600;">${data.attempts}</td></tr>
        <tr><td style="color: #6b7280; padding: 4px 0;">Zeitpunkt</td>
            <td style="color: #d1d5db;">${data.timestamp.toLocaleString('de-DE')}</td></tr>
      </table>
    </div>
  `, subject);
  const text = `Verdächtige Anmeldeversuche: ${data.attempts}x für "${data.username}" von ${data.ip}`;
  return { subject, html, text };
}
