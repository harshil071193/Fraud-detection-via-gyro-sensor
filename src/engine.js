/* Sensor log analysis engine. Pure functions, no DOM access, so it also runs under Node. */
(function (root) {
  'use strict';

  const G = 9.80665;
  const DEG = 180 / Math.PI;
  const SENSORS = [
    'TotalAcceleration',
    'Accelerometer',
    'Gravity',
    'Orientation',
    'Gyroscope',
    'Magnetometer',
    'Compass',
    'Location',
  ];
  const VECTOR_SENSORS = ['TotalAcceleration', 'Accelerometer', 'Gravity', 'Gyroscope', 'Magnetometer'];
  const NATIVE_SENSORS = ['Orientation', 'Gravity'];
  const RN_SENSORS = ['TotalAcceleration', 'Accelerometer', 'Gyroscope', 'Magnetometer', 'Compass'];

  // Position of each exterior capture around the car, measured in degrees from the front,
  // in the order the app asks for them (front -> car's left side -> rear -> car's right side).
  const SLOT_ORDER = [
    { key: 'front', short: 'F', name: 'Front', slot: 0 },
    { key: 'front-left', short: 'FL', name: 'Front left', slot: 45 },
    { key: 'left-side', short: 'L', name: 'Left side', slot: 90 },
    { key: 'left-side-rear', short: 'LR', name: 'Left side rear', slot: 112.5 },
    { key: 'rear-left', short: 'RL', name: 'Rear left', slot: 135 },
    { key: 'rear', short: 'R', name: 'Rear', slot: 180 },
    { key: 'rear-right', short: 'RR', name: 'Rear right', slot: 225 },
    { key: 'right-side-rear', short: 'RSR', name: 'Right side rear', slot: 247.5 },
    { key: 'right-side-front', short: 'RSF', name: 'Right side front', slot: 292.5 },
    { key: 'front-right', short: 'FR', name: 'Front right', slot: 315 },
  ];
  const SLOT_EXTRA = [{ key: 'right-side', short: 'RS', name: 'Right side', slot: 270 }];
  const SLOT_BY_KEY = Object.fromEntries(SLOT_ORDER.concat(SLOT_EXTRA).map((s) => [s.key, s]));
  // Interior captures in the order the app asks for them: upload key (sent as `position`) and the
  // name shown on the capture screen (sent as `label`). Older builds label them `<key>-capture.jpg`.
  const INTERIOR_SLOTS = [
    { key: 'passenger-front-side', name: 'Passenger Front Seat' },
    { key: 'passenger-front-door', name: 'Passenger Front Door' },
    { key: 'interior-cabin', name: 'Passenger Rear Seat' },
    { key: 'passenger-rear-door', name: 'Passenger Rear Door' },
    { key: 'dashboard', name: 'Interior Dashboard Left' },
    { key: 'steering', name: 'Interior Dashboard Right' },
    { key: 'boot-space', name: 'Boot/Trunk' },
  ].map((s, order) => ({ ...s, order }));
  const INTERIOR_BY_KEY = Object.fromEntries(INTERIOR_SLOTS.map((s) => [s.key, s]));
  const INTERIOR_BY_NAME = Object.fromEntries(INTERIOR_SLOTS.map((s) => [s.name.toLowerCase(), s]));
  // GPS fixes for photos taken inside or at the car should stay within this distance of the
  // centre of the exterior photo ring (or twice the GPS accuracy, if larger).
  const INTERIOR_NEAR_CAR_M = 20;
  const LABEL_STOP_WORDS = new Set([
    'capture',
    'image',
    'img',
    'photo',
    'pic',
    'picture',
    'view',
    'exterior',
    'ext',
    'car',
    'vehicle',
    'of',
    'the',
    'jpg',
    'jpeg',
    'png',
    'heic',
  ]);

  const REVERSAL_DEG = 15;
  const CAPTURE_GAP_WINDOW_S = 1.5;

  // Same rule as the revamp app's on-device walk-around summary (smartRecordingWalkaround.ts).
  const APP_RULE = { minPhotos: 3, suspiciousReversals: 2, sweepCheckMinPhotos: 6, minSweepDeg: 180 };

  // ---------- math helpers ----------
  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : NaN;
  };
  const finite = (v) => Number.isFinite(v);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : NaN);
  const std = (a) => {
    if (a.length < 2) return NaN;
    const m = mean(a);
    return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
  };
  const quantile = (a, q) => {
    if (!a.length) return NaN;
    const s = [...a].sort((x, y) => x - y);
    const i = (s.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  };
  const median = (a) => quantile(a, 0.5);
  const clamp01 = (v) => (finite(v) ? Math.max(0, Math.min(1, v)) : 0);
  const norm360 = (a) => ((a % 360) + 360) % 360;
  const wrap180 = (a) => ((((a % 360) + 540) % 360) - 180);
  const circMean = (degs) => {
    const s = sum(degs.map((d) => Math.sin(d / DEG)));
    const c = sum(degs.map((d) => Math.cos(d / DEG)));
    return norm360(Math.atan2(s, c) * DEG);
  };
  const maxOf = (a) => a.reduce((m, v) => (v > m ? v : m), -Infinity);
  const minOf = (a) => a.reduce((m, v) => (v < m ? v : m), Infinity);

  function nearest(rows, t, maxDist) {
    if (!rows || !rows.length || !finite(t)) return null;
    let lo = 0;
    let hi = rows.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].t < t) lo = mid;
      else hi = mid;
    }
    const best = Math.abs(rows[lo].t - t) <= Math.abs(rows[hi].t - t) ? rows[lo] : rows[hi];
    if (maxDist != null && Math.abs(best.t - t) > maxDist) return null;
    return best;
  }

  function between(rows, t0, t1) {
    return (rows || []).filter((r) => r.t >= t0 && r.t <= t1);
  }

  // Heading (degrees clockwise from magnetic north) that the back camera points at.
  // The quaternion rotates device axes into the world frame; the back camera looks along
  // the device's -Z axis. Android's rotation vector uses x east, y north, z up ('ENU');
  // iOS CoreMotion's xMagneticNorthZVertical frame uses x north, y west, z up ('NWU').
  function cameraHeading(o, frame) {
    if (!o) return NaN;
    const x = num(o.qx);
    const y = num(o.qy);
    const z = num(o.qz);
    const w = num(o.qw);
    if (![x, y, z, w].every(finite)) return NaN;
    const wx = -2 * (x * z + w * y);
    const wy = -2 * (y * z - w * x);
    const east = frame === 'NWU' ? -wy : wx;
    const north = frame === 'NWU' ? wx : wy;
    if (Math.hypot(east, north) < 0.05) return NaN;
    return norm360(Math.atan2(east, north) * DEG);
  }

  // Maps app-specific labels ("front-left-capture.jpg", "FRONT_LEFT_IMAGE", "left_front")
  // onto a slot around the car by comparing word sets.
  function slotForLabel(label) {
    const tokens = String(label || '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
      .map((t) => (t === 'back' ? 'rear' : t))
      .filter((t) => !LABEL_STOP_WORDS.has(t));
    if (!tokens.length) return null;
    const direct = SLOT_BY_KEY[tokens.join('-')];
    if (direct) return direct;
    const set = new Set(tokens);
    const all = SLOT_ORDER.concat(SLOT_EXTRA);
    const match = all.find((s) => {
      const st = s.key.split('-');
      return st.length === set.size && st.every((t) => set.has(t));
    });
    if (match) return match;
    if (set.size === 1 && set.has('left')) return SLOT_BY_KEY['left-side'];
    if (set.size === 1 && set.has('right')) return SLOT_BY_KEY['right-side'];
    return null;
  }

  function interiorSlotFor(annotation) {
    const byPosition = annotation.position && INTERIOR_BY_KEY[String(annotation.position)];
    if (byPosition) return byPosition;
    const label = String(annotation.label || '').trim();
    const byName = INTERIOR_BY_NAME[label.toLowerCase()];
    if (byName) return byName;
    const legacy = /^(.+)-capture\.jpe?g$/i.exec(label);
    return legacy ? INTERIOR_BY_KEY[legacy[1].toLowerCase()] || null : null;
  }

  function labelKey(label) {
    return String(label || '')
      .toLowerCase()
      .replace(/\.(jpe?g|png|heic)$/, '')
      .replace(/[_\s]+/g, '-');
  }

  function detectPlatform(meta, streams) {
    const raw = String(meta.platform || '').toLowerCase();
    if (raw === 'ios' || raw === 'android') return { platform: raw, source: 'metadata' };
    const dev = String(meta['device name'] || '').toLowerCase();
    if (/iphone|ipad|ipod/.test(dev)) return { platform: 'ios', source: 'device name' };
    const tot = median((streams.TotalAcceleration || []).map((r) => Math.hypot(r.x, r.y, r.z)).filter(finite));
    if (finite(tot) && tot > 30) return { platform: 'android', source: 'acceleration scale (Android unit bug)' };
    return { platform: 'unknown', source: 'not in metadata' };
  }

  // Fields written by revamp builds with native motion sensors and the on-device walk-around summary.
  function appFields(meta) {
    const status = meta.walkaroundStatus ? String(meta.walkaroundStatus) : '';
    return {
      motionSource: meta.motionSensorSource ? String(meta.motionSensorSource) : '',
      headingReference: meta.headingReference ? String(meta.headingReference) : '',
      walkaround: status
        ? {
            status,
            photos: num(meta.walkaroundPhotoCount),
            reversals: num(meta.walkaroundReversals),
            sweep: num(meta.walkaroundSweepDeg),
          }
        : null,
    };
  }

  // Re-runs the app's walk-around rule on this page's camera headings, in position order
  // (front -> front-right) rather than time order, so it can be compared with the app's result.
  function appRule(captures) {
    const order = new Map(SLOT_ORDER.map((s, i) => [s.key, i]));
    const headings = captures
      .filter((c) => order.has(c.key) && finite(c.cam))
      .sort((x, y) => order.get(x.key) - order.get(y.key))
      .map((c) => c.cam);
    if (headings.length < APP_RULE.minPhotos) return { status: 'insufficient_data', photos: headings.length, reversals: NaN, sweep: NaN };
    const steps = headings.slice(1).map((h, i) => wrap180(h - headings[i]));
    const net = sum(steps);
    const dir = net >= 0 ? 1 : -1;
    const reversals = steps.filter((s) => s * dir < -REVERSAL_DEG).length;
    const sweep = Math.abs(net);
    const suspicious =
      reversals >= APP_RULE.suspiciousReversals || (headings.length >= APP_RULE.sweepCheckMinPhotos && sweep < APP_RULE.minSweepDeg);
    return { status: suspicious ? 'suspicious' : 'normal', photos: headings.length, reversals, sweep };
  }

  // How closely the app's logged cameraHeading matches the heading this page derives from the quaternion.
  function loggedHeadingAgreement(orientation) {
    const diffs = orientation
      .filter((r) => finite(r.cameraHeading) && finite(r.cam))
      .map((r) => Math.abs(wrap180(r.cameraHeading - r.cam)));
    return { n: diffs.length, p95: quantile(diffs, 0.95), max: diffs.length ? maxOf(diffs) : NaN };
  }

  // Elapsed seconds from the native `time` (epoch ns). Some revamp builds restarted
  // seconds_elapsed from 0 mid-session, so it is only the fallback.
  function elapsedSeconds(e, epochMs) {
    const ns = num(e.time);
    return finite(ns) && finite(epochMs) ? (ns / 1e6 - epochMs) / 1000 : num(e.seconds_elapsed);
  }

  function toNumRow(e, epochMs) {
    const row = {};
    Object.keys(e).forEach((k) => {
      if (k !== 'sensor') row[k] = num(e[k]);
    });
    row.se = num(e.seconds_elapsed);
    row.t = elapsedSeconds(e, epochMs);
    return row;
  }

  function recordingEpochMs(json) {
    const epochMs = num((json.metadata || {})['recording epoch time']);
    if (finite(epochMs)) return epochMs;
    const first = json.continuous_log.find((r) => r && finite(num(r.time)) && finite(num(r.seconds_elapsed)));
    return first ? num(first.time) / 1e6 - num(first.seconds_elapsed) * 1000 : NaN;
  }

  // seconds_elapsed jumping back while `time` moves on means the app restarted its clock.
  function secondsElapsedResets(streams) {
    let best = { checked: false, count: 0, first: null };
    Object.entries(streams).forEach(([name, list]) => {
      if (name === 'Location') return;
      const rows = list.filter((r) => finite(r.ns) && finite(r.se));
      if (rows.length < 2) return;
      let count = 0;
      let first = null;
      // A restart before the first row shows up as seconds_elapsed starting well behind `time`.
      if (finite(rows[0].t) && rows[0].t - rows[0].se > 1) {
        count += 1;
        first = { from: rows[0].t, to: rows[0].se, at: rows[0].t, beforeFirstRow: true };
      }
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].se < rows[i - 1].se - 0.5) {
          count += 1;
          if (!first) first = { from: rows[i - 1].se, to: rows[i].se, at: rows[i].t };
        }
      }
      if (!best.checked || count > best.count) best = { checked: true, count, first };
    });
    return best;
  }

  // ---------- parsing ----------
  function parseStreams(rawRows, epochMs) {
    const streams = {};
    const disorder = {};
    const dupes = {};
    for (const r of rawRows) {
      if (!r || !r.sensor) continue;
      const s = String(r.sensor);
      const list = streams[s] || (streams[s] = []);
      const row = { t: elapsedSeconds(r, epochMs), se: num(r.seconds_elapsed), ns: num(r.time) };
      for (const k of Object.keys(r)) {
        if (k === 'sensor' || k === 'time' || k === 'seconds_elapsed') continue;
        row[k] = num(r[k]);
      }
      if (!finite(row.t)) continue;
      const prev = list[list.length - 1];
      if (prev) {
        if (row.t < prev.t) disorder[s] = (disorder[s] || 0) + 1;
        else if (row.t === prev.t) dupes[s] = (dupes[s] || 0) + 1;
      }
      list.push(row);
    }
    Object.values(streams).forEach((l) => l.sort((a, b) => a.t - b.t));
    VECTOR_SENSORS.forEach((s) =>
      (streams[s] || []).forEach((r) => {
        r.mag = Math.hypot(r.x, r.y, r.z);
      }),
    );
    (streams.Orientation || []).forEach((r) => {
      r.pitchDeg = r.pitch * DEG;
      r.rollDeg = r.roll * DEG;
      r.yawDeg = r.yaw * DEG;
      r.qnorm = Math.hypot(r.qx, r.qy, r.qz, r.qw);
    });
    return { streams, disorder, dupes };
  }

  function parseCaptures(annotations, streams, epochMs, frame) {
    const caps = [];
    (Array.isArray(annotations) ? annotations : []).forEach((a) => {
      if (!a || !a.label) return;
      const snap = {};
      const sd = a.sensor_data;
      if (Array.isArray(sd)) {
        sd.forEach((e) => {
          if (e && e.sensor) snap[e.sensor] = e;
        });
      } else if (sd && typeof sd === 'object') {
        Object.keys(sd).forEach((k) => {
          const v = sd[k];
          if (v && typeof v === 'object') snap[v.sensor || k] = v;
        });
      }
      // Location `time` is the GPS fix clock, which can run a second or more off the phone clock.
      const snapTimes = Object.values(snap)
        .filter((e) => e.sensor !== 'Location')
        .map((e) => elapsedSeconds(e, epochMs))
        .filter(finite);
      const capMs = Date.parse(a.captured_at);
      const t =
        finite(capMs) && finite(epochMs)
          ? (capMs - epochMs) / 1000
          : snapTimes.length
            ? maxOf(snapTimes)
            : NaN;

      const o = snap.Orientation ? toNumRow(snap.Orientation, epochMs) : nearest(streams.Orientation, t, 1);
      const c = snap.Compass ? toNumRow(snap.Compass, epochMs) : nearest(streams.Compass, t, 1);
      const l = snap.Location ? toNumRow(snap.Location, epochMs) : nearest(streams.Location, t, 5);
      // Newer app builds send the screen name as label and the slot key as position.
      const interior = interiorSlotFor(a);
      const slot = interior ? null : (a.position && SLOT_BY_KEY[String(a.position)]) || slotForLabel(a.label);
      const key = interior ? interior.key : slot ? slot.key : labelKey(a.label);

      caps.push({
        label: String(a.label),
        position: a.position ? String(a.position) : null,
        key,
        short: slot ? slot.short : key,
        name: interior ? interior.name : slot ? slot.name : key,
        slot: slot ? slot.slot : NaN,
        interior: interior ? interior.key : null,
        interiorOrder: interior ? interior.order : NaN,
        t,
        capturedAt: a.captured_at,
        latency: snapTimes.length && finite(t) ? t - maxOf(snapTimes) : NaN,
        cam: cameraHeading(o, frame),
        appCam: o ? num(o.cameraHeading) : NaN,
        pitch: o ? num(o.pitch) * DEG : NaN,
        roll: o ? num(o.roll) * DEG : NaN,
        yaw: o ? num(o.yaw) * DEG : NaN,
        compass: c ? num(c.magneticBearing) : NaN,
        lat: l ? num(l.latitude) : NaN,
        lon: l ? num(l.longitude) : NaN,
        gpsAcc: l ? num(l.horizontalAccuracy) : NaN,
        snapshotHas: Object.keys(snap),
      });
    });
    caps.sort((x, y) => x.t - y.t);
    return caps;
  }

  // ---------- geometry ----------
  function makeProjector(lat0, lon0) {
    const kx = 111320 * Math.cos(lat0 / DEG);
    const ky = 110540;
    return (lat, lon) => ({ e: (lon - lon0) * kx, n: (lat - lat0) * ky });
  }

  // Walks the angle sequence and reports how consistently it turns one way.
  // A positive step means anticlockwise seen from above (bearing decreasing).
  function progression(angles, slots) {
    const idx = angles.map((_, i) => i).filter((i) => finite(angles[i]));
    if (idx.length < 2) return null;
    const steps = [];
    const raw = angles.map(() => NaN);
    raw[idx[0]] = 0;
    let cum = 0;
    for (let k = 1; k < idx.length; k++) {
      const deg = -wrap180(angles[idx[k]] - angles[idx[k - 1]]);
      steps.push({ from: idx[k - 1], to: idx[k], deg });
      cum += deg;
      raw[idx[k]] = cum;
    }
    const dir = cum >= 0 ? 1 : -1;
    const progress = raw.map((v) => v * dir);
    const signed = steps.map((s) => s.deg * dir);
    const reversals = signed.filter((d) => d < -REVERSAL_DEG).length;
    const backward = sum(signed.filter((d) => d < 0).map((d) => -d));
    // Slots grow anticlockwise (front -> car's left). Expected turn in the walking direction:
    // walking the other way round the car reaches the same slot after 360° minus that angle.
    let slotError = NaN;
    const expected = angles.map(() => NaN);
    if (slots) {
      const base = slots[idx[0]];
      idx.forEach((i) => {
        if (finite(slots[i]) && finite(base)) expected[i] = norm360(dir * (slots[i] - base));
      });
      const errs = idx.filter((i) => i !== idx[0] && finite(expected[i])).map((i) => Math.abs(wrap180(progress[i] - expected[i])));
      slotError = errs.length ? mean(errs) : NaN;
    }
    return {
      steps,
      signed,
      progress,
      expected,
      dir,
      dirLabel: dir > 0 ? 'anticlockwise' : 'clockwise',
      net: Math.abs(cum),
      reversals,
      backward,
      slotError,
    };
  }

  function ringMetrics(caps) {
    const pts = caps
      .map((c, i) => ({ i, e: c.e, n: c.n, cam: c.cam }))
      .filter((p) => finite(p.e) && finite(p.n));
    if (pts.length < 3) return null;
    const ce = mean(pts.map((p) => p.e));
    const cn = mean(pts.map((p) => p.n));
    pts.forEach((p) => {
      p.de = p.e - ce;
      p.dn = p.n - cn;
      p.r = Math.hypot(p.de, p.dn);
      p.angle = norm360(Math.atan2(p.de, p.dn) * DEG);
      p.toCentre = norm360(p.angle + 180);
      p.facing = finite(p.cam) ? wrap180(p.cam - p.toCentre) : NaN;
    });
    const angles = caps.map(() => NaN);
    const facing = caps.map(() => NaN);
    const radius = caps.map(() => NaN);
    pts.forEach((p) => {
      angles[p.i] = p.angle;
      facing[p.i] = p.facing;
      radius[p.i] = p.r;
    });

    const sorted = pts.map((p) => p.angle).sort((a, b) => a - b);
    let maxGap = 0;
    let gapStart = 0;
    for (let k = 0; k < sorted.length; k++) {
      const a = sorted[k];
      const b = k + 1 < sorted.length ? sorted[k + 1] : sorted[0] + 360;
      if (b - a > maxGap) {
        maxGap = b - a;
        gapStart = a;
      }
    }

    let area = 0;
    let perimeter = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[k];
      const q = pts[(k + 1) % pts.length];
      area += p.de * q.dn - q.de * p.dn;
      perimeter += Math.hypot(q.de - p.de, q.dn - p.dn);
    }
    area = Math.abs(area) / 2;
    const last = pts[pts.length - 1];
    const closure = Math.hypot(last.de - pts[0].de, last.dn - pts[0].dn);

    const sxx = mean(pts.map((p) => p.de * p.de));
    const syy = mean(pts.map((p) => p.dn * p.dn));
    const sxy = mean(pts.map((p) => p.de * p.dn));
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(theta);
    const uy = Math.sin(theta);
    const along = pts.map((p) => p.de * ux + p.dn * uy);
    const across = pts.map((p) => -p.de * uy + p.dn * ux);

    const radii = pts.map((p) => p.r);
    const facingAbs = pts.map((p) => Math.abs(p.facing)).filter(finite);
    return {
      pts,
      angles,
      facing,
      radius,
      centre: { e: ce, n: cn },
      meanR: mean(radii),
      maxR: maxOf(radii),
      minR: minOf(radii),
      maxGap,
      gapStart,
      coverage: 360 - maxGap,
      area,
      perimeter,
      closure,
      axisRad: theta,
      length: maxOf(along) - minOf(along),
      width: maxOf(across) - minOf(across),
      facingMeanAbs: mean(facingAbs),
      facingWithin45: facingAbs.filter((v) => v <= 45).length,
      facingCount: facingAbs.length,
    };
  }

  // ---------- data quality ----------
  function streamStats(name, rows, thr, targetHz, caps) {
    const n = rows.length;
    const out = { name, n, rate: 0, medianHz: NaN, gaps: [], longest: 0, gapTotal: 0, coverage: NaN, burst: NaN, nearCapture: 0, targetHz };
    if (n < 2) return out;
    const span = rows[n - 1].t - rows[0].t;
    const dts = [];
    for (let k = 1; k < n; k++) {
      const dt = rows[k].t - rows[k - 1].t;
      dts.push(dt);
      if (dt > thr) out.gaps.push({ start: rows[k - 1].t, end: rows[k].t, dur: dt });
    }
    out.rate = span > 0 ? (n - 1) / span : 0;
    out.medianHz = 1 / median(dts.filter((d) => d > 0));
    out.burst = dts.filter((d) => d < 0.005).length / dts.length;
    out.longest = out.gaps.length ? maxOf(out.gaps.map((g) => g.dur)) : 0;
    out.gapTotal = sum(out.gaps.map((g) => g.dur));
    out.coverage = span > 0 ? 1 - out.gapTotal / span : NaN;
    out.nearCapture = out.gaps.filter((g) =>
      caps.some((c) => g.end >= c.t - CAPTURE_GAP_WINDOW_S && g.start <= c.t + CAPTURE_GAP_WINDOW_S),
    ).length;
    out.first = rows[0].t;
    out.last = rows[n - 1].t;
    return out;
  }

  function integrateAbsDeg(rows, t0, t1) {
    let deg = 0;
    for (let k = 1; k < rows.length; k++) {
      const p = rows[k - 1];
      const r = rows[k];
      if (r.t <= t0 || p.t >= t1) continue;
      const dt = Math.min(r.t, t1) - Math.max(p.t, t0);
      if (dt > 0 && finite(p.mag)) deg += Math.min(dt, 0.25) * p.mag * DEG;
    }
    return deg;
  }

  function headingChurn(rows, t0, t1) {
    let deg = 0;
    for (let k = 1; k < rows.length; k++) {
      const p = rows[k - 1];
      const r = rows[k];
      if (r.t < t0 || p.t > t1 || r.t - p.t > 0.5) continue;
      if (finite(p.cam) && finite(r.cam)) deg += Math.abs(wrap180(r.cam - p.cam));
    }
    return deg;
  }

  function compassAgreement(orientation, compass) {
    const res = [];
    for (let k = 0; k < orientation.length; k += 2) {
      const o = orientation[k];
      if (!finite(o.cam)) continue;
      const c = nearest(compass, o.t, 0.15);
      if (c && finite(c.magneticBearing)) res.push(wrap180(c.magneticBearing - o.cam));
    }
    if (res.length < 10) return { offset: NaN, mad: NaN, n: res.length };
    const offset = circMean(res);
    const dev = res.map((r) => Math.abs(wrap180(r - offset)));
    return { offset, mad: median(dev), mean: mean(dev), n: res.length };
  }

  function sumResidual(streams) {
    const L = streams.Accelerometer || [];
    const T = streams.TotalAcceleration || [];
    const Gr = streams.Gravity || [];
    const res = [];
    for (let k = 0; k < L.length; k += 3) {
      const l = L[k];
      const t = nearest(T, l.t, 0.03);
      const g = nearest(Gr, l.t, 0.06);
      if (!t || !g) continue;
      res.push(Math.hypot(t.x - (l.x + g.x), t.y - (l.y + g.y), t.z - (l.z + g.z)));
    }
    return { median: median(res), n: res.length };
  }

  // ---------- checks ----------
  const status = (ok, warn) => (ok ? 'pass' : warn ? 'warn' : 'fail');

  function describeWalkaround(w) {
    if (w.status === 'insufficient_data') return `insufficient data (${w.photos} photos)`;
    return `${w.status} (${w.reversals} reversals, ${finite(w.sweep) ? w.sweep.toFixed(0) : '?'}° sweep)`;
  }

  function accuracyChecks(a) {
    const { streams, stats, meta, captures, epochMs } = a;
    const checks = {};
    const medMag = (s) => median((streams[s] || []).map((r) => r.mag).filter(finite));

    const tot = medMag('TotalAcceleration');
    checks.accTotal = {
      status: finite(tot) ? (tot > 30 ? 'fail' : status(tot >= 8.8 && tot <= 10.8, tot >= 7 && tot <= 13)) : 'na',
      value: finite(tot) ? `${tot.toFixed(2)} m/s² (${(tot / G).toFixed(1)} g)` : 'no data',
      raw: tot,
      unitBug: finite(tot) && tot > 30,
    };
    const lin = medMag('Accelerometer');
    checks.accLinear = {
      status: finite(lin) ? status(lin < 2.5, lin < 6) : 'na',
      value: finite(lin) ? `${lin.toFixed(2)} m/s²` : 'no data',
      raw: lin,
    };
    const grav = medMag('Gravity');
    checks.gravity = {
      status: finite(grav) ? status(grav >= 9.6 && grav <= 10.0, grav >= 9 && grav <= 10.6) : 'na',
      value: finite(grav) ? `${grav.toFixed(3)} m/s²` : 'no data',
      raw: grav,
    };
    const sr = sumResidual(streams);
    checks.sumCheck = {
      status: finite(sr.median) ? status(sr.median < 0.5, sr.median < 2) : 'na',
      value: finite(sr.median) ? `${sr.median.toFixed(3)} m/s² residual` : 'no data',
      raw: sr.median,
    };
    const qn = (streams.Orientation || []).map((r) => Math.abs(r.qnorm - 1)).filter(finite);
    const qMax = qn.length ? maxOf(qn) : NaN;
    checks.qnorm = {
      status: qn.length ? status(qMax < 0.01, qMax < 0.05) : 'na',
      value: qn.length ? `max |q|-1 = ${qMax.toExponential(1)}` : 'no data',
      raw: qMax,
    };

    const nat = stats.Orientation;
    const natRatio = nat ? nat.rate / nat.targetHz : NaN;
    checks.rateNative = {
      status: nat && nat.n > 1 ? status(natRatio >= 0.9, natRatio >= 0.6) : 'na',
      value: nat ? `${nat.rate.toFixed(1)} Hz of ${nat.targetHz.toFixed(0)} Hz (${(natRatio * 100).toFixed(0)}%)` : 'no data',
      raw: nat ? nat.rate : NaN,
    };
    const rn = RN_SENSORS.map((s) => stats[s]).filter((s) => s && s.n > 1);
    const rnMin = rn.length ? rn.reduce((m, s) => (s.rate < m.rate ? s : m)) : null;
    const rnRatio = rnMin ? rnMin.rate / rnMin.targetHz : NaN;
    const motionSource = a.app.motionSource === 'native' ? 'native' : 'react-native-sensors';
    checks.rateRN = {
      status: rnMin ? status(rnRatio >= 0.9, rnRatio >= 0.6) : 'na',
      value: rnMin ? `lowest ${rnMin.name} ${rnMin.rate.toFixed(1)} Hz (${(rnRatio * 100).toFixed(0)}%) · ${motionSource}` : 'no data',
      raw: rnMin ? rnMin.rate : NaN,
    };

    const og = nat ? nat.gaps : [];
    checks.gaps = {
      status: nat ? status(og.length === 0, og.length <= 10 && (nat.longest || 0) < 5) : 'na',
      value: nat ? `${og.length} gaps, longest ${nat.longest.toFixed(1)} s, ${nat.nearCapture} near captures` : 'no data',
      raw: og.length,
    };
    const gy = stats.Gyroscope;
    const burst = gy ? gy.burst : NaN;
    checks.bursts = {
      status: finite(burst) ? status(burst < 0.02, burst < 0.1) : 'na',
      value: finite(burst) ? `${(burst * 100).toFixed(1)}% of gyro samples < 5 ms apart` : 'no data',
      raw: burst,
    };

    const dis = sum(Object.values(a.disorder));
    const dup = sum(Object.values(a.dupes));
    const totalRows = sum(Object.values(streams).map((l) => l.length));
    checks.monotonic = {
      status: status(dis === 0 && dup / Math.max(1, totalRows) < 0.01, dis === 0),
      value: `${dis} out of order, ${dup} duplicate timestamps`,
      raw: dis,
    };

    const tc = [];
    Object.values(streams).forEach((l) =>
      l.forEach((r, i) => {
        if (i % 10 === 0 && finite(r.ns) && finite(r.se) && finite(epochMs)) tc.push((r.ns / 1e6 - epochMs) / 1000 - r.se);
      }),
    );
    const se = secondsElapsedResets(streams);
    checks.secondsElapsed = {
      status: se.checked ? status(se.count === 0, true) : 'na',
      value: !se.checked
        ? 'no time field'
        : se.count === 0
          ? 'no resets'
          : se.first.beforeFirstRow
            ? `${se.count} reset${se.count > 1 ? 's' : ''}: first row reads ${se.first.to.toFixed(1)} s at ${se.first.at.toFixed(1)} s into the recording`
            : `${se.count} reset${se.count > 1 ? 's' : ''}: ${se.first.from.toFixed(1)} s → ${se.first.to.toFixed(1)} s at ${se.first.at.toFixed(1)} s`,
      raw: se.count,
    };
    const tcMed = median(tc);
    const tcSpread = quantile(tc, 0.95) - quantile(tc, 0.05);
    checks.timeConsistency = {
      status: finite(tcMed) ? status(Math.abs(tcMed) < 0.2 && tcSpread < 0.02, Math.abs(tcMed) < 1 && tcSpread < 0.2) : 'na',
      value: finite(tcMed)
        ? `constant offset ${(tcMed * 1000).toFixed(0)} ms, spread ${(tcSpread * 1000).toFixed(1)} ms`
        : 'no data',
      raw: tcMed,
    };

    const ca = a.compassAgreement;
    checks.compass = {
      status: finite(ca.atCaptures) ? status(ca.atCaptures < 20, ca.atCaptures < 45) : 'na',
      value: finite(ca.atCaptures)
        ? `${ca.atCaptures.toFixed(0)}° at photos (whole log ${ca.mad.toFixed(0)}°)`
        : 'no data',
      raw: ca.atCaptures,
    };

    const lh = a.loggedHeading;
    checks.cameraHeadingLogged = {
      status: lh.n ? status(lh.p95 < 1, lh.p95 < 5) : 'na',
      value: lh.n ? `95% within ${lh.p95.toFixed(2)}° of this page (${lh.n.toLocaleString()} samples)` : 'not in log (older build)',
      raw: lh.p95,
    };

    const aw = a.app.walkaround;
    const pr = a.appRule;
    const sameNumbers =
      aw &&
      aw.photos === pr.photos &&
      (aw.status === 'insufficient_data' || (aw.reversals === pr.reversals && Math.abs(aw.sweep - pr.sweep) <= 5));
    checks.walkaroundFlag = {
      status: !aw ? 'na' : aw.status !== pr.status ? 'fail' : sameNumbers ? 'pass' : 'warn',
      value: !aw
        ? 'not in log (older build)'
        : `app ${describeWalkaround(aw)} · page ${describeWalkaround(pr)}`,
      raw: aw ? aw.status : '',
    };

    const lat = captures.map((c) => c.latency).filter(finite);
    const latMed = median(lat);
    checks.latency = {
      status: finite(latMed) ? status(latMed >= -0.05 && latMed <= 0.5, latMed <= 2) : 'na',
      value: finite(latMed) ? `${(latMed * 1000).toFixed(0)} ms median` : 'no data',
      raw: latMed,
    };

    const gpsAcc = median(captures.map((c) => c.gpsAcc).filter(finite));
    const loc = stats.Location;
    checks.gps = {
      status: finite(gpsAcc) ? status(gpsAcc <= 5 && loc && loc.rate >= 0.8, gpsAcc <= 10) : 'na',
      value: finite(gpsAcc) ? `±${gpsAcc.toFixed(1)} m at captures, ${loc ? loc.rate.toFixed(2) : '?'} Hz` : 'no data',
      raw: gpsAcc,
    };

    const src = String(meta.orientationSource || 'unknown');
    checks.orientationSource = {
      status: src === 'native' ? 'pass' : src === 'unknown' ? 'na' : 'warn',
      value: src,
      raw: src,
    };

    const known = captures.filter((c) => finite(c.slot)).length;
    const extra = [];
    if (a.retakes.length) extra.push(`${a.retakes.length} retaken`);
    if (a.ignoredCaptures.length) extra.push(`${a.ignoredCaptures.length} ignored`);
    if (a.interior.captures.length) extra.push(`${a.interior.captures.length} interior handled separately`);
    checks.captures = {
      status: status(captures.length >= 10 && known === captures.length, captures.length >= 8),
      value: `${captures.length} photos used, ${known} recognised labels${extra.length ? ` (${extra.join(', ')})` : ''}`,
      raw: captures.length,
    };
    return checks;
  }

  // ---------- fraud signals ----------
  function fraudSignals(a) {
    const cp = a.camProgress;
    const pp = a.posProgress;
    const ring = a.ring;
    const enoughPhotos = a.captures.length >= 3;
    const headingKnown = a.platform.platform !== 'unknown';
    const signals = [];
    // Signals that cannot be calculated are left out of the score rather than counted as 0,
    // otherwise missing data would push a log towards "Looks genuine".
    const add = (id, label, weight, available, value, display, threshold, score, explain, unavailableReason) =>
      signals.push({
        id,
        label,
        weight,
        available: !!available,
        value,
        display: available ? display : `n/a · ${unavailableReason || 'not enough data'}`,
        threshold,
        score: available ? clamp01(score) : 0,
        explain,
      });

    add(
      'camReversal',
      'Camera heading turns back',
      20,
      enoughPhotos && cp,
      cp ? cp.reversals : NaN,
      cp ? `${cp.reversals} reversals` : '',
      '0 expected, 2+ is suspicious',
      cp ? cp.reversals / 2 : 0,
      'When walking around a car the camera keeps turning one way. Turning back means the photos were not taken in a loop.',
      'no orientation at photos',
    );
    add(
      'camSweep',
      'Camera heading sweep',
      15,
      enoughPhotos && cp,
      cp ? cp.net : NaN,
      cp ? `${cp.net.toFixed(0)}°` : '',
      '≈ 315° expected (front to front-right)',
      cp ? (300 - cp.net) / 180 : 0,
      'Net rotation of the camera from the first to the last photo. A full walk-around turns about 315°.',
      'no orientation at photos',
    );
    add(
      'slotError',
      'Heading vs expected capture slot',
      10,
      enoughPhotos && cp && finite(cp.slotError),
      cp ? cp.slotError : NaN,
      cp && finite(cp.slotError) ? `${cp.slotError.toFixed(0)}° mean error` : '',
      '< 30° good, > 60° suspicious',
      cp ? (cp.slotError - 30) / 40 : 0,
      'Compares how far the camera turned at each photo with where that photo should be around the car.',
      a.labelsRecognised ? 'no orientation at photos' : 'photo labels not recognised',
    );
    add(
      'facing',
      'Camera points at the ring centre',
      15,
      headingKnown && ring && finite(ring.facingMeanAbs),
      ring ? ring.facingMeanAbs : NaN,
      ring && finite(ring.facingMeanAbs) ? `${ring.facingMeanAbs.toFixed(0)}° average offset` : '',
      '< 30° good, > 50° suspicious',
      ring ? (ring.facingMeanAbs - 30) / 25 : 0,
      'At each photo, compares where the camera points with the direction to the centre of the walked ring (where the car should be).',
      !headingKnown ? 'platform unknown, compass direction unreliable' : 'no GPS at photos',
    );
    const ppSlot = pp && finite(pp.slotError) ? (pp.slotError - 25) / 40 : 0;
    add(
      'posOrder',
      'GPS walk order around the ring',
      15,
      pp,
      pp ? pp.reversals : NaN,
      pp ? `${pp.reversals} reversals${finite(pp.slotError) ? `, ${pp.slotError.toFixed(0)}° slot error` : ''}` : '',
      '0 reversals expected',
      pp ? Math.max(pp.reversals / 3, ppSlot) : 0,
      'Position of each photo around the centre of the walk. A real walk-around moves steadily round the ring. GPS is ±2.5–3 m, so this is weighted less than heading.',
      'no GPS at photos',
    );
    add(
      'ringSize',
      'Size of the walked ring',
      5,
      ring,
      ring ? ring.meanR : NaN,
      ring ? `${ring.meanR.toFixed(1)} m radius, ${ring.length.toFixed(1)} × ${ring.width.toFixed(1)} m` : '',
      '1.5–6 m radius is car-like',
      ring ? (ring.meanR < 1.5 ? (1.5 - ring.meanR) / 1.5 : (ring.meanR - 6) / 4) : 0,
      'Average distance of the capture points from their centre. Very small means standing still; very large means not near one car.',
      'no GPS at photos',
    );
    const gy = a.motion.gyroMean;
    add(
      'gyro',
      'Phone rotation during inspection',
      10,
      enoughPhotos && finite(gy),
      gy,
      finite(gy) ? `${gy.toFixed(2)} rad/s mean, ${a.motion.churn.toFixed(0)}° heading churn` : '',
      '< 0.45 rad/s normal',
      (gy - 0.45) / 0.3,
      'Average gyroscope speed between the first and last photo. Sweeping or twisting the phone a lot raises it.',
      'no gyroscope data',
    );
    const cv = a.timing.intervalCv;
    add(
      'intervals',
      'Uneven time between photos',
      5,
      enoughPhotos && finite(cv),
      cv,
      finite(cv) ? `CV ${cv.toFixed(2)}` : '',
      '< 0.5 even',
      (cv - 0.5) / 0.5,
      'Coefficient of variation of the time between photos. Very uneven timing can mean hunting for angles.',
    );
    const nearGaps = a.stats.Orientation ? a.stats.Orientation.nearCapture : 0;
    add(
      'gapsNearCapture',
      'Sensor gaps around photos',
      5,
      enoughPhotos && a.stats.Orientation,
      nearGaps,
      `${nearGaps} of ${a.captures.length} photos`,
      '0 expected',
      nearGaps / Math.max(1, a.captures.length) / 0.5,
      'Gaps in native orientation data within 1.5 s of a photo. Missing data makes the check weaker.',
      'no orientation data',
    );
    const availableWeight = sum(signals.filter((s) => s.available).map((s) => s.weight));
    const totalWeight = sum(signals.map((s) => s.weight));
    const raw = sum(signals.map((s) => s.weight * s.score));
    const score = availableWeight ? Math.round((raw / availableWeight) * 100) : 0;
    const insufficient = !enoughPhotos || availableWeight < totalWeight / 2;
    const verdict = insufficient ? 'Insufficient data' : score >= 55 ? 'Likely fraud' : score >= 30 ? 'Needs review' : 'Looks genuine';
    const level = insufficient ? 'na' : score >= 55 ? 'bad' : score >= 30 ? 'warn' : 'ok';
    return { signals, score, verdict, level, insufficient, availableWeight, totalWeight };
  }

  // Interior photos: which of the seven were taken, when, and how far (by GPS) from the centre of
  // the exterior photo ring. Review evidence only; it does not change the fraud score.
  function interiorMetrics(allCaptures, exterior, ring, project) {
    const pool = allCaptures.filter((c) => c.interior);
    const lastByKey = new Map();
    pool.forEach((c) => lastByKey.set(c.key, c));
    const retakes = pool.filter((c) => lastByKey.get(c.key) !== c);
    const captures = pool.filter((c) => lastByKey.get(c.key) === c);
    const lastExterior = exterior.length ? exterior[exterior.length - 1] : null;
    captures.forEach((c, i) => {
      const prev = i ? captures[i - 1] : lastExterior;
      c.interval = prev ? c.t - prev.t : NaN;
      const p = finite(c.lat) && finite(c.lon) ? project(c.lat, c.lon) : null;
      c.e = p ? p.e : NaN;
      c.n = p ? p.n : NaN;
      c.carDistance = p && ring ? Math.hypot(p.e - ring.centre.e, p.n - ring.centre.n) : NaN;
      c.nearCarLimit = Math.max(INTERIOR_NEAR_CAR_M, finite(c.gpsAcc) ? 2 * c.gpsAcc : 0);
      c.farFromCar = finite(c.carDistance) && c.carDistance > c.nearCarLimit;
    });
    const taken = new Set(captures.map((c) => c.key));
    const distances = captures.map((c) => c.carDistance).filter(finite);
    const first = captures[0];
    const last = captures[captures.length - 1];
    return {
      captures,
      retakes,
      missing: captures.length ? INTERIOR_SLOTS.filter((s) => !taken.has(s.key)) : [],
      outOfOrder: captures.some((c, i) => i && c.interiorOrder < captures[i - 1].interiorOrder),
      legacyLabels: captures.some((c) => !c.position),
      span: captures.length ? last.t - first.t : NaN,
      afterExterior: first && lastExterior ? first.t - lastExterior.t : NaN,
      maxCarDistance: distances.length ? maxOf(distances) : NaN,
      medianCarDistance: median(distances),
      far: captures.filter((c) => c.farFromCar),
      hasCarCentre: Boolean(ring),
    };
  }

  // ---------- main ----------
  function analyze(json, opts) {
    const options = opts || {};
    const name = options.name || 'Log';
    const fileName = options.fileName || '';
    const gapThreshold = options.gapThreshold || 0.5;
    if (!json || typeof json !== 'object' || !Array.isArray(json.continuous_log)) {
      throw new Error(`${fileName || name}: not a smart recording sensor log (continuous_log is missing)`);
    }
    const meta = json.metadata || {};
    const epochMs = recordingEpochMs(json);
    const { streams, disorder, dupes } = parseStreams(json.continuous_log, epochMs);
    const sensorNames = SENSORS.filter((s) => streams[s] && streams[s].length).concat(
      Object.keys(streams).filter((s) => !SENSORS.includes(s) && streams[s].length),
    );
    const duration = maxOf(Object.values(streams).map((l) => (l.length ? l[l.length - 1].t : 0)).concat([0]));
    const sampleRateMs = num(meta.sampleRateMs);
    const targetHz = finite(sampleRateMs) && sampleRateMs > 0 ? 1000 / sampleRateMs : 20;

    const platform = detectPlatform(meta, streams);
    const frame = platform.platform === 'ios' ? 'NWU' : 'ENU';
    (streams.Orientation || []).forEach((r) => {
      r.cam = cameraHeading(r, frame);
    });

    // Interior photos never join the walk-around. Of the rest, only exterior photos (labels that
    // map to a slot round the car) are used when at least three are recognised; with retakes only
    // the last photo of each label is kept.
    const allCaptures = parseCaptures(json.annotations, streams, epochMs, frame);
    const exteriorCandidates = allCaptures.filter((c) => !c.interior);
    const recognised = exteriorCandidates.filter((c) => finite(c.slot));
    const labelsRecognised = recognised.length >= 3;
    const pool = labelsRecognised ? recognised : exteriorCandidates;
    const ignoredCaptures = labelsRecognised ? exteriorCandidates.filter((c) => !finite(c.slot)) : [];
    const lastByKey = new Map();
    pool.forEach((c) => lastByKey.set(c.key, c));
    const retakes = pool.filter((c) => lastByKey.get(c.key) !== c);
    const captures = pool.filter((c) => lastByKey.get(c.key) === c);

    // GPS projection centred on the capture points.
    const capGps = captures.filter((c) => finite(c.lat) && finite(c.lon));
    const locRows = (streams.Location || []).filter((r) => finite(r.latitude) && finite(r.longitude));
    const refSrc = capGps.length ? capGps.map((c) => [c.lat, c.lon]) : locRows.map((r) => [r.latitude, r.longitude]);
    const lat0 = refSrc.length ? mean(refSrc.map((p) => p[0])) : 0;
    const lon0 = refSrc.length ? mean(refSrc.map((p) => p[1])) : 0;
    const project = makeProjector(lat0, lon0);
    captures.forEach((c) => {
      const p = finite(c.lat) ? project(c.lat, c.lon) : { e: NaN, n: NaN };
      c.e = p.e;
      c.n = p.n;
    });
    captures.forEach((c, i) => {
      const prev = captures[i - 1];
      c.interval = prev ? c.t - prev.t : NaN;
      c.gpsStep = prev && finite(prev.e) && finite(c.e) ? Math.hypot(c.e - prev.e, c.n - prev.n) : NaN;
    });

    const tFirst = captures.length ? captures[0].t : 0;
    const tLast = captures.length ? captures[captures.length - 1].t : duration;
    const track = locRows
      .filter((r) => !captures.length || (r.t >= tFirst - 3 && r.t <= tLast + 3))
      .map((r) => ({ t: r.t, acc: r.horizontalAccuracy, ...project(r.latitude, r.longitude) }));
    const fullTrack = locRows.map((r) => ({ t: r.t, ...project(r.latitude, r.longitude) }));

    const ring = ringMetrics(captures);
    const interior = interiorMetrics(allCaptures, captures, ring, project);
    const slots = captures.map((c) => c.slot);
    const camProgress = progression(
      captures.map((c) => c.cam),
      slots,
    );
    const posProgress = ring ? progression(ring.angles, slots) : null;
    captures.forEach((c, i) => {
      c.ringAngle = ring ? ring.angles[i] : NaN;
      c.facing = ring ? ring.facing[i] : NaN;
      c.radius = ring ? ring.radius[i] : NaN;
      c.camProgress = camProgress ? camProgress.progress[i] : NaN;
      c.posProgress = posProgress ? posProgress.progress[i] : NaN;
    });

    const stats = {};
    sensorNames.forEach((s) => {
      const isLoc = s === 'Location';
      stats[s] = streamStats(s, streams[s], isLoc ? Math.max(gapThreshold, 2.5) : gapThreshold, isLoc ? 1 : targetHz, captures);
    });
    const allGapStarts = (stats.Orientation ? stats.Orientation.gaps : []).map((g) => g.start);
    const gapPeriod = allGapStarts.length > 2 ? median(allGapStarts.slice(1).map((v, i) => v - allGapStarts[i])) : NaN;

    const gyroRows = streams.Gyroscope || [];
    const winGyro = between(gyroRows, tFirst, tLast)
      .map((r) => r.mag)
      .filter(finite);
    captures.forEach((c, i) => {
      const prev = captures[i - 1];
      c.gyroStepDeg = prev ? integrateAbsDeg(gyroRows, prev.t, c.t) : NaN;
    });
    const motion = {
      gyroMean: mean(winGyro),
      gyroStd: std(winGyro),
      gyroP95: quantile(winGyro, 0.95),
      gyroRotationDeg: integrateAbsDeg(gyroRows, tFirst, tLast),
      churn: headingChurn(streams.Orientation || [], tFirst, tLast),
      gpsPath: sum(captures.map((c) => c.gpsStep).filter(finite)),
    };

    const intervals = captures.map((c) => c.interval).filter(finite);
    let slowest = null;
    captures.forEach((c) => {
      if (finite(c.interval) && (!slowest || c.interval > slowest.interval)) slowest = c;
    });
    const timing = {
      duration,
      preCapture: captures.length ? tFirst : NaN,
      span: captures.length ? tLast - tFirst : NaN,
      postCapture: captures.length ? duration - tLast : NaN,
      intervalMean: mean(intervals),
      intervalMedian: median(intervals),
      intervalStd: std(intervals),
      intervalCv: intervals.length > 1 ? std(intervals) / mean(intervals) : NaN,
      slowest,
      fastest: captures.reduce((m, c) => (finite(c.interval) && (!m || c.interval < m.interval) ? c : m), null),
      startedAt: finite(epochMs) ? new Date(epochMs) : null,
    };

    const analysis = {
      name,
      fileName,
      meta,
      platform,
      frame,
      allCaptures,
      retakes,
      ignoredCaptures,
      labelsRecognised,
      epochMs,
      targetHz,
      gapThreshold,
      sensorNames,
      streams,
      disorder,
      dupes,
      totalRows: sum(Object.values(streams).map((l) => l.length)),
      captures,
      interior,
      track,
      fullTrack,
      ring,
      camProgress,
      posProgress,
      stats,
      gapPeriod,
      motion,
      timing,
      compassAgreement: compassAgreement(streams.Orientation || [], streams.Compass || []),
      app: appFields(meta),
      appRule: appRule(captures),
      loggedHeading: loggedHeadingAgreement(streams.Orientation || []),
    };
    const ca = analysis.compassAgreement;
    captures.forEach((c) => {
      c.compassDiff = finite(ca.offset) && finite(c.compass) && finite(c.cam) ? wrap180(c.compass - ca.offset - c.cam) : NaN;
    });
    const capDiffs = captures.map((c) => Math.abs(c.compassDiff)).filter(finite);
    ca.atCaptures = capDiffs.length ? mean(capDiffs) : NaN;
    analysis.checks = accuracyChecks(analysis);
    analysis.fraud = fraudSignals(analysis);
    analysis.warnings = logWarnings(analysis);
    return analysis;
  }

  function logWarnings(a) {
    const w = [];
    const add = (level, text) => w.push({ level, text });
    const p = a.platform;
    if (p.platform === 'unknown') {
      add('warn', 'Platform (Android or iOS) is not in the metadata and could not be detected, so the camera-to-centre check is skipped.');
    } else if (p.source !== 'metadata') {
      add('info', `Platform is not in the metadata; detected as ${p.platform} from the ${p.source}.`);
    }
    if (p.platform === 'ios') {
      add(
        'info',
        "iOS log: the camera heading is converted from CoreMotion's north/west/up axes. This assumes the magnetic-north reference frame; if the phone fell back to an arbitrary frame, only the camera-to-centre check is affected.",
      );
    }
    const src = String(a.meta.orientationSource || '');
    if (src && src !== 'native') add('warn', `Orientation came from "${src}" instead of the native module, so headings are less accurate.`);
    if (!src) add('info', 'Metadata has no orientationSource (older or boltSA build); assuming the native orientation module.');
    if (!a.app.motionSource) {
      add(
        'info',
        'Metadata has no motionSensorSource, so this log is from boltSA or a revamp build before the sensor accuracy fix. Expect the Android acceleration unit bug, receive-time timestamps and gaps around photos.',
      );
    } else if (a.app.motionSource !== 'native') {
      add('warn', `Motion sensors came from "${a.app.motionSource}" instead of the native module, so rates and timestamps are less reliable.`);
    }
    if (a.checks.secondsElapsed.raw > 0) {
      add(
        'warn',
        `seconds_elapsed restarts mid-recording (${a.checks.secondsElapsed.value}). This page builds the timeline from the native time field instead. Fixed in revamp: sensors restarting on app foreground or journey resume now keep the session's recording epoch.`,
      );
    }
    const outOfOrder = sum(Object.values(a.disorder));
    if (outOfOrder > 0) {
      add(
        'warn',
        `${outOfOrder} sensor rows are out of time order (rows from two moments interleave). This page sorts each sensor by time. Fixed in revamp: overlapping sensor flushes reused the same sequence numbers and now run one at a time.`,
      );
    }
    if (!(a.streams.Orientation || []).length) add('bad', 'No Orientation data in this log; heading-based fraud checks are not possible.');
    const exteriorCandidates = a.allCaptures.filter((c) => !c.interior);
    if (exteriorCandidates.length < 3) add('bad', `Only ${exteriorCandidates.length} exterior photo annotations; walk-around checks need at least 3.`);
    if (!a.labelsRecognised && exteriorCandidates.length >= 3) {
      const ex = exteriorCandidates.slice(0, 3).map((c) => c.label).join(', ');
      add('warn', `Photo labels are not recognised as positions around the car (e.g. ${ex}). Photos are used in time order and the slot checks are skipped.`);
    }
    if (a.retakes.length) {
      add('info', `${a.retakes.length} retaken photo(s): ${a.retakes.map((c) => c.label).join(', ')}. Only the last photo of each label is used.`);
    }
    if (a.ignoredCaptures.length) {
      add('info', `Ignored ${a.ignoredCaptures.length} photo(s) that are neither exterior nor interior positions: ${a.ignoredCaptures.map((c) => c.label).join(', ')}.`);
    }
    const inside = a.interior;
    if (inside.far.length) {
      add(
        'warn',
        `${inside.far.length} interior photo(s) have a GPS fix more than ${INTERIOR_NEAR_CAR_M} m from the car (the centre of the exterior photos): ${inside.far
          .map((c) => `${c.name} ${c.carDistance.toFixed(0)} m`)
          .join(', ')}. Check that they show the same car.`,
      );
    }
    if (inside.missing.length) {
      add('info', `${inside.missing.length} of ${INTERIOR_SLOTS.length} interior photos are missing: ${inside.missing.map((s) => s.name).join(', ')}.`);
    }
    if (inside.retakes.length) {
      add('info', `${inside.retakes.length} retaken interior photo(s): ${inside.retakes.map((c) => c.name).join(', ')}. Only the last photo of each is used.`);
    }
    if (inside.legacyLabels) {
      add('info', 'Interior photos use file-name labels (a build before interior screen names); they were matched by file name.');
    }
    const withGps = a.captures.filter((c) => finite(c.lat)).length;
    if (a.captures.length >= 3 && withGps < 3) add('warn', 'Fewer than 3 photos have a GPS position, so the walk map and ring checks are skipped.');
    if (a.fraud.insufficient) {
      add(
        'bad',
        `Only ${a.fraud.availableWeight} of ${a.fraud.totalWeight} fraud-signal weight could be calculated, so no verdict is given.`,
      );
    }
    return w;
  }

  root.LogEngine = {
    analyze,
    G,
    DEG,
    SENSORS,
    NATIVE_SENSORS,
    RN_SENSORS,
    APP_RULE,
    SLOT_ORDER,
    INTERIOR_SLOTS,
    INTERIOR_NEAR_CAR_M,
    slotForLabel,
    interiorSlotFor,
    helpers: { mean, median, std, quantile, wrap180, norm360, finite, nearest, between, cameraHeading, maxOf, minOf },
  };
})(typeof window !== 'undefined' ? window : globalThis);
