<script lang="ts">
  import { confirmState } from '$lib/confirm';
  import Modal from './Modal.svelte';

  function yes() {
    confirmState.update((s) => {
      s.resolve?.(true);
      return { open: false, message: '', resolve: null };
    });
  }

  function no() {
    confirmState.update((s) => {
      s.resolve?.(false);
      return { open: false, message: '', resolve: null };
    });
  }
</script>

<Modal open={$confirmState.open} title="Confirm" onclose={no}>
  {#snippet children()}
    <p class="text-gray-300 text-sm">{$confirmState.message}</p>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={no}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white bg-transparent hover:bg-gray-800 rounded-lg transition-colors border border-gray-700"
    >
      Cancel
    </button>
    <button
      onclick={yes}
      class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors"
    >
      Delete
    </button>
  {/snippet}
</Modal>
