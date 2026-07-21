// Regenerates the commit-activity section of the profile README from real commits.
// Clones every owned non-fork repo, reads each commit local time (git %aI keeps the
// original timezone offset, unlike the GitHub API which normalizes to UTC), keeps only
// the owner's commits, and buckets them by time of day and weekday.
//
// Runs both in CI (reads GH_TOKEN from env) and locally (reads it from the git
// credential store). Needs a token with access to the private repos to include them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Commit identities that belong to the profile owner.
const MINE = new Set([
  'r.ranieri23@studenti.uniba.it',
  'rikirani10@gmail.com',
  '79905603+ricknewere@users.noreply.github.com',
  'ricknewere@users.noreply.github.com',
]);

const START = '<!--START:STATS-->';
const END = '<!--END:STATS-->';
const BLOCKS = 25;

function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  const res = spawnSync('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8' });
  const m = (res.stdout || '').match(/^password=(.*)$/m);
  if (!m) throw new Error('no token available');
  return m[1].trim();
}

async function listRepos(token, login) {
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 's', Accept: 'application/vnd.github+json' };
  const out = [];
  for (let page = 1; ; page++) {
    const j = await (await fetch(`https://api.github.com/user/repos?affiliation=owner&per_page=100&page=${page}`, { headers })).json();
    if (!Array.isArray(j) || j.length === 0) break;
    out.push(...j);
    if (j.length < 100) break;
  }
  return out.filter(r => !r.fork);
}

function bar(pct) {
  const filled = Math.round((pct / 100) * BLOCKS);
  return '█'.repeat(filled) + '░'.repeat(BLOCKS - filled);
}
function row(label, count, pct) {
  return `${label.padEnd(25)}${`${count} commits`.padEnd(20)}${bar(pct)}   ${pct.toFixed(2).padStart(5, '0')} % `;
}

async function main() {
  const token = getToken();
  const headers = { Authorization: `Bearer ${token}`, 'User-Agent': 's', Accept: 'application/vnd.github+json' };
  const me = await (await fetch('https://api.github.com/user', { headers })).json();
  const repos = await listRepos(token, me.login);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'stats-'));
  const commits = [];
  for (const r of repos) {
    const dir = path.join(work, `${r.name}.git`);
    const url = process.env.GH_TOKEN
      ? `https://x-access-token:${token}@github.com/${r.full_name}.git`
      : `https://github.com/${r.full_name}.git`;
    const cl = spawnSync('git', ['clone', '--bare', '--quiet', url, dir], { encoding: 'utf8' });
    if (cl.status !== 0) { console.error('clone failed', r.full_name); continue; }
    const lg = spawnSync('git', ['--git-dir', dir, 'log', '--all', '--no-merges', '--pretty=format:%aI\t%ae'], { encoding: 'utf8', maxBuffer: 1 << 26 });
    for (const ln of (lg.stdout || '').split('\n').filter(Boolean)) {
      const [iso, email] = ln.split('\t');
      commits.push({ iso, email });
    }
  }
  fs.rmSync(work, { recursive: true, force: true });

  const mine = commits.filter(c => MINE.has((c.email || '').toLowerCase()));
  const tod = { Morning: 0, Daytime: 0, Evening: 0, Night: 0 };
  const wdNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const wd = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0, Sunday: 0 };
  for (const c of mine) {
    const m = c.iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):/);
    if (!m) continue;
    const [, y, mo, d, hh] = m.map(Number);
    if (hh >= 6 && hh < 12) tod.Morning++;
    else if (hh >= 12 && hh < 18) tod.Daytime++;
    else if (hh >= 18 && hh < 24) tod.Evening++;
    else tod.Night++;
    wd[wdNames[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]]++;
  }

  const total = mine.length || 1;
  const icons = { Morning: '🌞', Daytime: '🌆', Evening: '🌃', Night: '🌙' };
  const phrase = {
    Morning: "I'm an early bird, I like committing in the morning 🌞",
    Daytime: 'I like committing in the afternoon 🌆',
    Evening: 'I like committing in the evening 🌃',
    Night: "I'm a night owl, I like committing at night 🌙",
  };
  const peak = Object.keys(tod).reduce((a, b) => (tod[b] > tod[a] ? b : a));
  const todOut = ['Morning', 'Daytime', 'Evening', 'Night'].map(k => row(`${icons[k]} ${k}`, tod[k], (tod[k] / total) * 100));
  const order = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const bestDay = order.reduce((a, b) => (wd[b] > wd[a] ? b : a));
  const wdOut = order.map(k => row(k, wd[k], (wd[k] / total) * 100));

  const block = [
    phrase[peak],
    '',
    '```text',
    ...todOut,
    '```',
    '',
    `📅 I'm Most Productive on ${bestDay}`,
    '',
    '```text',
    ...wdOut,
    '```',
  ].join('\n');

  const readmePath = path.join(process.cwd(), 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const next = readme.replace(new RegExp(`${START}[\\s\\S]*${END}`), `${START}\n${block}\n${END}`);
  fs.writeFileSync(readmePath, next);
  console.log('updated stats:', total, 'commits | peak:', peak, '| best day:', bestDay);
}

main();
