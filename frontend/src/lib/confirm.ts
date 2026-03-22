import { writable } from 'svelte/store';

type ConfirmState = {
  open: boolean;
  message: string;
  resolve: ((val: boolean) => void) | null;
};

export const confirmState = writable<ConfirmState>({ open: false, message: '', resolve: null });

export function confirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    confirmState.set({ open: true, message, resolve });
  });
}
