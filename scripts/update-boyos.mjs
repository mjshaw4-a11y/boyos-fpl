const FPL = "https://fantasy.premierleague.com/api";

const BOYOS = [
  { name: "Dave", manager: "David Eyre", id: 5568090 },
  { name: "Joe", manager: "Joe Burke", id: 3926846 },
  { name: "Manny", manager: "Manny Jandu", id: 2368930 },
  { name: "Ben", manager: "Ben Burt", id: 9314745 },
  { name: "Curlo", manager: "Matthew Shaw", id: 4909963 }
];

async function fplFetch(path) {
  const response = await fetch(`${FPL}${path}`, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!response.ok) throw new Error(`FPL request failed: ${path} (${response.status})`);
  return response.json();
}

const bootstrap = await fplFetch("/bootstrap-static/");
const players = Object.fromEntries(bootstrap.elements.map(p => [p.id, { name: p.web_name, full_name: `${p.first_name} ${p.second_name}`, team: p.team, position: p.element_type }]));
const events = bootstrap.events.map(e => ({ id: e.id, name: e.name, deadline_time: e.deadline_time, finished: e.finished, data_checked: e.data_checked }));

const base = await Promise.all(BOYOS.map(async boyo => {
  const [entry, history, transfers] = await Promise.all([
    fplFetch(`/entry/${boyo.id}/`), fplFetch(`/entry/${boyo.id}/history/`), fplFetch(`/entry/${boyo.id}/transfers/`)
  ]);
  return { boyo, entry, history, transfers };
}));

const latestGW = Math.max(...base.flatMap(x => x.history.current.map(g => g.event)));
const live = await fplFetch(`/event/${latestGW}/live/`);
const livePoints = Object.fromEntries(live.elements.map(e => [e.id, { points: e.stats.total_points, minutes: e.stats.minutes, goals: e.stats.goals_scored, assists: e.stats.assists, clean_sheets: e.stats.clean_sheets, bonus: e.stats.bonus, yellow_cards: e.stats.yellow_cards, red_cards: e.stats.red_cards }]));

const managers = await Promise.all(base.map(async ({ boyo, entry, history, transfers }) => {
  const gw = history.current.find(x => x.event === latestGW);
  const prev = history.current.find(x => x.event === latestGW - 1) || null;
  let picks = null;
  try { picks = await fplFetch(`/entry/${boyo.id}/event/${latestGW}/picks/`); } catch {}
  const squad = (picks?.picks || []).map(p => {
    const live = livePoints[p.element] || {};
    return { player: players[p.element]?.name || p.element, player_id: p.element, position: p.position, raw_points: live.points ?? null, multiplier: p.multiplier, counted_points: live.points !== undefined ? live.points * p.multiplier : null, captain: p.is_captain, vice_captain: p.is_vice_captain, bench: p.position > 11, minutes: live.minutes ?? null, goals: live.goals ?? null, assists: live.assists ?? null, clean_sheets: live.clean_sheets ?? null, bonus: live.bonus ?? null };
  });
  const captain = squad.find(p => p.captain), vice = squad.find(p => p.vice_captain);
  return {
    name: boyo.name, manager: boyo.manager, entry_id: boyo.id, team_name: entry.name,
    total_points: entry.summary_overall_points, overall_rank: entry.summary_overall_rank,
    latest_gameweek: latestGW, gameweek_points: gw?.points ?? null, transfer_cost: gw?.event_transfers_cost ?? 0,
    net_gameweek_points: gw ? gw.points - (gw.event_transfers_cost || 0) : null, points_on_bench: gw?.points_on_bench ?? null,
    captain: captain ? { player: captain.player, raw_points: captain.raw_points, counted_points: captain.counted_points } : null,
    vice_captain: vice ? { player: vice.player, raw_points: vice.raw_points } : null,
    active_chip: picks?.active_chip || null,
    transfers: transfers.filter(t => t.event === latestGW).map(t => ({ in: players[t.element_in]?.name || t.element_in, in_id: t.element_in, in_points: livePoints[t.element_in]?.points ?? null, out: players[t.element_out]?.name || t.element_out, out_id: t.element_out, out_points: livePoints[t.element_out]?.points ?? null, time: t.time })),
    bench: squad.filter(p => p.bench), squad,
    previous_gameweek: prev ? { gameweek: prev.event, points: prev.points, total_points: prev.total_points, overall_rank: prev.overall_rank, transfer_cost: prev.event_transfers_cost, points_on_bench: prev.points_on_bench } : null,
    gameweek_history: history.current.map(g => ({ gameweek: g.event, points: g.points, total_points: g.total_points, overall_rank: g.overall_rank, transfer_cost: g.event_transfers_cost, points_on_bench: g.points_on_bench }))
  };
}));

managers.sort((a,b) => b.total_points - a.total_points || a.overall_rank - b.overall_rank);
const previousStandings = [...managers].filter(m => m.previous_gameweek).sort((a,b) => b.previous_gameweek.total_points - a.previous_gameweek.total_points);
const previousRanks = Object.fromEntries(previousStandings.map((m,i) => [m.entry_id, i+1]));
const standings = managers.map((m,i) => ({ rank: i+1, name: m.name, manager: m.manager, team_name: m.team_name, gameweek_points: m.gameweek_points, transfer_cost: m.transfer_cost, net_gameweek_points: m.net_gameweek_points, total_points: m.total_points, overall_rank: m.overall_rank, previous_boyos_rank: previousRanks[m.entry_id] ?? null, rank_change: previousRanks[m.entry_id] ? previousRanks[m.entry_id] - (i+1) : null }));

const output = { league: { id: 1104421, name: "Boyos FPL" }, generated_at: new Date().toISOString(), latest_gameweek: latestGW, events, standings, managers };
await import("node:fs/promises").then(fs => fs.writeFile("boyos-data.json", JSON.stringify(output, null, 2) + "\n"));
console.log(`Updated Boyos data for GW${latestGW}`);
