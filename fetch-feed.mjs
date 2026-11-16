// Builds feed.json: the newest videos from every YouTube channel in the league.
// Runs on GitHub (see .github/workflows/update-feed.yml). Node 18+, no packages needed.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHEET_ID = '10r_w3Sy2j50YWrX8LpvGSk7oGGgEaBKN8gJIASP4Fyo';
// Always included. More channels are picked up from the sheet's "Media" tab (any YouTube channel link with /channel/UC...).
const CHANNELS = [
  { id: 'UCOO3uwGUhIgJ2tVQbyKwMEg', name: 'MNHL Live', team: '' },
  { id: 'UCMNS82Zph3G-E-fu7oHFmLw', name: 'Clankerville Renegades', team: 'CV Renegades' }
];
const PER_CHANNEL = 8, TOTAL = 48;

const decode = t => t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };

export function parseFeed(xml, channel) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, PER_CHANNEL).map(([, e]) => ({
    id: tag(e, 'yt:videoId'), title: tag(e, 'title'), published: tag(e, 'published'),
    channel: channel.name, team: channel.team
  })).filter(v => v.id);
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  row.push(cell); rows.push(row);
  return rows.map(r => r.map(x => x.trim()));
}

async function sheetChannels() {
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=Media`);
    const rows = parseCsv(await res.text());
    const hi = rows.findIndex(r => r.some(c => /^platform$/i.test(c)));
    if (hi < 0) return [];                       // no Media tab (Google returns another tab instead)
    const h = rows[hi].map(c => c.toLowerCase());
    const [cn, cl, ct] = ['name', 'link', 'team'].map(k => Math.max(0, h.indexOf(k)));
    return rows.slice(hi + 1).map(r => {
      const m = (r[cl] || '').match(/youtube\.com\/channel\/(UC[\w-]{20,})/);
      return m ? { id: m[1], name: r[cn] || m[1], team: r[ct] || '' } : null;
    }).filter(Boolean);
  } catch (e) { console.log('Could not read the Media tab:', e.message); return []; }
}

async function main() {
  const all = [...CHANNELS, ...(await sheetChannels())];
  const seen = new Set(), channels = all.filter(c => !seen.has(c.id) && seen.add(c.id));
  let items = [];
  for (const ch of channels) {
    try {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const got = parseFeed(await res.text(), ch);
      console.log(`${ch.name}: ${got.length} videos`);
      items = items.concat(got);
    } catch (e) { console.log(`${ch.name}: failed (${e.message})`); }
  }
  items.sort((a, b) => new Date(b.published) - new Date(a.published));
  writeFileSync('feed.json', JSON.stringify({ updated: new Date().toISOString(), items: items.slice(0, TOTAL) }, null, 1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
