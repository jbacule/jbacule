// Builds stats/streak-{dark,light}.svg from the GitHub contribution calendar.
// Runs in GitHub Actions; needs GITHUB_TOKEN and GITHUB_USER in the env.
import { mkdir, writeFile } from "node:fs/promises";

const USER = process.env.GITHUB_USER ?? "jbacule";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(JSON.stringify(json.errors ?? json));
  return json.data;
}

const CAL = `query($login:String!,$from:DateTime,$to:DateTime){user(login:$login){
  createdAt
  contributionsCollection(from:$from,to:$to){contributionCalendar{totalContributions
    weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;

// Last year (what the profile shows) gives the heatmap; earlier years fill in the streaks.
const recent = (await gql(CAL, { login: USER })).user;
const lastYear = recent.contributionsCollection.contributionCalendar;
const days = new Map();
for (const w of lastYear.weeks) for (const d of w.contributionDays) days.set(d.date, d.contributionCount);

const firstYear = new Date(recent.createdAt).getUTCFullYear();
for (let y = firstYear; y <= new Date().getUTCFullYear(); y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = `${y}-12-31T23:59:59Z`;
  {
    const cal = (await gql(CAL, { login: USER, from, to })).user.contributionsCollection.contributionCalendar;
    for (const w of cal.weeks) for (const d of w.contributionDays) if (!days.has(d.date)) days.set(d.date, d.contributionCount);
  }
}

const today = new Date().toISOString().slice(0, 10);
const sorted = [...days.entries()].filter(([d]) => d <= today).sort(([a], [b]) => a.localeCompare(b));
const total = sorted.reduce((s, [, c]) => s + c, 0);
const firstDay = sorted.find(([, c]) => c > 0)?.[0];

let longest = { len: 0, start: null, end: null };
let run = { len: 0, start: null };
for (const [d, c] of sorted) {
  if (c > 0) {
    run = run.len ? { len: run.len + 1, start: run.start } : { len: 1, start: d };
    if (run.len > longest.len) longest = { len: run.len, start: run.start, end: d };
  } else run = { len: 0, start: null };
}
// A quiet "today" doesn't break the current streak yet.
let i = sorted.length - 1;
if (i >= 0 && sorted[i][1] === 0) i--;
let current = { len: 0, start: null, end: null };
if (i >= 0 && sorted[i][1] > 0) {
  current.end = sorted[i][0];
  while (i >= 0 && sorted[i][1] > 0) { current.len++; current.start = sorted[i][0]; i--; }
}

const fmt = (d, year = true) =>
  d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year && { year: "numeric" }), timeZone: "UTC" }) : "";
const range = (s, e) => (s ? `${fmt(s, s.slice(0, 4) !== e.slice(0, 4))} – ${fmt(e)}` : "No streak yet");
const n = (x) => x.toLocaleString("en-US");

const THEMES = {
  dark: { bg: "#18181b", border: "#27272a", text: "#fafafa", muted: "#a1a1aa", accent: "#38bdf8",
    levels: ["#27272a", "#0c4a6e", "#0369a1", "#0ea5e9", "#7dd3fc"] },
  light: { bg: "#ffffff", border: "#e4e4e7", text: "#18181b", muted: "#71717a", accent: "#0e7490",
    levels: ["#f4f4f5", "#a5f3fc", "#22d3ee", "#0891b2", "#155e75"] },
};
const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

function svg(t) {
  const W = 720, H = 280, FONT = `Geist, ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
  const cols = [
    { label: "Total Contributions", value: n(total), sub: firstDay ? `${fmt(firstDay)} – Present` : "" },
    { label: "Current Streak", value: `${current.len} days`, sub: range(current.start, current.end), hi: true },
    { label: "Longest Streak", value: `${longest.len} days`, sub: range(longest.start, longest.end) },
  ];
  const colW = (W - 48) / 3;
  const stats = cols.map((c, k) => {
    const x = 24 + colW * k + colW / 2;
    return `<text x="${x}" y="62" text-anchor="middle" font-size="12" fill="${t.muted}" letter-spacing=".04em">${c.label.toUpperCase()}</text>
<text x="${x}" y="100" text-anchor="middle" font-size="30" font-weight="700" fill="${c.hi ? t.accent : t.text}">${c.value}</text>
<text x="${x}" y="122" text-anchor="middle" font-size="12" fill="${t.muted}">${c.sub}</text>`;
  }).join("\n");
  const dividers = [1, 2].map((k) => `<line x1="${24 + colW * k}" y1="48" x2="${24 + colW * k}" y2="128" stroke="${t.border}"/>`).join("");

  const cell = 10, gap = 2, weeks = lastYear.weeks.slice(-53);
  const gridW = weeks.length * (cell + gap) - gap;
  const gx = (W - gridW) / 2, gy = 160;
  const grid = weeks.map((w, wi) => w.contributionDays.map((d) => {
    const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
    return `<rect x="${gx + wi * (cell + gap)}" y="${gy + dow * (cell + gap)}" width="${cell}" height="${cell}" rx="2" fill="${t.levels[LEVEL[d.contributionLevel] ?? 0]}"><title>${d.contributionCount} on ${d.date}</title></rect>`;
  }).join("")).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}" role="img" aria-label="${USER}: ${n(total)} contributions, current streak ${current.len} days, longest streak ${longest.len} days">
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="${t.bg}" stroke="${t.border}"/>
<text x="24" y="30" font-size="14" font-weight="600" fill="${t.text}">GitHub Activity</text>
<text x="${W - 24}" y="30" text-anchor="end" font-size="12" fill="${t.muted}">@${USER}</text>
${dividers}
${stats}
${grid}
<text x="${gx}" y="${H - 20}" font-size="11" fill="${t.muted}">${n(lastYear.totalContributions)} contributions in the last year</text>
<text x="${gx + gridW}" y="${H - 20}" text-anchor="end" font-size="11" fill="${t.muted}">Updated ${fmt(today)}</text>
</svg>
`;
}

await mkdir("stats", { recursive: true });
for (const [name, t] of Object.entries(THEMES)) await writeFile(`stats/streak-${name}.svg`, svg(t));
console.log({ total, current, longest, lastYear: lastYear.totalContributions });
