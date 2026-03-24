<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, admin as adminApi, repos as reposApi, settings, notifications as notificationsApi, exclusionProfiles as exclusionProfilesApi, type AdminUser, type Repo, type SshConnection, type AuditLog, type AuditStats, type EmailProvider, type NotificationRule, type NotificationLogEntry, type ExclusionProfile } from '$lib/api';
  import { toast } from '$lib/toast';
  import Modal from '$lib/components/Modal.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import { confirm } from '$lib/confirm';
  import {userColor} from "$lib/utils";

  let role = $state('');
  let users = $state<AdminUser[]>([]);
  let repoList = $state<Repo[]>([]);
  let loading = $state(true);
  let activeTab = $state<'users' | 'permissions' | 'ssh' | 'settings' | 'logs' | 'notifications' | 'exclusions'>('users');

  // Users tab
  let showAddModal = $state(false);
  let newUsername = $state('');
  let newPassword = $state('');
  let newRole = $state('viewer');
  let addingUser = $state(false);

  let showResetModal = $state(false);
  let resetTargetId = $state<number | null>(null);
  let resetTargetName = $state('');
  let resetPassword = $state('');
  let resettingPassword = $state(false);

  let deletingId = $state<number | null>(null);

  // SSH Connections tab
  let sshConnections = $state<SshConnection[]>([]);
  let sshTestResults = $state<Map<number, 'testing' | 'ok' | 'error' | string>>(new Map());
  let showAddSshModal = $state(false);
  let sshName = $state('');
  let sshHost = $state('');
  let sshPort = $state(22);
  let sshUsername = $state('');
  let sshPrivateKey = $state('');
  let addingSsh = $state(false);
  let deletingSshId = $state<number | null>(null);

  // Settings tab
  let indexInterval = $state(15);
  let currentInterval = $state(15);
  let savingInterval = $state(false);
  let baseDir = $state('');
  let savingBaseDir = $state(false);

  // Logs tab
  let auditStats = $state<AuditStats | null>(null);
  let auditLogs = $state<AuditLog[]>([]);
  let auditTotal = $state(0);
  let auditOffset = $state(0);
  const AUDIT_PAGE_SIZE = 50;
  let auditFilterType = $state('');
  let auditFilterUser = $state('');
  let auditFilterSuccess = $state('');
  let auditLoading = $state(false);

  // Notifications tab
  let notifProviders = $state<EmailProvider[]>([]);
  let notifRules = $state<NotificationRule[]>([]);
  let notifLog = $state<NotificationLogEntry[]>([]);
  let notifInnerTab = $state<'providers' | 'rules' | 'log'>('providers');
  let notifLoading = $state(false);

  // Add-provider modal
  let showAddProviderModal = $state(false);
  let newProviderName = $state('');
  let newProviderType = $state<EmailProvider['provider']>('smtp');
  let newProviderIsDefault = $state(false);
  // SMTP fields
  let npSmtpHost = $state('');
  let npSmtpPort = $state(587);
  let npSmtpSecure = $state(false);
  let npSmtpUser = $state('');
  let npSmtpPass = $state('');
  let npFromAddress = $state('');
  let npFromName = $state('ResticVault');
  // API-key based fields (sendgrid / resend)
  let npApiKey = $state('');
  // Mailgun extra fields
  let npMailgunDomain = $state('');
  let npMailgunRegion = $state<'us' | 'eu'>('us');
  // SES fields
  let npSesAccessKey = $state('');
  let npSesSecretKey = $state('');
  let npSesRegion = $state('eu-central-1');
  let addingProvider = $state(false);
  // Test email
  let testProviderEmail = $state('');
  let testingProviderId = $state<number | null>(null);
  let testProviderResult = $state<Record<number, 'ok' | 'error' | string>>({});

  // Add-rule modal
  let showAddRuleModal = $state(false);
  let newRuleName = $state('');
  let newRuleProviderId = $state<number | ''>('');
  let newRuleTrigger = $state<'event' | 'schedule'>('event');
  let newRuleEvents = $state<string[]>([]);
  let newRuleScheduleType = $state<'weekly' | 'monthly'>('weekly');
  let newRuleScheduleDay = $state(0);
  let newRuleScheduleHour = $state(8);
  let newRuleRecipientsRaw = $state('');
  let addingRule = $state(false);

  const EVENT_OPTIONS: { value: string; label: string }[] = [
    { value: 'backup_failed',       label: 'Backup fehlgeschlagen' },
    { value: 'backup_success',      label: 'Backup erfolgreich' },
    { value: 'agent_disconnected',  label: 'Agent getrennt' },
    { value: 'agent_connected',     label: 'Agent verbunden' },
    { value: 'login_failure_burst', label: 'Verdächtige Anmeldeversuche (3+ in 15 Min)' },
    { value: 'repo_added',          label: 'Repository hinzugefügt' },
    { value: 'repo_deleted',        label: 'Repository gelöscht' },
    { value: 'snapshot_deleted',    label: 'Snapshot gelöscht' },
    { value: 'user_created',        label: 'Benutzer erstellt' },
    { value: 'user_deleted',        label: 'Benutzer gelöscht' },
  ];

  const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const PROVIDER_LABELS: Record<EmailProvider['provider'], string> = {
    smtp: 'SMTP', sendgrid: 'SendGrid', mailgun: 'Mailgun', resend: 'Resend', ses: 'AWS SES',
  };

  const tabs = [
    ['users', 'Users'],
    ['permissions', 'Permissions'],
    ['ssh', 'SSH Connections'],
    ['settings', 'Einstellungen'],
    ['logs', 'Audit Logs'],
    ['notifications', 'Benachrichtigungen'],
    ['exclusions', 'Exclusion Profiles'],
  ] as const;

  const notifInnerTabs = [
    ['providers', 'Anbieter'],
    ['rules', 'Regeln'],
    ['log', 'Protokoll'],
  ] as const;

  const triggerOptions = [
    ['event', 'Event-basiert'],
    ['schedule', 'Geplant'],
  ] as const;


  async function loadNotifications() {
    notifLoading = true;
    try {
      const [p, r, l] = await Promise.all([
        notificationsApi.getProviders(),
        notificationsApi.getRules(),
        notificationsApi.getLog(),
      ]);
      notifProviders = p;
      notifRules = r;
      notifLog = l;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Laden der Benachrichtigungen');
    } finally {
      notifLoading = false;
    }
  }

  function buildProviderConfig() {
    switch (newProviderType) {
      case 'smtp':     return { host: npSmtpHost, port: npSmtpPort, secure: npSmtpSecure, username: npSmtpUser, password: npSmtpPass, fromAddress: npFromAddress, fromName: npFromName };
      case 'sendgrid':
      case 'resend':   return { apiKey: npApiKey, fromAddress: npFromAddress, fromName: npFromName };
      case 'mailgun':  return { apiKey: npApiKey, domain: npMailgunDomain, region: npMailgunRegion, fromAddress: npFromAddress, fromName: npFromName };
      case 'ses':      return { accessKeyId: npSesAccessKey, secretAccessKey: npSesSecretKey, region: npSesRegion, fromAddress: npFromAddress, fromName: npFromName };
    }
  }

  async function addProvider() {
    if (!newProviderName || !npFromAddress) return;
    addingProvider = true;
    try {
      await notificationsApi.createProvider({
        name: newProviderName, provider: newProviderType,
        isDefault: newProviderIsDefault, config: buildProviderConfig(),
      });
      notifProviders = await notificationsApi.getProviders();
      showAddProviderModal = false;
      newProviderName = ''; npFromAddress = ''; npFromName = 'ResticVault';
      npApiKey = ''; npSmtpHost = ''; npSmtpUser = ''; npSmtpPass = '';
      toast.success('Anbieter gespeichert');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      addingProvider = false;
    }
  }

  async function deleteProvider(id: number) {
    const ok = await confirm('Diesen E-Mail-Anbieter löschen?');
    if (!ok) return;
    try {
      await notificationsApi.deleteProvider(id);
      notifProviders = notifProviders.filter(p => p.id !== id);
      toast.success('Anbieter gelöscht');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler');
    }
  }

  async function testProvider(id: number) {
    if (!testProviderEmail) { toast.error('Bitte Test-E-Mail-Adresse eingeben'); return; }
    testingProviderId = id;
    try {
      await notificationsApi.testProvider(id, testProviderEmail);
      testProviderResult = { ...testProviderResult, [id]: 'ok' };
      toast.success('Test-E-Mail gesendet');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Fehler';
      testProviderResult = { ...testProviderResult, [id]: msg };
      toast.error(`Test fehlgeschlagen: ${msg}`);
    } finally {
      testingProviderId = null;
    }
  }

  async function addRule() {
    const recipients = newRuleRecipientsRaw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
    if (!newRuleName || recipients.length === 0) return;
    addingRule = true;
    try {
      await notificationsApi.createRule({
        name: newRuleName,
        providerId: newRuleProviderId || null,
        triggerType: newRuleTrigger,
        events: newRuleTrigger === 'event' ? newRuleEvents : undefined,
        scheduleType: newRuleTrigger === 'schedule' ? newRuleScheduleType : undefined,
        scheduleDay: newRuleTrigger === 'schedule' ? newRuleScheduleDay : undefined,
        scheduleHour: newRuleTrigger === 'schedule' ? newRuleScheduleHour : undefined,
        recipients,
      });
      notifRules = await notificationsApi.getRules();
      showAddRuleModal = false;
      newRuleName = ''; newRuleRecipientsRaw = ''; newRuleEvents = [];
      toast.success('Regel gespeichert');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      addingRule = false;
    }
  }

  async function toggleRule(rule: NotificationRule) {
    try {
      await notificationsApi.updateRule(rule.id, { enabled: !rule.enabled });
      notifRules = notifRules.map(r => r.id === rule.id ? { ...r, enabled: (rule.enabled ? 0 : 1) as 0 | 1 } : r);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler');
    }
  }

  async function deleteRule(id: number) {
    const ok = await confirm('Diese Regel löschen?');
    if (!ok) return;
    try {
      await notificationsApi.deleteRule(id);
      notifRules = notifRules.filter(r => r.id !== id);
      toast.success('Regel gelöscht');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler');
    }
  }

  // Permissions tab
  let selectedUserId = $state<number | null>(null);
  let userPermRepoIds = $state<Set<number>>(new Set());
  let loadingPerms = $state(false);
  let savingPerms = $state(false);

  async function refreshActiveTab() {
    // Silently refresh only the data relevant to the active tab
    try {
      if (activeTab === 'users' || activeTab === 'permissions') {
        users = await adminApi.listUsers();
      } else if (activeTab === 'ssh') {
        sshConnections = await adminApi.listSshConnections();
      } else if (activeTab === 'logs') {
        const [as_, lg] = await Promise.all([
          adminApi.getAuditStats(),
          adminApi.getAuditLogs({ limit: AUDIT_PAGE_SIZE, offset: auditOffset, eventType: auditFilterType || undefined, username: auditFilterUser || undefined, success: auditFilterSuccess !== '' ? (auditFilterSuccess as '0' | '1') : undefined }),
        ]);
        auditStats = as_;
        auditLogs = lg.rows;
        auditTotal = lg.total;
      } else if (activeTab === 'notifications') {
        const [p, r, l] = await Promise.all([
          notificationsApi.getProviders(), notificationsApi.getRules(), notificationsApi.getLog(),
        ]);
        notifProviders = p; notifRules = r; notifLog = l;
      }
    } catch { /* best-effort silent refresh */ }
  }

  onMount(() => {
    (async () => {
      try {
        const me = await auth.me();
        role = me.role;
        if (me.role !== 'admin') { loading = false; return; }
        const [u, r, ssh, s, as_] = await Promise.all([
          adminApi.listUsers(), reposApi.list(), adminApi.listSshConnections(), settings.get(), adminApi.getAuditStats(),
        ]);
        users = u;
        repoList = r;
        sshConnections = ssh;
        baseDir = s.baseDir;
        indexInterval = s.indexIntervalMinutes;
        currentInterval = s.indexIntervalMinutes;
        auditStats = as_;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to load admin data');
      } finally {
        loading = false;
      }
    })();

    const timer = setInterval(refreshActiveTab, 60_000);
    return () => clearInterval(timer);
  });

  async function addUser() {
    if (!newUsername || !newPassword) return;
    addingUser = true;
    try {
      const created = await adminApi.createUser({ username: newUsername, password: newPassword, role: newRole });
      users = [...users, { id: Number(created.id), username: created.username, role: created.role as 'admin' | 'viewer', totp_enabled: 0, created_at: Date.now() / 1000, repo_count: 0 }];
      newUsername = '';
      newPassword = '';
      newRole = 'viewer';
      showAddModal = false;
      toast.success('User created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      addingUser = false;
    }
  }

  async function deleteUser(id: number) {
    const ok = await confirm('Delete this user? This cannot be undone.');
    if (!ok) return;
    deletingId = id;
    try {
      await adminApi.deleteUser(id);
      users = users.filter(u => u.id !== id);
      toast.success('User deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      deletingId = null;
    }
  }

  function openResetModal(user: AdminUser) {
    resetTargetId = user.id;
    resetTargetName = user.username;
    resetPassword = '';
    showResetModal = true;
  }

  async function resetPwd() {
    if (!resetTargetId || !resetPassword) return;
    resettingPassword = true;
    try {
      await adminApi.resetPassword(resetTargetId, resetPassword);
      toast.success(`Password reset for ${resetTargetName}`);
      showResetModal = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      resettingPassword = false;
    }
  }

  async function selectUser(userId: number) {
    selectedUserId = userId;
    loadingPerms = true;
    try {
      const ids = await adminApi.getPermissions(userId);
      userPermRepoIds = new Set(ids);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load permissions');
    } finally {
      loadingPerms = false;
    }
  }

  function togglePermRepo(repoId: number) {
    const next = new Set(userPermRepoIds);
    if (next.has(repoId)) next.delete(repoId);
    else next.add(repoId);
    userPermRepoIds = next;
  }

  async function savePerms() {
    if (selectedUserId === null) return;
    savingPerms = true;
    try {
      await adminApi.setPermissions(selectedUserId, [...userPermRepoIds]);
      // Update repo_count in users list
      users = users.map(u => u.id === selectedUserId ? { ...u, repo_count: userPermRepoIds.size } : u);
      toast.success('Permissions saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save permissions');
    } finally {
      savingPerms = false;
    }
  }

  async function reset2fa(id: number, name: string) {
    const ok = await confirm(`2FA für "${name}" zurücksetzen? Der Benutzer kann sich danach ohne 2FA einloggen.`);
    if (!ok) return;
    try {
      await adminApi.reset2fa(id);
      users = users.map(u => u.id === id ? { ...u, totp_enabled: 0 } : u);
      toast.success(`2FA für ${name} zurückgesetzt`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Zurücksetzen');
    }
  }

  async function addSshConnection() {
    if (!sshName || !sshHost || !sshUsername || !sshPrivateKey) return;
    addingSsh = true;
    try {
      await adminApi.createSshConnection({
        name: sshName, host: sshHost, port: sshPort,
        username: sshUsername, privateKey: sshPrivateKey,
      });
      sshConnections = await adminApi.listSshConnections();
      sshName = sshHost = sshUsername = sshPrivateKey = '';
      sshPort = 22;
      showAddSshModal = false;
      toast.success('SSH connection saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save SSH connection');
    } finally {
      addingSsh = false;
    }
  }

  async function deleteSshConnection(id: number) {
    const ok = await confirm('Delete this SSH connection? Repositories using it will lose their SSH config.');
    if (!ok) return;
    deletingSshId = id;
    try {
      await adminApi.deleteSshConnection(id);
      sshConnections = sshConnections.filter(c => c.id !== id);
      toast.success('SSH connection deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      deletingSshId = null;
    }
  }

  async function testSshConnection(id: number) {
    sshTestResults = new Map(sshTestResults).set(id, 'testing');
    try {
      const result = await adminApi.testSshConnection(id);
      sshTestResults = new Map(sshTestResults).set(id, result.ok ? 'ok' : (result.error ?? 'error'));
    } catch (err) {
      sshTestResults = new Map(sshTestResults).set(id, err instanceof Error ? err.message : 'error');
    }
  }

  async function saveIndexInterval() {
    savingInterval = true;
    try {
      await settings.set(baseDir, indexInterval);
      currentInterval = indexInterval;
      toast.success(`Indexierungsintervall auf ${indexInterval} Minuten gesetzt`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      savingInterval = false;
    }
  }

  async function saveBaseDir() {
    savingBaseDir = true;
    try {
      await settings.set(baseDir, currentInterval);
      toast.success('Base Directory gespeichert');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Speichern');
    } finally {
      savingBaseDir = false;
    }
  }

  async function loadAuditLogs(offset = 0) {
    auditLoading = true;
    try {
      const params: Parameters<typeof adminApi.getAuditLogs>[0] = {
        limit: AUDIT_PAGE_SIZE, offset,
      };
      if (auditFilterType) params.eventType = auditFilterType;
      if (auditFilterUser) params.username = auditFilterUser;
      if (auditFilterSuccess !== '') params.success = auditFilterSuccess as '0' | '1';
      const result = await adminApi.getAuditLogs(params);
      auditLogs = result.rows;
      auditTotal = result.total;
      auditOffset = offset;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load audit logs');
    } finally {
      auditLoading = false;
    }
  }

  function resetAuditFilters() {
    auditFilterType = '';
    auditFilterUser = '';
    auditFilterSuccess = '';
    loadAuditLogs(0);
  }

  function formatDate(ts: number) {
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  function formatDateTime(ts: number) {
    return new Date(ts * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  function eventBadgeClass(eventType: string): string {
    if (eventType.startsWith('login_failure') || eventType === 'rate_limit_hit') {
      return 'bg-red-500/10 text-red-400 ring-1 ring-red-500/20';
    }
    if (eventType.startsWith('login')) {
      return 'bg-green-500/10 text-green-400 ring-1 ring-green-500/20';
    }
    if (eventType === 'logout') {
      return 'bg-gray-500/10 text-gray-400 ring-1 ring-gray-500/20';
    }
    if (eventType.includes('deleted') || eventType.includes('failure')) {
      return 'bg-orange-500/10 text-orange-400 ring-1 ring-orange-500/20';
    }
    return 'bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20';
  }

  // ── Exclusion profiles ────────────────────────────────────────────────────
  let exclusionProfilesList = $state<ExclusionProfile[]>([]);
  let exclusionsLoading     = $state(false);
  let showAddProfileModal   = $state(false);
  let epName        = $state('');
  let epDescription = $state('');
  let epPatterns    = $state('');
  let addingProfile = $state(false);
  let editingProfile = $state<ExclusionProfile | null>(null);

  async function loadExclusionProfiles() {
    exclusionsLoading = true;
    try {
      exclusionProfilesList = await exclusionProfilesApi.list();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load profiles');
    } finally {
      exclusionsLoading = false;
    }
  }

  async function addExclusionProfile() {
    if (!epName.trim()) return;
    addingProfile = true;
    try {
      await exclusionProfilesApi.create({
        name: epName.trim(),
        description: epDescription.trim() || undefined,
        patterns: epPatterns.split('\n').map(s => s.trim()).filter(Boolean),
      });
      exclusionProfilesList = await exclusionProfilesApi.list();
      epName = ''; epDescription = ''; epPatterns = '';
      showAddProfileModal = false;
      toast.success('Profile saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      addingProfile = false;
    }
  }

  async function saveEditedProfile() {
    if (!editingProfile) return;
    addingProfile = true;
    try {
      await exclusionProfilesApi.update(editingProfile.id, {
        name: epName.trim(),
        description: epDescription.trim() || undefined,
        patterns: epPatterns.split('\n').map(s => s.trim()).filter(Boolean),
      });
      exclusionProfilesList = await exclusionProfilesApi.list();
      editingProfile = null;
      showAddProfileModal = false;
      toast.success('Profile updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile');
    } finally {
      addingProfile = false;
    }
  }

  async function deleteExclusionProfile(id: number) {
    const ok = await confirm('Delete this exclusion profile? Sources using it will retain a reference but patterns will no longer apply.');
    if (!ok) return;
    try {
      await exclusionProfilesApi.delete(id);
      exclusionProfilesList = exclusionProfilesList.filter(p => p.id !== id);
      toast.success('Profile deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete profile');
    }
  }

  function openEditProfile(p: ExclusionProfile) {
    editingProfile = p;
    epName = p.name;
    epDescription = p.description ?? '';
    try { epPatterns = (JSON.parse(p.patterns) as string[]).join('\n'); } catch { epPatterns = ''; }
    showAddProfileModal = true;
  }

  function openAddProfile() {
    editingProfile = null;
    epName = ''; epDescription = ''; epPatterns = '';
    showAddProfileModal = true;
  }


  function parseRecipients(s: string): string[] {
    return JSON.parse(s);
  }

  function parsePatterns(s: string): string[] {
    try { return JSON.parse(s); } catch { return []; }
  }
</script>

{#if loading}
  <div class="flex items-center justify-center py-20">
    <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
  </div>
{:else if role !== 'admin'}
  <div class="flex flex-col items-center justify-center py-20 gap-3">
    <div class="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
      <svg class="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
              d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/>
      </svg>
    </div>
    <p class="text-sm font-medium text-red-400">Access Denied</p>
    <p class="text-xs text-gray-500">Admin role required to view this page.</p>
  </div>
{:else}
  <div class="max-w-4xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl font-semibold text-white">Admin Panel</h1>
        <p class="text-xs text-gray-500 mt-0.5">Manage users and repository access</p>
      </div>
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 p-1 bg-gray-900 border border-gray-800 rounded-xl w-fit">
      {#each tabs as [key, label]}
        <button
                onclick={() => { activeTab = key; if (key === 'logs' && auditLogs.length === 0) loadAuditLogs(0); if (key === 'notifications' && notifProviders.length === 0) loadNotifications(); if (key === 'exclusions' && exclusionProfilesList.length === 0) loadExclusionProfiles(); }}
                class="px-4 py-1.5 text-sm font-medium rounded-lg transition-all duration-150
                 {activeTab === key
                   ? 'bg-gray-700 text-white shadow-sm'
                   : 'text-gray-400 hover:text-gray-200'}"
        >
          {label}
        </button>
      {/each}
    </div>

    <!-- Users Tab -->
    {#if activeTab === 'users'}
      <div class="space-y-4">
        <div class="flex justify-end">
          <button
                  onclick={() => showAddModal = true}
                  class="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-lg transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            Add User
          </button>
        </div>

        <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table class="w-full text-sm">
            <thead>
            <tr class="border-b border-gray-800 bg-gray-900/80">
              <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Username</th>
              <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
              <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Repos</th>
              <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">2FA</th>
              <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
              <th class="px-5 py-3"></th>
            </tr>
            </thead>
            <tbody class="divide-y divide-gray-800/60">
            {#each users as user (user.id)}
              <tr class="hover:bg-gray-800/20 transition-colors">
                <td class="px-5 py-3.5">
                  <div class="flex items-center gap-2.5">
                    <div class="w-7 h-7 rounded-full {userColor(user.username)} flex items-center justify-center text-xs font-medium text-blue-400">
                      {user.username[0].toUpperCase()}
                    </div>
                    <span class="text-white font-medium">{user.username}</span>
                  </div>
                </td>
                <td class="px-5 py-3.5">
                    <span class="text-xs px-2 py-0.5 rounded-md font-medium
                      {user.role === 'admin'
                        ? 'bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20'
                        : 'bg-gray-800 text-gray-400 ring-1 ring-gray-700'}">
                      {user.role}
                    </span>
                </td>
                <td class="px-5 py-3.5 text-gray-400 text-sm">
                  {user.role === 'admin' ? '∞ All' : user.repo_count}
                </td>
                <td class="px-5 py-3.5">
                  {#if user.totp_enabled}
                    <span class="inline-flex items-center gap-1 text-xs font-medium text-green-400 bg-green-500/10 ring-1 ring-green-500/20 px-2 py-0.5 rounded-md">
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                      </svg>
                      Aktiv
                    </span>
                  {:else}
                    <span class="text-gray-600 text-sm">—</span>
                  {/if}
                </td>
                <td class="px-5 py-3.5 text-gray-500 text-xs">{formatDate(user.created_at)}</td>
                <td class="px-5 py-3.5">
                  <div class="flex items-center justify-end gap-1">
                    <button
                            onclick={() => openResetModal(user)}
                            class="text-xs text-gray-400 hover:text-white transition-colors px-2.5 py-1.5 rounded-lg hover:bg-gray-800"
                    >
                      Reset PW
                    </button>
                    {#if user.totp_enabled}
                      <button
                              onclick={() => reset2fa(user.id, user.username)}
                              class="text-xs text-amber-400 hover:text-amber-300 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-amber-500/10"
                              title="2FA zurücksetzen"
                      >
                        2FA Reset
                      </button>
                    {/if}
                    <button
                            onclick={() => deleteUser(user.id)}
                            disabled={deletingId === user.id}
                            class="text-xs text-red-400 hover:text-red-300 transition-colors px-2.5 py-1.5 rounded-lg hover:bg-red-500/10 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}

    <!-- SSH Connections Tab -->
    {#if activeTab === 'ssh'}
      <div class="space-y-4">
        <div class="flex justify-end">
          <button
            onclick={() => showAddSshModal = true}
            class="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-lg transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            Add Connection
          </button>
        </div>

        {#if sshConnections.length === 0}
          <div class="bg-gray-900 border border-gray-800 rounded-xl px-6 py-12 text-center">
            <p class="text-gray-500 text-sm">No SSH connections yet.</p>
            <p class="text-gray-600 text-xs mt-1">Add one to connect SFTP repositories.</p>
          </div>
        {:else}
          <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-800 bg-gray-900/80">
                  <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                  <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Host</th>
                  <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Port</th>
                  <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                  <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                  <th class="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-800/60">
                {#each sshConnections as conn (conn.id)}
                  {@const testResult = sshTestResults.get(conn.id)}
                  <tr class="hover:bg-gray-800/20 transition-colors">
                    <td class="px-5 py-3.5 text-white font-medium">{conn.name}</td>
                    <td class="px-5 py-3.5 text-gray-300 font-mono text-xs">{conn.host}</td>
                    <td class="px-5 py-3.5 text-gray-400 text-xs">{conn.port}</td>
                    <td class="px-5 py-3.5 text-gray-400 text-xs">{conn.username}</td>
                    <td class="px-5 py-3.5 text-gray-500 text-xs">{formatDate(conn.created_at)}</td>
                    <td class="px-5 py-3.5">
                      <div class="flex items-center justify-end gap-2">
                        <!-- Test button -->
                        <button
                          onclick={() => testSshConnection(conn.id)}
                          disabled={testResult === 'testing'}
                          class="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white px-2.5 py-1.5 rounded-lg hover:bg-gray-800 transition-colors disabled:opacity-40"
                          title={testResult && testResult !== 'testing' && testResult !== 'ok' ? testResult : undefined}
                        >
                          {#if testResult === 'testing'}
                            <div class="w-3 h-3 border border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                            Testing…
                          {:else if testResult === 'ok'}
                            <span class="text-green-400">✓</span> Connected
                          {:else if testResult}
                            <span class="text-red-400">✗</span> Failed
                          {:else}
                            Test
                          {/if}
                        </button>
                        <button
                          onclick={() => deleteSshConnection(conn.id)}
                          disabled={deletingSshId === conn.id}
                          class="text-xs text-red-400 hover:text-red-300 px-2.5 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-40"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Settings Tab -->
    {#if activeTab === 'settings'}
      <div class="space-y-4 max-w-lg">
        <!-- Indexing interval -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-4">Indexierung</p>
          <div class="space-y-4">
            <div>
              <label class="block text-xs font-medium text-gray-400 mb-1.5">Intervall</label>
              <!-- Preset buttons -->
              <div class="grid grid-cols-4 gap-2 mb-3">
                {#each [
                  { label: '5 Min',  value: 5 },
                  { label: '15 Min', value: 15 },
                  { label: '30 Min', value: 30 },
                  { label: '1 Std',  value: 60 },
                  { label: '2 Std',  value: 120 },
                  { label: '6 Std',  value: 360 },
                  { label: '12 Std', value: 720 },
                  { label: '24 Std', value: 1440 },
                ] as preset}
                  <button
                    onclick={() => indexInterval = preset.value}
                    class="px-3 py-2 text-xs rounded-lg border transition-colors
                           {indexInterval === preset.value
                             ? 'bg-blue-600 border-blue-500 text-white'
                             : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-white hover:border-gray-600'}"
                  >
                    {preset.label}
                  </button>
                {/each}
              </div>
              <!-- Custom input -->
              <div class="flex items-center gap-2">
                <input
                  type="number"
                  bind:value={indexInterval}
                  min="1"
                  max="1440"
                  class="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                         focus:outline-none focus:border-blue-500 transition-colors tabular-nums"
                />
                <span class="text-sm text-gray-500">Minuten</span>
                {#if indexInterval >= 60}
                  <span class="text-xs text-gray-600">
                    = {Math.floor(indexInterval / 60)}h{indexInterval % 60 > 0 ? ` ${indexInterval % 60}min` : ''}
                  </span>
                {/if}
              </div>
              <p class="text-[10px] text-gray-600 mt-1.5">Zwischen 1 Minute und 24 Stunden (1440 Min)</p>
            </div>
            <!-- Current interval info -->
            <div class="bg-gray-800/50 border border-gray-700/50 rounded-lg px-3 py-2.5 flex items-center gap-2">
              <svg class="w-3.5 h-3.5 text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <p class="text-xs text-gray-400">
                Aktuell alle <span class="text-white font-medium">{currentInterval} Minuten</span> — Änderung wird sofort wirksam
              </p>
            </div>
            <div class="flex justify-end">
              <button
                onclick={saveIndexInterval}
                disabled={savingInterval}
                class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
                       hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {#if savingInterval}
                  <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                  Speichern…
                {:else}
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                  </svg>
                  Speichern
                {/if}
              </button>
            </div>
          </div>
        </div>

        <!-- Base directory -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-4">Verzeichnisse</p>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Base Directory</label>
            <div class="relative">
              <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
                </svg>
              </span>
              <input
                type="text"
                bind:value={baseDir}
                placeholder="/srv/restic-repos"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm
                       font-mono focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600 placeholder:font-sans"
              />
            </div>
            <p class="text-[10px] text-gray-600 mt-1">Überschreibt die REPO_BASE_DIR Umgebungsvariable</p>
          </div>
          <div class="flex justify-end mt-4">
            <button
              onclick={saveBaseDir}
              disabled={savingBaseDir}
              class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
                     hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {savingBaseDir ? 'Speichern…' : 'Speichern'}
            </button>
          </div>
        </div>
      </div>
    {/if}

    <!-- Permissions Tab -->
    <!-- Logs Tab -->
    {#if activeTab === 'logs'}
      <div class="space-y-4">
        <!-- Stats cards -->
        {#if auditStats}
          <div class="grid grid-cols-3 gap-3">
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Login Failures (24h)</p>
              <p class="text-2xl font-semibold {auditStats.loginFailures24h > 0 ? 'text-red-400' : 'text-white'}">{auditStats.loginFailures24h}</p>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Rate Limit Hits (24h)</p>
              <p class="text-2xl font-semibold {auditStats.rateLimitHits24h > 0 ? 'text-orange-400' : 'text-white'}">{auditStats.rateLimitHits24h}</p>
            </div>
            <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p class="text-xs text-gray-500 uppercase tracking-wider mb-1">Total Events (7d)</p>
              <p class="text-2xl font-semibold text-white">{auditStats.totalEvents7d}</p>
            </div>
          </div>
        {/if}

        <!-- Filters -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex-1 min-w-32">
              <label class="block text-xs font-medium text-gray-500 mb-1.5">Event Type</label>
              <select
                bind:value={auditFilterType}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">All events</option>
                <option value="login_success">Login Success</option>
                <option value="login_failure">Login Failure</option>
                <option value="login_2fa_success">2FA Success</option>
                <option value="login_2fa_failure">2FA Failure</option>
                <option value="logout">Logout</option>
                <option value="rate_limit_hit">Rate Limit Hit</option>
                <option value="repo_added">Repo Added</option>
                <option value="repo_deleted">Repo Deleted</option>
                <option value="user_created">User Created</option>
                <option value="user_deleted">User Deleted</option>
                <option value="password_reset">Password Reset</option>
                <option value="ssh_connection_created">SSH Connection Created</option>
                <option value="ssh_connection_deleted">SSH Connection Deleted</option>
                <option value="permissions_updated">Permissions Updated</option>
              </select>
            </div>
            <div class="flex-1 min-w-32">
              <label class="block text-xs font-medium text-gray-500 mb-1.5">Username</label>
              <input
                type="text"
                bind:value={auditFilterUser}
                placeholder="Any user"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500 placeholder:text-gray-600"
              />
            </div>
            <div class="flex-1 min-w-32">
              <label class="block text-xs font-medium text-gray-500 mb-1.5">Outcome</label>
              <select
                bind:value={auditFilterSuccess}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
              >
                <option value="">All</option>
                <option value="1">Success</option>
                <option value="0">Failure</option>
              </select>
            </div>
            <div class="flex gap-2 shrink-0">
              <button
                onclick={() => loadAuditLogs(0)}
                class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
              >
                Filter
              </button>
              <button
                onclick={resetAuditFilters}
                class="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </div>

        <!-- Log table -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {#if auditLoading}
            <div class="flex items-center justify-center py-12">
              <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          {:else if auditLogs.length === 0}
            <div class="flex flex-col items-center justify-center py-14 gap-2">
              <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
              </svg>
              <p class="text-gray-500 text-sm">No audit logs found</p>
            </div>
          {:else}
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-800 bg-gray-900/80">
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Event</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">User</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">IP</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Details</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800/60">
                  {#each auditLogs as log (log.id)}
                    <tr class="hover:bg-gray-800/20 transition-colors {log.success === 0 ? 'bg-red-950/5' : ''}">
                      <td class="px-4 py-3 text-gray-400 text-xs whitespace-nowrap font-mono">
                        {formatDateTime(log.created_at)}
                      </td>
                      <td class="px-4 py-3">
                        <span class="text-xs px-2 py-0.5 rounded-md font-medium {eventBadgeClass(log.event_type)}">
                          {log.event_type}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-sm">
                        {#if log.username}
                          <span class="text-gray-300">{log.username}</span>
                        {:else}
                          <span class="text-gray-600 italic">—</span>
                        {/if}
                      </td>
                      <td class="px-4 py-3 text-gray-400 text-xs font-mono">
                        {log.ip_address ?? '—'}
                      </td>
                      <td class="px-4 py-3 text-gray-400 text-xs max-w-xs truncate font-mono" title={log.details ?? ''}>
                        {log.details ?? ''}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <!-- Pagination -->
            {#if auditTotal > AUDIT_PAGE_SIZE}
              <div class="flex items-center justify-between px-4 py-3 border-t border-gray-800">
                <p class="text-xs text-gray-500">
                  {auditOffset + 1}–{Math.min(auditOffset + AUDIT_PAGE_SIZE, auditTotal)} of {auditTotal} events
                </p>
                <div class="flex gap-2">
                  <button
                    onclick={() => loadAuditLogs(auditOffset - AUDIT_PAGE_SIZE)}
                    disabled={auditOffset === 0}
                    class="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    ← Prev
                  </button>
                  <button
                    onclick={() => loadAuditLogs(auditOffset + AUDIT_PAGE_SIZE)}
                    disabled={auditOffset + AUDIT_PAGE_SIZE >= auditTotal}
                    class="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-700 hover:border-gray-600 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    Next →
                  </button>
                </div>
              </div>
            {/if}
          {/if}
        </div>
      </div>
    {/if}

    <!-- Notifications Tab -->
    {#if activeTab === 'notifications'}
      <div class="space-y-4">
        <!-- Inner tabs -->
        <div class="flex gap-1 p-0.5 bg-gray-800 rounded-lg w-fit">
          {#each notifInnerTabs as [k, lbl]}
            <button
              type="button"
              onclick={() => notifInnerTab = k}
              class="px-3 py-1.5 text-xs font-medium rounded-md transition-colors
                     {notifInnerTab === k ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}"
            >{lbl}</button>
          {/each}
        </div>

        {#if notifLoading}
          <div class="flex items-center justify-center py-12">
            <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if notifInnerTab === 'providers'}
          <!-- Provider list -->
          <div class="flex justify-between items-center">
            <div>
              <label class="block text-xs font-medium text-gray-500 mb-1">Test-E-Mail-Adresse</label>
              <input
                type="email"
                bind:value={testProviderEmail}
                placeholder="test@example.com"
                class="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:border-blue-500 w-60"
              />
            </div>
            <button
              type="button"
              onclick={() => showAddProviderModal = true}
              class="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-lg transition-colors"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
              Anbieter hinzufügen
            </button>
          </div>

          {#if notifProviders.length === 0}
            <div class="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-12 gap-2">
              <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
              </svg>
              <p class="text-gray-500 text-sm">Noch kein E-Mail-Anbieter konfiguriert</p>
            </div>
          {:else}
            <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-800">
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Typ</th>
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                    <th class="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800/60">
                  {#each notifProviders as provider (provider.id)}
                    <tr class="hover:bg-gray-800/20 transition-colors">
                      <td class="px-5 py-3.5">
                        <div class="flex items-center gap-2">
                          <span class="text-white font-medium">{provider.name}</span>
                          {#if provider.is_default}
                            <span class="text-xs px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20">Standard</span>
                          {/if}
                        </div>
                      </td>
                      <td class="px-5 py-3.5">
                        <span class="text-xs px-2 py-0.5 rounded-md font-medium bg-gray-700 text-gray-300">
                          {PROVIDER_LABELS[provider.provider]}
                        </span>
                      </td>
                      <td class="px-5 py-3.5">
                        {#if testProviderResult[provider.id] === 'ok'}
                          <span class="text-xs text-emerald-400">✓ OK</span>
                        {:else if testProviderResult[provider.id]}
                          <span class="text-xs text-red-400" title={testProviderResult[provider.id]}>✗ Fehler</span>
                        {:else}
                          <span class="text-xs text-gray-600">—</span>
                        {/if}
                      </td>
                      <td class="px-5 py-3.5">
                        <div class="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onclick={() => testProvider(provider.id)}
                            disabled={testingProviderId === provider.id || !testProviderEmail}
                            class="text-xs px-2.5 py-1 rounded-lg border border-gray-700 text-gray-400 hover:text-white hover:border-gray-500 transition-colors disabled:opacity-40"
                          >
                            {testingProviderId === provider.id ? 'Sende…' : 'Test'}
                          </button>
                          <button
                            type="button"
                            onclick={() => deleteProvider(provider.id)}
                            class="text-xs px-2.5 py-1 rounded-lg border border-red-900/40 text-red-400 hover:bg-red-500/10 transition-colors"
                          >Löschen</button>
                        </div>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

        {:else if notifInnerTab === 'rules'}
          <!-- Rules list -->
          <div class="flex justify-end">
            <button
              type="button"
              onclick={() => showAddRuleModal = true}
              class="flex items-center gap-2 text-sm bg-blue-600 hover:bg-blue-500 text-white px-3.5 py-2 rounded-lg transition-colors"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
              Regel hinzufügen
            </button>
          </div>

          {#if notifRules.length === 0}
            <div class="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-12 gap-2">
              <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/>
              </svg>
              <p class="text-gray-500 text-sm">Noch keine Regeln konfiguriert</p>
            </div>
          {:else}
            <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-800">
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Typ</th>
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Empfänger</th>
                    <th class="text-left px-5 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Aktiv</th>
                    <th class="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800/60">
                  {#each notifRules as rule (rule.id)}
                    {@const recipients = parseRecipients(rule.recipients)}
                    <tr class="hover:bg-gray-800/20 transition-colors">
                      <td class="px-5 py-3.5 text-white font-medium">{rule.name}</td>
                      <td class="px-5 py-3.5">
                        {#if rule.trigger_type === 'event'}
                          <span class="text-xs px-2 py-0.5 rounded-md font-medium bg-purple-500/10 text-purple-400 ring-1 ring-purple-500/20">Event</span>
                        {:else if rule.schedule_type === 'weekly'}
                          <span class="text-xs px-2 py-0.5 rounded-md font-medium bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20">Wöchentlich</span>
                        {:else}
                          <span class="text-xs px-2 py-0.5 rounded-md font-medium bg-teal-500/10 text-teal-400 ring-1 ring-teal-500/20">Monatlich</span>
                        {/if}
                      </td>
                      <td class="px-5 py-3.5 text-gray-400 text-xs">{recipients.length} Empfänger</td>
                      <td class="px-5 py-3.5">
                        <button
                          type="button"
                          onclick={() => toggleRule(rule)}
                          class="relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                                 {rule.enabled ? 'bg-blue-600' : 'bg-gray-700'}"
                          role="switch"
                          aria-checked={!!rule.enabled}
                        >
                          <span class="inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                                       {rule.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'}"></span>
                        </button>
                      </td>
                      <td class="px-5 py-3.5">
                        <button
                          type="button"
                          onclick={() => deleteRule(rule.id)}
                          class="text-xs px-2.5 py-1 rounded-lg border border-red-900/40 text-red-400 hover:bg-red-500/10 transition-colors"
                        >Löschen</button>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

        {:else}
          <!-- Log -->
          {#if notifLog.length === 0}
            <div class="bg-gray-900 border border-gray-800 rounded-xl flex flex-col items-center justify-center py-12 gap-2">
              <p class="text-gray-500 text-sm">Noch keine Benachrichtigungen versendet</p>
            </div>
          {:else}
            <div class="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-800">
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Zeit</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Betreff</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Empfänger</th>
                    <th class="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-gray-800/60">
                  {#each notifLog as entry (entry.id)}
                    {@const rcpt = parseRecipients(entry.recipients)}
                    <tr class="hover:bg-gray-800/20 transition-colors">
                      <td class="px-4 py-3 text-gray-400 text-xs whitespace-nowrap font-mono">{formatDateTime(entry.created_at)}</td>
                      <td class="px-4 py-3 text-gray-300 text-xs max-w-xs truncate">{entry.subject}</td>
                      <td class="px-4 py-3 text-gray-400 text-xs">{rcpt.join(', ')}</td>
                      <td class="px-4 py-3">
                        {#if entry.status === 'sent'}
                          <span class="text-xs px-2 py-0.5 rounded-md font-medium bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">gesendet</span>
                        {:else}
                          <span
                            class="text-xs px-2 py-0.5 rounded-md font-medium bg-red-500/10 text-red-400 ring-1 ring-red-500/20 cursor-help"
                            title={entry.error_message ?? ''}
                          >fehlgeschlagen</span>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Exclusion Profiles Tab -->
    {#if activeTab === 'exclusions'}
      <div class="space-y-4">
        <div class="flex justify-between items-center">
          <div>
            <p class="text-sm text-gray-400">
              Define reusable glob-pattern exclusion sets that backup sources can reference.
            </p>
          </div>
          <button
            onclick={openAddProfile}
            class="flex items-center gap-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white
                   px-3.5 py-2 rounded-lg transition-colors"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            New Profile
          </button>
        </div>

        {#if exclusionsLoading}
          <div class="flex justify-center py-10">
            <div class="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if exclusionProfilesList.length === 0}
          <div class="bg-gray-900 border border-gray-800 rounded-xl p-10 text-center">
            <p class="text-gray-500 text-sm">No exclusion profiles yet. Create one to reuse patterns across backup sources.</p>
          </div>
        {:else}
          <div class="space-y-3">
            {#each exclusionProfilesList as profile (profile.id)}
              {@const patterns = parsePatterns(profile.patterns)}
              <div class="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0 flex-1">
                    <p class="text-white font-medium text-sm">{profile.name}</p>
                    {#if profile.description}
                      <p class="text-gray-500 text-xs mt-0.5">{profile.description}</p>
                    {/if}
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <button
                      onclick={() => openEditProfile(profile)}
                      class="text-xs text-gray-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-gray-800 transition-colors"
                    >Edit</button>
                    <button
                      onclick={() => deleteExclusionProfile(profile.id)}
                      class="text-xs text-red-400 hover:text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/10 transition-colors"
                    >Delete</button>
                  </div>
                </div>
                {#if patterns.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each patterns as pat}
                      <code class="text-xs bg-gray-800 text-gray-300 px-2 py-0.5 rounded-md font-mono">{pat}</code>
                    {/each}
                  </div>
                {:else}
                  <p class="text-xs text-gray-600 italic">No patterns defined</p>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    {#if activeTab === 'permissions'}
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <p class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Select User</p>
          <div class="space-y-0.5">
            {#each users.filter(u => u.role === 'viewer') as user (user.id)}
              <button
                      onclick={() => selectUser(user.id)}
                      class="w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2.5
                       {selectedUserId === user.id
                         ? 'bg-blue-600 text-white'
                         : 'text-gray-300 hover:bg-gray-800'}"
              >
                <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0
  {selectedUserId === user.id ? 'bg-white/20 text-white' : userColor(user.username)}">
                  {user.username[0].toUpperCase()}
                </div>
                {user.username}
              </button>
            {:else}
              <p class="text-gray-600 text-xs px-3 py-2">No viewer accounts</p>
            {/each}
          </div>
        </div>

        <div class="sm:col-span-2 bg-gray-900 border border-gray-800 rounded-xl p-4">
          {#if selectedUserId === null}
            <div class="flex flex-col items-center justify-center h-full py-12 gap-2 text-center">
              <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
              </svg>
              <p class="text-gray-500 text-sm">Select a user to manage permissions</p>
            </div>
          {:else if loadingPerms}
            <div class="flex items-center justify-center py-10">
              <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          {:else}
            <p class="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">Repository Access</p>
            <div class="space-y-1 mb-5">
              {#each repoList as repo (repo.id)}
                <label class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-800/60 cursor-pointer transition-colors group">
                  <input
                          type="checkbox"
                          checked={userPermRepoIds.has(repo.id)}
                          onchange={() => togglePermRepo(repo.id)}
                          class="rounded border-gray-600 bg-gray-700 text-blue-500 cursor-pointer"
                  />
                  <div class="min-w-0">
                    <p class="text-white text-sm truncate">{repo.name}</p>
                    <p class="text-gray-500 text-xs font-mono truncate">{repo.path}</p>
                  </div>
                </label>
              {:else}
                <p class="text-gray-600 text-sm px-3">No repositories configured</p>
              {/each}
            </div>
            <button
                    onclick={savePerms}
                    disabled={savingPerms}
                    class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
            >
              {savingPerms ? 'Saving…' : 'Save Permissions'}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/if}

<!-- Add User Modal -->
<Modal open={showAddModal} title="Add User" onclose={() => showAddModal = false}>
  {#snippet children()}
    <div class="space-y-4">
      <div>
        <label for="new-username" class="block text-xs font-medium text-gray-400 mb-1.5">Username</label>
        <input
                id="new-username"
                type="text"
                bind:value={newUsername}
                placeholder="e.g. johndoe"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
        />
      </div>
      <div>
        <label for="new-password" class="block text-xs font-medium text-gray-400 mb-1.5">Password</label>
        <input
                id="new-password"
                type="password"
                bind:value={newPassword}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>
      <div>
        <label for="new-role" class="block text-xs font-medium text-gray-400 mb-1.5">Role</label>
        <select
                id="new-role"
                bind:value={newRole}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-blue-500 transition-colors"
        >
          <option value="viewer">Viewer</option>
          <option value="admin">Admin</option>
        </select>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
            onclick={() => showAddModal = false}
            class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Cancel
    </button>
    <button
            onclick={addUser}
            disabled={addingUser || !newUsername || !newPassword}
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500
             disabled:opacity-40 rounded-lg transition-colors"
    >
      {addingUser ? 'Creating…' : 'Create User'}
    </button>
  {/snippet}
</Modal>

<ConfirmModal />

<!-- Add SSH Connection Modal -->
<Modal open={showAddSshModal} title="Add SSH Connection" onclose={() => showAddSshModal = false}>
  {#snippet children()}
    <div class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <div class="col-span-2">
          <label for="ssh-name" class="block text-xs font-medium text-gray-400 mb-1.5">Connection Name</label>
          <input
            id="ssh-name" type="text" bind:value={sshName}
            placeholder="e.g. backup-server"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
          />
        </div>
        <div>
          <label for="ssh-host" class="block text-xs font-medium text-gray-400 mb-1.5">Host</label>
          <input
            id="ssh-host" type="text" bind:value={sshHost}
            placeholder="192.168.1.10"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono
                   focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
          />
        </div>
        <div>
          <label for="ssh-port" class="block text-xs font-medium text-gray-400 mb-1.5">Port</label>
          <input
            id="ssh-port" type="number" bind:value={sshPort} min="1" max="65535"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>
        <div class="col-span-2">
          <label for="ssh-user" class="block text-xs font-medium text-gray-400 mb-1.5">Username</label>
          <input
            id="ssh-user" type="text" bind:value={sshUsername}
            placeholder="root"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
          />
        </div>
        <div class="col-span-2">
          <label for="ssh-key" class="block text-xs font-medium text-gray-400 mb-1.5">Private Key</label>
          <textarea
            id="ssh-key" bind:value={sshPrivateKey} rows="6"
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs font-mono
                   focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600 resize-none"
          ></textarea>
          <p class="text-gray-600 text-xs mt-1">Paste the contents of your private key file (e.g. id_ed25519). Stored encrypted.</p>
        </div>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => showAddSshModal = false}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Cancel
    </button>
    <button
      onclick={addSshConnection}
      disabled={addingSsh || !sshName || !sshHost || !sshUsername || !sshPrivateKey}
      class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500
             disabled:opacity-40 rounded-lg transition-colors"
    >
      {addingSsh ? 'Saving…' : 'Save Connection'}
    </button>
  {/snippet}
</Modal>

<!-- Reset Password Modal -->
<Modal open={showResetModal} title="Reset Password" onclose={() => showResetModal = false}>
  {#snippet children()}
    <p class="text-gray-400 text-sm mb-4">
      New password for <span class="text-white font-medium">{resetTargetName}</span>
    </p>
    <div>
      <label for="reset-password" class="block text-xs font-medium text-gray-400 mb-1.5">New Password</label>
      <input
              id="reset-password"
              type="password"
              bind:value={resetPassword}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
               focus:outline-none focus:border-blue-500 transition-colors"
      />
    </div>
  {/snippet}
  {#snippet footer()}
    <button
            onclick={() => showResetModal = false}
            class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Cancel
    </button>
    <button
            onclick={resetPwd}
            disabled={resettingPassword || !resetPassword}
            class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500
             disabled:opacity-40 rounded-lg transition-colors"
    >
      {resettingPassword ? 'Resetting…' : 'Reset Password'}
    </button>
  {/snippet}
</Modal>

<!-- Add Provider Modal -->
<Modal open={showAddProviderModal} title="E-Mail-Anbieter hinzufügen" onclose={() => showAddProviderModal = false}>
  {#snippet children()}
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
        <input
          type="text" bind:value={newProviderName} placeholder="z.B. Firmen-SMTP"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Anbieter-Typ</label>
        <select
          bind:value={newProviderType}
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
        >
          <option value="smtp">SMTP</option>
          <option value="sendgrid">SendGrid</option>
          <option value="mailgun">Mailgun</option>
          <option value="resend">Resend</option>
          <option value="ses">AWS SES</option>
        </select>
      </div>

      {#if newProviderType === 'smtp'}
        <div class="grid grid-cols-2 gap-3">
          <div class="col-span-2 sm:col-span-1">
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Host</label>
            <input type="text" bind:value={npSmtpHost} placeholder="smtp.example.com"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Port</label>
            <input type="number" bind:value={npSmtpPort} min="1" max="65535"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div class="col-span-2 sm:col-span-1">
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Benutzername</label>
            <input type="text" bind:value={npSmtpUser}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Passwort</label>
            <input type="password" bind:value={npSmtpPass}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div class="col-span-2 flex items-center gap-2">
            <input type="checkbox" id="smtp-secure" bind:checked={npSmtpSecure} class="rounded border-gray-600 bg-gray-700 text-blue-500"/>
            <label for="smtp-secure" class="text-sm text-gray-300">TLS/SSL (Port 465)</label>
          </div>
        </div>
      {:else if newProviderType === 'mailgun'}
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1.5">API Key</label>
          <input type="password" bind:value={npApiKey} placeholder="key-..."
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Domain</label>
            <input type="text" bind:value={npMailgunDomain} placeholder="mg.example.com"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Region</label>
            <select bind:value={npMailgunRegion}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
              <option value="us">US</option>
              <option value="eu">EU</option>
            </select>
          </div>
        </div>
      {:else if newProviderType === 'ses'}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Access Key ID</label>
            <input type="text" bind:value={npSesAccessKey}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Secret Key</label>
            <input type="password" bind:value={npSesSecretKey}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
          <div class="col-span-2">
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Region</label>
            <input type="text" bind:value={npSesRegion} placeholder="eu-central-1"
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
          </div>
        </div>
      {:else}
        <!-- SendGrid / Resend -->
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1.5">API Key</label>
          <input type="password" bind:value={npApiKey}
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
        </div>
      {/if}

      <!-- Shared from/name fields -->
      <div class="grid grid-cols-2 gap-3 pt-1 border-t border-gray-800">
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1.5">Von-Adresse</label>
          <input type="email" bind:value={npFromAddress} placeholder="noreply@example.com"
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
        </div>
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-1.5">Absender-Name</label>
          <input type="text" bind:value={npFromName}
            class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <input type="checkbox" id="provider-default" bind:checked={newProviderIsDefault} class="rounded border-gray-600 bg-gray-700 text-blue-500"/>
        <label for="provider-default" class="text-sm text-gray-300">Als Standard-Anbieter verwenden</label>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => showAddProviderModal = false}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800 rounded-lg transition-colors border border-gray-700"
    >Abbrechen</button>
    <button
      onclick={addProvider}
      disabled={addingProvider || !newProviderName || !npFromAddress}
      class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg transition-colors"
    >{addingProvider ? 'Speichern…' : 'Anbieter speichern'}</button>
  {/snippet}
</Modal>

<!-- Add Rule Modal -->
<Modal open={showAddRuleModal} title="Benachrichtigungsregel hinzufügen" onclose={() => showAddRuleModal = false}>
  {#snippet children()}
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Name</label>
        <input type="text" bind:value={newRuleName} placeholder="z.B. Backup-Fehler-Alarm"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">E-Mail-Anbieter</label>
        <select bind:value={newRuleProviderId}
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
          <option value="">Standard-Anbieter</option>
          {#each notifProviders as p (p.id)}
            <option value={p.id}>{p.name} ({PROVIDER_LABELS[p.provider]})</option>
          {/each}
        </select>
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Auslöser</label>
        <div class="flex gap-2">
          {#each triggerOptions as [v, lbl]}
            <button type="button"
              onclick={() => newRuleTrigger = v}
              class="flex-1 py-2 text-sm rounded-lg border transition-colors
                     {newRuleTrigger === v ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-700 text-gray-400 hover:text-white'}"
            >{lbl}</button>
          {/each}
        </div>
      </div>

      {#if newRuleTrigger === 'event'}
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-2">Ereignisse</label>
          <div class="space-y-1.5">
            {#each EVENT_OPTIONS as opt}
              <label class="flex items-center gap-2.5 cursor-pointer hover:bg-gray-800/60 px-2 py-1.5 rounded-lg">
                <input type="checkbox"
                  checked={newRuleEvents.includes(opt.value)}
                  onchange={() => {
                    if (newRuleEvents.includes(opt.value)) {
                      newRuleEvents = newRuleEvents.filter(e => e !== opt.value);
                    } else {
                      newRuleEvents = [...newRuleEvents, opt.value];
                    }
                  }}
                  class="rounded border-gray-600 bg-gray-700 text-blue-500"
                />
                <span class="text-sm text-gray-300">{opt.label}</span>
              </label>
            {/each}
          </div>
        </div>
      {:else}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Typ</label>
            <select bind:value={newRuleScheduleType}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
              <option value="weekly">Wöchentlich</option>
              <option value="monthly">Monatlich</option>
            </select>
          </div>
          <div>
            {#if newRuleScheduleType === 'weekly'}
              <label class="block text-xs font-medium text-gray-400 mb-1.5">Wochentag</label>
              <select bind:value={newRuleScheduleDay}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
                {#each WEEKDAYS as day, i}
                  <option value={i}>{day}</option>
                {/each}
              </select>
            {:else}
              <label class="block text-xs font-medium text-gray-400 mb-1.5">Tag des Monats</label>
              <input type="number" min="1" max="28" bind:value={newRuleScheduleDay}
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
            {/if}
          </div>
          <div class="col-span-2">
            <label class="block text-xs font-medium text-gray-400 mb-1.5">Uhrzeit</label>
            <select bind:value={newRuleScheduleHour}
              class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500">
              {#each Array.from({ length: 24 }, (_, i) => i) as h}
                <option value={h}>{String(h).padStart(2, '0')}:00 Uhr</option>
              {/each}
            </select>
          </div>
        </div>
      {/if}

      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">
          Empfänger <span class="text-gray-600 font-normal">(kommagetrennt)</span>
        </label>
        <input type="text" bind:value={newRuleRecipientsRaw}
          placeholder="alice@example.com, bob@example.com"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"/>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => showAddRuleModal = false}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800 rounded-lg transition-colors border border-gray-700"
    >Abbrechen</button>
    <button
      onclick={addRule}
      disabled={addingRule || !newRuleName || !newRuleRecipientsRaw}
      class="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded-lg transition-colors"
    >{addingRule ? 'Speichern…' : 'Regel speichern'}</button>
  {/snippet}
</Modal>

<!-- Add / Edit Exclusion Profile Modal -->
<Modal open={showAddProfileModal} title={editingProfile ? 'Edit Profile' : 'New Exclusion Profile'}
       onclose={() => { showAddProfileModal = false; editingProfile = null; }}>
  {#snippet children()}
    <div class="space-y-4">
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5" for="ep-name">Profile Name</label>
        <input
          id="ep-name"
          bind:value={epName}
          placeholder="e.g. Common Cache Files"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-emerald-500 transition-colors"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5" for="ep-desc">Description</label>
        <input
          id="ep-desc"
          bind:value={epDescription}
          placeholder="Optional description"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-emerald-500 transition-colors"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5" for="ep-patterns">
          Exclusion Patterns <span class="text-gray-600 font-normal">(one per line)</span>
        </label>
        <textarea
          id="ep-patterns"
          bind:value={epPatterns}
          rows="8"
          placeholder="*.log&#10;*.tmp&#10;node_modules/&#10;.cache/&#10;/proc/**&#10;/sys/**"
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 font-mono focus:outline-none focus:border-emerald-500 transition-colors resize-y"
        ></textarea>
        <p class="text-xs text-gray-600 mt-1">Shell glob patterns passed to <code>restic backup --exclude</code>.</p>
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => { showAddProfileModal = false; editingProfile = null; }}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >Cancel</button>
    <button
      onclick={editingProfile ? saveEditedProfile : addExclusionProfile}
      disabled={addingProfile || !epName.trim()}
      class="px-4 py-2 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-500
             disabled:opacity-40 rounded-lg transition-colors"
    >{addingProfile ? 'Saving…' : (editingProfile ? 'Save Changes' : 'Create Profile')}</button>
  {/snippet}
</Modal>
