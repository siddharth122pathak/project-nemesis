# Milestone 1 Cheat Sheet

## Run it

```bash
cd /Volumes/workplace/HW/project-nemesis
npm install          # first time only
npm start            # open http://localhost:8090/cod/
npm test             # 8 tests, about 15 seconds (one starts the real server)
npm run eval         # bot hit-rate table, saves eval_out/
```

In the game: PLAY > DEPLOY > + ADD AI > START GAME. Press N to switch the bot's aim mode and
Shift+N to reset what it learned.

## Push and release (do this yourself so you can screenshot it)

```bash
git push -u origin main
git tag v0.1.0
git push origin v0.1.0
```

The tag makes GitHub Actions run the tests and attach `project-nemesis-v0.1.0.zip` to the v0.1.0
release. That release page is the "direct link to the build file."

## What each part does

- **ai/nemesis-aim.js**: the brains. Naive aims where you were, Lead guesses you keep going straight,
  Learned remembers how you moved before and learns where you end up.
- **ai/nemesis-bot.js**: plugs the brains into the bots. The bot decides, waits 0.3 s like a human
  would, then fires at its guess. It only hits if you are really there.
- **server.js**: the original LAB ARENA server with three small hooks marked NEMESIS.
- **public/cod/game.js**: the original game plus the Nemesis panel and the N / Shift+N / H keys.
- **tools/eval.js**: fake players with fixed habits fight every aim mode and print hit rates.

## How the learned model learns (simple version)

Every tick it writes down how you are moving compared to the bot. A moment later it checks where
you really went, compares that with what it would have guessed, and nudges its numbers to guess
better next time. After about 6 seconds of watching you, it starts aiming with what it learned.
