<script lang="ts">
  import { onMount } from 'svelte';
  import { auth } from '$lib/api';
  import { toast } from '$lib/toast';
  import Modal from '$lib/components/Modal.svelte';

  let loading = $state(true);
  let totpEnabled = $state(false);
  let username = $state('');

  // Setup flow
  let setupStep = $state<'idle' | 'scan' | 'confirm'>('idle');
  let qrCode = $state('');
  let manualSecret = $state('');
  let setupCode = $state('');
  let setupLoading = $state(false);

  // Disable flow
  let showDisableModal = $state(false);
  let disablePassword = $state('');
  let disableCode = $state('');
  let disableLoading = $state(false);

  onMount(async () => {
    try {
      const me = await auth.me();
      totpEnabled = me.totp_enabled;
      username = me.username;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Fehler beim Laden');
    } finally {
      loading = false;
    }
  });

  async function startSetup() {
    setupLoading = true;
    try {
      const data = await auth.setup2fa();
      qrCode = data.qrCode;
      manualSecret = data.secret;
      setupStep = 'scan';
      setupCode = '';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Setup fehlgeschlagen');
    } finally {
      setupLoading = false;
    }
  }

  async function confirmSetup() {
    if (setupCode.length !== 6) return;
    setupLoading = true;
    try {
      await auth.verify2fa(setupCode);
      totpEnabled = true;
      setupStep = 'idle';
      setupCode = '';
      qrCode = '';
      manualSecret = '';
      toast.success('Zwei-Faktor-Authentifizierung aktiviert');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Ungültiger Code');
      setupCode = '';
    } finally {
      setupLoading = false;
    }
  }

  async function disable2fa() {
    if (!disablePassword || disableCode.length !== 6) return;
    disableLoading = true;
    try {
      await auth.disable2fa(disablePassword, disableCode);
      totpEnabled = false;
      showDisableModal = false;
      disablePassword = '';
      disableCode = '';
      toast.success('Zwei-Faktor-Authentifizierung deaktiviert');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Deaktivierung fehlgeschlagen');
    } finally {
      disableLoading = false;
    }
  }

  function cancelSetup() {
    setupStep = 'idle';
    setupCode = '';
    qrCode = '';
    manualSecret = '';
  }

  // Format the manual secret in groups of 4 for readability
  const formattedSecret = $derived(
    manualSecret.match(/.{1,4}/g)?.join(' ') ?? manualSecret
  );
</script>

<div class="max-w-lg mx-auto space-y-6">
  <div>
    <h1 class="text-xl font-semibold text-white">Einstellungen</h1>
    <p class="text-xs text-gray-500 mt-0.5">Konto- und Sicherheitseinstellungen für <span class="text-gray-400">{username}</span></p>
  </div>

  {#if loading}
    <div class="flex items-center justify-center py-20">
      <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  {:else}

    <!-- 2FA card -->
    <div class="bg-gray-900 border border-gray-800 rounded-xl p-5">
      <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium mb-4">Sicherheit</p>

      <!-- Status row -->
      <div class="flex items-center justify-between mb-5">
        <div class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-lg {totpEnabled ? 'bg-green-500/10' : 'bg-gray-800'} flex items-center justify-center shrink-0">
            <svg class="w-4.5 h-4.5 {totpEnabled ? 'text-green-400' : 'text-gray-500'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>
            </svg>
          </div>
          <div>
            <p class="text-sm font-medium text-white">Zwei-Faktor-Authentifizierung</p>
            <p class="text-xs text-gray-500 mt-0.5">TOTP — kompatibel mit Google Authenticator, Authy, Bitwarden</p>
          </div>
        </div>
        {#if totpEnabled}
          <span class="text-xs font-medium text-green-400 bg-green-500/10 ring-1 ring-green-500/20 px-2.5 py-1 rounded-md shrink-0">
            Aktiv
          </span>
        {:else}
          <span class="text-xs font-medium text-gray-500 bg-gray-800 ring-1 ring-gray-700 px-2.5 py-1 rounded-md shrink-0">
            Inaktiv
          </span>
        {/if}
      </div>

      {#if totpEnabled}
        <!-- Already enabled -->
        <div class="bg-green-500/5 border border-green-500/15 rounded-lg px-4 py-3 mb-4 flex items-start gap-2.5">
          <svg class="w-4 h-4 text-green-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
          </svg>
          <p class="text-xs text-green-300">2FA ist aktiv. Dein Konto ist durch einen zusätzlichen Authentifizierungsschritt geschützt.</p>
        </div>
        <div class="flex justify-end">
          <button
            onclick={() => { showDisableModal = true; disablePassword = ''; disableCode = ''; }}
            class="text-sm text-red-400 hover:text-red-300 border border-red-900/40 hover:border-red-800
                   px-4 py-2 rounded-lg transition-colors"
          >
            2FA deaktivieren
          </button>
        </div>

      {:else if setupStep === 'idle'}
        <!-- Not enabled, offer to set up -->
        <p class="text-xs text-gray-500 mb-4">
          Schütze dein Konto mit einem zeitbasierten Einmalpasswort (TOTP). Du benötigst eine Authenticator-App auf deinem Smartphone.
        </p>
        <button
          onclick={startSetup}
          disabled={setupLoading}
          class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
                 hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
        >
          {#if setupLoading}
            <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            Vorbereitung…
          {:else}
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            2FA aktivieren
          {/if}
        </button>

      {:else if setupStep === 'scan'}
        <!-- QR code scanning step -->
        <div class="space-y-4">
          <div class="flex flex-col items-center gap-4 p-4 bg-gray-800/50 border border-gray-700/50 rounded-xl">
            {#if qrCode}
              <img src={qrCode} alt="2FA QR Code" class="w-48 h-48 rounded-lg bg-white p-1" />
            {/if}
            <div class="text-center">
              <p class="text-xs text-gray-400 mb-2">QR-Code mit deiner Authenticator-App scannen</p>
              <p class="text-[10px] text-gray-500 mb-1">Oder manuell eingeben:</p>
              <code class="text-xs font-mono text-blue-300 bg-gray-900 px-3 py-1.5 rounded-lg tracking-wider select-all">
                {formattedSecret}
              </code>
            </div>
          </div>

          <div>
            <label class="block text-xs font-medium text-gray-400 mb-1.5">
              Code aus der App eingeben zur Bestätigung
            </label>
            <div class="flex gap-2">
              <input
                type="text"
                inputmode="numeric"
                pattern="\d{6}"
                maxlength="6"
                bind:value={setupCode}
                oninput={() => { if (setupCode.length === 6) confirmSetup(); }}
                placeholder="000000"
                class="w-36 text-center font-mono tracking-[0.4em] bg-gray-800 border border-gray-700
                       rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500
                       transition-colors placeholder:tracking-normal"
              />
              <button
                onclick={confirmSetup}
                disabled={setupLoading || setupCode.length !== 6}
                class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600
                       hover:bg-blue-500 disabled:opacity-50 rounded-lg transition-colors"
              >
                {#if setupLoading}
                  <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                {:else}
                  Aktivieren
                {/if}
              </button>
              <button
                onclick={cancelSetup}
                class="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-700
                       hover:border-gray-600 rounded-lg transition-colors"
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
      {/if}
    </div>

  {/if}
</div>

<!-- Disable 2FA modal -->
<Modal open={showDisableModal} title="2FA deaktivieren" onclose={() => showDisableModal = false}>
  {#snippet children()}
    <div class="space-y-4">
      <div class="flex items-start gap-2.5 bg-amber-950/30 border border-amber-900/40 text-amber-300 text-xs rounded-lg px-3 py-2.5">
        <svg class="w-3.5 h-3.5 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z"/>
        </svg>
        Gib dein Passwort und einen aktuellen 2FA-Code ein um die Zwei-Faktor-Authentifizierung zu deaktivieren.
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Aktuelles Passwort</label>
        <input
          type="password"
          bind:value={disablePassword}
          class="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm
                 focus:outline-none focus:border-blue-500 transition-colors"
        />
      </div>
      <div>
        <label class="block text-xs font-medium text-gray-400 mb-1.5">Authenticator-Code</label>
        <input
          type="text"
          inputmode="numeric"
          maxlength="6"
          bind:value={disableCode}
          placeholder="000000"
          class="w-36 text-center font-mono tracking-[0.4em] bg-gray-800 border border-gray-700
                 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500
                 transition-colors placeholder:tracking-normal"
        />
      </div>
    </div>
  {/snippet}
  {#snippet footer()}
    <button
      onclick={() => showDisableModal = false}
      class="px-4 py-2 text-sm text-gray-300 hover:text-white border border-gray-700
             hover:bg-gray-800 rounded-lg transition-colors"
    >
      Abbrechen
    </button>
    <button
      onclick={disable2fa}
      disabled={disableLoading || !disablePassword || disableCode.length !== 6}
      class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-500
             disabled:opacity-40 rounded-lg transition-colors"
    >
      {disableLoading ? 'Deaktivieren…' : 'Deaktivieren'}
    </button>
  {/snippet}
</Modal>
