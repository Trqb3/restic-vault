<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { backupSources, auth, type BackupSource } from '$lib/api';
  import { toast } from '$lib/toast';

  let sources     = $state<BackupSource[]>([]);
  let loading     = $state(true);
  let showModal   = $state(false);
  let newToken    = $state<string | null>(null);
  let creating    = $state(false);
  let role        = $state<'admin' | 'viewer' | ''>('');

  // Form state
  let newName        = $state('');
  let newDescription = $state('');
  let nameError      = $state('');

  async function load(silent = false) {
    if (!silent) loading = true;
    try {
      sources = await backupSources.list();
    } catch (e) {
      if (!silent) toast.error((e as Error).message);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    auth.me().then(me => role = me.role).catch(() => {});
    const timer = setInterval(() => load(true), 10_000);
    return () => clearInterval(timer);
  });

  function openModal() {
    newName = '';
    newDescription = '';
    nameError = '';
    newToken = null;
    showModal = true;
  }

  async function createSource() {
    nameError = '';
    if (!newName.trim()) { nameError = 'Name is required'; return; }
    if (!/^[a-z0-9_-]+$/.test(newName.trim())) {
      nameError = 'Only lowercase letters, digits, hyphens and underscores allowed';
      return;
    }
    creating = true;
    try {
      const result = await backupSources.create({
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      });
      newToken = result.token;
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      creating = false;
    }
  }

  async function deleteSource(src: BackupSource) {
    if (!confirm(`Delete source "${src.name}"? This cannot be undone.`)) return;
    try {
      await backupSources.delete(src.id);
      toast.success(`Source "${src.name}" deleted`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function toggleDisabled(src: BackupSource) {
    try {
      const nowDisabled = src.disabled === 0;
      await backupSources.update(src.id, { disabled: nowDisabled });
      toast.success(`Source "${src.name}" ${nowDisabled ? 'disabled' : 'enabled'}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function formatDate(ts: number | null): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  }

  function timeSince(ts: number | null): string {
    if (!ts) return 'never';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)   return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function isOnline(ts: number | null): boolean {
    if (!ts) return false;
    return (Math.floor(Date.now() / 1000) - ts) < 120;
  }

  let copied = $state(false);
  async function copyToken() {
    if (!newToken) return;
    await navigator.clipboard.writeText(newToken);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }
</script>

<div class="max-w-6xl mx-auto space-y-6">

  <!-- Header -->
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-2xl font-bold text-white">Backup Sources</h1>
      <p class="text-sm text-gray-400 mt-1">
        Remote servers that push backups to ResticVault via the restic REST protocol.
      </p>
    </div>
    {#if role === 'admin'}
      <button
        onclick={openModal}
        class="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white
               text-sm font-medium rounded-xl transition-colors"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
        </svg>
        New Source
      </button>
    {/if}
  </div>

  <!-- Source cards -->
  {#if loading}
    <div class="flex justify-center py-16">
      <div class="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else if sources.length === 0}
    <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-12 text-center">
      <div class="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4">
        <svg class="w-8 h-8 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
        </svg>
      </div>
      <h3 class="text-lg font-semibold text-white mb-2">No backup sources yet</h3>
      <p class="text-gray-400 text-sm mb-6 max-w-md mx-auto">
        Create a source to generate an agent token. Install the agent on remote servers to start pushing backups.
      </p>
      <button
        onclick={openModal}
        class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded-xl transition-colors"
      >
        Add First Source
      </button>
    </div>
  {:else}
    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {#each sources as src (src.id)}
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-5 flex flex-col gap-4
                    {src.disabled ? 'opacity-60' : ''}
                    hover:border-gray-700/60 transition-colors">
          <!-- Top row -->
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-white font-semibold text-sm truncate">{src.name}</h3>
                <!-- Online indicator -->
                {#if isOnline(src.last_seen_at)}
                  <span class="flex items-center gap-1 text-xs text-emerald-400">
                    <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                    online
                  </span>
                {:else}
                  <span class="text-xs text-gray-600">offline</span>
                {/if}
                {#if src.disabled}
                  <span class="text-xs px-1.5 py-0.5 bg-red-500/15 text-red-400 rounded-md border border-red-500/20">
                    disabled
                  </span>
                {/if}
              </div>
              {#if src.description}
                <p class="text-xs text-gray-500 mt-0.5 truncate">{src.description}</p>
              {/if}
            </div>
          </div>

          <!-- Stats grid -->
          <div class="grid grid-cols-2 gap-3">
            <div class="bg-gray-800/40 rounded-xl p-3">
              <p class="text-xs text-gray-500 mb-1">Last seen</p>
              <p class="text-xs text-gray-300 font-medium">{timeSince(src.last_seen_at)}</p>
            </div>
            <div class="bg-gray-800/40 rounded-xl p-3">
              <p class="text-xs text-gray-500 mb-1">Last backup</p>
              <p class="text-xs text-gray-300 font-medium">{timeSince(src.last_backup_at)}</p>
            </div>
          </div>

          {#if src.agent_version}
            <p class="text-xs text-gray-600">Agent v{src.agent_version}</p>
          {/if}

          <!-- Actions -->
          <div class="flex items-center gap-2 mt-auto pt-2 border-t border-gray-800/50">
            <button
              onclick={() => goto(`/sources/${src.id}`)}
              class="flex-1 text-xs text-gray-400 hover:text-white py-1.5 px-3 rounded-lg
                     hover:bg-gray-800/60 transition-colors text-center"
            >
              Details
            </button>
            {#if role === 'admin'}
              <button
                onclick={() => toggleDisabled(src)}
                class="text-xs py-1.5 px-3 rounded-lg transition-colors
                       {src.disabled
                         ? 'text-emerald-400 hover:bg-emerald-500/10'
                         : 'text-yellow-400 hover:bg-yellow-500/10'}"
              >
                {src.disabled ? 'Enable' : 'Disable'}
              </button>
              <button
                onclick={() => deleteSource(src)}
                class="text-xs text-red-400 hover:text-red-300 py-1.5 px-3 rounded-lg
                       hover:bg-red-500/10 transition-colors"
              >
                Delete
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<!-- Create source modal -->
{#if showModal}
  <div
    class="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4"
    role="dialog" aria-modal="true"
  >
    <div class="bg-gray-900 border border-gray-700/60 rounded-2xl w-full max-w-md shadow-2xl">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <h2 class="text-white font-semibold">New Backup Source</h2>
        <button
          onclick={() => { showModal = false; newToken = null; }}
          class="text-gray-500 hover:text-gray-300 transition-colors"
          aria-label="Close"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="p-6 space-y-4">
        {#if newToken}
          <!-- Token display (shown after creation) -->
          <div class="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 space-y-3">
            <div class="flex items-center gap-2 text-emerald-400 font-medium text-sm">
              <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Source created! Copy your token now — it won't be shown again.
            </div>
            <div class="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-200 break-all leading-relaxed border border-gray-700/50">
              {newToken}
            </div>
            <button
              onclick={copyToken}
              class="w-full flex items-center justify-center gap-2 py-2 px-4 text-sm font-medium rounded-lg
                     transition-colors {copied ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-200 hover:bg-gray-700'}"
            >
              {#if copied}
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
                </svg>
                Copied!
              {:else}
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                </svg>
                Copy Token
              {/if}
            </button>
          </div>
          <button
            onclick={() => { showModal = false; newToken = null; }}
            class="w-full py-2.5 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium
                   rounded-xl transition-colors"
          >
            Done
          </button>
        {:else}
          <!-- Creation form -->
          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="src-name">
              Source Name <span class="text-red-400">*</span>
            </label>
            <input
              id="src-name"
              bind:value={newName}
              placeholder="my-server"
              class="w-full bg-gray-800/60 border {nameError ? 'border-red-500/60' : 'border-gray-700/60'}
                     rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-600
                     focus:outline-none focus:border-emerald-500/60"
            />
            {#if nameError}
              <p class="text-xs text-red-400">{nameError}</p>
            {:else}
              <p class="text-xs text-gray-600">Lowercase letters, digits, hyphens and underscores only.</p>
            {/if}
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="src-desc">Description</label>
            <input
              id="src-desc"
              bind:value={newDescription}
              placeholder="e.g. Production web server"
              class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                     text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500/60"
            />
          </div>

          <div class="flex gap-3 pt-2">
            <button
              onclick={() => { showModal = false; }}
              class="flex-1 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded-xl transition-colors"
            >
              Cancel
            </button>
            <button
              onclick={createSource}
              disabled={creating}
              class="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium
                     rounded-xl transition-colors disabled:opacity-60 flex items-center justify-center gap-2"
            >
              {#if creating}
                <span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
              {/if}
              Create Source
            </button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}
