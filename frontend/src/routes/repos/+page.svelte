<script lang="ts">
  import { onMount } from 'svelte';
  import { repos as reposApi, settings as settingsApi, admin as adminApi, type Repo, type SshConnection } from '$lib/api';
  import { toast } from '$lib/toast';
  import Modal from '$lib/components/Modal.svelte';

  let repoList = $state<Repo[]>([]);
  let loading = $state(true);
  let showAddModal = $state(false);
  let showSettingsModal = $state(false);
  let scanning = $state(false);

  // Add repo form
  let newName = $state('');
  let newPath = $state('');
  let newType = $state('local');
  let newPassword = $state('');
  let newConnectionId = $state<number | ''>('');
  let addLoading = $state(false);

  // SSH connections (for SFTP repo picker)
  let sshConnections = $state<SshConnection[]>([]);

  const PATH_PLACEHOLDERS: Record<string, string> = {
    local:  '/srv/restic-repos/myrepo',
    sftp:   'sftp:user@host:/srv/restic-repos/myrepo',
    rest:   'rest:http://localhost:8000/myrepo',
    s3:     's3:s3.amazonaws.com/bucket/myrepo',
    rclone: 'rclone:remote:bucket/myrepo',
  };
  let pathPlaceholder = $derived(PATH_PLACEHOLDERS[newType] ?? '/path/to/repo');

  // Settings form
  let baseDir = $state('');
  let settingsLoading = $state(false);

  onMount(() => {
    loadRepos();
    Promise.all([settingsApi.get(), adminApi.listSshConnections()])
      .then(([s, ssh]) => { baseDir = s.baseDir; sshConnections = ssh; })
      .catch(() => {});
    const timer = setInterval(() => loadRepos(true), 30_000);
    return () => clearInterval(timer);
  });

  async function loadRepos(silent = false) {
    if (!silent) loading = true;
    try {
      repoList = await reposApi.list();
    } catch (err) {
      if (!silent) toast.error(err instanceof Error ? err.message : 'Failed to load repositories');
    } finally {
      loading = false;
    }
  }

  async function addRepo() {
    if (!newName.trim() || !newPath.trim()) return;
    addLoading = true;
    try {
      await reposApi.create({
        name: newName.trim(),
        path: newPath.trim(),
        type: newType,
        password: newPassword || undefined,
        connectionId: newConnectionId !== '' ? newConnectionId : undefined,
      });
      toast.success('Repository added and indexing started');
      showAddModal = false;
      newName = newPath = newPassword = '';
      newType = 'local';
      newConnectionId = '';
      await loadRepos();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add repository');
    } finally {
      addLoading = false;
    }
  }

  async function refreshRepo(id: number) {
    try {
      const updated = await reposApi.refresh(id);
      repoList = repoList.map((r) => (r.id === id ? { ...r, ...updated } : r));
      toast.success('Repository refreshed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to refresh');
    }
  }

  async function scanRepos() {
    scanning = true;
    try {
      const res = await reposApi.scan();
      toast.success(`Scan complete: found ${res.found} repos, added ${res.added} new`);
      if (res.added > 0) await loadRepos();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      scanning = false;
    }
  }

  async function saveSettings() {
    settingsLoading = true;
    try {
      await settingsApi.set(baseDir);
      toast.success('Settings saved');
      showSettingsModal = false;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      settingsLoading = false;
    }
  }

  function statusColor(status: string) {
    if (status === 'ok') return 'bg-green-500';
    if (status === 'error') return 'bg-red-500';
    return 'bg-yellow-500';
  }

  function statusLabel(status: string) {
    if (status === 'ok') return 'OK';
    if (status === 'error') return 'Error';
    return 'Unknown';
  }

  function formatDate(ts: number | null) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  function formatTime(ts: number | null) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }
</script>

<div class="max-w-7xl mx-auto">
  <!-- Header -->
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-xl font-semibold text-white">Repositories</h1>
      <p class="text-gray-500 text-xs mt-0.5">
        {repoList.length} {repoList.length === 1 ? 'Repository' : 'Repositories'} konfiguriert
      </p>
    </div>

    <div class="flex items-center gap-2">
      <!-- Settings -->
      <button
              onclick={() => showSettingsModal = true}
              title="Settings"
              class="p-2 text-gray-500 hover:text-white hover:bg-gray-800 border border-transparent
             hover:border-gray-700 rounded-lg transition-all duration-150"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
      </button>

      <div class="w-px h-5 bg-gray-800"></div>

      <!-- Scan -->
      <button
              onclick={scanRepos}
              disabled={scanning}
              class="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white bg-gray-900
             hover:bg-gray-800 disabled:opacity-40 px-3 py-2 rounded-lg transition-all duration-150
             border border-gray-800 hover:border-gray-700"
      >
        <svg class="w-3.5 h-3.5 {scanning ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        {scanning ? 'Scanning…' : 'Scan'}
      </button>

      <!-- Add -->
      <button
              onclick={() => showAddModal = true}
              class="flex items-center gap-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500
             active:scale-95 px-3.5 py-2 rounded-lg transition-all duration-150"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
        </svg>
        Hinzufügen
      </button>
    </div>
  </div>

  <!-- Loading -->
  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if repoList.length === 0}
    <div class="flex flex-col items-center justify-center py-24 gap-4">
      <div class="relative">
        <div class="w-16 h-16 bg-gray-900 border border-gray-800 rounded-2xl flex items-center justify-center">
          <svg class="w-7 h-7 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                  d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"/>
          </svg>
        </div>
        <div class="absolute -top-1 -right-1 w-5 h-5 bg-gray-950 rounded-full flex items-center justify-center">
          <svg class="w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
        </div>
      </div>
      <div class="text-center">
        <p class="text-gray-300 text-sm font-medium">Keine Repositories</p>
        <p class="text-gray-600 text-xs mt-1">Repository hinzufügen oder Verzeichnis scannen um zu starten.</p>
      </div>
      <button
              onclick={() => showAddModal = true}
              class="flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 border border-blue-500/30
             hover:border-blue-500/60 hover:bg-blue-500/5 px-4 py-2 rounded-lg transition-all duration-150"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
        </svg>
        Repository hinzufügen
      </button>
    </div>
  {:else}
    <!-- Repo Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
      {#each repoList as repo (repo.id)}

        <a href="/repos/{repo.id}"
        class="group bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4
        flex flex-col gap-3 transition-all duration-150 hover:bg-gray-900/80 cursor-pointer"
        >
          <!-- Header: status + name + refresh -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 mb-1">
                <!-- Breathing status dot -->
                <span class="relative flex items-center justify-center w-2 h-2 shrink-0">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40 {statusColor(repo.status)}"></span>
              <span class="relative inline-flex rounded-full w-2 h-2 {statusColor(repo.status)}"></span>
            </span>
                <span class="text-[10px] text-gray-500 uppercase tracking-wider font-medium">{statusLabel(repo.status)}</span>
              </div>
              <h3 class="text-white font-semibold truncate leading-tight">{repo.name}</h3>
            </div>

            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                    class="opacity-0 group-hover:opacity-100 transition-opacity"
                    onclick={(e) => { e.preventDefault(); refreshRepo(repo.id); }}
            >
              <button
                      title="Refresh"
                      class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                </svg>
              </button>
            </div>
          </div>

          <!-- Path -->
          <p class="text-gray-600 text-[11px] font-mono truncate" title={repo.path}>{repo.path}</p>

          {#if repo.error_message}
            <div class="flex items-start gap-1.5 bg-red-950/30 border border-red-900/30 rounded-lg px-2.5 py-2">
              <svg class="w-3 h-3 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
              </svg>
              <p class="text-red-400 text-[11px] line-clamp-2">{repo.error_message}</p>
            </div>
          {/if}

          <!-- Stats -->
          <div class="flex items-center gap-3 border-t border-gray-800/60 pt-3">
            <div class="flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
              </svg>
              <span class="text-white text-sm font-semibold tabular-nums">{repo.snapshot_count}</span>
              <span class="text-gray-600 text-xs">snapshots</span>
            </div>

            <div class="ml-auto flex items-center gap-1.5">
              <svg class="w-3.5 h-3.5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              <span class="text-gray-400 text-xs">{formatDate(repo.last_backup)}</span>
            </div>
          </div>
        </a>
      {/each}
    </div>
  {/if}
</div>

<!-- Add Repo Modal -->
<Modal open={showAddModal} title="Add Repository" onclose={() => showAddModal = false}>
  {#snippet children()}
    <form id="add-form" onsubmit={(e) => { e.preventDefault(); addRepo(); }} class="space-y-5">

      <!-- Name + Type nebeneinander -->
      <div class="grid grid-cols-2 gap-3">
        <div>
          <label for="add-name" class="block text-xs font-medium text-gray-400 mb-1.5">Display Name</label>
          <input
                  id="add-name" type="text" bind:value={newName} required
                  placeholder="Mein Backup"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
          />
        </div>
        <div>
          <label for="add-type" class="block text-xs font-medium text-gray-400 mb-1.5">Typ</label>
          <select
                  id="add-type"
                  bind:value={newType}
                  onchange={() => { newPath = ''; newConnectionId = ''; }}
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors"
          >
            <option value="local">Local</option>
            <option value="sftp">SFTP</option>
            <option value="rest">REST Server</option>
            <option value="s3">S3</option>
            <option value="rclone">rclone</option>
          </select>
        </div>
      </div>

      <!-- Path -->
      <div>
        <label for="add-path" class="block text-xs font-medium text-gray-400 mb-1.5">Pfad / URL</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600">
            {#if newType === 'sftp'}
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            {:else if newType === 'local'}
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
              </svg>
            {:else}
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"/>
              </svg>
            {/if}
          </span>
          <input
                  id="add-path" type="text" bind:value={newPath} required
                  placeholder={pathPlaceholder}
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm
                   font-mono focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600 placeholder:font-sans"
          />
        </div>
      </div>

      <!-- SSH Connection (nur bei SFTP) -->
      {#if newType === 'sftp'}
        <div class="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 space-y-2">
          <label for="add-connection" class="block text-xs font-medium text-gray-400">
            SSH Verbindung <span class="text-gray-600 font-normal">— optional</span>
          </label>
          <select
                  id="add-connection" bind:value={newConnectionId}
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors"
          >
            <option value="">Keine — Server SSH Config nutzen</option>
            {#each sshConnections as c}
              <option value={c.id}>{c.name} ({c.username}@{c.host}:{c.port})</option>
            {/each}
          </select>
          {#if sshConnections.length === 0}
            <p class="text-[11px] text-gray-600">
              Noch keine SSH-Verbindungen. <a href="/admin" class="text-blue-400 hover:text-blue-300 transition-colors">Admin → SSH Connections</a>
            </p>
          {/if}
        </div>
      {/if}

      <!-- Password -->
      <div>
        <label for="add-password" class="block text-xs font-medium text-gray-400 mb-1.5">
          Repo-Passwort <span class="text-gray-600 font-normal">— optional</span>
        </label>
        <input
                id="add-password" type="password" bind:value={newPassword}
                placeholder="Leer lassen wenn kein Passwort gesetzt"
                class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600"
        />
      </div>

    </form>
  {/snippet}
  {#snippet footer()}
    <button
            onclick={() => showAddModal = false}
            class="px-4 py-2 text-sm text-gray-400 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Abbrechen
    </button>
    <button
            form="add-form" type="submit" disabled={addLoading}
            class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
             hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
    >
      {#if addLoading}
        <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
        Hinzufügen…
      {:else}
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
        </svg>
        Repository hinzufügen
      {/if}
    </button>
  {/snippet}
</Modal>

<!-- Settings Modal -->
<Modal open={showSettingsModal} title="Settings" onclose={() => showSettingsModal = false}>
  {#snippet children()}
    <div class="space-y-4">

      <div class="bg-gray-800/50 border border-gray-700/50 rounded-lg p-3 flex items-start gap-2.5">
        <svg class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p class="text-xs text-gray-400 leading-relaxed">
          Verzeichnis das nach lokalen Restic-Repos gescannt wird.
          Überschreibt die <code class="text-gray-300 bg-gray-700 px-1 py-0.5 rounded text-[10px]">REPO_BASE_DIR</code> Umgebungsvariable.
        </p>
      </div>

      <div>
        <label for="settings-basedir" class="block text-xs font-medium text-gray-400 mb-1.5">Base Directory</label>
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
          </span>
          <input
                  id="settings-basedir" type="text" bind:value={baseDir}
                  placeholder="/srv/restic-repos"
                  class="w-full bg-gray-800 border border-gray-700 rounded-lg pl-8 pr-3 py-2 text-white text-sm
                   font-mono focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600 placeholder:font-sans"
          />
        </div>
      </div>

    </div>
  {/snippet}
  {#snippet footer()}
    <button
            onclick={() => showSettingsModal = false}
            class="px-4 py-2 text-sm text-gray-400 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Abbrechen
    </button>
    <button
            onclick={saveSettings} disabled={settingsLoading}
            class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
             hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
    >
      {#if settingsLoading}
        <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
        Speichern…
      {:else}
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
        </svg>
        Speichern
      {/if}
    </button>
  {/snippet}
</Modal>
