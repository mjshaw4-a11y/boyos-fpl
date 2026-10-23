const FPL = "https://fantasy.premierleague.com/api";

const BOYOS = [
  { name: "Dave", manager: "David Eyre", id: 5568090 },
  { name: "Joe", manager: "Joe Burke", id: 3926846 },
  { name: "Manny", manager: "Manny Jandu", id: 2368930 },
  { name: "Ben", manager: "Ben Burt", id: 9314745 },
  { name: "Curlo", manager: "Matthew Shaw", id: 4909963 }
];

async function fplFetch(path) {
  const response = await fetch(`${FPL}${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`FPL request failed: ${path} (${response.status})`);
  }

  return response.json();
}

export default async function handler(req, res) {
  try {
    // Basic FPL data
    const bootstrap = await fplFetch("/bootstrap-static/");

    const players = Object.fromEntries(
      bootstrap.elements.map(player => [
        player.id,
        {
          name: player.web_name,
          full_name: `${player.first_name} ${player.second_name}`,
          team: player.team,
          position: player.element_type
        }
      ])
    );

    // Work out the latest completed/active GW from manager histories
    const managerBaseData = await Promise.all(
      BOYOS.map(async boyo => {
        const [entry, history, transfers] = await Promise.all([
          fplFetch(`/entry/${boyo.id}/`),
          fplFetch(`/entry/${boyo.id}/history/`),
          fplFetch(`/entry/${boyo.id}/transfers/`)
        ]);

        return { boyo, entry, history, transfers };
      })
    );

    const latestGW = Math.max(
      ...managerBaseData.flatMap(({ history }) =>
        history.current.map(gw => gw.event)
      )
    );

    // Live points for every player in latest GW
    const live = await fplFetch(`/event/${latestGW}/live/`);

    const livePoints = Object.fromEntries(
      live.elements.map(element => [
        element.id,
        {
          points: element.stats.total_points,
          minutes: element.stats.minutes,
          goals: element.stats.goals_scored,
          assists: element.stats.assists,
          clean_sheets: element.stats.clean_sheets,
          bonus: element.stats.bonus,
          yellow_cards: element.stats.yellow_cards,
          red_cards: element.stats.red_cards
        }
      ])
    );

    const managers = await Promise.all(
      managerBaseData.map(async ({ boyo, entry, history, transfers }) => {
        const completedGW = history.current.find(
          item => item.event === latestGW
        );

        const previousGW =
          history.current.find(item => item.event === latestGW - 1) || null;

        let picks = null;

        try {
          picks = await fplFetch(
            `/entry/${boyo.id}/event/${latestGW}/picks/`
          );
        } catch (e) {
          picks = null;
        }

        const gwTransfers = transfers
          .filter(transfer => transfer.event === latestGW)
          .map(transfer => ({
            in: players[transfer.element_in]?.name || transfer.element_in,
            in_id: transfer.element_in,
            in_points: livePoints[transfer.element_in]?.points ?? null,

            out: players[transfer.element_out]?.name || transfer.element_out,
            out_id: transfer.element_out,
            out_points: livePoints[transfer.element_out]?.points ?? null,

            time: transfer.time
          }));

        const squad =
          picks?.picks?.map(pick => {
            const playerLive = livePoints[pick.element] || {};

            return {
              player: players[pick.element]?.name || pick.element,
              player_id: pick.element,
              position: pick.position,

              raw_points: playerLive.points ?? null,
              multiplier: pick.multiplier,

              counted_points:
                playerLive.points !== undefined
                  ? playerLive.points * pick.multiplier
                  : null,

              captain: pick.is_captain,
              vice_captain: pick.is_vice_captain,
              bench: pick.position > 11,

              minutes: playerLive.minutes ?? null,
              goals: playerLive.goals ?? null,
              assists: playerLive.assists ?? null,
              clean_sheets: playerLive.clean_sheets ?? null,
              bonus: playerLive.bonus ?? null
            };
          }) || [];

        const captain = squad.find(player => player.captain);
        const viceCaptain = squad.find(player => player.vice_captain);

        const bench = squad.filter(player => player.bench);

        return {
          name: boyo.name,
          manager: boyo.manager,
          entry_id: boyo.id,
          team_name: entry.name,

          total_points: entry.summary_overall_points,
          overall_rank: entry.summary_overall_rank,

          latest_gameweek: latestGW,
          gameweek_points: completedGW?.points ?? null,
          transfer_cost: completedGW?.event_transfers_cost ?? 0,
          net_gameweek_points:
            completedGW?.points !== undefined
              ? completedGW.points - (completedGW.event_transfers_cost || 0)
              : null,

          points_on_bench: completedGW?.points_on_bench ?? null,

          captain: captain
            ? {
                player: captain.player,
                raw_points: captain.raw_points,
                counted_points: captain.counted_points
              }
            : null,

          vice_captain: viceCaptain
            ? {
                player: viceCaptain.player,
                raw_points: viceCaptain.raw_points
              }
            : null,

          active_chip: picks?.active_chip || null,

          transfers: gwTransfers,

          bench,

          squad,

          previous_gameweek: previousGW
            ? {
                gameweek: previousGW.event,
                points: previousGW.points,
                total_points: previousGW.total_points,
                overall_rank: previousGW.overall_rank,
                transfer_cost: previousGW.event_transfers_cost,
                points_on_bench: previousGW.points_on_bench
              }
            : null,

          gameweek_history: history.current.map(gw => ({
            gameweek: gw.event,
            points: gw.points,
            total_points: gw.total_points,
            overall_rank: gw.overall_rank,
            transfer_cost: gw.event_transfers_cost,
            points_on_bench: gw.points_on_bench
          }))
        };
      })
    );

    // Boyos league table
    managers.sort((a, b) => {
      if (b.total_points !== a.total_points) {
        return b.total_points - a.total_points;
      }

      // Match FPL-style tie handling as closely as possible
      return a.overall_rank - b.overall_rank;
    });

    const standings = managers.map((manager, index) => ({
      rank: index + 1,
      name: manager.name,
      manager: manager.manager,
      team_name: manager.team_name,
      gameweek_points: manager.gameweek_points,
      transfer_cost: manager.transfer_cost,
      net_gameweek_points: manager.net_gameweek_points,
      total_points: manager.total_points,
      overall_rank: manager.overall_rank
    }));

    // Work out Boyos movement from previous GW totals
    const previousStandings = [...managers]
      .filter(manager => manager.previous_gameweek)
      .sort(
        (a, b) =>
          b.previous_gameweek.total_points -
          a.previous_gameweek.total_points
      );

    const previousRanks = Object.fromEntries(
      previousStandings.map((manager, index) => [
        manager.entry_id,
        index + 1
      ])
    );

    standings.forEach(manager => {
      const fullManager = managers.find(
        item => item.entry_id ===
          BOYOS.find(boyo => boyo.name === manager.name)?.id
      );

      const previousRank = fullManager
        ? previousRanks[fullManager.entry_id]
        : null;

      manager.previous_boyos_rank = previousRank;
      manager.rank_change =
        previousRank !== null ? previousRank - manager.rank : null;
    });

    res.setHeader(
      "Cache-Control",
      "s-maxage=300, stale-while-revalidate"
    );

    res.status(200).json({
      league: {
        id: 1104421,
        name: "Boyos FPL"
      },

      generated_at: new Date().toISOString(),
      latest_gameweek: latestGW,

      standings,
      managers
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}
