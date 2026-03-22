<script lang="ts">
  import { goto } from '$app/navigation';
  import { auth } from '$lib/api';
  import { onMount } from 'svelte';

  let username = $state('');
  let password = $state('');
  let error = $state('');
  let errorKey = $state(0); // increment to re-trigger shake animation
  let loading = $state(false);
  let canvas: HTMLCanvasElement;

  let step = $state<'credentials' | '2fa'>('credentials');
  let totpCode = $state('');
  let totpInput: HTMLInputElement;

  async function handleSubmit() {
    if (loading) return;
    error = '';
    loading = true;
    try {
      const result = await auth.login(username, password);
      if (result.requires2fa) {
        step = '2fa';
        totpCode = '';
        // Focus the OTP input on next tick
        setTimeout(() => totpInput?.focus(), 50);
      } else {
        goto('/repos');
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Benutzername oder Passwort falsch.';
      errorKey++; // re-trigger shake even if the message is the same
    } finally {
      loading = false;
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleSubmit();
  }

  async function submitTotp() {
    if (totpCode.length !== 6) return;
    error = '';
    loading = true;
    try {
      await auth.challenge2fa(totpCode);
      goto('/repos');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Ungültiger Code';
      errorKey++;
      totpCode = '';
      totpInput?.focus();
    } finally {
      loading = false;
    }
  }

  function backToCredentials() {
    step = 'credentials';
    totpCode = '';
    error = '';
  }

  onMount(() => {
    const ctx = canvas.getContext('2d')!;
    let animId: number;
    let w = 0, h = 0;

    const CELL = 60;
    const NODES: { x: number; y: number; pulse: number; speed: number }[] = [];
    const PACKETS: { from: number; to: number; t: number; speed: number }[] = [];

    function resize() {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
      NODES.length = 0;
      const cols = Math.ceil(w / CELL) + 1;
      const rows = Math.ceil(h / CELL) + 1;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (Math.random() > 0.35) continue;
          NODES.push({
            x: c * CELL + (Math.random() - 0.5) * 20,
            y: r * CELL + (Math.random() - 0.5) * 20,
            pulse: Math.random() * Math.PI * 2,
            speed: 0.4 + Math.random() * 0.6,
          });
        }
      }
    }

    function spawnPacket() {
      if (NODES.length < 2) return;
      const from = Math.floor(Math.random() * NODES.length);
      let to = Math.floor(Math.random() * NODES.length);
      while (to === from) to = Math.floor(Math.random() * NODES.length);
      PACKETS.push({ from, to, t: 0, speed: 0.004 + Math.random() * 0.006 });
    }

    let frame = 0;
    function draw() {
      ctx.clearRect(0, 0, w, h);
      frame++;

      if (frame % 40 === 0 && PACKETS.length < 12) spawnPacket();

      // Grid lines
      ctx.strokeStyle = 'rgba(96,165,250,0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += CELL) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += CELL) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      // Connections between nearby nodes
      for (let i = 0; i < NODES.length; i++) {
        for (let j = i + 1; j < NODES.length; j++) {
          const a = NODES[i], b = NODES[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > CELL * 2.2) continue;
          const alpha = (1 - dist / (CELL * 2.2)) * 0.12;
          ctx.strokeStyle = `rgba(96,165,250,${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // Packets traveling along connections
      for (let i = PACKETS.length - 1; i >= 0; i--) {
        const p = PACKETS[i];
        p.t += p.speed;
        if (p.t >= 1) { PACKETS.splice(i, 1); continue; }
        const a = NODES[p.from], b = NODES[p.to];
        if (!a || !b) { PACKETS.splice(i, 1); continue; }
        const px = a.x + (b.x - a.x) * p.t;
        const py = a.y + (b.y - a.y) * p.t;
        // Trail
        const grad = ctx.createLinearGradient(a.x, a.y, px, py);
        grad.addColorStop(0, 'rgba(96,165,250,0)');
        grad.addColorStop(1, 'rgba(96,165,250,0.25)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(px, py); ctx.stroke();
        // Dot
        ctx.fillStyle = 'rgba(147,197,253,0.9)';
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
      }

      // Nodes
      NODES.forEach(n => {
        n.pulse += 0.02 * n.speed;
        const alpha = 0.2 + Math.sin(n.pulse) * 0.15;
        const r = 1.5 + Math.sin(n.pulse) * 0.5;
        ctx.fillStyle = `rgba(96,165,250,${alpha})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      });

      // Vignette
      const vg = ctx.createRadialGradient(w/2, h/2, h*0.1, w/2, h/2, h*0.85);
      vg.addColorStop(0, 'rgba(3,7,18,0)');
      vg.addColorStop(1, 'rgba(3,7,18,0.85)');
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, w, h);

      animId = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  });
</script>

<div class="min-h-screen bg-gray-950 flex items-center justify-center p-4 relative overflow-hidden">

  <canvas bind:this={canvas} class="absolute inset-0 w-full h-full pointer-events-none"></canvas>

  <div class="w-full max-w-sm relative z-10">
    <div class="text-center mb-8">
      <div class="inline-flex items-center justify-center w-12 h-12 bg-blue-600/20 border border-blue-500/20 rounded-2xl mb-4">
        <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
        </svg>
      </div>
      <h1 class="text-xl font-semibold text-white">ResticVault</h1>
      <p class="text-gray-600 text-xs mt-1">Backup Manager</p>
    </div>

    <div class="bg-gray-900/90 backdrop-blur-sm border border-gray-800 rounded-2xl p-6 space-y-4">

      {#if error}
        {#key errorKey}
          <div class="shake flex items-center gap-2.5 bg-red-950/40 border border-red-900/50
                      text-red-300 text-xs rounded-lg px-3 py-2.5">
            <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 9v2m0 4h.01M12 3a9 9 0 100 18A9 9 0 0012 3z"/>
            </svg>
            {error}
          </div>
        {/key}
      {/if}

      {#if step === 'credentials'}
        <div class="space-y-4">
          <div>
            <label for="username" class="block text-xs font-medium text-gray-400 mb-1.5">Benutzername</label>
            <input
              id="username"
              type="text"
              bind:value={username}
              autocomplete="username"
              placeholder="Benutzername"
              oninput={() => error = ''}
              onkeydown={handleKeydown}
              class="w-full bg-gray-800 border rounded-lg px-3 py-2.5 text-white text-sm
                     focus:outline-none focus:border-blue-500 transition-colors placeholder:text-gray-600
                     {error ? 'border-red-500/50' : 'border-gray-700'}"
            />
          </div>
          <div>
            <label for="password" class="block text-xs font-medium text-gray-400 mb-1.5">Passwort</label>
            <input
              id="password"
              type="password"
              bind:value={password}
              autocomplete="current-password"
              oninput={() => error = ''}
              onkeydown={handleKeydown}
              class="w-full bg-gray-800 border rounded-lg px-3 py-2.5 text-white text-sm
                     focus:outline-none focus:border-blue-500 transition-colors
                     {error ? 'border-red-500/50' : 'border-gray-700'}"
            />
          </div>
          <button
            type="button"
            onclick={handleSubmit}
            disabled={loading}
            class="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500
                   disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]
                   text-white font-medium py-2.5 rounded-lg transition-all duration-150 text-sm mt-2"
          >
            {#if loading}
              <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              Anmelden…
            {:else}
              Anmelden
            {/if}
          </button>
        </div>

      {:else}
        <!-- 2FA step -->
        <div class="text-center mb-2">
          <div class="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/20 flex items-center justify-center mx-auto mb-3">
            <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                    d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"/>
            </svg>
          </div>
          <p class="text-sm text-white font-medium">Zwei-Faktor-Authentifizierung</p>
          <p class="text-xs text-gray-500 mt-1">Code aus deiner Authenticator-App eingeben</p>
        </div>

        <input
          bind:this={totpInput}
          type="text"
          inputmode="numeric"
          pattern="\d{6}"
          maxlength="6"
          bind:value={totpCode}
          oninput={() => { error = ''; if (totpCode.length === 6) submitTotp(); }}
          disabled={loading}
          class="w-full text-center text-2xl font-mono tracking-[0.5em] bg-gray-800 border border-gray-700
                 rounded-lg px-3 py-3 text-white focus:outline-none focus:border-blue-500 transition-colors
                 disabled:opacity-50 placeholder:tracking-normal placeholder:text-base"
          placeholder="000000"
          autofocus
        />

        <div class="flex gap-2">
          <button
            onclick={backToCredentials}
            class="flex-1 py-2.5 text-sm text-gray-400 hover:text-white border border-gray-700
                   hover:border-gray-600 rounded-lg transition-colors"
          >
            ← Zurück
          </button>
          <button
            onclick={submitTotp}
            disabled={loading || totpCode.length !== 6}
            class="flex-1 flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500
                   disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium
                   py-2.5 rounded-lg transition-colors text-sm"
          >
            {#if loading}
              <div class="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
              Prüfen…
            {:else}
              Bestätigen
            {/if}
          </button>
        </div>
      {/if}
    </div>

    <p class="text-center text-[11px] text-gray-700 mt-4">ResticVault — Self-hosted backup manager</p>
  </div>
</div>
