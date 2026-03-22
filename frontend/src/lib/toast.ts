import { writable } from 'svelte/store';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  message: string;
}

function createToastStore() {
  const { subscribe, update } = writable<Toast[]>([]);

  function add(type: Toast['type'], message: string, duration = 4000) {
    const id = Math.random().toString(36).slice(2);
    update((toasts) => [...toasts, { id, type, message }]);
    setTimeout(() => {
      update((toasts) => toasts.filter((t) => t.id !== id));
    }, duration);
  }

  return {
    subscribe,
    success: (msg: string) => add('success', msg),
    error: (msg: string) => add('error', msg, 6000),
    info: (msg: string) => add('info', msg),
  };
}

export const toast = createToastStore();
