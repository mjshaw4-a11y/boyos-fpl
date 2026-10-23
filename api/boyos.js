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
    // Get player names + current gameweek
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

    const currentEvent =
      bootstrap.events.find(event => event.is_current) ||
      bootstrap.events.find(event => event.is_next);

    const gw = currentEvent?.id;

    const managers = await Promise.all(
      BOYOS.map(async boyo => {
        const [entry, history, transfers] = await Promise.all([
          fplFetch(`/entry/${boyo.id}/`),
          fplFetch(`/entry/${boyo.id}/history/`),
          fplFetch(`/entry/${boyo.id}/transfers/`)
        ]);

        const completedGW = history.current
          .filter(x => x.points !== undefined)
          .slice(-1)[0];

        const latestGW = completedGW?.event;

        let picks = null;

        if (latestGW) {
          try {
            picks = await fplFetch(
              `/entry/${boyo.id}/event/${latestGW}/picks/`
            );
          } catch (e) {
            picks = null;
          }
        }

        const gwTransfers = transfers
          .filter(t => t.event === latestGW)
          .map(t => ({
            in: players[t.element_in]?.name || t.element_in,
            out: players[t.element_out]?.name || t.element_out,
            time: t.time
          }));

        const squad = picks?.picks?.map(pick => ({
          player: players[pick.element]?.name || pick.element,
          multiplier: pick.multiplier,
          captain: pick.is_captain,
          vice_captain: pick.is_vice_captain,
          bench: pick.position > 11
        })) || [];

        const captain = squad.find(p => p.captain);
        const viceCaptain = squad.find(p => p.vice_captain);

        return {
          name: boyo.name,
          manager: boyo.manager,
          entry_id: boyo.id,
          team_name: entry.name,

          total_points: entry.summary_overall_points,
          overall_rank: entry.summary_overall_rank,

          latest_gameweek: latestGW,
          gameweek_points: completedGW?.points,
          transfer_cost: completedGW?.event_transfers_cost,
          points_on_bench: completedGW?.points_on_bench,

          captain: captain?.player || null,
          vice_captain: viceCaptain?.player || null,

          active_chip: picks?.active_chip || null,

          transfers: gwTransfers,
          squad
        };
      })
    );

    // Boyos-only ranking
    managers.sort((a, b) => b.total_points - a.total_points);

    const standings = managers.map((manager, index) => ({
      rank: index + 1,
      name: manager.name,
      manager: manager.manager,
      team_name: manager.team_name,
      gameweek_points: manager.gameweek_points,
      total_points: manager.total_points
    }));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate");

    res.status(200).json({
      league: {
        id: 1104421,
        name: "Boyos FPL"
      },
      generated_at: new Date().toISOString(),
      current_fpl_event: gw,
      standings,
      managers
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
}
