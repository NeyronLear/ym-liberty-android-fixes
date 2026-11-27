#!/usr/bin/env node

/**
 * Regression test for the Wave refill race.
 *
 * The background preload and the end-of-queue fallback could both ask Rotor for
 * more tracks, snapshot the same queue and append the same batch twice, which
 * made one track play two or three times in a row. The fix shares the in-flight
 * request and re-checks the live queue at append time.
 *
 * The test extracts the real functions from app.js (no duplicated logic) and
 * runs them against a Rotor that always answers with the same one-track batch.
 *
 * Run:  node tools/test-vibe-refill.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP = path.join(__dirname, '..', 'android_app', 'assets', 'www', 'app.js');
const src = fs.readFileSync(APP, 'utf8');

function slice(startMarker, endMarker) {
  const from = src.indexOf(startMarker);
  const to = src.indexOf(endMarker, from + startMarker.length);
  if (from < 0 || to < 0) {
    throw new Error(`app.js markers changed; update this test (${startMarker} -> ${endMarker})`);
  }
  return src.slice(from, to);
}

// Dedup engine + Rotor loader (everything up to startVibe()).
const engine = slice('const VIBE_HISTORY_KEY', 'async function startVibe()');
// The refill function itself (startVibe sits between applyVibeLoad and it).
const refill = slice('let vibeRefillPromise = null;', 'async function startTrackVibe(');

let getVibeCalls = 0;
const storage = {};
const state = {
  token: 'token',
  queue: [{ id: 'A', title: 'A' }],
  queueIndex: 0,
  currentTrack: { id: 'A', title: 'A' },
  currentStation: 'user:onyourwave',
  moodRequestSeq: 0,
  vibeHistory: new Set(['A']),
  vibeBatchId: null,
  vibeBatchByTrack: {},
  vibeCursor: null,
  vibeCursorStation: null,
  isFetchingVibe: false
};

const YandexClient = {
  async getVibe() {
    getVibeCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 40));
    // A stuck station: every request returns the same track.
    return { tracks: [{ id: 'B', title: 'B' }], batchId: 'batch-1', lastTrackId: 'B' };
  }
};

const sandbox = {
  console,
  state,
  YandexClient,
  localStorage: {
    getItem: key => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value); }
  },
  setTimeout,
  clearTimeout,
  Promise
};
vm.createContext(sandbox);
vm.runInContext(engine + '\n' + refill, sandbox, { filename: 'app-extract.js' });

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

(async () => {
  // Both callers ask at the same moment, as the preload and the end-of-queue
  // fallback do when the last track ends before a refill finishes.
  const [first, second] = await Promise.all([
    sandbox.fetchMoreVibeTracks(),
    sandbox.fetchMoreVibeTracks()
  ]);

  const ids = state.queue.map(track => String(track.id));
  const duplicate = ids.some((id, index) => ids.indexOf(id) !== index);

  if (duplicate) fail(`queue contains a repeated track: ${ids.join(', ')}`);
  if (getVibeCalls !== 2) fail(`expected one shared refill (2 Rotor requests), got ${getVibeCalls}`);
  if (first !== second) fail('second caller did not receive the in-flight promise');

  // A slow fallback that appends the same batch afterwards must add nothing.
  const late = sandbox.appendFreshVibeTracks([{ id: 'B', title: 'B' }]);
  if (late.length !== 0) fail(`late fallback re-appended ${late.length} track(s)`);

  const finalIds = state.queue.map(track => String(track.id));
  if (finalIds.join(',') !== 'A,B') fail(`unexpected final queue: ${finalIds.join(', ')}`);

  if (!process.exitCode) {
    console.log(`PASS: queue=${finalIds.join(', ')} rotorCalls=${getVibeCalls}`);
  }
})();
