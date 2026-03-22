<script lang="ts">
  import { toast, type Toast } from '$lib/toast';

  const icons: Record<Toast['type'], string> = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
  };

  const colors: Record<Toast['type'], string> = {
    success: 'bg-green-900/80 border-green-700 text-green-200',
    error: 'bg-red-900/80 border-red-700 text-red-200',
    info: 'bg-blue-900/80 border-blue-700 text-blue-200',
  };
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
  {#each $toast as t (t.id)}
    <div class="flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-sm text-sm shadow-xl
                pointer-events-auto animate-in slide-in-from-bottom-2 {colors[t.type]}"
         style="min-width: 280px; max-width: 420px">
      <span class="font-bold text-base flex-shrink-0">{icons[t.type]}</span>
      <span>{t.message}</span>
    </div>
  {/each}
</div>
