# Milestone 1 Screencast Script (about 3 minutes)

Record with QuickTime (File > New Screen Recording) or OBS. Run `npm start`, open
http://localhost:8090/cod/, create a Shipment or Firing Range match, add one AI, and start.

1. **Intro (15 s).** "This is Nemesis Engine on top of LAB ARENA, my three.js shooter. Normal bots
   roll a dice to decide if they hit you. Nemesis bots aim: they guess where I'll be 0.3 seconds
   from now, about human reaction time, and the shot lands there."
2. **Naive (30 s).** Press N until the panel shows Naive. Strafe. "Naive shoots where I was. If I
   keep moving it basically never hits."
3. **Lead (30 s).** Press N. Run steady, then start changing direction. "Lead assumes I keep going
   straight. It gets me when I'm predictable and misses when I turn."
4. **Learned (60 s).** Press N, then Shift+N to wipe the model. Strafe with a rhythm. "Learned
   starts knowing nothing. Every tick it checks where I actually went and updates. Watch the
   learned error in the panel drop below lead, and the hit rate climb."
5. **Evidence (30 s).** Show `npm run eval` output and `docs/images/learning_curve.png`. "Against
   scripted test players, learned aim hits a strafer 71% of the time versus 48% for lead. It still
   loses to random jukes, and it is too strong against circling, which is what the fairness governor
   is for."
6. **Wrap-up (15 s).** Show `npm test` passing, the repo, and the v0.1.0 release. "Next: play-style
   detection and the from-scratch PPO training pipeline."
