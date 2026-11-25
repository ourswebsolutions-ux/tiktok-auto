'use strict';
// Pure scheduling helpers: spread N posts across the full 24 hours of the day at even,
// slightly randomised intervals (no fixed posting hours).

const DAY_END_MIN = 24 * 60 - 5; // last possible slot of a day: 23:55
const MIN_GAP_MS = 25 * 60 * 1000; // at least 25 minutes between posts
const MAX_DAILY = 20;

const pad = (n) => String(n).padStart(2, '0');
function dayKey(date = new Date()) {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function atLocal(day, minutes) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60, 0, 0).getTime();
}

/**
 * Evenly distribute `count` times in [from, to], each in the middle of its slot with jitter.
 * Consecutive times are always at least `minGap` apart; times that would not fit are dropped.
 */
function planTimes(count, from, to, { minGap = MIN_GAP_MS, rand = Math.random } = {}) {
  if (count <= 0 || to <= from) return [];
  const maxFit = Math.max(1, Math.floor((to - from) / minGap));
  const n = Math.min(count, maxFit);
  const slot = (to - from) / n;
  const jitterAmp = slot >= 2 * minGap ? slot * 0.25 : 0;
  const times = [];
  for (let i = 0; i < n; i++) {
    const base = from + slot * i + slot / 2;
    times.push(Math.round(base + (rand() * 2 - 1) * jitterAmp));
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < minGap) times[i] = times[i - 1] + minGap;
  }
  return times.filter((t) => t <= to);
}

/**
 * Works out which new slots to add (or which scheduled posts to drop) so that `day` gets `target` posts.
 *  - existingActive: posts of that day counting toward the target (scheduled / in progress / published / unverified)
 *  - totalAttempts:  all posts created for that day (caps replacements of failed posts)
 * Returns { add: [timestamps], remove: [postIds] }.
 */
function planDay({ day, target, existingActive, totalAttempts, now, rand }) {
  target = Math.max(0, Math.min(MAX_DAILY, Number(target) || 0));
  const result = { add: [], remove: [] };
  const need = target - existingActive.length;
  if (need < 0) {
    // Quantity was reduced: drop the latest not-yet-started posts.
    const removable = existingActive.filter((p) => p.status === 'scheduled').sort((a, b) => b.scheduled_at - a.scheduled_at);
    result.remove = removable.slice(0, -need).map((p) => p.id);
    return result;
  }
  if (need === 0) return result;
  const allowed = Math.max(0, target * 3 - totalAttempts); // failed posts are replaced, but not endlessly
  const count = Math.min(need, allowed);
  if (!count) return result;

  const lastActive = existingActive.reduce((m, p) => Math.max(m, p.published_at || p.scheduled_at || 0), 0);
  // Whole day (00:00-23:55); when started mid-day, the remaining posts are spread over the remaining hours.
  const from = Math.max(now + 2 * 60 * 1000, atLocal(day, 0), lastActive ? lastActive + MIN_GAP_MS : 0);
  const to = atLocal(day, DAY_END_MIN);
  if (to <= from) return result;
  result.add = planTimes(count, from, to, { rand });
  return result;
}

module.exports = { dayKey, atLocal, planTimes, planDay, MIN_GAP_MS, MAX_DAILY };
