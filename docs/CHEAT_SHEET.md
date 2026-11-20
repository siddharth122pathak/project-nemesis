# Milestone 2 Cheat Sheet (v0.2.0)

## Run it

```bash
cd /Volumes/workplace/HW/project-nemesis
npm start            # then open the demo link below
npm test             # 16 tests, about 20 seconds
npm run m2           # v0.1 vs v0.2 measurements (~2.5 min) + charts + docs/MILESTONE2.md
```

**Demo:** http://localhost:8090/cod/?demo=1&map=killhouse&skill=expert

| Key | What it does |
|---|---|
| V | camera: 3rd person → 1st person (bot's eyes) → world (fly: WASD, Q/E, Shift, drag mouse) |
| M | next map |
| K | player skill beginner → average → expert (watch the bot re-rate it) |
| L | show/hide what it learned (yellow = where you go, red = where it died / was shot from) |
| H | panel size |

## Push and release (do this yourself so you can screenshot it)

```bash
git push origin main
git push origin v0.2.0
```

The tag makes GitHub Actions run the tests and attach `project-nemesis-v0.2.0.zip` to the release.

## Deliverables

| What | Where |
|---|---|
| Measurements, before vs. after | `docs/MILESTONE2.md` (and `docs/MILESTONE2.pdf`) |
| Charts | `docs/images/m2/charts/` |
| Screenshots, every map × every camera | `docs/images/m2/` |
| Feature tour video (captions, 3:50) | `docs/media/nemesis_m2_showcase.mp4` (re-record: `node tools/record-showcase.js`) |
| Short demo video | `docs/media/nemesis_m2_demo.mp4` |
| Raw data | `eval_out/m2/runs.json` |

## Headline numbers (162 simulated matches)

| | v0.1 | v0.2 |
|---|---|---|
| Time stuck while moving | 21.9% | 0.2% |
| Shots fired while facing away | 186 | 0 |
| Map reached | 27% | 52% |
| K/D vs. expert players | 0.26 | 0.45 |
| Skill rated right after 60 s | n/a | 45 of 54 |

## What each new part does (simple version)

- **nemesis-nav.js**: turns each map into a grid of spots you can stand on, and finds the shortest
  path between any two (A*), including stairs, jumps up onto ledges, and drops.
- **nemesis-move.js**: walks the bot along that path, jumps, falls, and gets un-stuck.
- **nemesis-learner.js**: the bot's notebook about you. Every second: how fast you move, how much
  you sprint, slide, jump and swap guns, and where you like to go. Every kill or death: which plan
  worked, where it died, and where you shot it from. Every 5 seconds: are you a beginner, average,
  or expert.
- **nemesis-brain.js**: the bot's decisions. It picks a fight plan (close/mid/long × push/hold/flank)
  that has worked on you before, picks the gun for that range, and plays easier or harder based on
  your level.
- **The facing bug**: the bot used to fire its delayed shot even after turning around. Now it keeps
  looking at its target until the shot leaves, and cancels the shot if it turned away.

## Say this to Dr. Stafford

- The fairness control is gone, so H3 changes to "win rate rises life over life", and a new H4 is
  "skill is detected within 60 s". In the eval H4 holds in 45 of 54 runs. H3 is partly supported:
  against experts v0.2 wins more fights, but the rise across lives is noisy.
- The opponents are scripted players. The next milestone tests against real people.
