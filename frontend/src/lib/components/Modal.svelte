<script lang="ts">
  interface Props {
    open: boolean;
    title: string;
    onclose: () => void;
    children: import('svelte').Snippet;
    footer?: import('svelte').Snippet;
  }

  let { open, title, onclose, children, footer }: Props = $props();
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4"
    onclick={(e) => { if (e.target === e.currentTarget) onclose(); }}
  >
    <div class="absolute inset-0 bg-black/60 backdrop-blur-sm"></div>
    <div class="relative bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md">
      <div class="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <h2 class="text-base font-semibold text-white">{title}</h2>
        <button
          onclick={onclose}
          aria-label="Close"
          class="text-gray-400 hover:text-white transition-colors p-1 rounded"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <div class="px-6 py-4">
        {@render children()}
      </div>
      {#if footer}
        <div class="px-6 py-4 border-t border-gray-800 flex justify-end gap-3">
          {@render footer()}
        </div>
      {/if}
    </div>
  </div>
{/if}
