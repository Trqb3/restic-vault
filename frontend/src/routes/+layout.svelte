<script lang="ts">
  import '../app.css';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { auth } from '$lib/api';
  import { toast } from '$lib/toast';
  import { userColor } from '$lib/utils';
  import ToastContainer from '$lib/components/ToastContainer.svelte';

  let { children } = $props();
  let username = $state('');
  let role = $state<'admin' | 'viewer' | ''>('');
  let checking = $state(true);
  let canvas = $state<HTMLCanvasElement | null>(null);
  let userMenuOpen = $state(false);

  const publicRoutes = ['/login'];

  onMount(async () => {
    if (publicRoutes.includes($page.url.pathname)) {
      checking = false;
      return;
    }
    try {
      const me = await auth.me();
      username = me.username;
      role = me.role;
    } catch {
      goto('/login');
    } finally {
      checking = false;
    }
  });

  $effect(() => {
    if (!canvas) return;

    const ctx = canvas.getContext('2d')!;
    let animId: number;
    let w = 0, h = 0;

    const CELL = 60;
    const NODES: { x: number; y: number; pulse: number; speed: number }[] = [];
    const PACKETS: { from: number; to: number; t: number; speed: number }[] = [];

    function resize() {
      w = canvas!.width = window.innerWidth;
      h = canvas!.height = window.innerHeight;
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

      ctx.strokeStyle = 'rgba(96,165,250,0.04)';
      ctx.lineWidth = 1;
      for (let x = 0; x < w; x += CELL) {
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      }
      for (let y = 0; y < h; y += CELL) {
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }

      for (let i = 0; i < NODES.length; i++) {
        for (let j = i + 1; j < NODES.length; j++) {
          const a = NODES[i], b = NODES[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > CELL * 2.2) continue;
          const alpha = (1 - dist / (CELL * 2.2)) * 0.10;
          ctx.strokeStyle = `rgba(96,165,250,${alpha})`;
          ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      for (let i = PACKETS.length - 1; i >= 0; i--) {
        const p = PACKETS[i];
        p.t += p.speed;
        if (p.t >= 1) { PACKETS.splice(i, 1); continue; }
        const a = NODES[p.from], b = NODES[p.to];
        if (!a || !b) { PACKETS.splice(i, 1); continue; }
        const px = a.x + (b.x - a.x) * p.t;
        const py = a.y + (b.y - a.y) * p.t;
        const grad = ctx.createLinearGradient(a.x, a.y, px, py);
        grad.addColorStop(0, 'rgba(96,165,250,0)');
        grad.addColorStop(1, 'rgba(96,165,250,0.2)');
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(px, py); ctx.stroke();
        ctx.fillStyle = 'rgba(147,197,253,0.8)';
        ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill();
      }

      NODES.forEach(n => {
        n.pulse += 0.02 * n.speed;
        const alpha = 0.15 + Math.sin(n.pulse) * 0.1;
        const r = 1.5 + Math.sin(n.pulse) * 0.5;
        ctx.fillStyle = `rgba(96,165,250,${alpha})`;
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      });

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

  async function handleLogout() {
    await auth.logout().catch(() => {});
    goto('/login');
  }

  $effect(() => {
    if (!publicRoutes.includes($page.url.pathname) && !checking) {
      auth.me().then((me) => { username = me.username; role = me.role; }).catch(() => goto('/login'));
    }
  });


  function closestUserMenu(target: EventTarget | null): boolean {
    return !!(target as Element)?.closest('[data-user-menu]');
  }
</script>

<svelte:window onclick={(e) => {
  if (!closestUserMenu(e.target)) {
    setTimeout(() => userMenuOpen = false, 100);
  }
}} />

{#if checking}
  <div class="flex items-center justify-center min-h-screen">
    <div class="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
  </div>
{:else if publicRoutes.includes($page.url.pathname)}
  {@render children()}
{:else}
  <div class="min-h-screen flex flex-col relative">

    <canvas bind:this={canvas} class="fixed inset-0 w-full h-full pointer-events-none" style="z-index: 0"></canvas>

    <header class="sticky top-0 z-30 bg-gray-900/80 backdrop-blur-sm border-b border-gray-800/60 px-6 py-3 flex items-center justify-between">

      <!-- Logo -->
      <a href="/repos" class="flex items-center gap-2.5 group">
        <div class="w-7 h-7 rounded-lg bg-blue-600/20 flex items-center justify-center">
          <svg class="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
        </div>
        <span class="text-white font-semibold text-sm group-hover:text-blue-400 transition-colors duration-150">
          ResticVault
        </span>
      </a>

      <!-- User dropdown -->
      <div class="relative" data-user-menu>
        <button
                onclick={() => userMenuOpen = !userMenuOpen}
                class="flex items-center gap-1.5 bg-gray-800/60 border border-gray-700/60 rounded-xl px-2.5 py-1.5
                 hover:border-gray-600 transition-all duration-150"
        >
          <div class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium shrink-0 {userColor(username)}">
            {username[0]?.toUpperCase() ?? '?'}
          </div>
          <span class="text-sm text-gray-300 font-medium px-1">{username}</span>
          <svg
                  class="w-3 h-3 text-gray-500 transition-transform duration-150 {userMenuOpen ? 'rotate-180' : ''}"
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/>
          </svg>
        </button>

        {#if userMenuOpen}
          <div class="absolute right-0 top-full mt-1.5 w-52 bg-gray-900 border border-gray-700/60 rounded-xl shadow-2xl overflow-hidden z-50">

            <!-- User info header -->
            <div class="px-3 py-3 border-b border-gray-800 flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium shrink-0 {userColor(username)}">
                {username[0]?.toUpperCase() ?? '?'}
              </div>
              <div class="min-w-0">
                <p class="text-xs font-semibold text-white truncate">{username}</p>
                <p class="text-[10px] text-gray-500 capitalize">{role}</p>
              </div>
            </div>

            <!-- Nav items -->
            <div class="p-1">

              <a href="/repos"
              onclick={() => userMenuOpen = false}
              class="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors
              {$page.url.pathname.startsWith('/repos')
                      ? 'text-white bg-gray-800'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'}"
              >
              <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"/>
              </svg>
              Repositories
              </a>


              <a href="/settings"
              onclick={() => userMenuOpen = false}
              class="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors
              {$page.url.pathname === '/settings'
                      ? 'text-white bg-gray-800'
                      : 'text-gray-400 hover:text-white hover:bg-gray-800'}"
              >
              <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
              </svg>
              Einstellungen
              </a>

              <a href="/sources"
              onclick={() => userMenuOpen = false}
              class="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors
              {$page.url.pathname.startsWith('/sources')
                      ? 'text-emerald-300 bg-emerald-500/10'
                      : 'text-emerald-400/80 hover:text-emerald-300 hover:bg-emerald-500/8'}"
              >
              <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                      d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
              </svg>
              Backup Sources
              </a>

              {#if role === 'admin'}
                <a href="/admin"
                onclick={() => userMenuOpen = false}
                class="flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors
                {$page.url.pathname === '/admin'
                        ? 'text-amber-300 bg-amber-500/10'
                        : 'text-amber-400/80 hover:text-amber-300 hover:bg-amber-500/8'}"
                >
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
                </svg>
                Admin Panel
                </a>
              {/if}
            </div>

            <!-- Logout -->
            <div class="p-1 border-t border-gray-800">
              <button
                      onclick={() => { userMenuOpen = false; handleLogout(); }}
                      class="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400
                       hover:text-red-300 hover:bg-red-500/8 rounded-lg transition-colors"
              >
                <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
                        d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
                </svg>
                Logout
              </button>
            </div>

          </div>
        {/if}
      </div>
    </header>

    <main class="relative z-10 flex-1 p-6">
      {@render children()}
    </main>
  </div>
{/if}

<ToastContainer />