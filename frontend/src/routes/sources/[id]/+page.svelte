<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    backupSources, exclusionProfiles, auth,
    type BackupSource, type BackupSourceLog, type AgentCommand,
    type SourceExclusionRule, type AgentDiscoveredPath, type ExclusionProfile,
    type BackupProgress,
  } from '$lib/api';
  import { toast } from '$lib/toast';

  let role = $state<'admin' | 'viewer' | ''>('');

  type Tab = 'overview' | 'install' | 'config' | 'logs' | 'paths' | 'commands';

  const sourceId = parseInt($page.params.id ?? '0', 10);

  let source      = $state<BackupSource | null>(null);
  let logs        = $state<BackupSourceLog[]>([]);
  let commands    = $state<AgentCommand[]>([]);
  let paths       = $state<AgentDiscoveredPath[]>([]);
  let rule        = $state<SourceExclusionRule | null>(null);
  let profiles    = $state<ExclusionProfile[]>([]);
  let loading     = $state(true);
  let activeTab   = $state<Tab>('overview');
  let newToken    = $state<string | null>(null);
  let copied      = $state(false);

  // Config tab form state
  let cfgProfileId     = $state<number | ''>('');
  let cfgCustomPats    = $state('');
  let cfgBackupPaths   = $state('');
  let cfgSchedule      = $state('0 2 * * *');
  let cfgKeepLast      = $state<string>('');
  let cfgKeepDaily     = $state<string>('7');
  let cfgKeepWeekly    = $state<string>('4');
  let cfgKeepMonthly   = $state<string>('6');
  let cfgKeepYearly    = $state<string>('1');
  let cfgSaving        = $state(false);

  // Backup progress
  let progress      = $state<BackupProgress | null>(null);
  let progressTimer = $state<ReturnType<typeof setInterval> | null>(null);

  // Remote actions
  let sendingCmd = $state<string | null>(null);

  // Agent version tracking
  let serverAgentVersion = $state<string | null>(null);

  // Rotate token
  let rotating   = $state(false);

  async function load() {
    loading = true;
    try {
      const [src, lg, cmds, ps, rl, profs] = await Promise.all([
        backupSources.get(sourceId),
        backupSources.getLogs(sourceId),
        backupSources.getCommands(sourceId),
        backupSources.getPaths(sourceId),
        backupSources.getExclusionRule(sourceId),
        exclusionProfiles.list(),
      ]);
      source   = src;
      logs     = lg;
      commands = cmds;
      paths    = ps;
      rule     = rl;
      profiles = profs;

      // Populate config form
      cfgProfileId   = rl?.profile_id ?? '';
      cfgCustomPats  = rl?.custom_patterns ? JSON.parse(rl.custom_patterns).join('\n') : '';
      cfgBackupPaths = rl?.backup_paths    ? JSON.parse(rl.backup_paths).join('\n')    : '';
      cfgSchedule    = src.schedule ?? '0 2 * * *';
      cfgKeepLast    = src.keep_last    != null ? String(src.keep_last)    : '';
      cfgKeepDaily   = src.keep_daily   != null ? String(src.keep_daily)   : '';
      cfgKeepWeekly  = src.keep_weekly  != null ? String(src.keep_weekly)  : '';
      cfgKeepMonthly = src.keep_monthly != null ? String(src.keep_monthly) : '';
      cfgKeepYearly  = src.keep_yearly  != null ? String(src.keep_yearly)  : '';
    } catch (e) {
      toast.error((e as Error).message);
      goto('/sources');
    } finally {
      loading = false;
    }
  }

  async function pollProgress() {
    try {
      const p = await backupSources.getProgress(sourceId);
      const wasActive = progress?.active;
      progress = p.active ? p : null;
      // Backup just finished — refresh all data
      if (wasActive && !p.active) await load();
    } catch { /* best-effort */ }
  }

  onMount(() => {
    load();
    auth.me().then(me => role = me.role).catch(() => {});
    backupSources.getCurrentAgentVersion().then(v => serverAgentVersion = v).catch(() => {});
    pollProgress();
    progressTimer = setInterval(pollProgress, 3000);
    const dataTimer = setInterval(() => {
      // Silent data refresh — don't show loading spinner if already loaded
      if (source) {
        Promise.all([
          backupSources.get(sourceId),
          backupSources.getLogs(sourceId),
          backupSources.getCommands(sourceId),
          backupSources.getPaths(sourceId),
        ]).then(([src, lg, cmds, ps]) => {
          source = src; logs = lg; commands = cmds; paths = ps;
        }).catch(() => {});
      }
    }, 30_000);
    return () => {
      if (progressTimer) clearInterval(progressTimer);
      clearInterval(dataTimer);
    };
  });

  function parseKeep(v: string | number): number | null {
    if (v === '' || v === null || v === undefined) return null;
    const n = typeof v === 'number' ? v : parseInt(String(v).trim(), 10);
    return isNaN(n) ? null : n;
  }

  async function saveConfig() {
    cfgSaving = true;
    try {
      await Promise.all([
        backupSources.setExclusionRule(sourceId, {
          profileId:      cfgProfileId !== '' ? Number(cfgProfileId) : null,
          customPatterns: cfgCustomPats.split('\n').map(s => s.trim()).filter(Boolean),
          backupPaths:    cfgBackupPaths.split('\n').map(s => s.trim()).filter(Boolean),
        }),
        backupSources.update(sourceId, {
          schedule:    cfgSchedule,
          keepLast:    parseKeep(cfgKeepLast),
          keepDaily:   parseKeep(cfgKeepDaily),
          keepWeekly:  parseKeep(cfgKeepWeekly),
          keepMonthly: parseKeep(cfgKeepMonthly),
          keepYearly:  parseKeep(cfgKeepYearly),
        }),
      ]);
      toast.success('Configuration saved');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      cfgSaving = false;
    }
  }

  async function sendCommand(cmd: string) {
    sendingCmd = cmd;
    try {
      await backupSources.sendCommand(sourceId, cmd);
      toast.success(`Command "${cmd}" sent to agent`);
      if (cmd === 'backup') pollProgress();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      sendingCmd = null;
    }
  }

  async function rotateToken() {
    if (!confirm('Rotate the agent token? The current token will stop working immediately.')) return;
    rotating = true;
    try {
      const result = await backupSources.rotateToken(sourceId);
      newToken = result.token;
      toast.success('Token rotated. Copy the new token.');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      rotating = false;
    }
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    copied = true;
    setTimeout(() => copied = false, 2000);
  }

  function timeSince(ts: number | null): string {
    if (!ts) return 'never';
    const diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60)    return 'just now';
    if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function formatDate(ts: number | null): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  }

  function isOnline(ts: number | null): boolean {
    if (!ts) return false;
    return (Math.floor(Date.now() / 1000) - ts) < 120;
  }

  function formatBytes(b: number | null): string {
    if (b === null || b === undefined) return '—';
    if (b < 1024)       return `${b} B`;
    if (b < 1048576)    return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1073741824) return `${(b / 1048576).toFixed(1)} MB`;
    return `${(b / 1073741824).toFixed(2)} GB`;
  }

  // Install command generation
  function installCommand(srv: string, tok: string, name: string): string {
    return `curl -fsSL ${srv}/agent-install.sh | sudo bash -s -- \\\n  --server ${srv} \\\n  --token  ${tok} \\\n  --name   ${name}`;
  }

  const allTabs: { id: Tab; label: string; adminOnly?: boolean }[] = [
    { id: 'overview', label: 'Overview'      },
    { id: 'install',  label: 'Install',       adminOnly: true },
    { id: 'config',   label: 'Configuration', adminOnly: true },
    { id: 'logs',     label: 'Logs'          },
    { id: 'paths',    label: 'Paths'         },
    { id: 'commands', label: 'Remote Actions'},
  ];
  let tabs = $derived(role === 'admin' ? allTabs : allTabs.filter(t => !t.adminOnly));
</script>

{#if loading}
  <div class="flex justify-center py-16">
    <div class="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
  </div>
{:else if source}
  <div class="max-w-5xl mx-auto space-y-6">

    <!-- Breadcrumb + header -->
    <div class="flex items-start justify-between gap-4 flex-wrap">
      <div>
        <div class="flex items-center gap-2 text-sm text-gray-500 mb-2">
          <a href="/sources" class="hover:text-gray-300 transition-colors">Backup Sources</a>
          <span>/</span>
          <span class="text-gray-300">{source.name}</span>
        </div>
        <div class="flex items-center gap-3">
          <h1 class="text-2xl font-bold text-white">{source.name}</h1>
          {#if isOnline(source.last_seen_at)}
            <span class="flex items-center gap-1.5 text-sm text-emerald-400 bg-emerald-500/10
                         border border-emerald-500/20 px-2.5 py-1 rounded-full">
              <span class="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
              Online
            </span>
          {:else}
            <span class="text-sm text-gray-600 bg-gray-800/50 border border-gray-700/50
                         px-2.5 py-1 rounded-full">Offline</span>
          {/if}
          {#if source.disabled}
            <span class="text-sm text-red-400 bg-red-500/10 border border-red-500/20 px-2.5 py-1 rounded-full">
              Disabled
            </span>
          {/if}
          {#if serverAgentVersion && source.agent_version && source.agent_version !== serverAgentVersion}
            <span class="flex items-center gap-1.5 text-sm text-amber-400 bg-amber-500/10
                         border border-amber-500/20 px-2.5 py-1 rounded-full">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                      d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
              </svg>
              Update available ({source.agent_version} → {serverAgentVersion})
            </span>
          {/if}
        </div>
        {#if source.description}
          <p class="text-sm text-gray-400 mt-1">{source.description}</p>
        {/if}
      </div>

      <a href="/sources" class="text-sm text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
        </svg>
        Back
      </a>
    </div>

    <!-- Stats strip -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="bg-gray-900/60 border border-gray-800/60 rounded-xl p-4">
        <p class="text-xs text-gray-500 mb-1">Last seen</p>
        <p class="text-sm text-white font-medium">{timeSince(source.last_seen_at)}</p>
      </div>
      <div class="bg-gray-900/60 border border-gray-800/60 rounded-xl p-4">
        <p class="text-xs text-gray-500 mb-1">Last backup</p>
        <p class="text-sm text-white font-medium">{timeSince(source.last_backup_at)}</p>
      </div>
      <div class="bg-gray-900/60 border border-gray-800/60 rounded-xl p-4">
        <p class="text-xs text-gray-500 mb-1">Agent version</p>
        <p class="text-sm text-white font-medium">{source.agent_version ?? '—'}</p>
      </div>
      <div class="bg-gray-900/60 border border-gray-800/60 rounded-xl p-4">
        <p class="text-xs text-gray-500 mb-1">Created</p>
        <p class="text-sm text-white font-medium">{formatDate(source.created_at)}</p>
      </div>
    </div>

    <!-- Backup progress -->
    {#if progress}
      <div class="bg-gray-900/60 border border-emerald-500/20 rounded-2xl p-5 space-y-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse"></span>
            <span class="text-sm font-medium text-emerald-400">Backup in progress</span>
          </div>
          <span class="text-sm text-white font-mono">
            {progress.totalFiles
              ? `${Math.round((progress.percentDone ?? 0) * 100)}%`
              : 'Scanning…'}
          </span>
        </div>

        <div class="w-full h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            class="h-full bg-emerald-500 rounded-full transition-all duration-500"
            style="width: {(progress.percentDone ?? 0) * 100}%"
          ></div>
        </div>

        <div class="flex gap-6 text-xs text-gray-400">
          {#if progress.totalFiles}
            <span>{(progress.filesDone ?? 0).toLocaleString()} / {(progress.totalFiles ?? 0).toLocaleString()} files</span>
          {/if}
          {#if progress.totalBytes}
            <span>{formatBytes(progress.bytesDone ?? 0)} / {formatBytes(progress.totalBytes ?? 0)}</span>
          {/if}
          {#if progress.currentFile}
            <span class="truncate text-gray-600" title={progress.currentFile}>{progress.currentFile}</span>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Tabs -->
    <div class="border-b border-gray-800/60">
      <nav class="flex gap-1 overflow-x-auto">
        {#each tabs as tab}
          <button
            onclick={() => activeTab = tab.id}
            class="px-4 py-2.5 text-sm font-medium transition-colors whitespace-nowrap border-b-2
                   {activeTab === tab.id
                     ? 'border-emerald-500 text-emerald-400'
                     : 'border-transparent text-gray-500 hover:text-gray-300'}"
          >
            {tab.label}
            {#if tab.id === 'logs' && logs.some(l => l.level === 'error')}
              <span class="ml-1.5 text-xs bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded-md">
                {logs.filter(l => l.level === 'error').length}
              </span>
            {/if}
          </button>
        {/each}
      </nav>
    </div>

    <!-- Tab content -->
    <div>

      <!-- ── Overview ──────────────────────────────────────────────────────── -->
      {#if activeTab === 'overview'}
        <div class="space-y-4">
          <!-- Token management (admin only) -->
          {#if role === 'admin'}
          <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-4">
            <h3 class="text-sm font-semibold text-white">Token Management</h3>
            {#if newToken}
              <div class="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 space-y-3">
                <p class="text-sm text-emerald-400 font-medium">
                  New token generated — copy it now, it won't be shown again.
                </p>
                <div class="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-200 break-all border border-gray-700/50">
                  {newToken}
                </div>
                <button
                  onclick={() => newToken && copyText(newToken)}
                  class="flex items-center gap-2 text-sm py-2 px-4 rounded-lg
                         {copied ? 'bg-emerald-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'} transition-colors"
                >
                  {copied ? '✓ Copied!' : 'Copy Token'}
                </button>
              </div>
            {:else}
              <p class="text-sm text-gray-400">
                Rotating the token immediately invalidates the old one. The agent will fail to
                authenticate until updated with the new token.
              </p>
              <button
                onclick={rotateToken}
                disabled={rotating}
                class="flex items-center gap-2 text-sm py-2 px-4 bg-yellow-500/15 border border-yellow-500/30
                       text-yellow-300 hover:bg-yellow-500/25 rounded-xl transition-colors disabled:opacity-60"
              >
                {#if rotating}
                  <span class="w-3.5 h-3.5 border-2 border-yellow-300 border-t-transparent rounded-full animate-spin"></span>
                {/if}
                Rotate Token
              </button>
            {/if}
          </div>
          {/if}

          <!-- Recent log entries -->
          {#if logs.length > 0}
            <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-3">
              <h3 class="text-sm font-semibold text-white">Recent Activity</h3>
              <div class="space-y-2">
                {#each logs.slice(0, 5) as entry}
                  <div class="flex items-start gap-3 text-xs">
                    <span class="shrink-0 w-1.5 h-1.5 rounded-full mt-1.5
                                 {entry.level === 'error' ? 'bg-red-400' : entry.level === 'warning' ? 'bg-yellow-400' : 'bg-emerald-400'}">
                    </span>
                    <span class="text-gray-300 flex-1">{entry.message}</span>
                    <span class="text-gray-600 shrink-0">{timeSince(entry.created_at)}</span>
                  </div>
                {/each}
              </div>
              {#if logs.length > 5}
                <button onclick={() => activeTab = 'logs'} class="text-xs text-emerald-400 hover:text-emerald-300 transition-colors">
                  View all {logs.length} entries →
                </button>
              {/if}
            </div>
          {/if}
        </div>

      <!-- ── Install ───────────────────────────────────────────────────────── -->
      {:else if activeTab === 'install'}
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-5">
          <div>
            <h3 class="text-sm font-semibold text-white mb-1">One-line installer</h3>
            <p class="text-xs text-gray-500 mb-3">
              Run this command as root on the remote server. It installs restic, the agent daemon,
              and sets up a systemd service and backup timer.
            </p>
            <div class="bg-gray-950 rounded-xl p-4 font-mono text-xs text-gray-200 border border-gray-700/50 relative">
              <pre class="whitespace-pre-wrap break-all">{installCommand(
                typeof window !== 'undefined' ? window.location.origin : 'https://your-host',
                '<your-token>',
                source.name
              )}</pre>
            </div>
            <p class="text-xs text-yellow-400 mt-2">
              Replace <code class="text-yellow-300">&lt;your-token&gt;</code> with the token
              shown when this source was created (or rotate to get a new one).
            </p>
          </div>

          <div class="border-t border-gray-800/60 pt-5">
            <h3 class="text-sm font-semibold text-white mb-3">Manual setup</h3>
            <ol class="space-y-2 text-sm text-gray-400 list-decimal list-inside">
              <li>Install <a href="https://restic.net" target="_blank" rel="noopener" class="text-emerald-400 hover:underline">restic</a> on the remote server.</li>
              <li>Download and configure the agent:
                <div class="mt-2 bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-300 border border-gray-700/50">
                  curl -fsSL {typeof window !== 'undefined' ? window.location.origin : 'https://your-host'}/agent-install.sh -o install.sh<br/>
                  chmod +x install.sh<br/>
                  sudo ./install.sh --server {typeof window !== 'undefined' ? window.location.origin : 'https://your-host'} --token &lt;token&gt; --name {source.name}
                </div>
              </li>
              <li>Verify with: <code class="text-gray-300">systemctl status resticvault-agent</code></li>
            </ol>
          </div>

          <div class="border-t border-gray-800/60 pt-5">
            <h3 class="text-sm font-semibold text-white mb-2">Restic repository URL</h3>
            <div class="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-200 border border-gray-700/50">
              rest:{typeof window !== 'undefined' ? window.location.origin : 'https://your-host'}/restic/{source.name}/
            </div>
          </div>
        </div>

      <!-- ── Configuration ─────────────────────────────────────────────────── -->
      {:else if activeTab === 'config'}
        <!-- Backup Schedule -->
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-4 mb-5">
          <h3 class="text-sm font-semibold text-white">Backup Schedule</h3>
          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="cfg-schedule">
              Cron Expression
            </label>
            <p class="text-xs text-gray-600">Standard 5-field cron (minute hour day month weekday). Default: <code class="text-gray-500">0 2 * * *</code> = daily at 02:00.</p>
            <input
              id="cfg-schedule"
              type="text"
              bind:value={cfgSchedule}
              placeholder="0 2 * * *"
              class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                     text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                     focus:border-emerald-500/60"
            />
          </div>
        </div>

        <!-- Retention Policy -->
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-4 mb-5">
          <h3 class="text-sm font-semibold text-white">Retention Policy</h3>
          <p class="text-xs text-gray-600">
            Configure how many snapshots to keep. Leave empty to disable a rule. After each backup the agent runs <code class="text-gray-500">restic forget --prune</code> with these values.
          </p>
          <div class="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <div class="space-y-1">
              <label class="block text-xs font-medium text-gray-400" for="cfg-keep-last">Keep last</label>
              <input id="cfg-keep-last" type="number" min="0" max="9999" bind:value={cfgKeepLast} placeholder="—"
                class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                       text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                       focus:border-emerald-500/60" />
            </div>
            <div class="space-y-1">
              <label class="block text-xs font-medium text-gray-400" for="cfg-keep-daily">Daily</label>
              <input id="cfg-keep-daily" type="number" min="0" max="9999" bind:value={cfgKeepDaily} placeholder="—"
                class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                       text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                       focus:border-emerald-500/60" />
            </div>
            <div class="space-y-1">
              <label class="block text-xs font-medium text-gray-400" for="cfg-keep-weekly">Weekly</label>
              <input id="cfg-keep-weekly" type="number" min="0" max="9999" bind:value={cfgKeepWeekly} placeholder="—"
                class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                       text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                       focus:border-emerald-500/60" />
            </div>
            <div class="space-y-1">
              <label class="block text-xs font-medium text-gray-400" for="cfg-keep-monthly">Monthly</label>
              <input id="cfg-keep-monthly" type="number" min="0" max="9999" bind:value={cfgKeepMonthly} placeholder="—"
                class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                       text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                       focus:border-emerald-500/60" />
            </div>
            <div class="space-y-1">
              <label class="block text-xs font-medium text-gray-400" for="cfg-keep-yearly">Yearly</label>
              <input id="cfg-keep-yearly" type="number" min="0" max="9999" bind:value={cfgKeepYearly} placeholder="—"
                class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                       text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                       focus:border-emerald-500/60" />
            </div>
          </div>
        </div>

        <!-- Exclusion Rules -->
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-5">
          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="cfg-paths">
              Backup Paths
            </label>
            <p class="text-xs text-gray-600">One path per line. If empty, the agent uses the paths configured during install.</p>
            <textarea
              id="cfg-paths"
              bind:value={cfgBackupPaths}
              rows="4"
              placeholder="/home&#10;/etc&#10;/var/www"
              class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                     text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                     focus:border-emerald-500/60 resize-y"
            ></textarea>
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="cfg-profile">
              Exclusion Profile
            </label>
            <select
              id="cfg-profile"
              bind:value={cfgProfileId}
              class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                     text-sm text-white focus:outline-none focus:border-emerald-500/60"
            >
              <option value="">None</option>
              {#each profiles as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
          </div>

          <div class="space-y-1">
            <label class="block text-xs font-medium text-gray-400" for="cfg-custom">
              Custom Exclusion Patterns
            </label>
            <p class="text-xs text-gray-600">One glob pattern per line. Applied in addition to the profile.</p>
            <textarea
              id="cfg-custom"
              bind:value={cfgCustomPats}
              rows="4"
              placeholder="*.log&#10;/tmp/**&#10;node_modules/"
              class="w-full bg-gray-800/60 border border-gray-700/60 rounded-xl px-3 py-2.5
                     text-sm text-white placeholder-gray-600 font-mono focus:outline-none
                     focus:border-emerald-500/60 resize-y"
            ></textarea>
          </div>

          <button
            onclick={saveConfig}
            disabled={cfgSaving}
            class="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium
                   rounded-xl transition-colors disabled:opacity-60 flex items-center gap-2"
          >
            {#if cfgSaving}
              <span class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
            {/if}
            Save Configuration
          </button>
        </div>

      <!-- ── Logs ──────────────────────────────────────────────────────────── -->
      {:else if activeTab === 'logs'}
        <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl overflow-hidden">
          {#if logs.length === 0}
            <div class="p-8 text-center text-gray-500 text-sm">No log entries yet.</div>
          {:else}
            <div class="overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-gray-800/60">
                    <th class="text-left text-xs font-medium text-gray-500 px-4 py-3 w-24">Level</th>
                    <th class="text-left text-xs font-medium text-gray-500 px-4 py-3">Message</th>
                    <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-36">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {#each logs as entry}
                    <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
                      <td class="px-4 py-3">
                        <span class="text-xs px-2 py-0.5 rounded-md font-medium
                                     {entry.level === 'error' ? 'bg-red-500/15 text-red-400' :
                                      entry.level === 'warning' ? 'bg-yellow-500/15 text-yellow-400' :
                                      'bg-emerald-500/15 text-emerald-400'}">
                          {entry.level}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-gray-300 font-mono text-xs">{entry.message}</td>
                      <td class="px-4 py-3 text-right text-gray-600 text-xs">{formatDate(entry.created_at)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>

      <!-- ── Paths ─────────────────────────────────────────────────────────── -->
      {:else if activeTab === 'paths'}
        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <p class="text-sm text-gray-400">
              Filesystem paths discovered by the agent on the remote server.
            </p>
            {#if role === 'admin'}
              <button
                onclick={() => sendCommand('discover')}
                disabled={!!sendingCmd}
                class="flex items-center gap-2 text-sm px-4 py-2 bg-gray-800 hover:bg-gray-700
                       text-gray-300 rounded-xl transition-colors disabled:opacity-60"
              >
                {#if sendingCmd === 'discover'}
                  <span class="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin"></span>
                {:else}
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                  </svg>
                {/if}
                Trigger Discovery
              </button>
            {/if}
          </div>

          <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl overflow-hidden">
            {#if paths.length === 0}
              <div class="p-8 text-center text-gray-500 text-sm">
                No paths discovered yet. Click "Trigger Discovery" to request the agent scan the filesystem.
              </div>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-800/60">
                      <th class="text-left text-xs font-medium text-gray-500 px-4 py-3">Path</th>
                      <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-28">Size</th>
                      <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-24">Files</th>
                      <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-32">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each paths as p (p.id)}
                      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
                        <td class="px-4 py-3 font-mono text-xs text-gray-300">{p.path}</td>
                        <td class="px-4 py-3 text-right text-gray-500 text-xs">{formatBytes(p.size_bytes)}</td>
                        <td class="px-4 py-3 text-right text-gray-500 text-xs">{p.file_count?.toLocaleString() ?? '—'}</td>
                        <td class="px-4 py-3 text-right text-gray-600 text-xs">{timeSince(p.last_seen_at)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        </div>

      <!-- ── Remote Actions ────────────────────────────────────────────────── -->
      {:else if activeTab === 'commands'}
        <div class="space-y-5">

          <!-- Action buttons (admin only) -->
          {#if role === 'admin'}
          <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl p-6 space-y-4">
            <h3 class="text-sm font-semibold text-white">Send Command to Agent</h3>
            <div class="grid sm:grid-cols-2 gap-3">

              <button
                onclick={() => sendCommand('backup')}
                disabled={!!sendingCmd || source.disabled === 1}
                class="flex items-center gap-3 p-4 bg-emerald-500/10 border border-emerald-500/20
                       hover:bg-emerald-500/15 text-emerald-300 rounded-xl transition-colors
                       disabled:opacity-50 text-left"
              >
                {#if sendingCmd === 'backup'}
                  <span class="w-5 h-5 border-2 border-emerald-300 border-t-transparent rounded-full animate-spin shrink-0"></span>
                {:else}
                  <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                          d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
                  </svg>
                {/if}
                <div>
                  <p class="font-medium text-sm">Run Backup</p>
                  <p class="text-xs text-emerald-400/60 mt-0.5">Trigger a backup immediately</p>
                </div>
              </button>

              <button
                onclick={() => sendCommand('discover')}
                disabled={!!sendingCmd || source.disabled === 1}
                class="flex items-center gap-3 p-4 bg-blue-500/10 border border-blue-500/20
                       hover:bg-blue-500/15 text-blue-300 rounded-xl transition-colors
                       disabled:opacity-50 text-left"
              >
                {#if sendingCmd === 'discover'}
                  <span class="w-5 h-5 border-2 border-blue-300 border-t-transparent rounded-full animate-spin shrink-0"></span>
                {:else}
                  <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
                  </svg>
                {/if}
                <div>
                  <p class="font-medium text-sm">Discover Paths</p>
                  <p class="text-xs text-blue-400/60 mt-0.5">Scan remote filesystem</p>
                </div>
              </button>

              {#if serverAgentVersion && source.agent_version && source.agent_version !== serverAgentVersion}
              <button
                onclick={() => sendCommand('update')}
                disabled={!!sendingCmd || source.disabled === 1}
                class="flex items-center gap-3 p-4 bg-amber-500/10 border border-amber-500/20
                       hover:bg-amber-500/15 text-amber-300 rounded-xl transition-colors
                       disabled:opacity-50 text-left"
              >
                {#if sendingCmd === 'update'}
                  <span class="w-5 h-5 border-2 border-amber-300 border-t-transparent rounded-full animate-spin shrink-0"></span>
                {:else}
                  <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
                  </svg>
                {/if}
                <div>
                  <p class="font-medium text-sm">Update Agent</p>
                  <p class="text-xs text-amber-400/60 mt-0.5">{source.agent_version} → {serverAgentVersion}</p>
                </div>
              </button>
              {/if}

              <button
                onclick={() => sendCommand('uninstall')}
                disabled={!!sendingCmd || source.disabled === 1}
                class="flex items-center gap-3 p-4 bg-red-500/10 border border-red-500/20
                       hover:bg-red-500/15 text-red-300 rounded-xl transition-colors
                       disabled:opacity-50 text-left sm:col-span-2"
              >
                {#if sendingCmd === 'uninstall'}
                  <span class="w-5 h-5 border-2 border-red-300 border-t-transparent rounded-full animate-spin shrink-0"></span>
                {:else}
                  <svg class="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
                  </svg>
                {/if}
                <div>
                  <p class="font-medium text-sm">Uninstall Agent</p>
                  <p class="text-xs text-red-400/60 mt-0.5">Remove the agent from the remote server. The source record stays in ResticVault.</p>
                </div>
              </button>
            </div>
          </div>
          {/if}

          <!-- Command history -->
          <div class="bg-gray-900/60 border border-gray-800/60 rounded-2xl overflow-hidden">
            <div class="px-4 py-3 border-b border-gray-800/60">
              <h3 class="text-sm font-semibold text-white">Command History</h3>
            </div>
            {#if commands.length === 0}
              <div class="p-8 text-center text-gray-500 text-sm">No commands sent yet.</div>
            {:else}
              <div class="overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-800/60">
                      <th class="text-left text-xs font-medium text-gray-500 px-4 py-3">Command</th>
                      <th class="text-left text-xs font-medium text-gray-500 px-4 py-3 w-24">Status</th>
                      <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-36">Sent</th>
                      <th class="text-right text-xs font-medium text-gray-500 px-4 py-3 w-36">Acked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each commands as cmd}
                      <tr class="border-b border-gray-800/40 hover:bg-gray-800/20 transition-colors">
                        <td class="px-4 py-3 text-gray-300 font-mono text-xs">{cmd.command}</td>
                        <td class="px-4 py-3">
                          <span class="text-xs px-2 py-0.5 rounded-md font-medium
                                       {cmd.status === 'done' ? 'bg-emerald-500/15 text-emerald-400' :
                                        cmd.status === 'acked' ? 'bg-blue-500/15 text-blue-400' :
                                        'bg-yellow-500/15 text-yellow-400'}">
                            {cmd.status}
                          </span>
                        </td>
                        <td class="px-4 py-3 text-right text-gray-600 text-xs">{formatDate(cmd.created_at)}</td>
                        <td class="px-4 py-3 text-right text-gray-600 text-xs">{formatDate(cmd.acked_at)}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
          </div>
        </div>
      {/if}

    </div>
  </div>
{/if}
