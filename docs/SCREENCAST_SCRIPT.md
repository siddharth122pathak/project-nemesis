# Milestone 2 Screencast Script (about 4 minutes)

Run `npm start` and open http://localhost:8090/cod/?demo=1&map=killhouse&skill=average.
Record with QuickTime (File > New Screen Recording) or OBS. The Milestone 1 script is in
`SCREENCAST_SCRIPT_M1.md`.

1. **Intro (20 s).** "Last milestone the bot learned to aim at where I'll be. This milestone it
   learns how I play, during the match, and changes how it fights."
2. **Camera modes (40 s).** Press V three times. "Third person over its shoulder. First person
   through its eyes, so you see exactly what it sees. World camera, so you can fly around. The cyan
   line is the route it planned with A*, on every map."
3. **Abilities (30 s).** Stay in 3rd person during a fight. "It sprints, slides into fights, jumps,
   and swaps weapons for the range: shotgun close, rifle mid, sniper long. Watch the chips in the
   panel."
4. **Learning (50 s).** Press L, then switch to the world camera. "Yellow tiles are where the player
   usually goes. When it patrols, it goes there. Red tiles are where it died, and the red arrows
   are where it was shot from. Next life it avoids those and pre-aims them. The lessons in the
   panel say what it changed after each death."
5. **Expertise (50 s).** Press K until the player is EXPERT. "Every 5 seconds it rates the player.
   Watch the skill line change from average to expert. Against an expert it reacts faster and
   slides more. Against a beginner it eases off." Press K again for beginner and show the change.
6. **All maps (30 s).** Press M a few times. "Same bot, every map. It used to get stuck on corridor
   maps like this one."
7. **Measurements (40 s).** Open docs/MILESTONE2.pdf. "162 simulated matches. Time stuck went from
   22% to 0.2%. Shots fired while looking away went from 186 to zero. K/D against expert players
   went from 0.26 to 0.45. It rates the player's skill correctly within a minute in 45 of 54 runs."
8. **Close (10 s).** "Next milestone: test against real players."
