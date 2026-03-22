<script lang="ts">
  import { fade } from 'svelte/transition';
  import type { Snapshot } from '$lib/api';

  interface Props {
    snapshots: Snapshot[];
    selectedDate: string | null;
    onselect: (dateKey: string, snaps: Snapshot[]) => void;
  }

  let { snapshots, selectedDate, onselect }: Props = $props();

  const today = new Date();
  let year  = $state(today.getFullYear());
  let month = $state(today.getMonth());

  // Drives the month-label fade: updated only after the slide completes
  let labelKey = $state(`${year}-${month}`);

  // Carousel CSS state — manipulated imperatively during animation
  let trackTransform  = $state('translateX(-33.333%)');
  let trackTransition = $state('transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)');
  let sliding  = false;
  let pendingDir = 0;

  const DAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const MONTHS = [
    'Januar','Februar','März','April','Mai','Juni',
    'Juli','August','September','Oktober','November','Dezember',
  ];

  let snapshotsByDay = $derived(
    snapshots.reduce<Record<string, Snapshot[]>>((acc, snap) => {
      const d = new Date(snap.time * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (!acc[key]) acc[key] = [];
      acc[key].push(snap);
      return acc;
    }, {})
  );

  // Three panels: [prev, current, next] — always rendered, only current is visible
  let panels = $derived([-1, 0, 1].map((offset) => {
    let m = month + offset;
    let y = year;
    if (m < 0)  { m += 12; y -= 1; }
    if (m > 11) { m -= 12; y += 1; }
    return { year: y, month: m };
  }));

  function applySlide(dir: -1 | 1) {
    if (sliding) return;
    sliding   = true;
    pendingDir = dir;
    // prev (dir=-1): slide right → show panel 0 → translateX(0%)
    // next (dir=+1): slide left  → show panel 2 → translateX(-66.666%)
    trackTransform = dir === -1 ? 'translateX(0%)' : 'translateX(-66.666%)';
  }

  function handleTransitionEnd(e: TransitionEvent) {
    if (e.propertyName !== 'transform' || !sliding) return;

    // Advance month state (triggers Svelte to re-render panels)
    if (pendingDir === -1) {
      if (month === 0) { month = 11; year -= 1; } else month -= 1;
    } else {
      if (month === 11) { month = 0; year += 1; } else month += 1;
    }
    labelKey = `${year}-${month}`;

    // Snap back to center instantly (no visible jump since panels are re-rendered)
    trackTransition = 'none';
    trackTransform  = 'translateX(-33.333%)';

    // Re-enable transition after two frames so the reset doesn't itself animate
    requestAnimationFrame(() => requestAnimationFrame(() => {
      trackTransition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      sliding = false;
    }));
  }

  function prevMonth() { applySlide(-1); }
  function nextMonth() { applySlide(1); }

  // ── Touch / swipe ─────────────────────────────────────────────────────────────
  let touchStartX = 0;
  function onTouchStart(e: TouchEvent) { touchStartX = e.touches[0].clientX; }
  function onTouchEnd(e: TouchEvent) {
    const delta = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(delta) >= 50) delta > 0 ? nextMonth() : prevMonth();
  }

  // ── Calendar helpers ──────────────────────────────────────────────────────────
  function calendarDays(y: number, m: number) {
    const firstDay    = new Date(y, m, 1);
    const startDow    = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const daysInPrev  = new Date(y, m, 0).getDate();

    const days: Array<{ date: Date; dateKey: string | null; current: boolean }> = [];
    for (let i = 0; i < startDow; i++)
      days.push({ date: new Date(y, m - 1, daysInPrev - startDow + i + 1), dateKey: null, current: false });
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      days.push({ date: new Date(y, m, d), dateKey: key, current: true });
    }
    // Always pad to 42 cells (6 rows × 7 cols) so the grid height never changes
    const remaining = 42 - days.length;
    for (let i = 1; i <= remaining; i++)
      days.push({ date: new Date(y, m + 1, i), dateKey: null, current: false });
    return days;
  }

  function isToday(date: Date) {
    return date.getFullYear() === today.getFullYear() &&
           date.getMonth()    === today.getMonth()    &&
           date.getDate()     === today.getDate();
  }

  function bestType(snaps: Snapshot[]): string {
    for (const p of ['yearly', 'monthly', 'weekly', 'daily'])
      if (snaps.some((s) => s.backup_type === p)) return p;
    return 'daily';
  }
</script>

<div class="select-none">
  <!-- Navigation -->
  <div class="flex items-center justify-between mb-4">
    <button
      onclick={prevMonth}
      aria-label="Previous month"
      class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-all duration-150 active:scale-95"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>
      </svg>
    </button>

    <!-- Month label — fades in after each navigation -->
    {#key labelKey}
      <p
        class="text-sm font-semibold text-white tracking-wide"
        in:fade={{ duration: 180 }}
      >
        {MONTHS[month]} <span class="text-gray-500 font-normal">{year}</span>
      </p>
    {/key}

    <button
      onclick={nextMonth}
      aria-label="Next month"
      class="p-1.5 text-gray-500 hover:text-white hover:bg-gray-800 rounded-lg transition-all duration-150 active:scale-95"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
      </svg>
    </button>
  </div>

  <!-- Carousel container -->
  <div
    class="overflow-hidden rounded-xl border border-gray-800/60"
    ontouchstart={onTouchStart}
    ontouchend={onTouchEnd}
  >
    <!-- Track: 300% wide, only the center third (panel 1) is visible at a time -->
    <div
      style="display: flex; width: 300%; transform: {trackTransform}; transition: {trackTransition}; will-change: transform;"
      ontransitionend={handleTransitionEnd}
    >
      {#each panels as vm}
        <!-- Each panel occupies one third of the track width -->
        <div style="width: 33.333%; flex-shrink: 0; min-width: 0;" class="p-3">
          <!-- Day-of-week headers -->
          <div class="grid grid-cols-7 mb-1">
            {#each DAYS as day}
              <div class="text-center text-[9px] font-medium text-gray-600 uppercase tracking-wider py-1">{day}</div>
            {/each}
          </div>

          <!-- Day cells -->
          <div class="grid grid-cols-7 gap-1">
            {#each calendarDays(vm.year, vm.month) as cell (cell.date.toISOString())}
              {@const snaps      = cell.dateKey ? (snapshotsByDay[cell.dateKey] ?? []) : []}
              {@const type       = snaps.length > 0 ? bestType(snaps) : null}
              {@const isSelected = cell.dateKey !== null && selectedDate === cell.dateKey}
              {@const hasSnap    = cell.current && snaps.length > 0}

              <button
                disabled={!cell.current || snaps.length === 0}
                onclick={() => cell.dateKey && snaps.length > 0 && onselect(cell.dateKey, snaps)}
                class="relative w-full h-7 flex flex-col items-center justify-center rounded-md text-[11px]
                       transition-all duration-100
                       {!cell.current
                         ? 'text-gray-800 cursor-default'
                         : hasSnap
                           ? 'text-gray-200 hover:bg-gray-700/70 hover:text-white cursor-pointer active:scale-95'
                           : 'text-gray-600 cursor-default'}
                       {isToday(cell.date) && !isSelected ? 'ring-1 ring-blue-500/60 text-blue-300' : ''}
                       {isSelected ? 'bg-blue-600/20 ring-1 ring-blue-500/50 text-blue-200' : ''}"
              >
                <span class="leading-none {isToday(cell.date) ? 'font-semibold' : ''}">
                  {cell.date.getDate()}
                </span>

                {#if type === 'yearly'}
                  <span class="text-yellow-400 text-[7px] leading-none mt-px">★</span>
                {:else if type === 'monthly'}
                  <span class="w-1 h-1 rounded-full bg-teal-400 mt-px"></span>
                {:else if type === 'weekly'}
                  <span class="w-1 h-1 rounded-full bg-blue-400 mt-px"></span>
                {:else if type === 'daily'}
                  <span class="w-1 h-1 rounded-full bg-blue-600 mt-px"></span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>

  <!-- Legend -->
  <div class="flex items-center gap-4 mt-3 pt-3 border-t border-gray-800/60">
    <span class="text-[10px] text-gray-600 uppercase tracking-wider font-medium">Legend</span>
    <div class="flex items-center gap-1.5 text-[11px] text-gray-500">
      <span class="w-1 h-1 rounded-full bg-blue-600 inline-block"></span> Daily
    </div>
    <div class="flex items-center gap-1.5 text-[11px] text-gray-500">
      <span class="w-1 h-1 rounded-full bg-blue-400 inline-block"></span> Weekly
    </div>
    <div class="flex items-center gap-1.5 text-[11px] text-gray-500">
      <span class="w-1 h-1 rounded-full bg-teal-400 inline-block"></span> Monthly
    </div>
    <div class="flex items-center gap-1.5 text-[11px] text-gray-500">
      <span class="text-yellow-400 text-[10px]">★</span> Yearly
    </div>
  </div>
</div>
