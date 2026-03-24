<script lang="ts">
  import { files as filesApi, type FileNode } from '$lib/api';
  import { toast } from '$lib/toast';

  interface Props {
    open: boolean;
    repoId: number;
    snapshotId: string;
    snapshotShortId: string;
    onclose: () => void;
  }

  let { open, repoId, snapshotId, snapshotShortId, onclose }: Props = $props();

  let nodes = $state<FileNode[]>([]);
  let breadcrumb = $state<string[]>([]);
  let loading = $state(false);
  let error = $state('');
  let pathInput = $state('/');
  let editingPath = $state(false);
  let pathInputEl: HTMLInputElement;

  let currentPath = $derived(breadcrumb.length === 0 ? '/' : '/' + breadcrumb.join('/'));

  $effect(() => {
    if (open && snapshotId) {
      breadcrumb = [];
      pathInput = '/';
      loadDir('/');
    }
  });

  $effect(() => {
    pathInput = currentPath;
  });

  async function loadDir(path: string) {
    loading = true;
    error = '';
    try {
      const res = await filesApi.ls(repoId, snapshotId, path);
      nodes = res.nodes.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load directory';
      toast.error(error);
    } finally {
      loading = false;
    }
  }

  function navigateTo(index: number) {
    breadcrumb = breadcrumb.slice(0, index);
    loadDir(index === 0 ? '/' : '/' + breadcrumb.join('/'));
  }

  function enterDir(node: FileNode) {
    const parts = node.path.replace(/^\//, '').split('/').filter(Boolean);
    breadcrumb = parts;
    loadDir(node.path);
  }

  function handlePathSubmit(e: Event) {
    e.preventDefault();
    editingPath = false;
    const path = pathInput.startsWith('/') ? pathInput : '/' + pathInput;
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    breadcrumb = parts;
    loadDir(path || '/');
  }

  function startEditPath() {
    editingPath = true;
    setTimeout(() => {
      pathInputEl?.select();
    }, 10);
  }

  function downloadFile(node: FileNode) {
    window.location.href = filesApi.downloadUrl(repoId, snapshotId, node.path);
  }

  function downloadDir(node: FileNode) {
    window.location.href = filesApi.downloadDirUrl(repoId, snapshotId, node.path);
  }

  function formatSize(bytes?: number) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function formatMtime(mtime?: string) {
    if (!mtime) return '';
    return new Date(mtime).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }

  function getFileIcon(node: FileNode) {
    if (node.type === 'dir') return 'dir';
    if (node.type === 'symlink') return 'symlink';
    const ext = node.name.split('.').pop()?.toLowerCase();
    if (['jpg','jpeg','png','gif','svg','webp'].includes(ext ?? '')) return 'image';
    if (['mp4','mkv','avi','mov'].includes(ext ?? '')) return 'video';
    if (['mp3','flac','wav','ogg'].includes(ext ?? '')) return 'audio';
    if (['zip','tar','gz','bz2','xz','7z'].includes(ext ?? '')) return 'archive';
    if (['js','ts','py','go','rs','sh','json','yaml','yml','toml','conf'].includes(ext ?? '')) return 'code';
    if (['pdf'].includes(ext ?? '')) return 'pdf';
    return 'file';
  }
</script>

{#if open}
  <!-- Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" onclick={onclose}></div>

  <!-- Centered modal -->
  <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="w-full max-w-2xl max-h-[80vh] flex flex-col bg-gray-900 border border-gray-700/60 rounded-2xl shadow-2xl overflow-hidden">

      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-gray-800 shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-lg bg-blue-600/20 flex items-center justify-center shrink-0">
            <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
          </div>
          <div>
            <h2 class="text-sm font-semibold text-white">Snapshot Browser</h2>
            <p class="text-[10px] text-gray-500 font-mono">{snapshotShortId}</p>
          </div>
        </div>
        <button
                onclick={onclose}
                aria-label="Schließen"
                class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Path bar -->
      <div class="px-4 py-2.5 border-b border-gray-800 shrink-0">
        {#if editingPath}
          <form onsubmit={handlePathSubmit} class="flex items-center gap-2">
            <span class="text-gray-600 shrink-0">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
              </svg>
            </span>
            <input
                    bind:this={pathInputEl}
                    bind:value={pathInput}
                    onblur={handlePathSubmit}
                    onkeydown={(e) => e.key === 'Escape' && (editingPath = false)}
                    class="flex-1 bg-gray-800 border border-blue-500/50 rounded-lg px-3 py-1.5 text-white text-sm
                     font-mono focus:outline-none focus:border-blue-500 transition-colors"
                    placeholder="/pfad/zum/verzeichnis"
            />
            <button type="submit" class="text-xs text-blue-400 hover:text-blue-300 px-2 py-1.5 rounded-lg hover:bg-blue-500/10 transition-colors shrink-0">
              Go
            </button>
          </form>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div
                  class="flex items-center gap-1 cursor-text group"
                  onclick={startEditPath}
                  title="Klicken um Pfad einzugeben"
          >
            <span class="text-gray-600 shrink-0 group-hover:text-gray-400 transition-colors">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
              </svg>
            </span>
            <div class="flex items-center gap-0.5 flex-1 min-w-0 overflow-x-auto">
              <button
                      onclick={(e) => { e.stopPropagation(); navigateTo(0); }}
                      class="text-blue-400 hover:text-blue-300 text-sm font-mono shrink-0 transition-colors"
              >/</button>
              {#each breadcrumb as segment, i}
                <span class="text-gray-700 text-sm shrink-0">/</span>
                <button
                        onclick={(e) => { e.stopPropagation(); navigateTo(i + 1); }}
                        class="text-blue-400 hover:text-blue-300 text-sm font-mono shrink-0 truncate max-w-40 transition-colors"
                >{segment}</button>
              {/each}
            </div>
            <span class="text-gray-700 group-hover:text-gray-500 transition-colors shrink-0">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/>
              </svg>
            </span>
          </div>
        {/if}
      </div>

      <!-- File listing -->
      <div class="flex-1 overflow-y-auto">
        {#if loading}
          <div class="flex items-center justify-center py-16">
            <div class="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        {:else if error}
          <div class="flex flex-col items-center justify-center py-12 gap-2">
            <svg class="w-8 h-8 text-red-500/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
            </svg>
            <p class="text-red-400 text-sm">{error}</p>
          </div>
        {:else if nodes.length === 0}
          <div class="flex flex-col items-center justify-center py-12 gap-2">
            <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/>
            </svg>
            <p class="text-gray-600 text-sm">Leeres Verzeichnis</p>
          </div>
        {:else}
          <div class="divide-y divide-gray-800/40">
            {#each nodes as node (node.path)}
              {@const iconType = getFileIcon(node)}
              <div class="flex items-center gap-3 px-4 py-2 hover:bg-gray-800/30 group transition-colors">

                <!-- Icon -->
                <div class="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center
                  {iconType === 'dir' ? 'bg-yellow-500/10' :
                   iconType === 'image' ? 'bg-pink-500/10' :
                   iconType === 'archive' ? 'bg-orange-500/10' :
                   iconType === 'code' ? 'bg-blue-500/10' :
                   iconType === 'symlink' ? 'bg-purple-500/10' :
                   'bg-gray-800'}"
                >
                  {#if iconType === 'dir'}
                    <svg class="w-3.5 h-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
                    </svg>
                  {:else if iconType === 'symlink'}
                    <svg class="w-3.5 h-3.5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101"/>
                    </svg>
                  {:else if iconType === 'image'}
                    <svg class="w-3.5 h-3.5 text-pink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                    </svg>
                  {:else if iconType === 'archive'}
                    <svg class="w-3.5 h-3.5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"/>
                    </svg>
                  {:else if iconType === 'code'}
                    <svg class="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"/>
                    </svg>
                  {:else}
                    <svg class="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"/>
                    </svg>
                  {/if}
                </div>

                <!-- Name + meta -->
                <div class="flex-1 min-w-0">
                  {#if node.type === 'dir'}
                    <button
                            onclick={() => enterDir(node)}
                            class="text-sm text-white hover:text-blue-400 text-left truncate w-full transition-colors font-medium"
                    >{node.name}</button>
                  {:else}
                    <span class="text-sm text-gray-200 truncate block">{node.name}</span>
                  {/if}
                  <div class="flex items-center gap-2 mt-0.5">
                    {#if node.size != null}
                      <span class="text-[10px] text-gray-600 tabular-nums">{formatSize(node.size)}</span>
                    {/if}
                    {#if node.mtime}
                      <span class="text-[10px] text-gray-700">{formatMtime(node.mtime)}</span>
                    {/if}
                  </div>
                </div>

                <!-- Actions -->
                <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  {#if node.type === 'dir'}
                    <button
                            onclick={() => enterDir(node)}
                            title="Öffnen"
                            class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
                      </svg>
                    </button>
                    <button
                            onclick={() => downloadDir(node)}
                            title="Als TAR herunterladen"
                            class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                      </svg>
                    </button>
                  {:else if node.type === 'file'}
                    <button
                            onclick={() => downloadFile(node)}
                            title="Herunterladen"
                            class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                    >
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
                      </svg>
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

    </div>
  </div>
{/if}