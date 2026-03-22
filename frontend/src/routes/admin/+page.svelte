<script lang="ts">
  import { onMount } from 'svelte';
  import { auth, admin as adminApi, repos as reposApi, settings, type AdminUser, type Repo, type SshConnection, type AuditLog, type AuditStats } from '$lib/api';
  import { toast } from '$lib/toast';
  import Modal from '$lib/components/Modal.svelte';
  import ConfirmModal from '$lib/components/ConfirmModal.svelte';
  import { confirm } from '$lib/confirm';
  import {userColor} from "$lib/utils";

  let role = $state('');
  let users = $state<AdminUser[]>([]);
  let repoList = $state<Repo[]>([]);
  let loading = $state(true);
  let activeTab = $state<'users' | 'permissions' | 'ssh' | 'settings' | 'logs'>('users');

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

  // Permissions tab
  let selectedUserId = $state<number | null>(null);
  let userPermRepoIds = $state<Set<number>>(new Set());
  let loadingPerms = $state(false);
  let savingPerms = $state(false);

  onMount(async () => {
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
      {#each ([['users', 'Users'], ['permissions', 'Permissions'], ['ssh', 'SSH Connections'], ['settings', 'Einstellungen'], ['logs', 'Audit Logs']] as const) as [key, label]}
        <button
                onclick={() => { activeTab = key; if (key === 'logs' && auditLogs.length === 0) loadAuditLogs(0); }}
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
