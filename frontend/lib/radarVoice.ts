'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Aircraft, EstimatedAircraft, Units } from './types';
import { bearing, compassWords, distanceNm } from './flight';

/** One aircraft as the radar sees it. */
export interface RadarTarget {
  hex: string;
  label: string;
  lat: number;
  lon: number;
  alt: number | null;
  gs: number | null;
  track: number | null;
  estimated: boolean;
}

export function toTargets(live: Aircraft[], est: EstimatedAircraft[]): RadarTarget[] {
  const out: RadarTarget[] = [];
  const seen = new Set<string>();
  for (const a of live) {
    if (a.onGround) continue;
    seen.add(a.hex);
    out.push({ hex: a.hex, label: a.callsign ?? a.reg ?? a.hex, lat: a.lat, lon: a.lon, alt: a.alt, gs: a.gs, track: a.track, estimated: false });
  }
  for (const e of est) {
    if (seen.has(e.hex)) continue;
    out.push({ hex: e.hex, label: e.flightNumber ?? e.callsign, lat: e.lat, lon: e.lon, alt: e.alt, gs: e.gs, track: e.track, estimated: true });
  }
  return out;
}

// ---------------------------------------------------------------- speech helpers

/** "ABY587" → "A B Y 5 8 7" so speech engines read callsigns like a controller would. */
function sayCallsign(cs: string) {
  return cs
    .replace(/\s+/g, '')
    .split('')
    .join(' ');
}

function sayDistance(nm: number, units: Units) {
  if (units === 'metric') return `${Math.round(nm * 1.852)} kilometres`;
  if (units === 'imperial') return `${Math.round(nm * 1.15078)} miles`;
  return `${Math.round(nm)} nautical miles`;
}

function sayAltitude(ft: number | null, units: Units) {
  if (ft === null) return '';
  if (units === 'metric') {
    const m = ft * 0.3048;
    return m >= 1000 ? `${(Math.round(m / 100) / 10).toLocaleString('en')} thousand metres` : `${Math.round(m / 10) * 10} metres`;
  }
  if (units === 'aviation' && ft >= 18000) return `flight level ${Math.round(ft / 1000) * 10}`;
  return ft >= 1000 ? `${Math.round(ft / 1000)} thousand feet` : `${Math.round(ft / 100) * 100} feet`;
}

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const signedTurn = (from: number, to: number) => ((to - from + 540) % 360) - 180;

// ---------------------------------------------------------------- the hook

interface TrackState {
  inside: boolean;
  announcedTrack: number | null;
  leavingAnnounced: boolean;
  lastDist: number;
  lastSpokeAt: number;
  label: string;
  estimated: boolean;
  /** Consecutive updates this aircraft was missing from (grace for data hiccups). */
  missing: number;
}

interface Pending {
  text: string;
  at: number;
  priority: number;
}

const TURN_DEG = 35;
const PER_FLIGHT_COOLDOWN_MS = 25_000;
const MAX_QUEUE = 5;
const STALE_MS = 20_000;
/** Entering/leaving messages may wait longer before being dropped. */
const STALE_IMPORTANT_MS = 60_000;

/**
 * Spoken radar announcements (Web Speech API): aircraft entering the range, turning,
 * about to leave and leaving. Stateless between sessions; only runs while `active`.
 */
export function useRadarVoice(opts: {
  enabled: boolean;
  active: boolean;
  location: { lat: number; lon: number } | null;
  radiusNm: number;
  units: Units;
  targets: RadarTarget[];
  /** Bumped whenever new radar data arrives. */
  version: number;
}) {
  const { enabled, active, location, radiusNm, units, targets, version } = opts;
  const state = useRef(new Map<string, TrackState>());
  const queue = useRef<Pending[]>([]);
  const speaking = useRef(false);
  const primed = useRef(false);
  const [caption, setCaption] = useState<string | null>(null);
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window;

  // Chrome garbage-collects utterances that nothing references, and then never fires onend —
  // which would stall our queue after the first message. Keep a reference + a watchdog.
  const current = useRef<SpeechSynthesisUtterance | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pump = useCallback(() => {
    if (!supported || speaking.current) return;
    const now = Date.now();
    queue.current = queue.current.filter((p) => now - p.at < (p.priority >= 3 ? STALE_IMPORTANT_MS : STALE_MS));
    const next = queue.current.shift();
    if (!next) return;
    const u = new SpeechSynthesisUtterance(next.text);
    const voices = window.speechSynthesis.getVoices();
    const voice =
      voices.find((v) => /^en(-|_)/i.test(v.lang) && /natural|google|samantha|daniel|serena/i.test(v.name)) ?? voices.find((v) => /^en(-|_)/i.test(v.lang));
    if (voice) u.voice = voice;
    u.rate = 1.02;
    speaking.current = true;
    current.current = u;
    setCaption(next.text);
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (watchdog.current) clearTimeout(watchdog.current);
      current.current = null;
      speaking.current = false;
      pump();
    };
    u.onend = done;
    u.onerror = done;
    // ~80 ms per character is slow speech; if onend still hasn't fired by then, move on.
    watchdog.current = setTimeout(done, 3_000 + next.text.length * 80);
    window.speechSynthesis.speak(u);
  }, [supported]);

  const say = useCallback(
    (text: string, priority = 1) => {
      if (!supported) return;
      queue.current.push({ text, at: Date.now(), priority });
      // Keep the most important / newest few.
      queue.current.sort((a, b) => b.priority - a.priority || a.at - b.at);
      if (queue.current.length > MAX_QUEUE) queue.current = queue.current.slice(0, MAX_QUEUE);
      pump();
    },
    [pump, supported],
  );

  // Reset when switched off / radar closed / moved.
  useEffect(() => {
    if (enabled && active) return;
    state.current.clear();
    queue.current = [];
    primed.current = false;
    if (supported) window.speechSynthesis.cancel();
    if (watchdog.current) clearTimeout(watchdog.current);
    current.current = null;
    speaking.current = false;
  }, [enabled, active, supported]);

  useEffect(() => {
    state.current.clear();
    primed.current = false;
  }, [radiusNm, location?.lat, location?.lon]);

  // Diff each radar update against the previous one.
  useEffect(() => {
    if (!enabled || !active || !location || !supported) return;
    const now = Date.now();
    const seen = new Set<string>();
    const first = !primed.current;
    let insideCount = 0;
    // Events of one update are combined, so simultaneous arrivals are all announced.
    const entering: { name: string; detail: string }[] = [];
    const left: string[] = [];
    const lost: string[] = [];

    for (const t of targets) {
      const dist = distanceNm(location.lat, location.lon, t.lat, t.lon);
      const inside = dist <= radiusNm;
      const brg = bearing(location.lat, location.lon, t.lat, t.lon);
      const prev = state.current.get(t.hex);
      const name = `${sayCallsign(t.label)}${t.estimated ? ', estimated,' : ''}`;
      seen.add(t.hex);
      if (inside) insideCount++;

      const st: TrackState = prev ?? {
        inside: false,
        announcedTrack: t.track,
        leavingAnnounced: false,
        lastDist: dist,
        lastSpokeAt: 0,
        label: t.label,
        estimated: t.estimated,
        missing: 0,
      };
      st.missing = 0;
      const canSpeak = now - st.lastSpokeAt > PER_FLIGHT_COOLDOWN_MS;

      if (inside && !st.inside) {
        if (!first) {
          const alt = sayAltitude(t.alt, units);
          const hdg = t.track !== null ? `, heading ${compassWords(t.track)}` : '';
          entering.push({ name, detail: `${sayDistance(dist, units)} ${compassWords(brg)}${alt ? `, ${alt}` : ''}${hdg}` });
          st.lastSpokeAt = now;
        }
        st.announcedTrack = t.track;
        st.leavingAnnounced = false;
      } else if (inside && st.inside) {
        // Direction change (live aircraft moving at speed only — estimates follow great circles).
        if (!t.estimated && t.track !== null && st.announcedTrack !== null && (t.gs ?? 0) > 80) {
          const turn = signedTurn(st.announcedTrack, t.track);
          if (Math.abs(turn) >= TURN_DEG) {
            if (canSpeak) {
              say(`${name} turning ${turn > 0 ? 'right' : 'left'}, now heading ${compassWords(t.track)}.`, 1);
              st.lastSpokeAt = now;
            }
            st.announcedTrack = t.track;
          }
        } else if (st.announcedTrack === null) st.announcedTrack = t.track;
        // About to leave: outer 20 % of the range and moving outwards.
        const outward = t.track !== null && angleDiff(t.track, brg) < 70;
        if (!st.leavingAnnounced && dist > radiusNm * 0.8 && outward && dist >= st.lastDist) {
          say(`${name} about to leave radar, ${sayDistance(dist, units)} ${compassWords(brg)}.`, 2);
          st.leavingAnnounced = true;
          st.lastSpokeAt = now;
        } else if (dist < radiusNm * 0.7) st.leavingAnnounced = false;
      } else if (!inside && st.inside) {
        left.push(name);
        st.lastSpokeAt = now;
        st.leavingAnnounced = false;
      }
      st.inside = inside;
      st.lastDist = dist;
      st.label = t.label;
      st.estimated = t.estimated;
      state.current.set(t.hex, st);
    }

    // Aircraft that vanished from the data while inside the range.
    for (const [hex, st] of state.current) {
      if (seen.has(hex)) continue;
      if (++st.missing < 2) continue; // one missed update is usually just a data hiccup
      if (st.inside && !first) {
        const name = sayCallsign(st.label);
        if (st.lastDist > radiusNm * 0.8) left.push(name);
        else lost.push(name);
      }
      state.current.delete(hex);
    }

    const list = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
    if (entering.length === 1) say(`${entering[0].name} entering radar, ${entering[0].detail}.`, 3);
    else if (entering.length <= 3 && entering.length > 1)
      say(`${entering.length} aircraft entering radar: ${entering.map((e) => `${e.name}, ${e.detail}`).join('; and ')}.`, 3);
    else if (entering.length > 3)
      say(`${entering.length} aircraft entering radar, including ${list(entering.slice(0, 3).map((e) => e.name))}.`, 3);
    if (left.length === 1) say(`${left[0]} has left the radar.`, 3);
    else if (left.length > 1) say(`${left.length} aircraft left the radar: ${list(left.slice(0, 4))}${left.length > 4 ? ' and others' : ''}.`, 3);
    if (lost.length === 1) say(`${lost[0]}, signal lost.`, 2);
    else if (lost.length > 1) say(`Signal lost for ${list(lost.slice(0, 4))}${lost.length > 4 ? ' and others' : ''}.`, 2);

    if (first) {
      primed.current = true;
      say(insideCount === 0 ? 'Radar active. No aircraft in range.' : `Radar active. ${insideCount} aircraft in range.`, 3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  /** Speak immediately (used for the on/off confirmation — also unlocks audio after a click). */
  const announce = useCallback(
    (text: string) => {
      if (!supported) return;
      window.speechSynthesis.cancel();
      speaking.current = false;
      queue.current = [];
      say(text, 5);
    },
    [say, supported],
  );

  return { supported, caption, announce };
}
