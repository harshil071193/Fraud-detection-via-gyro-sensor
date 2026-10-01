/* Dashboard UI: loads two logs, runs LogEngine.analyze on each and renders every section. */
(function () {
  'use strict';

  const E = window.LogEngine;
  const H = E.helpers;
  const { finite, wrap180, norm360 } = H;
  const DEG = E.DEG;

  const COLORS = {
    a: '#2dd4bf',
    b: '#fb7185',
    ideal: '#a78bfa',
    ok: '#34d399',
    warn: '#fbbf24',
    bad: '#f87171',
    grid: 'rgba(148,163,184,0.12)',
    text: '#cbd5e1',
    muted: '#8193b2',
    lane: 'rgba(148,163,184,0.10)',
  };
  const SLOTS = ['a', 'b'];

  const state = {
    raw: { a: null, b: null },
    names: { a: '', b: '' },
    files: { a: '', b: '' },
    embedded: null,
    gapThreshold: 0.5,
    res: { a: null, b: null },
    charts: [],
  };

  // ---------- small helpers ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (v, d = 1, unit = '') => (finite(v) ? `${v.toFixed(d)}${unit}` : '–');
  const fmtSigned = (v, d = 1, unit = '') => (finite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(d)}${unit}` : '–');
  const fmtDur = (s) => {
    if (!finite(s)) return '–';
    const m = Math.floor(s / 60);
    const r = s - m * 60;
    return m ? `${m}m ${r.toFixed(0).padStart(2, '0')}s` : `${s.toFixed(1)}s`;
  };
  const color = (slot) => COLORS[slot];
  const levelClass = (lvl) => ({ ok: 'txt-ok', warn: 'txt-warn', bad: 'txt-bad' })[lvl] || '';
  const facingLevel = (v) => (!finite(v) ? 'na' : Math.abs(v) <= 30 ? 'ok' : Math.abs(v) <= 60 ? 'warn' : 'bad');
  const levelColor = (lvl) => ({ ok: COLORS.ok, warn: COLORS.warn, bad: COLORS.bad })[lvl] || COLORS.muted;
  const platformLabel = (res) => {
    const p = res.platform;
    const name = p.platform === 'ios' ? 'iOS' : p.platform === 'android' ? 'Android' : 'unknown platform';
    return p.source === 'metadata' ? name : `${name} (${p.platform === 'unknown' ? 'not in metadata' : 'detected'})`;
  };
  const alpha = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };

  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show${isError ? ' error' : ''}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (el.className = 'toast'), isError ? 6000 : 2500);
  }

  function chart(id, config) {
    const el = $(id);
    if (!el) return null;
    const c = new Chart(el, config);
    state.charts.push(c);
    return c;
  }

  function setupChartDefaults() {
    Chart.defaults.color = COLORS.text;
    Chart.defaults.borderColor = COLORS.grid;
    Chart.defaults.font.family = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    Chart.defaults.font.size = 11;
    Chart.defaults.plugins.legend.labels.usePointStyle = true;
    Chart.defaults.plugins.legend.labels.boxWidth = 8;
    Chart.defaults.plugins.tooltip.backgroundColor = '#0f172a';
    Chart.defaults.plugins.tooltip.borderColor = 'rgba(148,163,184,0.25)';
    Chart.defaults.plugins.tooltip.borderWidth = 1;
    Chart.defaults.animation.duration = 350;
  }

  function scatterOptions(xTitle, yTitle, extra) {
    const opts = {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const r = ctx.raw || {};
              if (r.label) return `${ctx.dataset.label}: ${r.label}`;
              return `${ctx.dataset.label}: ${finite(r.y) ? r.y.toFixed(2) : '–'} @ ${finite(r.x) ? r.x.toFixed(1) : '–'} s`;
            },
          },
        },
      },
      scales: {
        x: { type: 'linear', title: { display: true, text: xTitle } },
        y: { title: { display: true, text: yTitle } },
      },
      elements: { point: { radius: 0 }, line: { borderWidth: 1.4, tension: 0.15 } },
    };
    return Object.assign(opts, extra || {});
  }

  // Downsampled {x,y} series aligned to t0; inserts nulls at data gaps so the line breaks there.
  function series(rows, valueFn, t0, gapThr, maxPts) {
    const out = [];
    if (!rows || !rows.length) return out;
    const step = Math.max(1, Math.ceil(rows.length / (maxPts || 1400)));
    let prevT = null;
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      const v = valueFn(r, i);
      if (prevT != null && r.t - prevT > gapThr * Math.max(1, step / 2)) out.push({ x: prevT - t0 + 0.01, y: null });
      if (finite(v)) out.push({ x: +(r.t - t0).toFixed(3), y: +v.toFixed(4) });
      prevT = r.t;
    }
    return out;
  }

  function movingAverage(rows, field, w) {
    const out = new Array(rows.length);
    let acc = 0;
    let cnt = 0;
    const q = [];
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][field];
      q.push(v);
      if (finite(v)) {
        acc += v;
        cnt++;
      }
      if (q.length > w) {
        const old = q.shift();
        if (finite(old)) {
          acc -= old;
          cnt--;
        }
      }
      out[i] = cnt ? acc / cnt : NaN;
    }
    return out;
  }

  function captureMarkers(res, slot, t0, yFn) {
    return {
      type: 'scatter',
      label: `${state.names[slot]} photos`,
      data: res.captures.map((c, i) => ({ x: c.t - t0, y: yFn(c, i), label: `${i + 1}. ${c.name} (${(c.t - t0).toFixed(1)} s)` })),
      pointStyle: 'triangle',
      pointRadius: 6,
      pointHoverRadius: 8,
      backgroundColor: color(slot),
      borderColor: '#0b1020',
      borderWidth: 1,
      showLine: false,
    };
  }

  // ---------- loading ----------
  function readEmbedded(slot) {
    const el = $(`log-${slot}`);
    if (!el) return null;
    const txt = el.textContent.trim();
    if (!txt || txt.startsWith('__LOG_')) return null;
    try {
      return { json: JSON.parse(txt), name: el.dataset.name || `Log ${slot.toUpperCase()}`, file: el.dataset.file || '' };
    } catch (e) {
      toast(`Could not read the included log ${slot.toUpperCase()}: ${e.message}`, true);
      return null;
    }
  }

  function loadEmbedded() {
    state.embedded = state.embedded || { a: readEmbedded('a'), b: readEmbedded('b') };
    SLOTS.forEach((s) => {
      const emb = state.embedded[s];
      state.raw[s] = emb ? emb.json : null;
      state.names[s] = emb ? emb.name : `Log ${s.toUpperCase()}`;
      state.files[s] = emb ? emb.file : 'no file loaded';
    });
  }

  async function loadFile(slot, file) {
    try {
      const json = JSON.parse(await file.text());
      E.analyze(json, { name: 'check', fileName: file.name });
      state.raw[slot] = json;
      state.files[slot] = file.name;
      state.names[slot] = guessName(json, file.name, slot);
      return true;
    } catch (e) {
      toast(`${file.name}: ${e.message}`, true);
      return false;
    }
  }

  function guessName(json, fileName, slot) {
    const m = json && json.metadata;
    const when = m && m['recording time'] ? ` · ${m['recording time']}` : '';
    const base = fileName.replace(/\.json$/i, '').replace(/^sensor_log_/, '');
    return `Log ${slot.toUpperCase()} (${base.slice(0, 8)}${when})`;
  }

  function syncLoaderUi() {
    SLOTS.forEach((s) => {
      const up = s.toUpperCase();
      $(`name${up}`).value = state.names[s];
      $(`file${up}`).textContent = state.files[s];
    });
  }

  function setupLoader() {
    SLOTS.forEach((s) => {
      const up = s.toUpperCase();
      $(`input${up}`).addEventListener('change', async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (f && (await loadFile(s, f))) render();
        ev.target.value = '';
      });
      $(`name${up}`).addEventListener('change', (ev) => {
        state.names[s] = ev.target.value || `Log ${up}`;
        render();
      });
      const slotEl = $(`slot${up}`);
      slotEl.addEventListener('dragover', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        slotEl.classList.add('dragover');
      });
      slotEl.addEventListener('dragleave', () => slotEl.classList.remove('dragover'));
      slotEl.addEventListener('drop', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        slotEl.classList.remove('dragover');
        $('dropOverlay').classList.remove('show');
        const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f && (await loadFile(s, f))) render();
      });
    });

    let depth = 0;
    window.addEventListener('dragenter', (ev) => {
      if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes('Files')) return;
      depth++;
      $('dropOverlay').classList.add('show');
    });
    window.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) $('dropOverlay').classList.remove('show');
    });
    window.addEventListener('dragover', (ev) => ev.preventDefault());
    window.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      depth = 0;
      $('dropOverlay').classList.remove('show');
      const files = Array.from((ev.dataTransfer && ev.dataTransfer.files) || []).filter((f) => /json/i.test(f.type) || /\.json$/i.test(f.name));
      if (!files.length) return;
      let ok = false;
      if (files.length === 1) ok = await loadFile('b', files[0]);
      else {
        const okA = await loadFile('a', files[0]);
        const okB = await loadFile('b', files[1]);
        ok = okA || okB;
      }
      if (ok) {
        render();
        toast(files.length === 1 ? `Loaded ${files[0].name} as log B` : 'Loaded two logs as A and B');
      }
    });

    $('swapBtn').addEventListener('click', () => {
      ['raw', 'names', 'files'].forEach((k) => {
        const t = state[k].a;
        state[k].a = state[k].b;
        state[k].b = t;
      });
      render();
    });
    $('resetBtn').addEventListener('click', () => {
      loadEmbedded();
      render();
      toast('Reset to the included logs');
    });

    $('gapSlider').addEventListener('input', (ev) => {
      $('gapValue').textContent = `${(+ev.target.value).toFixed(1)} s`;
    });
    $('gapSlider').addEventListener('change', (ev) => {
      state.gapThreshold = +ev.target.value;
      render();
    });
  }

  // ---------- render orchestration ----------
  function render() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
    syncLoaderUi();
    SLOTS.forEach((s) => {
      state.res[s] = null;
      if (!state.raw[s]) return;
      try {
        state.res[s] = E.analyze(state.raw[s], { name: state.names[s], fileName: state.files[s], gapThreshold: state.gapThreshold });
      } catch (e) {
        toast(e.message, true);
      }
    });
    const { a, b } = state.res;
    if (!a || !b) {
      $('verdictCards').innerHTML = '<div class="card">Load two sensor_log JSON files to compare.</div>';
      return;
    }
    renderVerdict(a, b);
    renderWarnings(a, b);
    renderInsights(a, b);
    renderTiming(a, b);
    renderCompleteness(a, b);
    renderCircle(a, b);
    renderMotion(a, b);
    renderCaptures(a, b);
    renderAccuracy(a, b);
    renderSignals(a, b);
    renderRecommendations(a, b);
  }

  // ---------- verdict ----------
  function gauge(score, lvl) {
    const r = 46;
    const c = 2 * Math.PI * r;
    if (lvl === 'na') {
      return `<svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="Not enough data for a fraud score">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(148,163,184,0.15)" stroke-width="12" stroke-dasharray="4 6"/>
        <text x="60" y="64" text-anchor="middle" font-size="30" font-weight="800" fill="${COLORS.muted}">–</text>
        <text x="60" y="84" text-anchor="middle" font-size="10" fill="${COLORS.muted}">no score</text>
      </svg>`;
    }
    const pct = Math.max(0, Math.min(100, score)) / 100;
    return `<svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="Fraud risk ${score} of 100">
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(148,163,184,0.15)" stroke-width="12"/>
      <circle cx="60" cy="60" r="${r}" fill="none" stroke="${levelColor(lvl)}" stroke-width="12" stroke-linecap="round"
        stroke-dasharray="${(c * pct).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"/>
      <text x="60" y="62" text-anchor="middle" font-size="30" font-weight="800" fill="#e2e8f0">${score}</text>
      <text x="60" y="82" text-anchor="middle" font-size="10" fill="${COLORS.muted}">/ 100 risk</text>
    </svg>`;
  }

  function kpi(label, value, lvl) {
    return `<div class="kpi"><div class="k">${esc(label)}</div><div class="v ${lvl || ''}">${value}</div></div>`;
  }

  function renderVerdict(a, b) {
    const card = (res, slot) => {
      const m = res.meta;
      const f = res.fraud;
      const cp = res.camProgress;
      const ring = res.ring;
      const summary =
        f.level === 'na'
          ? 'Not enough data to judge this inspection. See the warnings below.'
          : f.level === 'bad'
            ? 'The photos do not look like one walk around one car.'
            : f.level === 'warn'
              ? 'Some signals are unusual; review the photos manually.'
              : 'Photos follow one consistent walk around the car.';
      const partial =
        !f.insufficient && f.availableWeight < f.totalWeight
          ? `<div class="small">Score based on ${f.availableWeight} of ${f.totalWeight} signal weight.</div>`
          : '';
      return `<div class="card verdict" style="--accent:${color(slot)}">
        <div class="verdict-head"><div class="tag">${slot.toUpperCase()}</div>
          <div><div class="vname">${esc(state.names[slot])}</div>
          <div class="vfile">${esc(state.files[slot])} · ${esc(m['device name'] || '?')} · app ${esc(m.appVersion || '?')} · orientation ${esc(m.orientationSource || '?')}${res.timing.startedAt ? ` · ${esc(res.timing.startedAt.toLocaleString())}` : ''}</div></div>
          <span class="platform-tag ${res.platform.platform}">${esc(platformLabel(res))}</span>
        </div>
        <div class="verdict-body">${gauge(f.score, f.level)}
          <div><span class="badge ${f.level}">${esc(f.verdict)}</span><div class="verdict-summary">${summary}</div>${partial}</div>
        </div>
        <div class="kpis">
          ${kpi('Recording length', fmtDur(res.timing.duration))}
          ${kpi('Photo span', fmtDur(res.timing.span))}
          ${kpi('Photos', res.captures.length)}
          ${kpi('Rows logged', res.totalRows.toLocaleString())}
          ${kpi('Data gaps', res.stats.Orientation ? res.stats.Orientation.gaps.length : '–', res.stats.Orientation && res.stats.Orientation.gaps.length ? 'warn' : 'ok')}
          ${kpi('Camera sweep', cp ? `${cp.net.toFixed(0)}°` : '–', cp ? (cp.net >= 280 ? 'ok' : cp.net >= 180 ? 'warn' : 'bad') : '')}
          ${kpi('Heading reversals', cp ? cp.reversals : '–', cp ? (cp.reversals === 0 ? 'ok' : cp.reversals === 1 ? 'warn' : 'bad') : '')}
          ${kpi('Camera → car centre', ring ? `${ring.facingMeanAbs.toFixed(0)}°` : '–', ring ? facingLevel(ring.facingMeanAbs) : '')}
          ${kpi('Ring size', ring ? `${ring.length.toFixed(1)}×${ring.width.toFixed(1)} m` : '–')}
          ${kpi('Gyro mean', `${fmt(res.motion.gyroMean, 2)} rad/s`, res.motion.gyroMean > 0.6 ? 'bad' : res.motion.gyroMean > 0.45 ? 'warn' : 'ok')}
        </div>
      </div>`;
    };
    $('verdictCards').innerHTML = card(a, 'a') + card(b, 'b');
  }

  function renderWarnings(a, b) {
    const items = [];
    SLOTS.forEach((s) => {
      const res = state.res[s];
      res.warnings.forEach((w) => items.push({ level: w.level, slot: s, text: w.text }));
    });
    const pa = a.platform.platform;
    const pb = b.platform.platform;
    if (pa !== pb) {
      items.unshift({
        level: 'warn',
        text: `The two logs come from different platforms (A: ${platformLabel(a)}, B: ${platformLabel(b)}). Sample rates, acceleration scale and sensor noise differ between Android and iOS, so compare timing and walk-around signals rather than raw sensor values.`,
      });
    } else if ((a.meta['device name'] || '') !== (b.meta['device name'] || '')) {
      items.push({ level: 'info', text: `Different devices: A ${a.meta['device name'] || '?'}, B ${b.meta['device name'] || '?'}.` });
    }
    if ((a.meta.appVersion || '') !== (b.meta.appVersion || '')) {
      items.push({ level: 'info', text: `Different app versions: A ${a.meta.appVersion || '?'}, B ${b.meta.appVersion || '?'}.` });
    }
    const order = { bad: 0, warn: 1, info: 2 };
    items.sort((x, y) => order[x.level] - order[y.level]);
    $('warnings').innerHTML = items.length
      ? `<div class="card warnings"><h3>Data notes and warnings</h3><ul>${items
          .map(
            (w) =>
              `<li class="w-${w.level}"><span class="pill ${w.level === 'bad' ? 'fail' : w.level === 'warn' ? 'warn' : 'na'}">${w.level === 'bad' ? 'problem' : w.level === 'warn' ? 'warning' : 'note'}</span>${w.slot ? `<span class="col-${w.slot}"><strong>${w.slot.toUpperCase()}</strong></span> · ` : ''}${esc(w.text)}</li>`,
          )
          .join('')}</ul></div>`
      : `<div class="card warnings"><h3>Data notes and warnings</h3><p class="txt-ok" style="margin:0">Both logs are complete: same platform and device, recognised photo labels, no retakes.</p></div>`;
  }

  function renderInsights(a, b) {
    const nA = `<span class="col-a">${esc(state.names.a)}</span>`;
    const nB = `<span class="col-b">${esc(state.names.b)}</span>`;
    const items = [];
    const sc = (f) => (f.insufficient ? '–' : f.score);
    items.push(
      `Fraud risk: ${nA} (${esc(platformLabel(a))}) scores <strong>${sc(a.fraud)}</strong> (${esc(a.fraud.verdict)}), ${nB} (${esc(platformLabel(b))}) scores <strong>${sc(b.fraud)}</strong> (${esc(b.fraud.verdict)}).`,
    );
    if (a.camProgress && b.camProgress) {
      items.push(
        `Camera heading: ${nA} turned <strong>${a.camProgress.net.toFixed(0)}°</strong> ${a.camProgress.dirLabel} with <strong>${a.camProgress.reversals}</strong> reversals; ${nB} turned <strong>${b.camProgress.net.toFixed(0)}°</strong> with <strong>${b.camProgress.reversals}</strong> reversals. A full walk-around turns about 315° without reversing.`,
      );
    }
    if (a.ring && b.ring) {
      items.push(
        `At each photo the camera pointed on average <strong>${a.ring.facingMeanAbs.toFixed(0)}°</strong> (${nA}) and <strong>${b.ring.facingMeanAbs.toFixed(0)}°</strong> (${nB}) away from the centre of the walked ring, where the car should be.`,
      );
    }
    items.push(
      `Timing: photo span ${nA} <strong>${fmtDur(a.timing.span)}</strong> vs ${nB} <strong>${fmtDur(b.timing.span)}</strong>; both spent about ${fmtDur(a.timing.preCapture)} / ${fmtDur(b.timing.preCapture)} before the first photo. Slowest step: ${esc(a.timing.slowest ? a.timing.slowest.name : '–')} (${fmt(a.timing.slowest && a.timing.slowest.interval)} s) vs ${esc(b.timing.slowest ? b.timing.slowest.name : '–')} (${fmt(b.timing.slowest && b.timing.slowest.interval)} s).`,
    );
    if (a.checks.accTotal.unitBug || b.checks.accTotal.unitBug) {
      items.push(
        `<span class="txt-bad">Implementation bug:</span> total acceleration is about ${fmt(a.checks.accTotal.raw, 0)} m/s² instead of 9.81 — Android values are multiplied by G twice. Linear acceleration is wrong for the same reason.`,
      );
    }
    const oa = a.stats.Orientation;
    const ob = b.stats.Orientation;
    if (oa && ob) {
      items.push(
        `Data gaps over ${state.gapThreshold.toFixed(1)} s: ${oa.gaps.length} (${nA}) and ${ob.gaps.length} (${nB}), longest ${oa.longest.toFixed(1)} s / ${ob.longest.toFixed(1)} s, recurring about every ${fmt(a.gapPeriod, 0)}–${fmt(b.gapPeriod, 0)} s across all sensors at once. Native orientation runs at ${oa.rate.toFixed(1)} Hz of the ${oa.targetHz.toFixed(0)} Hz target.`,
      );
    }
    items.push(
      `The compass (<code>magneticBearing</code>) disagrees with the camera heading by ${fmt(a.compassAgreement.atCaptures, 0)}° / ${fmt(b.compassAgreement.atCaptures, 0)}° at photos, because it is not tilt-compensated. This page uses the quaternion heading instead.`,
    );
    $('insights').innerHTML = items.map((i) => `<li>${i}</li>`).join('');
  }

  // ---------- timing ----------
  function renderTiming(a, b) {
    const maxDur = Math.max(a.timing.duration, b.timing.duration) || 1;
    const W = 1100;
    const left = 150;
    const bar = (res, slot, y) => {
      const sx = (t) => left + (t / maxDur) * (W - left - 20);
      const t = res.timing;
      const caps = res.captures;
      const first = caps.length ? caps[0].t : 0;
      const last = caps.length ? caps[caps.length - 1].t : 0;
      let s = `<text x="0" y="${y + 17}" fill="${color(slot)}" font-size="13" font-weight="700">${esc(state.names[slot]).slice(0, 22)}</text>`;
      s += `<rect x="${sx(0)}" y="${y}" width="${sx(t.duration) - sx(0)}" height="26" rx="6" fill="rgba(148,163,184,0.12)"/>`;
      s += `<rect x="${sx(first)}" y="${y}" width="${Math.max(2, sx(last) - sx(first))}" height="26" rx="6" fill="${alpha(color(slot), 0.35)}"/>`;
      caps.forEach((c, i) => {
        s += `<line x1="${sx(c.t)}" x2="${sx(c.t)}" y1="${y - 2}" y2="${y + 28}" stroke="${color(slot)}" stroke-width="2"><title>${i + 1}. ${esc(c.name)} at ${c.t.toFixed(1)} s</title></line>`;
        s += `<text x="${sx(c.t)}" y="${y - 6}" text-anchor="middle" fill="${COLORS.muted}" font-size="9">${i + 1}</text>`;
      });
      s += `<text x="${(sx(0) + sx(first)) / 2}" y="${y + 17}" text-anchor="middle" fill="${COLORS.text}" font-size="11">before photos ${fmtDur(t.preCapture)}</text>`;
      s += `<text x="${sx(t.duration) + 4}" y="${y + 17}" fill="${COLORS.muted}" font-size="11">${fmtDur(t.duration)}</text>`;
      return s;
    };
    let axis = '';
    for (let s = 0; s <= maxDur; s += 10) {
      const x = left + (s / maxDur) * (W - left - 20);
      axis += `<line x1="${x}" x2="${x}" y1="18" y2="122" stroke="${COLORS.grid}"/><text x="${x}" y="136" text-anchor="middle" fill="${COLORS.muted}" font-size="10">${s}s</text>`;
    }
    $('phaseBars').innerHTML = `<h3>Recording phases</h3><svg viewBox="0 0 ${W + 40} 142">${axis}${bar(a, 'a', 30)}${bar(b, 'b', 86)}</svg>
      <div class="legend"><span><i style="background:rgba(148,163,184,0.3)"></i>Before / after photos (instructions, setup)</span><span><i style="background:${alpha(COLORS.a, 0.6)}"></i>Photo span (first to last photo)</span><span>Numbers = photo order</span></div>`;

    const n = Math.max(a.captures.length, b.captures.length);
    const labels = [];
    for (let i = 1; i < n; i++) {
      const ref = a.captures[i] && a.captures[i - 1] ? a : b;
      labels.push(`${ref.captures[i - 1].short}→${ref.captures[i].short}`);
    }
    chart('chartIntervals', {
      type: 'bar',
      data: {
        labels,
        datasets: SLOTS.map((s) => ({
          label: state.names[s],
          data: state.res[s].captures.slice(1).map((c) => +c.interval.toFixed(2)),
          backgroundColor: alpha(color(s), 0.7),
          borderRadius: 4,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { title: { display: true, text: 'seconds' } } },
        plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw} s` } } },
      },
    });

    const rows = [
      ['Recording length', a.timing.duration, b.timing.duration, ' s', 1],
      ['Before first photo', a.timing.preCapture, b.timing.preCapture, ' s', 1],
      ['Photo span', a.timing.span, b.timing.span, ' s', 1],
      ['After last photo', a.timing.postCapture, b.timing.postCapture, ' s', 1],
      ['Mean time between photos', a.timing.intervalMean, b.timing.intervalMean, ' s', 1],
      ['Median time between photos', a.timing.intervalMedian, b.timing.intervalMedian, ' s', 1],
      ['Slowest step', a.timing.slowest && a.timing.slowest.interval, b.timing.slowest && b.timing.slowest.interval, ' s', 1, a.timing.slowest, b.timing.slowest],
      ['Fastest step', a.timing.fastest && a.timing.fastest.interval, b.timing.fastest && b.timing.fastest.interval, ' s', 1, a.timing.fastest, b.timing.fastest],
      ['Unevenness (CV)', a.timing.intervalCv, b.timing.intervalCv, '', 2],
      ['Rows logged', a.totalRows, b.totalRows, '', 0],
    ];
    $('timingTable').innerHTML = `<table><thead><tr><th>Metric</th><th class="num col-a">A</th><th class="num col-b">B</th><th class="num">B − A</th></tr></thead><tbody>${rows
      .map(([label, va, vb, unit, digits, ca, cb]) => {
        const extraA = ca ? `<div class="small">${esc(ca.name)}</div>` : '';
        const extraB = cb ? `<div class="small">${esc(cb.name)}</div>` : '';
        return `<tr><td>${label}</td><td class="num">${fmt(va, digits, unit)}${extraA}</td><td class="num">${fmt(vb, digits, unit)}${extraB}</td><td class="num">${fmtSigned(vb - va, digits, unit)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  // ---------- completeness ----------
  function timelineSvg(res, slot, maxDur) {
    const names = res.sensorNames;
    const W = 1100;
    const left = 140;
    const top = 26;
    const laneH = 20;
    const H2 = top + names.length * (laneH + 6) + 24;
    const sx = (t) => left + (t / maxDur) * (W - left - 10);
    let s = '';
    for (let t = 0; t <= maxDur; t += 10) {
      s += `<line x1="${sx(t)}" x2="${sx(t)}" y1="${top - 6}" y2="${H2 - 20}" stroke="${COLORS.grid}"/><text x="${sx(t)}" y="${H2 - 6}" fill="${COLORS.muted}" font-size="10" text-anchor="middle">${t}s</text>`;
    }
    names.forEach((n, i) => {
      const st = res.stats[n];
      const y = top + i * (laneH + 6);
      s += `<text x="${left - 8}" y="${y + 14}" text-anchor="end" fill="${COLORS.text}" font-size="11">${n}</text>`;
      s += `<rect x="${sx(0)}" y="${y}" width="${sx(res.timing.duration) - sx(0)}" height="${laneH}" rx="4" fill="${COLORS.lane}"/>`;
      if (st.n > 1) {
        s += `<rect x="${sx(st.first)}" y="${y}" width="${Math.max(1, sx(st.last) - sx(st.first))}" height="${laneH}" rx="4" fill="${alpha(color(slot), 0.28)}"/>`;
      }
      st.gaps.forEach((g) => {
        s += `<rect x="${sx(g.start)}" y="${y - 1}" width="${Math.max(2, sx(g.end) - sx(g.start))}" height="${laneH + 2}" rx="2" fill="${alpha(COLORS.bad, 0.85)}"><title>${n}: no data ${g.start.toFixed(1)}–${g.end.toFixed(1)} s (${g.dur.toFixed(2)} s)</title></rect>`;
      });
    });
    res.captures.forEach((c, i) => {
      s += `<line x1="${sx(c.t)}" x2="${sx(c.t)}" y1="${top - 6}" y2="${H2 - 20}" stroke="#e2e8f0" stroke-opacity="0.55" stroke-dasharray="3 3"><title>${i + 1}. ${esc(c.name)} at ${c.t.toFixed(1)} s</title></line>`;
      s += `<text x="${sx(c.t)}" y="${top - 10}" fill="#e2e8f0" font-size="10" text-anchor="middle">${i + 1}</text>`;
    });
    return `<div class="timeline-title"><h3><span class="col-${slot}">${slot.toUpperCase()}</span> · ${esc(state.names[slot])}</h3><span class="hint">${res.captures.length} photos · ${fmtDur(res.timing.duration)} · gaps repeat every ~${fmt(res.gapPeriod, 1)} s</span></div><svg viewBox="0 0 ${W} ${H2}">${s}</svg>`;
  }

  function renderCompleteness(a, b) {
    $('gapSlider').value = state.gapThreshold;
    $('gapValue').textContent = `${state.gapThreshold.toFixed(1)} s`;
    const maxDur = Math.max(a.timing.duration, b.timing.duration) || 1;
    $('timelineA').innerHTML = timelineSvg(a, 'a', maxDur);
    $('timelineB').innerHTML = timelineSvg(b, 'b', maxDur);

    const names = Array.from(new Set(a.sensorNames.concat(b.sensorNames)));
    const rateCell = (st) => {
      if (!st || st.n < 2) return '<td class="num txt-muted">–</td>';
      const r = st.rate / st.targetHz;
      const cls = r >= 0.9 ? 'txt-ok' : r >= 0.6 ? 'txt-warn' : 'txt-bad';
      return `<td class="num ${cls}">${st.rate.toFixed(1)} Hz<div class="small">${(r * 100).toFixed(0)}% of ${st.targetHz.toFixed(0)}</div></td>`;
    };
    const cells = (st) =>
      !st
        ? '<td class="num txt-muted" colspan="5">not recorded</td>'
        : `${rateCell(st)}<td class="num">${st.n.toLocaleString()}</td><td class="num ${st.gaps.length ? 'txt-warn' : 'txt-ok'}">${st.gaps.length}<div class="small">longest ${st.longest.toFixed(1)} s</div></td><td class="num">${fmt(st.coverage * 100, 1)}%</td><td class="num">${fmt(st.burst * 100, 1)}%</td>`;
    $('streamTable').innerHTML = `<table><thead>
      <tr><th></th><th colspan="5" class="col-a">A · ${esc(state.names.a)}</th><th colspan="5" class="col-b">B · ${esc(state.names.b)}</th></tr>
      <tr><th>Sensor</th>${'<th class="num">Rate</th><th class="num">Samples</th><th class="num">Gaps</th><th class="num">Coverage</th><th class="num">Bursts &lt;5ms</th>'.repeat(2)}</tr></thead>
      <tbody>${names.map((n) => `<tr><td><strong>${n}</strong><div class="small">${E.NATIVE_SENSORS.includes(n) ? 'native module' : n === 'Location' ? 'GPS' : 'react-native-sensors'}</div></td>${cells(a.stats[n])}${cells(b.stats[n])}</tr>`).join('')}</tbody></table>`;

    const chips = (res, slot) => {
      const st = res.stats.Orientation;
      if (!st) return '';
      const list = st.gaps
        .map((g) => {
          const near = res.captures.some((c) => g.end >= c.t - 1.5 && g.start <= c.t + 1.5);
          return `<span class="chip${near ? ' near' : ''}" title="${near ? 'within 1.5 s of a photo' : ''}">${g.start.toFixed(1)}–${g.end.toFixed(1)} s · ${g.dur.toFixed(1)} s</span>`;
        })
        .join('');
      return `<div><h3><span class="col-${slot}">${slot.toUpperCase()}</span> native orientation gaps</h3><div class="chips">${list || '<span class="txt-ok">none</span>'}</div><div class="small" style="margin-top:6px">Outlined chips are within 1.5 s of a photo.</div></div>`;
    };
    $('gapLists').innerHTML = chips(a, 'a') + chips(b, 'b');
  }

  // ---------- circle around the car ----------
  function arrowDefs(id, fill) {
    return `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${fill}"/></marker>`;
  }

  function mapSvg(res, slot, half) {
    const S = 460;
    const c = S / 2;
    const k = (S / 2 - 24) / half;
    const X = (e) => c + e * k;
    const Y = (n) => c - n * k;
    const col = color(slot);
    let s = `<defs>${arrowDefs(`arr-${slot}`, col)}${arrowDefs(`cam-${slot}`, '#e2e8f0')}</defs>`;
    s += `<rect x="0" y="0" width="${S}" height="${S}" rx="14" fill="rgba(2,6,23,0.35)"/>`;
    const stepM = half > 14 ? 5 : 2;
    for (let m = -Math.floor(half / stepM) * stepM; m <= half; m += stepM) {
      s += `<line x1="${X(m)}" x2="${X(m)}" y1="0" y2="${S}" stroke="${COLORS.grid}"/><line y1="${Y(m)}" y2="${Y(m)}" x1="0" x2="${S}" stroke="${COLORS.grid}"/>`;
    }
    const ring = res.ring;
    if (ring) {
      const ce = ring.centre.e;
      const cn = ring.centre.n;
      s += `<circle cx="${X(ce)}" cy="${Y(cn)}" r="${ring.meanR * k}" fill="none" stroke="${col}" stroke-opacity="0.35" stroke-dasharray="5 5"/>`;
      const deg = (-ring.axisRad * DEG).toFixed(1);
      s += `<g transform="translate(${X(ce)} ${Y(cn)}) rotate(${deg})"><rect x="${-2.3 * k}" y="${-0.95 * k}" width="${4.6 * k}" height="${1.9 * k}" rx="${0.5 * k}" fill="rgba(148,163,184,0.12)" stroke="rgba(226,232,240,0.45)"><title>Typical car footprint 4.6 × 1.9 m, aligned to the ring's long axis</title></rect></g>`;
      s += `<path d="M${X(ce) - 5},${Y(cn)} h10 M${X(ce)},${Y(cn) - 5} v10" stroke="#e2e8f0" stroke-width="1.5"><title>Ring centre</title></path>`;
    }
    if (res.track.length > 1) {
      s += `<polyline points="${res.track.map((p) => `${X(p.e).toFixed(1)},${Y(p.n).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-opacity="0.22" stroke-width="2"/>`;
    }
    const pts = res.captures.filter((c2) => finite(c2.e));
    if (pts.length > 1) {
      s += `<polyline points="${pts.map((p) => `${X(p.e).toFixed(1)},${Y(p.n).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2" marker-mid="url(#arr-${slot})" stroke-opacity="0.85"/>`;
    }
    res.captures.forEach((cp, i) => {
      if (!finite(cp.e)) return;
      const x = X(cp.e);
      const y = Y(cp.n);
      if (finite(cp.cam)) {
        const L = 1.8 * k;
        const x2 = x + Math.sin(cp.cam / DEG) * L;
        const y2 = y - Math.cos(cp.cam / DEG) * L;
        s += `<line x1="${x}" y1="${y}" x2="${x2}" y2="${y2}" stroke="${levelColor(facingLevel(cp.facing))}" stroke-width="2.2" marker-end="url(#cam-${slot})"/>`;
      }
      s += `<circle cx="${x}" cy="${y}" r="10" fill="${col}" stroke="#0b1020" stroke-width="2"><title>${i + 1}. ${esc(cp.name)} · camera ${fmt(cp.cam, 0)}° · off-centre ${fmt(cp.facing, 0)}° · ±${fmt(cp.gpsAcc, 1)} m</title></circle>`;
      s += `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" font-weight="700" fill="#0b1020">${i + 1}</text>`;
    });
    s += `<g transform="translate(${S - 30} 34)"><path d="M0,-18 L7,4 L0,-2 L-7,4 z" fill="#e2e8f0"/><text y="18" text-anchor="middle" fill="#e2e8f0" font-size="11">N</text></g>`;
    s += `<g transform="translate(18 ${S - 18})"><line x1="0" x2="${stepM * k}" y1="0" y2="0" stroke="#e2e8f0" stroke-width="2"/><text x="${(stepM * k) / 2}" y="-6" text-anchor="middle" fill="#e2e8f0" font-size="10">${stepM} m</text></g>`;

    const stats = ring
      ? [
          ['Ring radius', `${ring.meanR.toFixed(1)} m`],
          ['Ring size', `${ring.length.toFixed(1)} × ${ring.width.toFixed(1)} m`],
          ['Area enclosed', `${ring.area.toFixed(1)} m²`],
          ['Loop closure (last→first)', `${ring.closure.toFixed(1)} m`],
          ['Camera within 45° of centre', `${ring.facingWithin45} / ${ring.facingCount}`],
          ['GPS accuracy', `±${fmt(H.median(res.captures.map((c2) => c2.gpsAcc).filter(finite)), 1)} m`],
        ]
      : [['GPS', 'not enough capture positions']];
    return `<div class="card diagram"><h3><span class="col-${slot}">${slot.toUpperCase()}</span> · GPS walk map · ${esc(state.names[slot])}</h3><svg viewBox="0 0 ${S} ${S}">${s}</svg>
      <div class="legend"><span><i style="background:${col}"></i>Photo position (number = order)</span><span><i style="background:${COLORS.ok}"></i>Camera points at centre</span><span><i style="background:${COLORS.warn}"></i>30–60° off</span><span><i style="background:${COLORS.bad}"></i>&gt;60° off</span><span>Grey box = typical car (4.6 × 1.9 m) · + = ring centre · faint line = GPS track</span></div>
      <div class="diagram-stats">${stats.map(([k2, v]) => kpi(k2, v)).join('')}</div></div>`;
  }

  function polarSvg(res, slot) {
    const S = 440;
    const c = S / 2;
    const R = 170;
    const col = color(slot);
    const P = (bearing, r) => [c + r * Math.sin(bearing / DEG), c - r * Math.cos(bearing / DEG)];
    const arc = (b1, b2, r, stroke, width, dash) => {
      const d = wrap180(b2 - b1);
      const [x1, y1] = P(b1, r);
      const [x2, y2] = P(b1 + d, r);
      return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 ${d > 0 ? 1 : 0} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${stroke}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''} stroke-linecap="round"/>`;
    };
    const rPos = R * 0.86;
    const rCam = R * 0.52;
    let s = `<rect x="0" y="0" width="${S}" height="${S}" rx="14" fill="rgba(2,6,23,0.35)"/>`;
    [R, rPos, rCam].forEach((r) => (s += `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${COLORS.grid}"/>`));
    s += `<rect x="${c - 18}" y="${c - 40}" width="36" height="80" rx="10" fill="rgba(148,163,184,0.12)" stroke="rgba(226,232,240,0.35)"/><text x="${c}" y="${c + 4}" text-anchor="middle" fill="${COLORS.muted}" font-size="10">car</text>`;
    const ring = res.ring;
    const caps = res.captures;
    const anchor = ring && finite(caps[0] && caps[0].ringAngle) ? caps[0].ringAngle : 0;
    E.SLOT_ORDER.forEach((sl) => {
      const b = norm360(anchor - sl.slot);
      const [x1, y1] = P(b, R - 6);
      const [x2, y2] = P(b, R + 6);
      const [tx, ty] = P(b, R + 20);
      s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${COLORS.ideal}" stroke-width="2"/><text x="${tx}" y="${ty + 4}" text-anchor="middle" fill="${COLORS.ideal}" font-size="10">${sl.short}</text>`;
    });
    if (ring) {
      const gStart = ring.gapStart;
      s += arc(gStart + 4, gStart + ring.maxGap - 4, R + 2, alpha(COLORS.bad, 0.85), 6);
      const [gx, gy] = P(gStart + ring.maxGap / 2, R - 22);
      s += `<text x="${gx}" y="${gy}" text-anchor="middle" fill="${COLORS.bad}" font-size="10">gap ${ring.maxGap.toFixed(0)}°</text>`;
    }
    const drawSeq = (angleFn, r, prog, hollow) => {
      let out = '';
      const dir = prog ? prog.dir : 1;
      for (let i = 1; i < caps.length; i++) {
        const b1 = angleFn(caps[i - 1]);
        const b2 = angleFn(caps[i]);
        if (!finite(b1) || !finite(b2)) continue;
        const forward = -wrap180(b2 - b1) * dir > -15;
        out += arc(b1, b2, r, forward ? alpha(col, 0.9) : COLORS.bad, forward ? 3 : 4, forward ? '' : '5 4');
      }
      caps.forEach((cp, i) => {
        const b = angleFn(cp);
        if (!finite(b)) return;
        const [x, y] = P(b, r);
        out += hollow
          ? `<circle cx="${x}" cy="${y}" r="9" fill="#0b1020" stroke="${col}" stroke-width="2"><title>${i + 1}. ${esc(cp.name)} · camera-implied position ${b.toFixed(0)}°</title></circle><text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="9" fill="${col}" font-weight="700">${i + 1}</text>`
          : `<circle cx="${x}" cy="${y}" r="10" fill="${col}" stroke="#0b1020" stroke-width="2"><title>${i + 1}. ${esc(cp.name)} · GPS position ${b.toFixed(0)}° around ring</title></circle><text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="10" fill="#0b1020" font-weight="700">${i + 1}</text>`;
      });
      return out;
    };
    s += drawSeq((cp) => cp.ringAngle, rPos, res.posProgress, false);
    s += drawSeq((cp) => (finite(cp.cam) ? norm360(cp.cam + 180) : NaN), rCam, res.camProgress, true);
    const pp = res.posProgress;
    const cp2 = res.camProgress;
    const stats = [
      ['Angular coverage (GPS)', ring ? `${ring.coverage.toFixed(0)}°` : '–'],
      ['Largest uncovered arc', ring ? `${ring.maxGap.toFixed(0)}°` : '–'],
      ['GPS order reversals', pp ? pp.reversals : '–'],
      ['Camera sweep', cp2 ? `${cp2.net.toFixed(0)}° ${cp2.dirLabel}` : '–'],
      ['Camera reversals', cp2 ? cp2.reversals : '–'],
      ['Turned backwards', cp2 ? `${cp2.backward.toFixed(0)}°` : '–'],
    ];
    return `<div class="card diagram"><h3><span class="col-${slot}">${slot.toUpperCase()}</span> · Coverage around the car · ${esc(state.names[slot])}</h3><svg viewBox="0 0 ${S} ${S}">${s}</svg>
      <div class="legend"><span><i style="background:${col}"></i>Outer ring: GPS position around the walked ring</span><span><i style="border:2px solid ${col};background:transparent"></i>Inner ring: where the camera says you stood (heading + 180°)</span><span><i style="background:${COLORS.ideal}"></i>Expected slot (F, FL, L ...)</span><span><i style="background:${COLORS.bad}"></i>Dashed red = turned back · thick red arc = largest uncovered part</span></div>
      <div class="diagram-stats">${stats.map(([k2, v]) => kpi(k2, v)).join('')}</div></div>`;
  }

  function renderCircle(a, b) {
    const ext = (res) => res.captures.filter((c) => finite(c.e)).map((c) => Math.max(Math.abs(c.e), Math.abs(c.n)));
    const half = Math.max(5, Math.min(40, H.maxOf(ext(a).concat(ext(b), [0])) + 2.5));
    $('maps').innerHTML = mapSvg(a, 'a', half) + mapSvg(b, 'b', half);
    $('polars').innerHTML = polarSvg(a, 'a') + polarSvg(b, 'b');

    const ref = a.captures.length >= b.captures.length ? a : b;
    const labels = ref.captures.map((c, i) => `${i + 1}. ${c.short}`);
    const idealSrc = [a, b].find((r) => r.camProgress && r.camProgress.expected.some(finite) && r.fraud.level === 'ok') || ref;
    const ideal = idealSrc.camProgress ? idealSrc.camProgress.expected : [];
    chart('chartProgress', {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Ideal walk-around',
            data: ref.captures.map((_, i) => (finite(ideal[i]) ? ideal[i] : null)),
            borderColor: COLORS.ideal,
            borderDash: [4, 4],
            pointRadius: 3,
            backgroundColor: COLORS.ideal,
          },
          ...SLOTS.map((s) => ({
            label: `${state.names[s]} · camera`,
            data: state.res[s].captures.map((c) => (finite(c.camProgress) ? +c.camProgress.toFixed(1) : null)),
            borderColor: color(s),
            backgroundColor: color(s),
            borderWidth: 2.5,
            pointRadius: 4,
          })),
          ...SLOTS.map((s) => ({
            label: `${state.names[s]} · GPS position`,
            data: state.res[s].captures.map((c) => (finite(c.posProgress) ? +c.posProgress.toFixed(1) : null)),
            borderColor: alpha(color(s), 0.5),
            backgroundColor: alpha(color(s), 0.5),
            borderDash: [2, 3],
            pointRadius: 2,
          })),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { title: { display: true, text: 'degrees turned in walking direction' } } },
        plugins: { tooltip: { callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.raw}°` } } },
      },
    });
  }

  // ---------- motion ----------
  function renderMotion(a, b) {
    const t0 = (res) => (res.captures.length ? res.captures[0].t : 0);
    const thr = state.gapThreshold;
    const xMin = -Math.min(20, Math.max(a.timing.preCapture || 0, b.timing.preCapture || 0));
    const xMax = Math.max(a.timing.span || 0, b.timing.span || 0) + 10;
    const xScale = (title) => ({ type: 'linear', min: xMin, max: xMax, title: { display: true, text: title } });

    const gyroSets = [];
    SLOTS.forEach((s) => {
      const res = state.res[s];
      const rows = res.streams.Gyroscope || [];
      const ma = movingAverage(rows, 'mag', 5);
      gyroSets.push({ type: 'line', label: state.names[s], data: series(rows, (r, i) => ma[i], t0(res), thr), borderColor: color(s), backgroundColor: alpha(color(s), 0.12), fill: true });
      gyroSets.push(captureMarkers(res, s, t0(res), () => 0));
    });
    chart('chartGyro', { type: 'scatter', data: { datasets: gyroSets }, options: scatterOptions('seconds from first photo', 'rad/s', { scales: { x: xScale('seconds from first photo'), y: { min: 0, title: { display: true, text: 'rad/s' } } } }) });

    const accSets = [];
    SLOTS.forEach((s) => {
      const res = state.res[s];
      const lin = res.streams.Accelerometer || [];
      const grav = res.streams.Gravity || [];
      const bug = res.checks.accTotal.unitBug;
      const vals = lin.map((r) => {
        if (!bug) return r.mag;
        const g = H.nearest(grav, r.t, 0.1);
        if (!g) return NaN;
        return Math.hypot((r.x + g.x) / E.G - g.x, (r.y + g.y) / E.G - g.y, (r.z + g.z) / E.G - g.z);
      });
      const tmp = lin.map((r, i) => ({ t: r.t, v: vals[i] }));
      const ma = movingAverage(tmp, 'v', 5);
      accSets.push({ type: 'line', label: `${state.names[s]}${bug ? ' (÷G corrected)' : ''}`, data: series(tmp, (r, i) => ma[i], t0(res), thr), borderColor: color(s) });
      accSets.push(captureMarkers(res, s, t0(res), () => 0));
    });
    chart('chartAcc', { type: 'scatter', data: { datasets: accSets }, options: scatterOptions('seconds from first photo', 'm/s²', { scales: { x: xScale('seconds from first photo'), y: { min: 0, title: { display: true, text: 'm/s²' } } } }) });

    const pitchSets = [];
    SLOTS.forEach((s) => {
      const res = state.res[s];
      const rows = res.streams.Orientation || [];
      pitchSets.push({ type: 'line', label: `${state.names[s]} pitch`, data: series(rows, (r) => r.pitchDeg, t0(res), thr), borderColor: color(s) });
      pitchSets.push({ type: 'line', label: `${state.names[s]} roll`, data: series(rows, (r) => r.rollDeg, t0(res), thr), borderColor: alpha(color(s), 0.55), borderDash: [3, 3] });
      pitchSets.push(captureMarkers(res, s, t0(res), (c) => c.pitch));
    });
    chart('chartPitch', { type: 'scatter', data: { datasets: pitchSets }, options: scatterOptions('seconds from first photo', 'degrees', { scales: { x: xScale('seconds from first photo'), y: { title: { display: true, text: 'degrees' } } } }) });

    const ref = a.captures.length >= b.captures.length ? a : b;
    const stepLabels = ref.captures.slice(1).map((c, i) => `${ref.captures[i].short}→${c.short}`);
    chart('chartSteps', {
      type: 'bar',
      data: {
        labels: stepLabels,
        datasets: [
          ...SLOTS.map((s) => ({ label: `${state.names[s]} · GPS metres`, data: state.res[s].captures.slice(1).map((c) => (finite(c.gpsStep) ? +c.gpsStep.toFixed(2) : null)), backgroundColor: alpha(color(s), 0.75), yAxisID: 'y', borderRadius: 3 })),
          ...SLOTS.map((s) => ({ type: 'line', label: `${state.names[s]} · gyro rotation °`, data: state.res[s].captures.slice(1).map((c) => (finite(c.gyroStepDeg) ? +c.gyroStepDeg.toFixed(0) : null)), borderColor: color(s), backgroundColor: color(s), borderDash: [4, 3], yAxisID: 'y2', pointRadius: 3 })),
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { position: 'left', title: { display: true, text: 'GPS metres between photos' } },
          y2: { position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'gyro rotation (°)' } },
        },
      },
    });

    SLOTS.forEach((s) => {
      const res = state.res[s];
      const up = s.toUpperCase();
      $(`headingTitle${up}`).innerHTML = `Camera heading vs compass · <span class="col-${s}">${up}</span> ${esc(state.names[s])}`;
      const o = res.streams.Orientation || [];
      const comp = res.streams.Compass || [];
      const off = finite(res.compassAgreement.offset) ? res.compassAgreement.offset : 0;
      chart(`chartHeading${up}`, {
        type: 'scatter',
        data: {
          datasets: [
            { label: 'Camera heading (quaternion)', data: series(o, (r) => r.cam, t0(res), 99, 1600), backgroundColor: color(s), pointRadius: 1.4, showLine: false },
            { label: `Compass (offset ${off.toFixed(0)}° removed)`, data: series(comp, (r) => norm360(r.magneticBearing - off), t0(res), 99, 1600), backgroundColor: COLORS.warn, pointRadius: 1.1, showLine: false },
            Object.assign(captureMarkers(res, s, t0(res), (c) => c.cam), { backgroundColor: '#e2e8f0' }),
          ],
        },
        options: scatterOptions('seconds from first photo', 'degrees from north', {
          interaction: { mode: 'nearest', intersect: true },
          scales: { x: xScale('seconds from first photo'), y: { min: 0, max: 360, ticks: { stepSize: 90 }, title: { display: true, text: 'heading (°)' } } },
        }),
      });
    });
  }

  // ---------- per-capture tables ----------
  function renderCaptures(a, b) {
    const table = (res, slot) => {
      const rows = res.captures
        .map((c, i) => {
          const fl = facingLevel(c.facing);
          const expected = res.camProgress ? res.camProgress.expected[i] : NaN;
          const slotErr = finite(c.camProgress) && finite(expected) ? wrap180(c.camProgress - expected) : NaN;
          return `<tr>
            <td class="num">${i + 1}</td>
            <td><strong>${esc(c.name)}</strong><div class="small">${esc(c.label)}</div></td>
            <td class="num">${fmt(c.t, 1)} s</td>
            <td class="num">${finite(c.interval) ? `${c.interval.toFixed(1)} s` : '–'}</td>
            <td class="num">${finite(c.gpsStep) ? `${c.gpsStep.toFixed(1)} m` : '–'}</td>
            <td class="num">${fmt(c.ringAngle, 0, '°')}</td>
            <td class="num">${fmt(c.cam, 0, '°')}</td>
            <td class="num">${fmt(c.camProgress, 0, '°')}<div class="small">ideal ${fmt(expected, 0, '°')}</div></td>
            <td class="num ${Math.abs(slotErr) > 60 ? 'txt-bad' : Math.abs(slotErr) > 30 ? 'txt-warn' : 'txt-ok'}">${fmtSigned(slotErr, 0, '°')}</td>
            <td class="num ${levelClass(fl)}">${fmtSigned(c.facing, 0, '°')}</td>
            <td class="num">${fmt(c.pitch, 0, '°')} / ${fmt(c.roll, 0, '°')}</td>
            <td class="num">${fmt(c.compass, 0, '°')}<div class="small ${Math.abs(c.compassDiff) > 45 ? 'txt-bad' : ''}">${fmtSigned(c.compassDiff, 0, '°')} vs camera</div></td>
            <td class="num">${finite(c.latency) ? `${(c.latency * 1000).toFixed(0)} ms` : '–'}</td>
            <td class="num">±${fmt(c.gpsAcc, 1)} m</td>
          </tr>`;
        })
        .join('');
      return `<h3><span class="col-${slot}">${slot.toUpperCase()}</span> · ${esc(state.names[slot])}</h3><table><thead><tr>
        <th class="num">#</th><th>Photo</th><th class="num">Time</th><th class="num">Since previous</th><th class="num">GPS step</th><th class="num">Ring angle</th>
        <th class="num">Camera heading</th><th class="num">Turned so far</th><th class="num">Slot error</th><th class="num">Camera → centre</th><th class="num">Pitch / roll</th><th class="num">Compass</th><th class="num">Snapshot delay</th><th class="num">GPS acc.</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    };
    $('capturesA').innerHTML = table(a, 'a');
    $('capturesB').innerHTML = table(b, 'b');
  }

  // ---------- accuracy ----------
  function renderAccuracy(a, b) {
    const gp = `${fmt(a.gapPeriod, 0)}–${fmt(b.gapPeriod, 0)} s`;
    const defs = [
      {
        id: 'accTotal',
        title: 'Total acceleration magnitude',
        expected: '≈ 9.81 m/s² (1 g) when handheld',
        why: 'On Android, react-native-sensors already reports m/s², but both apps multiply by G (9.80665) again: boltSA <code>SensorRecorderService.ts</code> lines 292–294 and revamp <code>smartRecordingSensors.ts</code>. Values are about 9.8× too large on Android.',
        fix: 'Multiply by G only on iOS (<code>Platform.OS === \'ios\'</code>), where the library reports g.',
      },
      {
        id: 'accLinear',
        title: 'Linear acceleration (Accelerometer row)',
        expected: '< 2.5 m/s² median',
        why: 'Calculated as TotalAcceleration − Gravity, so it inherits the 9.8× error.',
        fix: 'Fixed automatically once TotalAcceleration is corrected.',
      },
      { id: 'gravity', title: 'Gravity magnitude', expected: '≈ 9.81 m/s²', why: 'Comes from the native module (Android TYPE_GRAVITY / iOS CoreMotion).', fix: 'None needed.' },
      {
        id: 'sumCheck',
        title: 'Gravity + Accelerometer = TotalAcceleration',
        expected: '< 0.5 m/s² residual',
        why: 'Confirms the three rows are written from the same samples. Consistent, even though the scale is wrong.',
        fix: 'None needed.',
      },
      { id: 'qnorm', title: 'Orientation quaternion is unit length', expected: '| |q| − 1 | < 0.01', why: 'A valid rotation; the camera heading on this page is derived from it.', fix: 'None needed.' },
      { id: 'orientationSource', title: 'Orientation source', expected: 'native', why: 'Native rotation vector is far more accurate than the JS fallback.', fix: 'Make sure the native module is in every build.' },
      {
        id: 'rateNative',
        title: 'Native orientation sample rate',
        expected: '≥ 90% of target',
        why: 'The native module throttles to the target rate, but samples reach the log through the JS bridge, and some are lost while JS is busy.',
        fix: 'Buffer samples in native code with sensor timestamps and send them in batches.',
      },
      {
        id: 'rateRN',
        title: 'react-native-sensors sample rate',
        expected: '≥ 90% of target',
        why: 'The 50 ms update interval is only a hint; the effective rate on this device is about 12–14 Hz.',
        fix: 'Move gyroscope and accelerometer into the native module too, or request a faster sensor delay.',
      },
      {
        id: 'gaps',
        title: 'Data gaps over the threshold',
        expected: '0',
        why: `Gaps line up across every sensor, including native ones, and repeat about every ${gp}. That points to the JS thread being blocked (camera capture, image processing), not the sensors stopping.`,
        fix: 'Timestamp and buffer in native code; move heavy capture work off the JS thread.',
      },
      {
        id: 'bursts',
        title: 'Bursty delivery (samples < 5 ms apart)',
        expected: '< 2%',
        why: 'After a stall, queued samples arrive together and all get nearly the same <code>Date.now()</code> timestamp.',
        fix: 'Use the sensor event timestamp instead of the time JS receives the event.',
      },
      { id: 'monotonic', title: 'Timestamps in order', expected: 'no out-of-order, < 1% duplicates', why: 'Duplicates come from the same burst effect.', fix: 'Same fix as bursty delivery.' },
      { id: 'timeConsistency', title: '<code>time</code> vs <code>seconds_elapsed</code>', expected: 'constant offset, spread < 20 ms', why: 'Both come from <code>Date.now()</code>; a constant offset is harmless.', fix: 'None needed.' },
      {
        id: 'compass',
        title: 'Compass agrees with camera heading at photos',
        expected: '< 20° mean difference',
        why: '<code>magneticBearing</code> is calculated from the raw magnetometer x/y without tilt compensation. When the phone is held upright for a photo it no longer matches where the camera points.',
        fix: 'Use the heading from the orientation quaternion (as this page does) or tilt-compensate with gravity.',
      },
      { id: 'latency', title: 'Snapshot timing at photo', expected: '0–500 ms before <code>captured_at</code>', why: 'Each photo stores the latest sample of every sensor.', fix: 'None needed.' },
      {
        id: 'gps',
        title: 'GPS accuracy and rate',
        expected: '≤ 5 m, ≈ 1 Hz',
        why: 'GPS error (±2.5–3 m) is close to the size of a car, so GPS alone cannot prove a walk-around. The camera heading is the stronger signal.',
        fix: 'None needed; keep GPS as supporting evidence.',
      },
      { id: 'captures', title: 'Capture annotations', expected: '10 photos with known labels', why: 'Needed to line the sensors up with each photo.', fix: 'None needed.' },
    ];
    const cell = (chk) =>
      chk ? `<td><span class="pill ${chk.status}">${chk.status === 'na' ? 'n/a' : chk.status}</span><div>${esc(chk.value)}</div></td>` : '<td>–</td>';
    const count = (res) => {
      const c = { pass: 0, warn: 0, fail: 0 };
      Object.values(res.checks).forEach((k) => {
        if (c[k.status] != null) c[k.status]++;
      });
      return `<span class="txt-ok">${c.pass} pass</span> · <span class="txt-warn">${c.warn} warn</span> · <span class="txt-bad">${c.fail} fail</span>`;
    };
    $('accuracyTable').innerHTML = `<div class="small" style="margin-bottom:8px"><span class="col-a">A</span>: ${count(a)} &nbsp;&nbsp; <span class="col-b">B</span>: ${count(b)}</div>
      <table><thead><tr><th>Check</th><th>Expected</th><th class="col-a">A · ${esc(state.names.a)}</th><th class="col-b">B · ${esc(state.names.b)}</th><th>Why / likely cause</th><th>Fix</th></tr></thead>
      <tbody>${defs.map((d) => `<tr><td class="check-title">${d.title}</td><td class="small">${d.expected}</td>${cell(a.checks[d.id])}${cell(b.checks[d.id])}<td class="small">${d.why}</td><td class="small">${d.fix}</td></tr>`).join('')}</tbody></table>`;
  }

  // ---------- fraud signals ----------
  function renderSignals(a, b) {
    const sigCell = (sig) => {
      if (!sig.available) return `<td class="txt-muted">${esc(sig.display)}<div class="small">not counted</div></td>`;
      const pts = sig.weight * sig.score;
      const lvl = sig.score >= 0.66 ? 'bad' : sig.score >= 0.33 ? 'warn' : 'ok';
      return `<td><div class="${levelClass(lvl)}">${esc(sig.display)}</div><div class="bar"><span style="width:${(sig.score * 100).toFixed(0)}%;background:${levelColor(lvl)}"></span></div><div class="small">${pts.toFixed(1)} / ${sig.weight} pts</div></td>`;
    };
    const rows = a.fraud.signals
      .map((sig, i) => {
        const sb = b.fraud.signals[i];
        return `<tr><td class="check-title">${esc(sig.label)}<div class="small">${esc(sig.explain)}</div></td><td class="num">${sig.weight}</td><td class="small">${esc(sig.threshold)}</td>${sigCell(sig)}${sigCell(sb)}</tr>`;
      })
      .join('');
    const total = (f) =>
      `<span class="badge ${f.level}">${f.insufficient ? '–' : f.score} · ${esc(f.verdict)}</span>${f.availableWeight < f.totalWeight ? `<div class="small">based on ${f.availableWeight} of ${f.totalWeight} weight</div>` : ''}`;
    $('signalsTable').innerHTML = `<table><thead><tr><th>Signal</th><th class="num">Weight</th><th>Threshold</th><th class="col-a">A · ${esc(state.names.a)}</th><th class="col-b">B · ${esc(state.names.b)}</th></tr></thead>
      <tbody>${rows}<tr class="total-row"><td>Total risk score</td><td class="num">100</td><td class="small">Signals that cannot be calculated are left out and the score is scaled to the rest.</td><td>${total(a.fraud)}</td><td>${total(b.fraud)}</td></tr></tbody></table>`;
  }

  // ---------- recommendations ----------
  function renderRecommendations(a, b) {
    const oa = a.stats.Orientation;
    const recs = [
      `<strong>Fix the Android acceleration unit bug.</strong> TotalAcceleration is ${fmt(a.checks.accTotal.raw, 0)} m/s² instead of 9.81 because react-native-sensors already returns m/s² on Android and we multiply by G again. Apply the G factor on iOS only. Affects boltSA <code>SensorRecorderService.ts</code> and revamp <code>smartRecordingSensors.ts</code>; linear acceleration is fixed by the same change.`,
      `<strong>Use sensor timestamps, not <code>Date.now()</code>.</strong> ${(a.checks.bursts.raw * 100).toFixed(0)}–${(b.checks.bursts.raw * 100).toFixed(0)}% of gyro samples arrive less than 5 ms apart, which is the JS bridge flushing a backlog. Pass <code>event.timestamp</code> from the native side so the timeline is real even when JS stalls.`,
      `<strong>Remove the recurring gaps.</strong> All sensors stop together for 0.5–4 s about every ${fmt(a.gapPeriod, 0)} s, around photo capture. Buffer samples in the native module and flush them in batches, and keep image processing off the JS thread during recording.`,
      `<strong>Raise the effective sample rate.</strong> Native orientation reaches ${oa ? oa.rate.toFixed(1) : '?'} Hz and react-native-sensors about 12–14 Hz against a ${oa ? oa.targetHz.toFixed(0) : 20} Hz target. Moving gyroscope and accelerometer into the native module (as done for orientation) would fix both.`,
      `<strong>Use the quaternion camera heading for fraud checks.</strong> The logged compass is not tilt-compensated and disagrees with the camera by ${fmt(a.compassAgreement.atCaptures, 0)}–${fmt(b.compassAgreement.atCaptures, 0)}° at photos. Either log a tilt-compensated heading or compute the camera heading from <code>qx, qy, qz, qw</code> as this page does.`,
      `<strong>Add a walk-around check to the app or backend.</strong> The two strongest signals are cheap to compute from the existing annotations: camera heading reversals between photos (A ${a.camProgress ? a.camProgress.reversals : '?'}, B ${b.camProgress ? b.camProgress.reversals : '?'}) and total camera sweep (A ${a.camProgress ? a.camProgress.net.toFixed(0) : '?'}°, B ${b.camProgress ? b.camProgress.net.toFixed(0) : '?'}°). They could warn the user live or flag the inspection for review.`,
      `<strong>Collect more labelled runs before trusting the score.</strong> Record several genuine and fraudulent inspections on different devices, including iOS, then tune the weights and thresholds in <code>src/engine.js</code>.`,
    ];
    $('recommendationList').innerHTML = recs.map((r) => `<li>${r}</li>`).join('');
  }

  // ---------- boot ----------
  function boot() {
    if (!window.Chart) {
      document.body.insertAdjacentHTML('afterbegin', '<div class="card" style="margin:20px">Chart.js failed to load.</div>');
      return;
    }
    setupChartDefaults();
    setupLoader();
    loadEmbedded();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
