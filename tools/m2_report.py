"""Builds the Milestone 2 report from eval_out/m2/runs.json (made by tools/arena-eval.js).

Writes charts to docs/images/m2/charts/ and the tables into docs/MILESTONE2.md.
Every number in the report is computed here from the run data; nothing is typed in by hand.
Usage: python3 tools/m2_report.py   (needs matplotlib)
"""
import json, os, statistics
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = json.load(open(os.path.join(ROOT, "eval_out/m2/runs.json")))
CH = os.path.join(ROOT, "docs/images/m2/charts")
os.makedirs(CH, exist_ok=True)
CFG = ["v0.1", "v0.2-nolearn", "v0.2"]
LABEL = {"v0.1": "v0.1 (before)", "v0.2-nolearn": "v0.2, learning off", "v0.2": "v0.2 (after)"}
COL = {"v0.1": "#9aa5ad", "v0.2-nolearn": "#f0c83c", "v0.2": "#2fb67a"}
MAPS = ["shipment", "killhouse", "range", "blackout", "districts", "monastery"]
SKILLS = ["beginner", "average", "expert"]
MIN = RUNS[0]["minutes"]
SEEDS = max(r["seed"] for r in RUNS)


def sel(**kw):
    return [r for r in RUNS if all(r[k] == v for k, v in kw.items())]


def kd(rs):
    d = sum(r["botDeaths"] for r in rs)
    return sum(r["botKills"] for r in rs) / max(1, d)


def mean(rs, key):
    return statistics.mean(r[key] for r in rs) if rs else 0


def bars(fname, title, ylabel, groups, values, fmt="{:.1f}", ylim=None):
    fig, ax = plt.subplots(figsize=(9, 4.2), dpi=130)
    w = 0.8 / len(CFG)
    for i, c in enumerate(CFG):
        xs = [g + (i - (len(CFG) - 1) / 2) * w for g in range(len(groups))]
        ys = [values[c][g] for g in groups]
        b = ax.bar(xs, ys, w, label=LABEL[c], color=COL[c])
        for x, y in zip(xs, ys):
            ax.text(x, y, fmt.format(y), ha="center", va="bottom", fontsize=7)
    ax.set_xticks(range(len(groups)), groups)
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    if ylim:
        ax.set_ylim(*ylim)
    ax.legend(frameon=False, fontsize=8)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(os.path.join(CH, fname))
    plt.close(fig)


# 1. stuck % by map
bars("stuck_by_map.png", "Time stuck while trying to move (lower is better)", "% of moving time",
     MAPS, {c: {m: mean(sel(config=c, map=m), "stuckPct") for m in MAPS} for c in CFG})
# 2. coverage by map
bars("coverage_by_map.png", "How much of the map the bot reaches (2 m cells visited)", "% of walkable cells",
     MAPS, {c: {m: mean(sel(config=c, map=m), "coveragePct") for m in MAPS} for c in CFG})
# 3. K/D by player skill
bars("kd_by_skill.png", "Bot kills per death, by the player's skill", "K/D", SKILLS,
     {c: {s: kd(sel(config=c, skill=s)) for s in SKILLS} for c in CFG}, fmt="{:.2f}")
# 4. abilities
ab = ["sprintPct", "slidesPerMin", "jumpsPerMin", "switchesPerMin"]
abl = {"sprintPct": "sprint (% of time)", "slidesPerMin": "slides / min", "jumpsPerMin": "jumps / min", "switchesPerMin": "weapon swaps / min"}
bars("abilities.png", "Movement and weapon abilities used", "", [abl[a] for a in ab],
     {c: {abl[a]: mean(sel(config=c), a) for a in ab} for c in CFG})

# 5. learning within the match vs experts: kill share per 2-minute block
fig, ax = plt.subplots(figsize=(9, 4.2), dpi=130)
curve = {}
for c in CFG:
    rs = sel(config=c, skill="expert")
    ys = []
    for m in range(0, MIN, 2):
        k = sum(r["perMin"][m]["kills"] + r["perMin"][m + 1]["kills"] for r in rs)
        d = sum(r["perMin"][m]["deaths"] + r["perMin"][m + 1]["deaths"] for r in rs)
        ys.append(k / max(1, k + d))
    curve[c] = ys
    ax.plot([f"{m}-{m + 2}" for m in range(0, MIN, 2)], ys, marker="o", label=LABEL[c], color=COL[c], lw=2)
ax.set_title("Against EXPERT players: share of fights the bot wins, over the match")
ax.set_xlabel("match minute")
ax.set_ylabel("bot kills / (kills + deaths)")
ax.set_ylim(0, 0.6)
ax.legend(frameon=False, fontsize=8)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(os.path.join(CH, "learning_curve_expert.png"))
plt.close(fig)

# 6. expertise score over time
fig, ax = plt.subplots(figsize=(9, 4.2), dpi=130)
v2 = sel(config="v0.2")
SC = {"beginner": "#2fb67a", "average": "#f0a830", "expert": "#e04848"}
for s in SKILLS:
    rs = [r for r in v2 if r["skill"] == s]
    ts = sorted({round(x["t"]) for r in rs for x in r["skillSamples"]})
    ys = []
    for t in ts:
        vals = [x["score"] for r in rs for x in r["skillSamples"] if round(x["t"]) == t and x["score"] is not None]
        ys.append(statistics.mean(vals) if vals else None)
    ax.plot(ts, ys, label=f"scripted {s}", color=SC[s], lw=2)
ax.axhline(0.34, color="#666", ls=":", lw=1)
ax.axhline(0.62, color="#666", ls=":", lw=1)
ax.text(5, 0.30, "below: rated beginner", fontsize=7, color="#555")
ax.text(5, 0.64, "above: rated expert", fontsize=7, color="#555")
ax.set_title("Skill score the bot assigns to each player over time (average of all maps/seeds)")
ax.set_xlabel("seconds into match")
ax.set_ylabel("skill score")
ax.set_ylim(0, 1)
ax.legend(frameon=False, fontsize=8)
ax.spines[["top", "right"]].set_visible(False)
fig.tight_layout()
fig.savefig(os.path.join(CH, "expertise_over_time.png"))
plt.close(fig)


# ---------- tables ----------
def at(r, t):
    xs = [x for x in r["skillSamples"] if x["t"] >= t]
    return xs[0]["level"] if xs else r["expertise"]


def settle_time(r):
    s = r["skillSamples"]
    for i in range(len(s)):
        if all(x["level"] == r["skill"] for x in s[i:]):
            return s[i]["t"]
    return None


def pct(a, b):
    return f"{100 * a / max(1, b):.0f}%"


L = []
row = lambda *c: L.append("| " + " | ".join(str(x) for x in c) + " |")
tot = {c: sel(config=c) for c in CFG}
row("Measurement", *[LABEL[c] for c in CFG])
row(*["---"] * 4)
row("Bot kills / deaths (all runs)", *[f"{sum(r['botKills'] for r in tot[c])} / {sum(r['botDeaths'] for r in tot[c])}" for c in CFG])
row("Time stuck while moving (avg)", *[f"{mean(tot[c], 'stuckPct'):.1f}%" for c in CFG])
row("Worst single run, time stuck", *[f"{max(r['stuckPct'] for r in tot[c]):.0f}%" for c in CFG])
row("Runs where the bot got stuck more than half the time", *[sum(1 for r in tot[c] if r["stuckPct"] > 50) for c in CFG])
row("Shots fired while facing more than 30 degrees away", *[sum(r["firedFacingAway"] for r in tot[c]) for c in CFG])
row("Shots cancelled because the bot turned away", *[sum(r["cancelledTurnedAway"] for r in tot[c]) for c in CFG])
row("Map reached (2 m cells visited, avg)", *[f"{mean(tot[c], 'coveragePct'):.1f}%" for c in CFG])
row("Time sprinting", *[f"{mean(tot[c], 'sprintPct'):.1f}%" for c in CFG])
row("Slides / min", *[f"{mean(tot[c], 'slidesPerMin'):.2f}" for c in CFG])
row("Jumps / min", *[f"{mean(tot[c], 'jumpsPerMin'):.2f}" for c in CFG])
row("Weapon swaps / min", *[f"{mean(tot[c], 'switchesPerMin'):.2f}" for c in CFG])
row("Bot hit rate", *[f"{100 * sum(r['hits'] for r in tot[c]) / max(1, sum(r['shots'] for r in tot[c])):.1f}%" for c in CFG])
headline = "\n".join(L)

L = []
row("Map", *[f"{LABEL[c]}: stuck / reached / K-D" for c in CFG])
row(*["---"] * 4)
for m in MAPS:
    row(m, *[f"{mean(sel(config=c, map=m), 'stuckPct'):.1f}% / {mean(sel(config=c, map=m), 'coveragePct'):.0f}% / {kd(sel(config=c, map=m)):.2f}" for c in CFG])
per_map = "\n".join(L)

L = []
row("Player skill", *[f"{LABEL[c]} K/D" for c in CFG])
row(*["---"] * 4)
for s in SKILLS:
    row(s, *[f"{kd(sel(config=c, skill=s)):.2f}" for c in CFG])
per_skill = "\n".join(L)

L = []
row("Scripted as", "rated beginner", "rated average", "rated expert", "correct at 60 s", "correct at end", "median time until rated right for good")
row(*["---"] * 7)
for s in SKILLS:
    rs = [r for r in v2 if r["skill"] == s]
    ends = [r["expertise"] for r in rs]
    st = [settle_time(r) for r in rs]
    st_ok = [t for t in st if t is not None]
    row(s, ends.count("beginner"), ends.count("average"), ends.count("expert"),
        f"{sum(1 for r in rs if at(r, 60) == s)}/{len(rs)}", f"{sum(1 for r in rs if r['expertise'] == s)}/{len(rs)}",
        f"{statistics.median(st_ok):.0f} s ({len(st_ok)}/{len(rs)} runs)" if st_ok else "never")
expertise = "\n".join(L)
exp_60 = sum(1 for r in v2 if at(r, 60) == r["skill"])
exp_end = sum(1 for r in v2 if r["expertise"] == r["skill"])

L = []
row("Match minutes", *[LABEL[c] for c in CFG])
row(*["---"] * 4)
for i, m in enumerate(range(0, MIN, 2)):
    row(f"{m}-{m + 2}", *[f"{curve[c][i]:.2f}" for c in CFG])
curve_tbl = "\n".join(L)

# kills per life, by life index, vs experts
L = []
row("Life # (vs. expert)", *[LABEL[c] + " kills/life" for c in CFG])
row(*["---"] * 4)
for lo, hi in [(1, 3), (4, 6), (7, 9), (10, 14)]:
    cells = []
    for c in CFG:
        xs = [k for r in sel(config=c, skill="expert") for i, k in enumerate(r["lives"][:-1], start=1) if lo <= i <= hi]
        cells.append(f"{statistics.mean(xs):.2f} (n={len(xs)})" if xs else "--")
    row(f"{lo}-{hi}", *cells)
lives_tbl = "\n".join(L)

md_path = os.path.join(ROOT, "docs/MILESTONE2.md")
tpl = open(os.path.join(ROOT, "docs/MILESTONE2.template.md")).read()
out = (tpl.replace("{{RUNS}}", str(len(RUNS))).replace("{{MIN}}", str(MIN)).replace("{{SEEDS}}", str(SEEDS))
       .replace("{{HEADLINE}}", headline).replace("{{PER_MAP}}", per_map).replace("{{PER_SKILL}}", per_skill)
       .replace("{{EXPERTISE}}", expertise).replace("{{CURVE}}", curve_tbl).replace("{{LIVES}}", lives_tbl)
       .replace("{{EXP60}}", f"{exp_60}/{len(v2)}").replace("{{EXPEND}}", f"{exp_end}/{len(v2)}"))
open(md_path, "w").write(out)
print("wrote", md_path, "and", len(os.listdir(CH)), "charts")
print(headline); print(per_skill); print(expertise); print(curve_tbl); print(lives_tbl)
