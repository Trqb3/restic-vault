<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import {
    repos as reposApi,
    snapshots as snapshotsApi,
    type Repo, type Snapshot, type RepoStats, type SnapshotStats, type SizeHistoryPoint
  } from '$lib/api';
  import SizeHistoryChart from '$lib/components/SizeHistoryChart.svelte';
  import { toast } from '$lib/toast';
  import Calendar from '$lib/components/Calendar.svelte';
  import SnapshotBrowser from '$lib/components/SnapshotBrowser.svelte';
  import Modal from '$lib/components/Modal.svelte';

  const repoId = Number($page.params.id);

  let repo = $state<Repo | null>(null);
  let snapshotList = $state<Snapshot[]>([]);
  let loading = $state(true);
  let refreshing = $state(false);
  let activeTab = $state<'calendar' | 'details' | 'configuration'>('calendar');

  // Selected day in the calendar
  let selectedDay = $state<string | null>(null);
  let selectedDaySnaps = $derived(
    selectedDay
      ? snapshotList.filter((s) => {
          const d = new Date(s.time * 1000);
          const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
          return key === selectedDay;
        })
      : []
  );

  // Snapshot browser
  let browserOpen = $state(false);
  let browserSnapshot = $state<Snapshot | null>(null);

  // Multi-select (for delete)
  let selected = $state<Set<string>>(new Set());
  let showDeleteModal = $state(false);
  let deleting = $state(false);

  // Details tab
  let repoStats = $state<RepoStats | null>(null);
  let statsLoading = $state(false);
  let statsLoaded = $state(false);
  let statsError = $state(false);

  // Size history chart
  let sizeHistory = $state<SizeHistoryPoint[]>([]);
  let sizeHistoryDays = $state(90);
  let sizeHistoryLoading = $state(false);

  // Snapshot stats (lazy, cached per snapshot)
  let snapshotStats = $state<Map<string, SnapshotStats | 'loading' | 'error'>>(new Map());
  let snapshotStatsTriggered = $state(false);

  // Expanded detail row in the snapshot list
  let expandedSnap = $state<string | null>(null);

  // Configuration tab
  let configName = $state('');
  let configPath = $state('');
  let configPassword = $state('');
  let configSaving = $state(false);

  onMount(() => {
    load();
    const timer = setInterval(() => {
      // Silent refresh — don't show loading spinner if already loaded
      if (repo) {
        Promise.all([reposApi.get(repoId), snapshotsApi.list(repoId)])
          .then(([r, s]) => { repo = r; snapshotList = s; snapshotStats = buildPreloadedStats(s); })
          .catch(() => {});
      }
    }, 30_000);
    return () => clearInterval(timer);
  });

  async function load() {
    loading = true;
    try {
      const [r, s] = await Promise.all([reposApi.get(repoId), snapshotsApi.list(repoId)]);
      repo = r;
      snapshotList = s;
      snapshotStats = buildPreloadedStats(s);
      // Default selected day to the most recent snapshot's day
      if (s.length > 0 && !selectedDay) {
        const d = new Date(s[0].time * 1000);
        selectedDay = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load repository');
    } finally {
      loading = false;
    }
  }

  async function refresh() {
    refreshing = true;
    try {
      const r = await reposApi.refresh(repoId);
      const s = await snapshotsApi.list(repoId);
      repo = r;
      snapshotList = s;
      snapshotStats = buildPreloadedStats(s);
      snapshotStatsTriggered = false;
      statsLoaded = false;
      statsError = false;
      toast.success('Repository refreshed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      refreshing = false;
    }
  }

  function openBrowser(snap: Snapshot) {
    browserSnapshot = snap;
    browserOpen = true;
  }

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  async function deleteSelected() {
    deleting = true;
    try {
      await snapshotsApi.delete(repoId, [...selected]);
      toast.success(`Deleted ${selected.size} snapshot${selected.size > 1 ? 's' : ''}`);
      selected = new Set();
      showDeleteModal = false;
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      deleting = false;
    }
  }

  // Load snapshot stats as soon as the list is available (not tied to a tab)
  $effect(() => {
    if (snapshotList.length > 0 && !snapshotStatsTriggered) {
      snapshotStatsTriggered = true;
      loadSnapshotStats();
    }
  });

  async function loadSnapshotStats() {
    const needsFetch = snapshotList.filter((snap) => {
      const existing = snapshotStats.get(snap.snapshot_id);
      return !existing || existing === 'error';
    });
    if (needsFetch.length === 0) return;

    const updated = new Map(snapshotStats);
    for (const snap of needsFetch) updated.set(snap.snapshot_id, 'loading');
    snapshotStats = updated;

    const BATCH = 5;
    for (let i = 0; i < needsFetch.length; i += BATCH) {
      const batch = needsFetch.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (snap) => {
          try {
            const stats = await snapshotsApi.stats(repoId, snap.snapshot_id);
            snapshotStats = new Map(snapshotStats).set(snap.snapshot_id, stats);
          } catch {
            snapshotStats = new Map(snapshotStats).set(snap.snapshot_id, 'error');
          }
        })
      );
    }
  }

  // Details tab: load repo stats + size history on first visit
  $effect(() => {
    if (activeTab === 'details') {
      if (!statsLoaded && !statsLoading && !statsError) {
        loadStats();
      }
      if (sizeHistory.length === 0 && !sizeHistoryLoading) {
        loadSizeHistory();
      }
    }
  });

  async function loadStats() {
    statsLoading = true;
    statsError = false;
    try {
      repoStats = await reposApi.stats(repoId);
      statsLoaded = true;
    } catch (err) {
      statsError = true;
      toast.error(err instanceof Error ? err.message : 'Failed to load stats');
    } finally {
      statsLoading = false;
    }
  }

  async function loadSizeHistory() {
    sizeHistoryLoading = true;
    try {
      sizeHistory = await reposApi.sizeHistory(repoId, sizeHistoryDays);
    } catch (err) {
      console.error('Failed to load size history:', err);
    } finally {
      sizeHistoryLoading = false;
    }
  }

  async function handleDaysChange(days: number) {
    sizeHistoryDays = days;
    await loadSizeHistory();
  }

  // Configuration tab: pre-fill from repo
  $effect(() => {
    if (repo && activeTab === 'configuration') {
      if (!configName) configName = repo.name;
      if (!configPath) configPath = repo.path;
    }
  });

  async function saveConfig() {
    configSaving = true;
    try {
      await reposApi.patch(repoId, {
        name: configName,
        path: configPath,
        ...(configPassword ? { password: configPassword } : {}),
      });
      toast.success('Configuration saved');
      configPassword = '';
      repo = await reposApi.get(repoId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      configSaving = false;
    }
  }

  function buildPreloadedStats(snaps: typeof snapshotList): Map<string, SnapshotStats | 'loading' | 'error'> {
    const map = new Map<string, SnapshotStats | 'loading' | 'error'>();
    for (const snap of snaps) {
      if (snap.restore_size !== null && snap.restore_size !== undefined) {
        map.set(snap.snapshot_id, {
          snapshot_id:      snap.snapshot_id,
          repo_id:          snap.repo_id,
          restore_size:     snap.restore_size,
          added_size:       snap.added_size       ?? null,
          file_count:       snap.file_count       ?? null,
          files_new:        snap.files_new        ?? null,
          files_changed:    snap.files_changed    ?? null,
          files_unmodified: snap.files_unmodified ?? null,
          fetched_at:       '',
        });
      }
    }
    return map;
  }

  function dayLabel(key: string): string {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
  }

  function formatTime(ts: number) {
    return new Date(ts * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit', minute: '2-digit',
    });
  }

  function formatDateShort(ts: number | null) {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  }

  function formatBytes(bytes: number | null): string {
    if (bytes === null || bytes === undefined) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  const statusColor: Record<string, string> = {
    ok: 'bg-green-500',
    error: 'bg-red-500',
    unknown: 'bg-yellow-500',
  };

  const typeBadge: Record<string, string> = {
    yearly:  'bg-yellow-900/50 text-yellow-300 border-yellow-700',
    monthly: 'bg-teal-900/50 text-teal-300 border-teal-700',
    weekly:  'bg-blue-900/50 text-blue-300 border-blue-700',
    daily:   'bg-gray-800 text-gray-300 border-gray-700',
  };

  const tabs = [
    { key: 'calendar',      label: 'Calendar' },
    { key: 'details',       label: 'Details' },
    { key: 'configuration', label: 'Configuration' },
  ] as const;


  // Delete repo
  let showDeleteRepoModal = $state(false);
  let deletingRepo = $state(false);

  async function deleteRepo() {
    deletingRepo = true;
    try {
      await reposApi.delete(repoId);
      toast.success('Repository entfernt');
      goto('/repos');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Entfernen');
    } finally {
      deletingRepo = false;
      showDeleteRepoModal = false;
    }
  }

  function fmtCount(v: number | null): string {
    return v !== null ? v.toLocaleString() : '?';
  }

  function weekdayValues(obj: Record<string, number>): number[] {
    return Object.values(obj);
  }

  function weekdayCount(obj: Record<string, number>, i: number): number {
    return obj[i] ?? 0;
  }

  function hourValues(obj: Record<string, number>): number[] {
    return Object.values(obj);
  }

  function hourCount(obj: Record<string, number>, h: number): number {
    return obj[h] ?? 0;
  }
</script>

{#if loading}
  <div class="flex items-center justify-center py-20">
    <div class="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
  </div>
{:else if repo}
  <div class="max-w-6xl mx-auto">
    <!-- Header -->
    <div class="flex items-center justify-between gap-4 mb-6">
      <div class="flex items-center gap-3">
        <button onclick={() => goto('/repos')} aria-label="Back to repositories" class="text-gray-400 hover:text-white transition-colors shrink-0">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div>
          <div class="flex items-center gap-2 mb-1">
            <h1 class="text-xl font-bold text-white flex items-center gap-2">
              <span class="relative flex items-center justify-center w-2.5 h-2.5 shrink-0 mt-1">
                <span class="animate-ping absolute inline-flex h-full w-full rounded-full opacity-50 {statusColor[repo.status] ?? 'bg-gray-500'}"></span>
                <span class="relative inline-flex rounded-full w-2.5 h-2.5 {statusColor[repo.status] ?? 'bg-gray-500'}"></span>
              </span>
              {repo.name}
            </h1>
          </div>
          <p class="text-gray-400 text-sm font-mono">{repo.path}</p>
          {#if repo.error_message}
            <p class="text-red-400 text-xs mt-1">{repo.error_message}</p>
          {/if}
        </div>
      </div>

      <button
              onclick={refresh}
              disabled={refreshing}
              class="flex items-center gap-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700
           text-gray-300 hover:text-white px-4 py-2 rounded-lg transition-colors disabled:opacity-50 shrink-0"
      >
        <svg class="w-4 h-4 {refreshing ? 'animate-spin' : ''}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </div>

    <!-- Stats bar -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
      {#each [
        {
          label: 'Snapshots',
          value: String(repo.snapshot_count),
          icon: 'M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4',
          accent: 'text-blue-400',
        },
        {
          label: 'Last Backup',
          value: formatDateShort(repo.last_backup),
          icon: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
          accent: 'text-emerald-400',
        },
        {
          label: 'Type',
          value: repo.type,
          icon: 'M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2',
          accent: 'text-purple-400',
        },
        {
          label: 'Last Indexed',
          value: formatDateShort(repo.last_indexed),
          icon: 'M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15',
          accent: 'text-amber-400',
        },
      ] as stat}
        <div class="group bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl px-4 py-3 transition-colors duration-150 flex items-center gap-3">
          <div class="shrink-0 w-8 h-8 rounded-lg bg-gray-800 group-hover:bg-gray-750 flex items-center justify-center transition-colors">
            <svg class="w-4 h-4 {stat.accent}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d={stat.icon}/>
            </svg>
          </div>
          <div class="min-w-0">
            <p class="text-gray-500 text-[10px] uppercase tracking-wider font-medium">{stat.label}</p>
            <p class="text-white font-medium text-sm capitalize truncate mt-0.5">{stat.value}</p>
          </div>
        </div>
      {/each}
    </div>

    <!-- Tabs -->
    <div class="flex gap-1 border-b border-gray-800 mb-6">
      {#each tabs as tab}
        <button
          onclick={() => activeTab = tab.key}
          class="px-4 py-2 text-sm font-medium transition-colors
                 {activeTab === tab.key
                   ? 'text-white border-b-2 border-blue-500 -mb-px'
                   : 'text-gray-400 hover:text-gray-200'}"
        >
          {tab.label}
          {#if tab.key === 'calendar' && snapshotList.length > 0}
            <span class="ml-1.5 text-xs bg-gray-700 text-gray-300 rounded-full px-1.5 py-0.5">
              {snapshotList.length}
            </span>
          {/if}
        </button>
      {/each}
    </div>

    <!-- ── Calendar Tab ───────────────────────────────────────────────────── -->
    {#if activeTab === 'calendar'}
      <div class="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <Calendar
          snapshots={snapshotList}
          selectedDate={selectedDay}
          onselect={(key) => { selectedDay = key; expandedSnap = null; }}
        />
      </div>

      <!-- Selected day snapshot list -->
      <div class="mt-4">
        <!-- Day header + delete bar -->
        <div class="flex items-center justify-between mb-3 gap-4">
          <div>
            {#if selectedDay}
              <h3 class="text-sm font-semibold text-white">{dayLabel(selectedDay)}</h3>
              <p class="text-xs text-gray-500 mt-0.5">{selectedDaySnaps.length} snapshot{selectedDaySnaps.length !== 1 ? 's' : ''}</p>
            {:else}
              <p class="text-sm text-gray-500">Wähle einen Tag im Kalender aus</p>
            {/if}
          </div>

          {#if selected.size > 0}
            <div class="flex items-center gap-2 bg-red-950/30 border border-red-900/50 rounded-xl px-3 py-1.5">
              <span class="text-xs text-red-300 font-medium">{selected.size} ausgewählt</span>
              <button
                      onclick={() => selected = new Set()}
                      class="text-xs text-gray-500 hover:text-white transition-colors px-1.5 py-0.5 rounded hover:bg-gray-800"
              >Abwählen</button>
              <button
                      onclick={() => showDeleteModal = true}
                      class="text-xs text-white bg-red-600 hover:bg-red-500 px-2.5 py-1 rounded-lg transition-colors"
              >Löschen</button>
            </div>
          {/if}
        </div>

        <!-- Snapshot list -->
        {#if selectedDaySnaps.length === 0 && selectedDay}
          <div class="flex flex-col items-center justify-center py-10 gap-2 bg-gray-900/50 border border-gray-800 rounded-xl">
            <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/>
            </svg>
            <p class="text-gray-600 text-sm">Keine Snapshots an diesem Tag</p>
          </div>
        {:else if selectedDaySnaps.length > 0}
          <div class="overflow-y-auto max-h-[40vh] rounded-xl border border-gray-800 divide-y divide-gray-800/60 bg-gray-900">
            {#each selectedDaySnaps as snap (snap.snapshot_id)}
              {@const stats = snapshotStats.get(snap.snapshot_id)}
              {@const statsObj = (stats && stats !== 'loading' && stats !== 'error') ? stats : null}
              {@const isExpanded = expandedSnap === snap.snapshot_id}

              <div class="group">
                <!-- Header row -->
                <div
                        class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-800/30 transition-colors"
                        onclick={() => expandedSnap = isExpanded ? null : snap.snapshot_id}
                        role="button"
                        tabindex="0"
                        onkeydown={(e) => e.key === 'Enter' && (expandedSnap = isExpanded ? null : snap.snapshot_id)}
                >
                  <!-- Checkbox -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div onclick={(e) => e.stopPropagation()} class="shrink-0">
                    <input
                            type="checkbox"
                            checked={selected.has(snap.snapshot_id)}
                            onchange={() => toggleSelect(snap.snapshot_id)}
                            class="rounded border-gray-700 bg-gray-800 text-blue-500 cursor-pointer"
                    />
                  </div>

                  <!-- Time + ID -->
                  <div class="shrink-0 w-16 text-center">
                    <p class="text-white text-sm font-medium tabular-nums">{formatTime(snap.time)}</p>
                    <p class="text-gray-600 text-[10px] font-mono mt-0.5">{snap.short_id}</p>
                  </div>

                  <!-- Divider -->
                  <div class="w-px h-7 bg-gray-800 shrink-0"></div>

                  <!-- Host + paths -->
                  <div class="flex-1 min-w-0">
                    <p class="text-gray-200 text-sm truncate font-mono">{snap.hostname ?? '—'}</p>
                    {#if snap.paths?.length}
                      <p class="text-gray-600 text-[11px] truncate mt-0.5">{snap.paths.join(', ')}</p>
                    {/if}
                  </div>

                  <!-- Type badge -->
                  <span class="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border capitalize {typeBadge[snap.backup_type] ?? typeBadge.daily}">
              {snap.backup_type}
            </span>

                  <!-- Quick stats -->
                  {#if stats === 'loading'}
                    <div class="w-3 h-3 border border-blue-500/60 border-t-transparent rounded-full animate-spin shrink-0"></div>
                  {:else if statsObj}
                    <div class="shrink-0 text-right hidden sm:block min-w-[64px]">
                      <p class="text-xs text-gray-400 tabular-nums">{formatBytes(statsObj.restore_size)}</p>
                      {#if statsObj.added_size !== null}
                        {@const neg = statsObj.added_size < 0}
                        <p class="text-[11px] tabular-nums font-medium {neg ? 'text-red-400' : 'text-emerald-400'}">
                          {neg ? '−' : '+'}{formatBytes(Math.abs(statsObj.added_size))}
                        </p>
                      {/if}
                    </div>
                  {/if}

                  <!-- Actions -->
                  <!-- svelte-ignore a11y_click_events_have_key_events -->
                  <div class="flex items-center gap-1.5 shrink-0" onclick={(e) => e.stopPropagation()}>
                    <button
                            onclick={() => openBrowser(snap)}
                            class="text-[11px] text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10 border border-transparent hover:border-blue-500/20"
                    >Browse</button>
                    <svg
                            class="w-3.5 h-3.5 text-gray-600 transition-transform duration-200 {isExpanded ? 'rotate-180' : ''}"
                            fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
                    </svg>
                  </div>
                </div>

                <!-- Expanded detail panel -->
                {#if isExpanded}
                  <div class="px-4 pb-4 pt-2 bg-gray-950/60 border-t border-gray-800/40">
                    {#if stats === 'loading'}
                      <div class="flex items-center gap-2 text-xs text-gray-500 py-2">
                        <div class="w-3.5 h-3.5 border border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        Lade Stats…
                      </div>
                    {:else}
                      <!-- Meta row -->
                      <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
                        <div class="bg-gray-900 rounded-lg px-3 py-2">
                          <p class="text-[10px] text-gray-500 mb-1">Snapshot ID</p>
                          <p class="font-mono text-gray-300 text-[11px]">{snap.snapshot_id.slice(0, 16)}…</p>
                        </div>
                        <div class="bg-gray-900 rounded-lg px-3 py-2">
                          <p class="text-[10px] text-gray-500 mb-1">User &amp; Host</p>
                          <p class="text-gray-300 text-[11px] font-mono truncate">{snap.username ?? '—'}@{snap.hostname ?? '—'}</p>
                        </div>
                        {#if snap.tags?.length}
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Tags</p>
                            <div class="flex flex-wrap gap-1">
                              {#each snap.tags as tag}
                                <span class="text-[10px] bg-blue-900/40 text-blue-300 border border-blue-700/40 rounded px-1.5 py-0.5">{tag}</span>
                              {/each}
                            </div>
                          </div>
                        {/if}
                        {#if snap.paths?.length}
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Pfade</p>
                            <p class="text-gray-300 text-[11px] font-mono truncate" title={snap.paths.join(', ')}>{snap.paths.join(', ')}</p>
                          </div>
                        {/if}
                      </div>

                      {#if statsObj}
                        <!-- Stats grid -->
                        <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Hinzugefügte Dateien</p>
                            <p class="text-white text-sm font-medium">{fmtCount(statsObj.files_new)}</p>
                          </div>
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Hinzugefügte Bytes</p>
                            {#if statsObj.added_size !== null}
                              {@const neg = statsObj.added_size < 0}
                              <p class="text-sm font-medium {neg ? 'text-red-400' : 'text-emerald-400'}">
                                {neg ? '−' : '+'}{formatBytes(Math.abs(statsObj.added_size))}
                              </p>
                            {:else}
                              <p class="text-white text-sm font-medium">?</p>
                            {/if}
                          </div>
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Geänderte Dateien</p>
                            <p class="text-white text-sm font-medium">{fmtCount(statsObj.files_changed)}</p>
                          </div>
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Unverändert</p>
                            <p class="text-white text-sm font-medium">{fmtCount(statsObj.files_unmodified)}</p>
                          </div>
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Gesamt Bytes</p>
                            <p class="text-white text-sm font-medium">{formatBytes(statsObj.restore_size)}</p>
                          </div>
                          <div class="bg-gray-900 rounded-lg px-3 py-2">
                            <p class="text-[10px] text-gray-500 mb-1">Gesamt Dateien</p>
                            <p class="text-white text-sm font-medium">{statsObj.file_count !== null ? statsObj.file_count.toLocaleString() : '?'}</p>
                          </div>
                        </div>
                      {:else}
                        <p class="text-gray-700 text-xs italic">Stats werden beim nächsten Index-Lauf geladen.</p>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ── Details Tab ────────────────────────────────────────────────────── -->
    {#if activeTab === 'details'}
      {#if statsLoading}
        <div class="flex flex-col items-center justify-center py-20 gap-3">
          <div class="w-7 h-7 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          <p class="text-gray-600 text-sm">Restic stats werden geladen…</p>
        </div>
      {:else if repoStats}
        <div class="space-y-3">

          <!-- Row 1: Size cards -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {#each [
              {
                label: 'Restore-Größe',
                value: formatBytes(repoStats.total_restore_size),
                sub: 'Gesamt wiederherstellbar',
                icon: 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4',
                accent: 'text-blue-400', bg: 'bg-blue-500/8',
              },
              {
                label: 'Dedupliziert',
                value: formatBytes(repoStats.deduplicated_size),
                sub: repoStats.total_restore_size > 0
                  ? `${formatBytes(repoStats.total_restore_size - repoStats.deduplicated_size)} Ersparnis (${Math.round((1 - repoStats.deduplicated_size / repoStats.total_restore_size) * 100)}%)`
                  : 'Tatsächlicher Speicher',
                icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
                accent: 'text-emerald-400', bg: 'bg-emerald-500/8',
              },
              {
                label: 'Ø Snapshot-Größe',
                value: repoStats.avg_snapshot_size ? formatBytes(repoStats.avg_snapshot_size) : '—',
                sub: 'Durchschnitt',
                icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
                accent: 'text-purple-400', bg: 'bg-purple-500/8',
              },
              {
                label: 'Eindeutige Dateien',
                value: repoStats.total_file_count !== null ? repoStats.total_file_count.toLocaleString() : '—',
                sub: 'Über alle Snapshots',
                icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
                accent: 'text-amber-400', bg: 'bg-amber-500/8',
              },
            ] as card}
              <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4 flex items-start gap-3">
                <div class="shrink-0 w-9 h-9 rounded-lg {card.bg} flex items-center justify-center mt-0.5">
                  <svg class="w-4 h-4 {card.accent}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d={card.icon}/>
                  </svg>
                </div>
                <div class="min-w-0">
                  <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium">{card.label}</p>
                  <p class="text-white font-semibold text-lg mt-0.5 tabular-nums truncate">{card.value}</p>
                  <p class="text-[11px] text-gray-600 mt-0.5">{card.sub}</p>
                </div>
              </div>
            {/each}
          </div>

          <!-- Size history chart -->
          {#if sizeHistoryLoading}
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4
                        flex items-center justify-center h-48">
              <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            </div>
          {:else}
            <SizeHistoryChart
              data={sizeHistory}
              days={sizeHistoryDays}
              onDaysChange={handleDaysChange}
            />
          {/if}

          <!-- Row 2: Snapshot timeline + interval + blobs -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <!-- Timeline -->
            <div class="sm:col-span-2 bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
              <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-3">Snapshot-Zeitraum</p>
              <div class="flex items-center gap-3">
                <div class="flex-1 bg-gray-800 rounded-lg px-3 py-2.5">
                  <p class="text-[10px] text-gray-600 mb-1">Ältester Snapshot</p>
                  <p class="text-white text-sm font-medium">{formatDateShort(repoStats.oldest_snapshot)}</p>
                </div>
                <div class="flex items-center gap-1 text-gray-700 shrink-0">
                  <div class="w-2 h-px bg-gray-700"></div>
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                  </svg>
                  <div class="w-2 h-px bg-gray-700"></div>
                </div>
                <div class="flex-1 bg-gray-800 rounded-lg px-3 py-2.5">
                  <p class="text-[10px] text-gray-600 mb-1">Neuester Snapshot</p>
                  <p class="text-white text-sm font-medium">{formatDateShort(repoStats.newest_snapshot)}</p>
                </div>
                <div class="shrink-0 bg-blue-500/10 border border-blue-500/20 rounded-lg px-3 py-2.5 text-center">
                  <p class="text-[10px] text-blue-400/70 mb-1">Snapshots</p>
                  <p class="text-blue-300 text-sm font-semibold tabular-nums">{repoStats.snapshot_count}</p>
                </div>
              </div>
            </div>

            <!-- Interval + blobs -->
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4 flex flex-col gap-3">
              <div>
                <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">Ø Backup-Intervall</p>
                <p class="text-white font-semibold text-base">
                  {#if repoStats.avg_interval_seconds}
                    {#if repoStats.avg_interval_seconds < 3600}
                      {Math.round(repoStats.avg_interval_seconds / 60)} Minuten
                    {:else if repoStats.avg_interval_seconds < 86400}
                      {Math.round(repoStats.avg_interval_seconds / 3600)} Stunden
                    {:else}
                      {Math.round(repoStats.avg_interval_seconds / 86400)} Tage
                    {/if}
                  {:else}
                    —
                  {/if}
                </p>
              </div>
              <div class="border-t border-gray-800 pt-3">
                <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">Blobs / Chunks</p>
                <p class="text-white font-semibold text-base">
                  {repoStats.total_blob_count !== null ? repoStats.total_blob_count.toLocaleString() : '—'}
                </p>
              </div>
              {#if repoStats.compression_ratio !== null}
                <div class="border-t border-gray-800 pt-3">
                  <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-1">Kompressionsrate</p>
                  <p class="text-emerald-400 font-semibold text-base">{repoStats.compression_ratio.toFixed(2)}×</p>
                </div>
              {/if}
            </div>
          </div>

          <!-- Row 3: Weekday heatmap -->
          {#if repoStats.backup_by_weekday}
            {@const days = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']}
            {@const maxDay = Math.max(...weekdayValues(repoStats.backup_by_weekday), 1)}
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
              <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-3">Backups nach Wochentag</p>
              <div class="grid grid-cols-7 gap-2">
                {#each days as day, i}
                  {@const count = weekdayCount(repoStats.backup_by_weekday, i)}
                  {@const pct = Math.round((count / maxDay) * 100)}
                  <div class="flex flex-col items-center gap-1.5">
                    <div class="w-full bg-gray-800 rounded-lg overflow-hidden" style="height: 48px;">
                      <div
                              class="w-full bg-blue-500/70 rounded-lg transition-all duration-500"
                              style="height: {pct}%; margin-top: {100 - pct}%;"
                      ></div>
                    </div>
                    <p class="text-[10px] text-gray-500">{day}</p>
                    <p class="text-[10px] text-gray-400 tabular-nums">{count}</p>
                  </div>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Row 4: Hour heatmap -->
          {#if repoStats.backup_by_hour}
            {@const maxHour = Math.max(...hourValues(repoStats.backup_by_hour), 1)}
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
              <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-3">Backups nach Uhrzeit</p>
              <div class="grid grid-cols-24 gap-px" style="grid-template-columns: repeat(24, minmax(0, 1fr));">
                {#each Array.from({length: 24}, (_, i) => i) as hour}
                  {@const count = hourCount(repoStats.backup_by_hour, hour)}
                  {@const pct = Math.round((count / maxHour) * 100)}
                  {@const intensity = pct === 0 ? 'bg-gray-800' : pct < 25 ? 'bg-blue-900/60' : pct < 50 ? 'bg-blue-700/70' : pct < 75 ? 'bg-blue-500/80' : 'bg-blue-400'}
                  <div class="flex flex-col items-center gap-1" title="{hour}:00 — {count} Snapshots">
                    <div class="w-full h-8 rounded-sm {intensity} transition-colors"></div>
                    <p class="text-[9px] text-gray-700 tabular-nums">{String(hour).padStart(2, '0')}</p>
                  </div>
                {/each}
              </div>
              <div class="flex items-center gap-2 mt-2 justify-end">
                <p class="text-[10px] text-gray-600">Wenig</p>
                {#each ['bg-gray-800', 'bg-blue-900/60', 'bg-blue-700/70', 'bg-blue-500/80', 'bg-blue-400'] as cls}
                  <div class="w-3 h-3 rounded-sm {cls}"></div>
                {/each}
                <p class="text-[10px] text-gray-600">Viel</p>
              </div>
            </div>
          {/if}

          <!-- Row 5: Hostnames + Tags -->
          {#if repoStats.hostnames.length > 0 || repoStats.tags.length > 0}
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {#if repoStats.hostnames.length > 0}
                <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
                  <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2.5">Hostnames</p>
                  <div class="flex flex-wrap gap-1.5">
                    {#each repoStats.hostnames as host}
                  <span class="inline-flex items-center gap-1.5 text-[11px] bg-gray-800 text-gray-300 border border-gray-700/60 rounded-lg px-2.5 py-1">
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0"></span>
                    {host}
                  </span>
                    {/each}
                  </div>
                </div>
              {/if}
              {#if repoStats.tags.length > 0}
                <div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
                  <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-2.5">Tags</p>
                  <div class="flex flex-wrap gap-1.5">
                    {#each repoStats.tags as tag}
                      <span class="text-[11px] bg-blue-950/60 text-blue-300 border border-blue-800/50 rounded-lg px-2.5 py-1">{tag}</span>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>
          {/if}

        </div>
      {:else}
        <div class="flex flex-col items-center justify-center py-20 gap-2">
          <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
          </svg>
          <p class="text-gray-600 text-sm">Stats konnten nicht geladen werden.</p>
        </div>
      {/if}
    {/if}

    <!-- ── Configuration Tab ──────────────────────────────────────────────── -->
    {#if activeTab === 'configuration'}
      <div class="space-y-3">

        <!-- General settings -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-4">Allgemein</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="cfg-name" class="block text-xs font-medium text-gray-400 mb-1.5">Display Name</label>
              <input
                      id="cfg-name"
                      type="text"
                      bind:value={configName}
                      class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
            <div>
              <label for="cfg-path" class="block text-xs font-medium text-gray-400 mb-1.5">Pfad / URL</label>
              <input
                      id="cfg-path"
                      type="text"
                      bind:value={configPath}
                      class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   font-mono focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p class="text-[10px] text-gray-600 mt-1">z.B. /srv/repos/mein-repo oder sftp:user@host:/pfad</p>
            </div>
          </div>
        </div>

        <!-- Security -->
        <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-4">Sicherheit</p>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label for="cfg-password" class="block text-xs font-medium text-gray-400 mb-1.5">Repo-Passwort</label>
              <input
                      id="cfg-password"
                      type="password"
                      bind:value={configPassword}
                      placeholder="Leer lassen um beizubehalten"
                      class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                   placeholder:text-gray-600 focus:outline-none focus:border-blue-500 transition-colors"
              />
              <p class="text-[10px] text-gray-600 mt-1">Nur ausfüllen wenn das Passwort geändert werden soll</p>
            </div>
          </div>
        </div>

        <!-- Danger zone -->
        <div class="bg-gray-900 border border-red-900/30 rounded-xl p-5">
          <p class="text-[10px] text-red-500/70 uppercase tracking-wider font-medium mb-4">Gefahrenzone</p>
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm text-white font-medium">Repository entfernen</p>
              <p class="text-xs text-gray-500 mt-0.5">Entfernt das Repo aus ResticVault. Die Backup-Daten selbst bleiben erhalten.</p>
            </div>
            <button
                    onclick={() => showDeleteRepoModal = true}
                    class="shrink-0 px-4 py-2 text-sm font-medium text-red-400 hover:text-white
                 border border-red-900/50 hover:bg-red-600 rounded-lg transition-all duration-150"
            >
              Entfernen
            </button>
          </div>
        </div>

        <!-- Save -->
        <div class="flex justify-end">
          <button
                  onclick={saveConfig}
                  disabled={configSaving}
                  class="flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-blue-600
               hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
          >
            {#if configSaving}
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
    {/if}
  </div>
{:else}
  <div class="text-center py-20 text-gray-500">Repository not found.</div>
{/if}

<!-- Snapshot Browser Drawer -->
<SnapshotBrowser
  open={browserOpen}
  {repoId}
  snapshotId={browserSnapshot?.snapshot_id ?? ''}
  snapshotShortId={browserSnapshot?.short_id ?? ''}
  onclose={() => { browserOpen = false; browserSnapshot = null; }}
/>

<!-- Delete Confirmation Modal -->
<Modal open={showDeleteModal} title="Delete Snapshots" onclose={() => showDeleteModal = false}>
  {#snippet children()}
    <p class="text-gray-300 text-sm">
      Are you sure you want to delete <strong class="text-white">{selected.size} snapshot{selected.size > 1 ? 's' : ''}</strong>?
    </p>
    <p class="text-gray-500 text-xs mt-2">
      This will run <code class="text-gray-400">restic forget --prune</code> and permanently remove the data.
      This action cannot be undone.
    </p>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => showDeleteModal = false}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700
             rounded-lg transition-colors border border-gray-700"
    >
      Cancel
    </button>
    <button
      onclick={deleteSelected}
      disabled={deleting}
      class="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-500
             disabled:opacity-50 rounded-lg transition-colors"
    >
      {deleting ? 'Deleting…' : 'Delete'}
    </button>
  {/snippet}
</Modal>

<Modal open={showDeleteRepoModal} title="Repository entfernen" onclose={() => showDeleteRepoModal = false}>
  {#snippet children()}
    <div class="space-y-3">
      <div class="flex items-start gap-3 bg-red-950/30 border border-red-900/30 rounded-lg px-3 py-3">
        <svg class="w-4 h-4 text-red-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
        </svg>
        <p class="text-sm text-red-300">
          <strong class="font-medium">{repo?.name}</strong> wird aus ResticVault entfernt.
          Die Backup-Daten selbst bleiben erhalten.
        </p>
      </div>
      <p class="text-xs text-gray-500">Diese Aktion kann nicht rückgängig gemacht werden.</p>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
            onclick={() => showDeleteRepoModal = false}
            class="px-4 py-2 text-sm text-gray-400 hover:text-white bg-transparent hover:bg-gray-800
             rounded-lg transition-colors border border-gray-700"
    >
      Abbrechen
    </button>
    <button
            onclick={deleteRepo}
            disabled={deletingRepo}
            class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600
             hover:bg-red-500 disabled:opacity-50 rounded-lg transition-colors"
    >
      {#if deletingRepo}
        <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
        Entfernen…
      {:else}
        Entfernen
      {/if}
    </button>
  {/snippet}
</Modal>
