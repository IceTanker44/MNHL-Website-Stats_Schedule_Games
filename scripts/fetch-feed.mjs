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

const videoIdOf = link => (link.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/)([\w-]{11})/) || [])[1] || '';
async function sheetMedia() {
  const out = { channels: [], videos: [] };
  try {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=0&sheet=Media`);
    const rows = parseCsv(await res.text());
    const hi = rows.findIndex(r => r.some(c => /^platform$/i.test(c)));
    if (hi < 0) return out;                      // no Media tab (Google returns another tab instead)
    const h = rows[hi].map(c => c.toLowerCase());
    const [cn, cl, ct] = ['name', 'link', 'team'].map(k => Math.max(0, h.indexOf(k)));
    const cd = h.indexOf('date');
    for (const r of rows.slice(hi + 1)) {
      const link = r[cl] || '', ch = link.match(/youtube\.com\/channel\/(UC[\w-]{20,})/), vid = videoIdOf(link);
      if (ch) out.channels.push({ id: ch[1], name: r[cn] || ch[1], team: r[ct] || '' });
      else if (vid) {
        const d = cd >= 0 && r[cd] ? new Date(r[cd]) : null;
        out.videos.push({ id: vid, title: r[cn] || 'Video', published: d && !isNaN(d) ? d.toISOString() : '', channel: r[ct] || 'MNHL', team: r[ct] || '' });
      }
    }
  } catch (e) { console.log('Could not read the Media tab:', e.message); }
  return out;
}

// YouTube's channel feed sometimes answers 404 even for active channels, so try the channel's "uploads" playlist feeds too.
const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function fetchChannel(ch, fetchFn = fetch, wait = 2000) {
  const rest = ch.id.replace(/^UC/, '');
  const urls = [
    `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`,
    `https://www.youtube.com/feeds/videos.xml?playlist_id=UU${rest}`,
    `https://www.youtube.com/feeds/videos.xml?playlist_id=UULF${rest}`
  ];
  const errors = [];
  if (process.env.YT_API_KEY) {                  // official API: most reliable, needs a free key (see README steps)
    try {
      const api = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=${PER_CHANNEL}&playlistId=UU${rest}&key=${process.env.YT_API_KEY}`;
      const res = await fetchFn(api), j = await res.json();
      if (!res.ok) throw new Error('API ' + res.status + (j.error ? ' ' + j.error.message : ''));
      const got = (j.items || []).map(it => ({ id: it.snippet.resourceId.videoId, title: it.snippet.title, published: it.snippet.publishedAt, channel: ch.name, team: ch.team })).filter(v => v.id);
      if (got.length) return { got, via: 'YouTube API' };
      throw new Error('API returned no videos');
    } catch (e) { errors.push(e.message); }
  }
  for (const url of urls) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchFn(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const got = parseFeed(await res.text(), ch);
        if (got.length) return { got, via: url.includes('channel_id') ? 'channel feed' : 'uploads playlist' };
        throw new Error('no videos in feed');
      } catch (e) { errors.push(e.message); if (attempt < 2) await sleep(wait); }
    }
  }
  throw new Error([...new Set(errors)].join(', '));
}

async function main() {
  const sm = await sheetMedia();
  const all = [...CHANNELS, ...sm.channels];
  const seen = new Set(), channels = all.filter(c => !seen.has(c.id) && seen.add(c.id));
  let items = [...sm.videos];
  console.log(`${sm.videos.length} video(s) listed on the Media tab`);
  for (const ch of channels) {
    try {
      const { got, via } = await fetchChannel(ch);
      console.log(`${ch.name}: ${got.length} videos (via ${via})`);
      items = items.concat(got);
    } catch (e) { console.log(`${ch.name}: failed (${e.message})`); }
  }
  items.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));
  writeFileSync('feed.json', JSON.stringify({ updated: new Date().toISOString(), items: items.slice(0, TOTAL) }, null, 1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
