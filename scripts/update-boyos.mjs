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
const players = Object.fromEntries(bootstrap.elements.map(p => [p.id, {
  name: p.web_name, full_name: `${p.first_name} ${p.second_name}`, team: p.team, position: p.element_type
}]));
const events = bootstrap.events.map(e => ({ id: e.id, name: e.name, deadline_time: e.deadline_time, finished: e.finished, data_checked: e.data_checked }));

const base = await Promise.all(BOYOS.map(async boyo => {
  const [entry, history, transfers] = await Promise.all([
    fplFetch(`/entry/${boyo.id}/`), fplFetch(`/entry/${boyo.id}/history/`), fplFetch(`/entry/${boyo.id}/transfers/`)
  ]);
  return { boyo, entry, history, transfers };
}));

const latestGW = Math.max(...base.flatMap(x => x.history.current.map(g => g.event)));

// Official player scores for every played GW.
const gameweekLive = {};
await Promise.all(Array.from({ length: latestGW }, (_, i) => i + 1).map(async gw => {
  const live = await fplFetch(`/event/${gw}/live/`);
  gameweekLive[gw] = Object.fromEntries(live.elements.map(e => [e.id, {
    points: e.stats.total_points, minutes: e.stats.minutes, goals: e.stats.goals_scored,
    assists: e.stats.assists, clean_sheets: e.stats.clean_sheets, bonus: e.stats.bonus,
    yellow_cards: e.stats.yellow_cards, red_cards: e.stats.red_cards
  }]));
}));

function playerGW(gw, id) {
  const s = gameweekLive[gw]?.[id] || {};
  return { points: s.points ?? null, minutes: s.minutes ?? null, goals: s.goals ?? null, assists: s.assists ?? null, clean_sheets: s.clean_sheets ?? null, bonus: s.bonus ?? null };
}

const managers = await Promise.all(base.map(async ({ boyo, entry, history, transfers }) => {
  const current = history.current;
  const gw = current.find(x => x.event === latestGW);
  const prev = current.find(x => x.event === latestGW - 1) || null;
  const chipsByGW = Object.fromEntries((history.chips || []).map(c => [c.event, c.name]));

  // Historical picks unlock captaincy, bench and selection analysis for every GW.
  const picksByGW = {};
  await Promise.all(current.map(async g => {
    try { picksByGW[g.event] = await fplFetch(`/entry/${boyo.id}/event/${g.event}/picks/`); } catch {}
  }));

  const squadForGW = gwNo => (picksByGW[gwNo]?.picks || []).map(p => {
    const live = playerGW(gwNo, p.element);
    return {
      player: players[p.element]?.name || p.element, player_id: p.element, position: p.position,
      raw_points: live.points, multiplier: p.multiplier,
      counted_points: live.points !== null ? live.points * p.multiplier : null,
      captain: p.is_captain, vice_captain: p.is_vice_captain, bench: p.position > 11,
      minutes: live.minutes, goals: live.goals, assists: live.assists, clean_sheets: live.clean_sheets, bonus: live.bonus
    };
  });

  const squad = squadForGW(latestGW);
  const captain = squad.find(p => p.captain), vice = squad.find(p => p.vice_captain);

  const transferHistory = transfers.filter(t => t.event <= latestGW).map(t => {
    const incoming = playerGW(t.event, t.element_in), outgoing = playerGW(t.event, t.element_out);
    const grossPL = incoming.points !== null && outgoing.points !== null ? incoming.points - outgoing.points : null;
    return {
      gameweek: t.event, chip: chipsByGW[t.event] || null,
      in: players[t.element_in]?.name || t.element_in, in_id: t.element_in, in_points: incoming.points, in_minutes: incoming.minutes,
      out: players[t.element_out]?.name || t.element_out, out_id: t.element_out, out_points: outgoing.points, out_minutes: outgoing.minutes,
      gross_pl: grossPL, time: t.time
    };
  }).sort((a, b) => a.gameweek - b.gameweek || a.time.localeCompare(b.time));

  const transferByGW = current.map(g => {
    const tx = transferHistory.filter(t => t.gameweek === g.event);
    const gross = tx.reduce((s, t) => s + (t.gross_pl ?? 0), 0);
    const chip = chipsByGW[g.event] || null;
    return {
      gameweek: g.event, count: tx.length, chip, transfer_cost: g.event_transfers_cost || 0,
      gross_pl: gross, net_pl: gross - (g.event_transfers_cost || 0),
      transfers: tx.map(t => ({ in: t.in, out: t.out, gross_pl: t.gross_pl }))
    };
  }).filter(x => x.count > 0);

  const chipTransferGWs = new Set((history.chips || []).filter(c => ["wildcard", "freehit"].includes(c.name)).map(c => c.event));
  const normalTransfers = transferHistory.filter(t => !chipTransferGWs.has(t.gameweek));
  const grossTransferPL = transferHistory.reduce((s, t) => s + (t.gross_pl ?? 0), 0);
  const normalGrossPL = normalTransfers.reduce((s, t) => s + (t.gross_pl ?? 0), 0);
  const totalHitCost = current.reduce((s, g) => s + (g.event_transfers_cost || 0), 0);

  const captainHistory = current.map(g => {
    const sq = squadForGW(g.event);
    const cap = sq.find(p => p.captain), viceCap = sq.find(p => p.vice_captain);
    const starters = sq.filter(p => !p.bench);
    const bestStarter = [...starters].filter(p => p.raw_points !== null).sort((a,b) => b.raw_points - a.raw_points)[0] || null;
    const capPts = cap?.raw_points ?? null;
    const bestPts = bestStarter?.raw_points ?? null;
    return {
      gameweek: g.event, captain: cap?.player ?? null, captain_points: capPts, captain_minutes: cap?.minutes ?? null,
      vice_captain: viceCap?.player ?? null, vice_points: viceCap?.raw_points ?? null, vice_minutes: viceCap?.minutes ?? null,
      best_starting_player: bestStarter?.player ?? null, best_starting_points: bestPts,
      captain_points_missed_vs_best_starter: capPts !== null && bestPts !== null ? Math.max(0, bestPts - capPts) : null,
      chip: chipsByGW[g.event] || null
    };
  });

  const totalCaptainRaw = captainHistory.reduce((s, x) => s + (x.captain_points ?? 0), 0);
  const totalBestStarter = captainHistory.reduce((s, x) => s + (x.best_starting_points ?? 0), 0);
  const captainMissed = captainHistory.reduce((s, x) => s + (x.captain_points_missed_vs_best_starter ?? 0), 0);
  const captainEfficiency = totalBestStarter ? Math.round((totalCaptainRaw / totalBestStarter) * 1000) / 10 : null;

  const benchTotal = current.reduce((s, g) => s + (g.points_on_bench || 0), 0);
  const scores = current.map(g => g.points - (g.event_transfers_cost || 0));
  const bestGW = current.reduce((best, g) => !best || g.points - (g.event_transfers_cost || 0) > best.net_points ? { gameweek: g.event, points: g.points, hit: g.event_transfers_cost || 0, net_points: g.points - (g.event_transfers_cost || 0) } : best, null);
  const worstGW = current.reduce((worst, g) => !worst || g.points - (g.event_transfers_cost || 0) < worst.net_points ? { gameweek: g.event, points: g.points, hit: g.event_transfers_cost || 0, net_points: g.points - (g.event_transfers_cost || 0) } : worst, null);
  const bestTransfer = [...normalTransfers].filter(t => t.gross_pl !== null).sort((a,b) => b.gross_pl - a.gross_pl)[0] || null;
  const worstTransfer = [...normalTransfers].filter(t => t.gross_pl !== null).sort((a,b) => a.gross_pl - b.gross_pl)[0] || null;
  const cameoBuys = normalTransfers.filter(t => t.in_minutes !== null && t.in_minutes < 60);

  return {
    name: boyo.name, manager: boyo.manager, entry_id: boyo.id, team_name: entry.name,
    total_points: entry.summary_overall_points, overall_rank: entry.summary_overall_rank,
    latest_gameweek: latestGW, gameweek_points: gw?.points ?? null, transfer_cost: gw?.event_transfers_cost ?? 0,
    net_gameweek_points: gw ? gw.points - (gw.event_transfers_cost || 0) : null, points_on_bench: gw?.points_on_bench ?? null,
    captain: captain ? { player: captain.player, raw_points: captain.raw_points, counted_points: captain.counted_points, minutes: captain.minutes } : null,
    vice_captain: vice ? { player: vice.player, raw_points: vice.raw_points, minutes: vice.minutes } : null,
    active_chip: picksByGW[latestGW]?.active_chip || null,
    transfers: transferHistory.filter(t => t.gameweek === latestGW),
    transfer_history: transferHistory,
    transfer_summary: {
      total_transfers: transferHistory.length,
      normal_transfers: normalTransfers.length,
      wildcard_freehit_transfers: transferHistory.length - normalTransfers.length,
      active_transfer_gameweeks: transferByGW.length,
      transfer_gameweeks: transferByGW,
      gross_player_points_all: grossTransferPL,
      gross_player_points_normal: normalGrossPL,
      hit_cost: totalHitCost,
      hit_count_equivalent: totalHitCost / 4,
      net_pl_all: grossTransferPL - totalHitCost,
      net_pl_normal: normalGrossPL - totalHitCost,
      best_normal_transfer: bestTransfer,
      worst_normal_transfer: worstTransfer,
      sub_60_minute_buys: cameoBuys.length,
      sub_60_minute_buy_details: cameoBuys
    },
    transfer_pl: { gross_player_points: grossTransferPL, hit_cost: totalHitCost, net: grossTransferPL - totalHitCost },
    captain_history: captainHistory,
    season_insights: {
      gameweeks_played: current.length,
      average_net_gw_score: scores.length ? Math.round(scores.reduce((a,b) => a+b,0) / scores.length * 10) / 10 : null,
      best_gameweek: bestGW,
      worst_gameweek: worstGW,
      total_bench_points: benchTotal,
      average_bench_points: current.length ? Math.round(benchTotal / current.length * 10) / 10 : null,
      captain_raw_points: totalCaptainRaw,
      captain_efficiency_pct_vs_best_starter: captainEfficiency,
      captain_points_missed_vs_best_starter: captainMissed,
      chips_used: history.chips || []
    },
    bench: squad.filter(p => p.bench), squad,
    previous_gameweek: prev ? { gameweek: prev.event, points: prev.points, total_points: prev.total_points, overall_rank: prev.overall_rank, transfer_cost: prev.event_transfers_cost, points_on_bench: prev.points_on_bench } : null,
    gameweek_history: current.map(g => ({ gameweek: g.event, points: g.points, net_points: g.points - (g.event_transfers_cost || 0), total_points: g.total_points, overall_rank: g.overall_rank, transfer_cost: g.event_transfers_cost, points_on_bench: g.points_on_bench, chip: chipsByGW[g.event] || null }))
  };
}));

managers.sort((a,b) => b.total_points - a.total_points || a.overall_rank - b.overall_rank);
const previousStandings = [...managers].filter(m => m.previous_gameweek).sort((a,b) => b.previous_gameweek.total_points - a.previous_gameweek.total_points);
const previousRanks = Object.fromEntries(previousStandings.map((m,i) => [m.entry_id, i+1]));
const standings = managers.map((m,i) => ({
  rank: i+1, name: m.name, manager: m.manager, team_name: m.team_name, gameweek_points: m.gameweek_points,
  transfer_cost: m.transfer_cost, net_gameweek_points: m.net_gameweek_points, total_points: m.total_points, overall_rank: m.overall_rank,
  previous_boyos_rank: previousRanks[m.entry_id] ?? null, rank_change: previousRanks[m.entry_id] ? previousRanks[m.entry_id] - (i+1) : null
}));

// Ready-made league leaderboards so ChatGPT can answer quickly without parsing huge histories.
const leaderboard = (field, direction = "desc") => [...managers].map(m => ({ name: m.name, value: field(m) })).sort((a,b) => direction === "desc" ? b.value - a.value : a.value - b.value);
const weeklyWinners = {};
for (let gwNo = 1; gwNo <= latestGW; gwNo++) {
  const rows = managers.map(m => {
    const g = m.gameweek_history.find(x => x.gameweek === gwNo);
    return g ? { name: m.name, net_points: g.net_points } : null;
  }).filter(Boolean).sort((a,b) => b.net_points - a.net_points);
  if (rows.length) weeklyWinners[gwNo] = { winner: rows[0].name, score: rows[0].net_points, rankings: rows };
}
const weeklyWinCounts = Object.values(weeklyWinners).reduce((acc, x) => { acc[x.winner] = (acc[x.winner] || 0) + 1; return acc; }, {});

const league_insights = {
  transfer_count: leaderboard(m => m.transfer_summary.total_transfers),
  normal_transfer_count: leaderboard(m => m.transfer_summary.normal_transfers),
  transfer_pnl_normal: leaderboard(m => m.transfer_summary.net_pl_normal),
  hit_cost: leaderboard(m => m.transfer_summary.hit_cost),
  bench_points: leaderboard(m => m.season_insights.total_bench_points),
  captain_efficiency: leaderboard(m => m.season_insights.captain_efficiency_pct_vs_best_starter),
  captain_regret: leaderboard(m => m.season_insights.captain_points_missed_vs_best_starter),
  weekly_wins: managers.map(m => ({ name: m.name, wins: weeklyWinCounts[m.name] || 0 })).sort((a,b) => b.wins - a.wins),
  weekly_winners: weeklyWinners
};

const output = { league: { id: 1104421, name: "Boyos FPL" }, generated_at: new Date().toISOString(), latest_gameweek: latestGW, events, standings, league_insights, managers };
await import("node:fs/promises").then(fs => fs.writeFile("boyos-data.json", JSON.stringify(output, null, 2) + "\n"));
console.log(`Updated Boyos data + insights for GW${latestGW}`);
