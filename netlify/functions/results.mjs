// Reads the Electoral Commission's XML results feed and returns one clean JSON file.
// Netlify's CDN caches the response for 30 seconds, so however many people view the
// site, the Commission's server only sees a request from this function every ~30s.

const BASE = (process.env.FEED_BASE || "https://media.election.net.nz/xml/").replace(/\/?$/, "/");
const FETCH_TIMEOUT_MS = 6000;
const CONCURRENCY = 10;

let refCache = null;      // candidates / parties / electorates (rarely change)
let refLoadedAt = 0;

function decode(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
}

// Value of a simple child element, e.g. tag(block, "votes")
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}

// All repeated elements with an id attribute, e.g. items(xml, "party", "p_no")
function items(xml, name, idAttr) {
  const out = [];
  const re = new RegExp(`<${name}\\s+([^>]*?)(?:\\/>|>([\\s\\S]*?)</${name}>)`, "g");
  let m;
  while ((m = re.exec(xml || ""))) {
    const attrs = m[1];
    const id = (attrs.match(new RegExp(`\\b${idAttr}="([^"]*)"`)) || [])[1];
    if (id === undefined) continue;
    out.push({ id, attrs, body: m[2] || "" });
  }
  return out;
}

function attr(attrs, name) {
  const m = (attrs || "").match(new RegExp(`${name}="([^"]*)"`));
  return m ? decode(m[1]) : "";
}

function section(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : "";
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

let deadline = Infinity;

async function getText(path) {
  const left = Math.min(FETCH_TIMEOUT_MS, deadline - Date.now());
  if (left < 300) throw new Error(`Out of time before ${path}`);
  const res = await fetch(BASE + path, {
    headers: { Accept: "application/xml,text/xml,*/*" },
    signal: AbortSignal.timeout(left),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.text();
}

async function loadReference() {
  if (refCache && Date.now() - refLoadedAt < 10 * 60 * 1000) return refCache;
  const [cXml, pXml, eXml] = await Promise.all([
    getText("candidates.xml"),
    getText("parties.xml"),
    getText("electorates.xml"),
  ]);
  const parties = {};
  for (const p of items(section(pXml, "parties") || pXml, "party", "p_no")) {
    parties[p.id] = {
      abbrev: tag(p.body, "abbrev"),
      short: tag(p.body, "short_name"),
      name: tag(p.body, "party_name"),
    };
  }
  const candidates = {};
  for (const c of items(section(cXml, "candidates") || cXml, "candidate", "c_no")) {
    candidates[c.id] = { name: tag(c.body, "candidate_name"), party: tag(c.body, "party") };
  }
  const electorates = [];
  for (const e of items(section(eXml, "electorates") || eXml, "electorate", "e_no")) {
    electorates.push({ no: num(e.id), name: tag(e.body, "electorate_name") });
  }
  electorates.sort((a, b) => a.no - b.no);
  refCache = { parties, candidates, electorates };
  refLoadedAt = Date.now();
  return refCache;
}

async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (i < list.length) {
      const idx = i++;
      try { out[idx] = await fn(list[idx]); } catch { out[idx] = null; }
    }
  });
  await Promise.all(workers);
  return out;
}

function partyLabel(ref, pNo) {
  const p = ref.parties[pNo];
  return p ? (p.short || p.name || p.abbrev) : "";
}

function parseElectorate(xml, e, ref) {
  const rootAttrs = (xml.match(/<electorate\s+([^>]*)>/) || [])[1] || "";
  const stats = section(xml, "statistics");
  const cands = items(section(xml, "candidatevotes"), "candidate", "c_no")
    .map((c) => {
      const info = ref.candidates[c.id] || {};
      return { name: info.name || `Candidate ${c.id}`, party: partyLabel(ref, info.party) || "Independent", votes: num(tag(c.body, "votes")) };
    })
    .sort((a, b) => b.votes - a.votes);
  return {
    no: e.no,
    name: e.name,
    final: attr(rootAttrs, "final") === "true",
    updated: attr(rootAttrs, "updated"),
    pctCounted: num(tag(stats, "percent_voting_places_counted")),
    votesCast: num(tag(stats, "total_votes_cast")),
    candidates: cands.slice(0, 4),
    candidateTotal: cands.reduce((s, c) => s + c.votes, 0),
  };
}

export default async () => {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "public, max-age=0, must-revalidate",
    "Netlify-CDN-Cache-Control": "public, durable, s-maxage=30, stale-while-revalidate=30",
  };
  deadline = Date.now() + 8500; // stay well inside Netlify's 10 second limit
  try {
    const [ref, elXml] = await Promise.all([loadReference(), getText("election.xml")]);
    const updated = attr((elXml.match(/<election\s+([^>]*)>/) || [])[1], "updated");
    const stats = section(elXml, "statistics");
    const parties = items(section(elXml, "partystatus"), "party", "p_no")
      .map((p) => {
        const info = ref.parties[p.id] || {};
        return {
          id: p.id,
          name: info.short || info.name || `Party ${p.id}`,
          abbrev: info.abbrev || "",
          votes: num(tag(p.body, "votes")),
          pct: num(tag(p.body, "percent_votes")),
          listSeats: num(tag(p.body, "party_seats")),
          electorateSeats: num(tag(p.body, "candidate_seats")),
          totalSeats: num(tag(p.body, "total_seats")),
        };
      })
      .sort((a, b) => b.votes - a.votes);

    const electorates = (await mapLimit(ref.electorates, CONCURRENCY, async (e) => {
      const pad = String(e.no).padStart(2, "0");
      const xml = await getText(`e${pad}/e${pad}.xml`);
      return parseElectorate(xml, e, ref);
    })).map((r, i) => r || { no: ref.electorates[i].no, name: ref.electorates[i].name, missing: true, candidates: [], pctCounted: 0, votesCast: 0, candidateTotal: 0 });

    const body = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      updated,
      stats: {
        pctPlacesCounted: num(tag(stats, "percent_voting_places_counted")),
        votesCast: num(tag(stats, "total_votes_cast")),
        electoratesFinal: num(tag(stats, "total_electorates_final")),
        specialVotes: num(tag(stats, "total_special_votes")),
      },
      parties,
      electorates,
      missingElectorates: electorates.filter((e) => e.missing).length,
    };
    return new Response(JSON.stringify(body), { headers });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err && err.message || err) }), {
      status: 502,
      headers: { ...headers, "Netlify-CDN-Cache-Control": "public, s-maxage=10" },
    });
  }
};

export const config = { path: "/api/results" };
