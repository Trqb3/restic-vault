<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    Chart,
    LineController,
    LineElement,
    PointElement,
    LinearScale,
    TimeScale,
    Tooltip,
    Filler,
  } from 'chart.js';
  import 'chartjs-adapter-date-fns';
  import type { SizeHistoryPoint } from '$lib/api';

  interface Props {
    data: SizeHistoryPoint[];
    days: number;
    onDaysChange: (days: number) => void;
  }

  let { data, days, onDaysChange }: Props = $props();

  Chart.register(LineController, LineElement, PointElement, LinearScale, TimeScale, Tooltip, Filler);

  let canvas: HTMLCanvasElement | undefined = $state();
  let chart: Chart | null = null;

  const TIME_RANGES: { d: number; label: string }[] = [
    { d: 7,   label: '7T' },
    { d: 30,  label: '30T' },
    { d: 90,  label: '90T' },
    { d: 365, label: '1J' },
  ];

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    return `${(bytes / 1024 ** 4).toFixed(2)} TB`;
  }

  function buildChart(): void {
    if (!canvas || data.length === 0) return;
    chart?.destroy();

    const labels = data.map((p) => new Date(p.recorded_at * 1000));
    const deduped = data.map((p) => p.deduplicated_size);

    const timeUnit: 'day' | 'week' = days <= 30 ? 'day' : 'week';

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Deduplizierte Größe',
            data: deduped,
            borderColor: 'rgba(59,130,246,0.9)',
            backgroundColor: 'rgba(59,130,246,0.08)',
            borderWidth: 2,
            pointRadius: data.length > 60 ? 0 : 3,
            pointHoverRadius: 5,
            pointBackgroundColor: 'rgba(59,130,246,1)',
            tension: 0.3,
            fill: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(17,24,39,0.95)',
            borderColor: 'rgba(55,65,81,0.8)',
            borderWidth: 1,
            titleColor: '#9ca3af',
            bodyColor: '#f3f4f6',
            padding: 10,
            callbacks: {
              title: (items) => {
                const item = items[0];
                if (!item) return '';
                return new Date(item.parsed.x ?? 0).toLocaleString('de-DE', {
                  day: '2-digit',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });
              },
              label: (item) => ` ${formatBytes(item.parsed.y ?? 0)}`,
            },
          },
        },
        scales: {
          x: {
            type: 'time',
            time: {
              unit: timeUnit,
              displayFormats: {
                day:  'dd. MMM',
                week: 'dd. MMM',
              },
            },
            grid:  { color: 'rgba(55,65,81,0.3)' },
            ticks: { color: '#6b7280', font: { size: 11 } },
          },
          y: {
            grid: { color: 'rgba(55,65,81,0.3)' },
            ticks: {
              color: '#6b7280',
              font: { size: 11 },
              callback: (val) => formatBytes(Number(val)),
            },
          },
        },
      },
    });
  }

  $effect(() => {
    // Re-build whenever data or canvas changes
    if (data && canvas) buildChart();
  });

  onDestroy(() => {
    chart?.destroy();
  });
</script>

<div class="bg-gray-900 border border-gray-800 rounded-xl px-4 py-4">
  <!-- Header row -->
  <div class="flex items-center justify-between mb-4">
    <p class="text-[10px] text-gray-500 uppercase tracking-wider font-medium">
      Backup-Größe (dedupliziert)
    </p>
    <!-- Time-range selector -->
    <div class="flex gap-1 p-0.5 bg-gray-800 rounded-lg">
      {#each TIME_RANGES as range (range.d)}
        <button
          type="button"
          onclick={() => onDaysChange(range.d)}
          class="px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors
                 {days === range.d
                   ? 'bg-gray-700 text-white'
                   : 'text-gray-500 hover:text-gray-300'}"
        >
          {range.label}
        </button>
      {/each}
    </div>
  </div>

  {#if data.length === 0}
    <!-- Empty state -->
    <div class="flex flex-col items-center justify-center h-40 gap-2 text-center">
      <svg class="w-8 h-8 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"
          d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
      </svg>
      <p class="text-gray-600 text-sm">Noch keine Verlaufsdaten</p>
      <p class="text-gray-700 text-xs">Daten werden beim nächsten Indexierungslauf gesammelt</p>
    </div>
  {:else}
    <!-- Chart canvas -->
    <div style="height: 200px; position: relative;">
      <canvas bind:this={canvas}></canvas>
    </div>

    <!-- Change summary below chart -->
    {#if data.length >= 2}
      {@const first = data[0]}
      {@const last  = data[data.length - 1]}
      {#if first && last}
        {@const diff = last.deduplicated_size - first.deduplicated_size}
        {@const pct  = first.deduplicated_size > 0
          ? ((diff / first.deduplicated_size) * 100).toFixed(1)
          : '0'}
        <div class="flex items-center gap-4 mt-3 pt-3 border-t border-gray-800">
          <div class="text-[11px] text-gray-500">
            Zeitraum: <span class="text-gray-300">
              {new Date(first.recorded_at * 1000).toLocaleDateString('de-DE')}
              –
              {new Date(last.recorded_at * 1000).toLocaleDateString('de-DE')}
            </span>
          </div>
          <div class="ml-auto flex items-center gap-1.5 text-[11px]">
            <span class="text-gray-500">Änderung:</span>
            <span class="{diff > 0
                ? 'text-amber-400'
                : diff < 0
                  ? 'text-emerald-400'
                  : 'text-gray-400'} font-medium tabular-nums">
              {diff > 0 ? '+' : ''}{formatBytes(diff)}
              ({diff > 0 ? '+' : ''}{pct}%)
            </span>
          </div>
        </div>
      {/if}
    {/if}
  {/if}
</div>
