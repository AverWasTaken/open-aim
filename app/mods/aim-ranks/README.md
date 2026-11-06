# Rank icons

VALORANT competitive rank icons (top division of each rank, Radiant's single icon), 128 px.
Used by the "Enemy rank" setting (app/bot-settings.js) and Studio's "Shoots back" picker.
Downloaded once from valorant-api.com by `tools/fetch_rank_icons.py`; nothing is fetched at run time.

The art belongs to Riot Games. open-aim was created under Riot Games' "Legal Jibber Jabber"
policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.

`spot-scores.json` is not art: off-angle scores per drill spot for the rank-biased spot choice,
made by `tools/spot_scores.mjs` (see tools/README.md).

`spot-alts.json` is not art either: checked alternative positions per static drill spot, so bots
stand somewhere a little different every round, made by `tools/spot_alts.mjs` (see tools/README.md).
