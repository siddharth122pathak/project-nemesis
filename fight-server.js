// FRAME TRAP (public/tekken) — fight relay: tiny room state + input relay for rooms with game === 'tekken'.
// Mirrors the nfs-server.js / heromode-server.js module pattern: server.js only routes into these hooks.
// The server runs NO game logic: both browsers run the deterministic sim with rollback (src/net/netsession.js); this
// module seats two fighters (+ up to 4 spectators), keeps names / char picks / ready flags, and forwards validated
// 'f'-prefixed messages to the other members of the SAME room only. Every field is validated (types, sizes, int ranges);
// raw messages > 2 KB and connections over 120 msg/s (burst 240) are dropped before JSON.parse; bad input never throws.
//
// Protocol (client -> server; the server relays to the rest of the room with `seat` = sender seat, 0 / 1, -1 spectator):
//   fhello { v:int SIM_VERSION, b:'build id' }            version gate (clients compare; "different version - refresh")
//   fpick  { char:'id', locked:bool }                     character cursor / lock-in
//   fstage { stage:'id' }                                 host (seat 0) only
//   fready { char:'id', n:int }                           "I'm in the fight screen" (READY barrier; n = local match nonce)
//   fstart { e, seed, stage, chars:[a,b], rounds, roundTime, delay }   host only: agreed match config, starts frame 0
//   fi     { e, s, a, d, v:[u16 x 1..32], h?:[frame, hash] }  inputs: epoch, start frame, ack, frame advantage, held masks
//   fping  { q:int, ts:number }  fpong { q, ts }          RTT probes (echoed by the peer)
//   fdesync{ e, f:int, h:uint32 }                         checksum mismatch report (logged + relayed)
// server -> client: froom { code, you:seat, seats:[{name,char,locked,ready}|null, ...], specs:n }  ·  fleft { seat, name }
'use strict';

const MAX_MSG = 2048;            // bytes: anything bigger is dropped unparsed
const RATE = 120;                // messages per second per connection (token bucket refill)
const BURST = 240;               // bucket size
const SEATS = 2, MAX_SPECS = 4;
const ID_RE = /^[a-z0-9_]{1,20}$/;
const BUILD_RE = /^[a-z0-9]{1,16}$/;
const U31 = 0x7fffffff, U32 = 0xffffffff;

const isInt = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
const isId = (x) => typeof x === 'string' && ID_RE.test(x);

function defaults() { return { map: 'rooftop', mode: 'versus' }; }
function cleanName(s) { return String(s == null ? 'player' : s).replace(/[^\w .-]/g, '').trim().slice(0, 16) || 'player'; }

function fight(room) {
  if (!room.fight) room.fight = { seats: new Array(SEATS).fill(null), specs: [] };
  return room.fight;
}
function seatOf(room, id) {
  const F = fight(room);
  for (let i = 0; i < SEATS; i++) if (F.seats[i] && F.seats[i].id === id) return i;
  return F.specs.includes(id) ? -1 : -2;      // -2 = not a member
}
function sendTo(room, id, obj) {
  const p = room.players.get(id);
  if (p && p.ws && p.ws.readyState === 1) { try { p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (e) { void e; } }
}
// relay to every OTHER member of this room (players + spectators); never across rooms
function relay(room, fromId, obj) {
  const data = JSON.stringify(obj);
  for (const [id] of room.players) if (id !== fromId) sendTo(room, id, data);
}
function roomState(room) {
  const F = fight(room);
  const seats = F.seats.map((s) => (s ? { name: s.name, char: s.char, locked: s.locked, ready: s.ready } : null));
  for (const [id] of room.players) sendTo(room, id, { t: 'froom', code: room.code, you: seatOf(room, id), seats, specs: F.specs.length });
}

// ---- hooks called by server.js
function onCreate(room, id) {
  const F = fight(room);
  const p = room.players.get(id);
  F.seats[0] = { id, name: cleanName(p && p.name), char: '', locked: false, ready: false, v: 0 };
  roomState(room);
}
function canJoin(room) {
  const F = fight(room);
  return F.seats.some((s) => !s) || F.specs.length < MAX_SPECS;
}
function onJoin(room, id) {
  const F = fight(room);
  const p = room.players.get(id);
  const free = F.seats.findIndex((s) => !s);
  if (free >= 0) F.seats[free] = { id, name: cleanName(p && p.name), char: '', locked: false, ready: false, v: 0 };
  else F.specs.push(id);
  console.log(`[fight ${room.code}] ${cleanName(p && p.name)} joined as ${free >= 0 ? 'seat ' + free : 'spectator'}`);
  roomState(room);
}
function onLeave(room, id) {
  const F = fight(room);
  const s = seatOf(room, id);
  if (s >= 0) {
    const name = F.seats[s].name;
    F.seats[s] = null;
    for (const q of F.seats) if (q) { q.ready = false; q.locked = false; }
    relay(room, id, { t: 'fleft', seat: s, name });
  } else if (s === -1) {
    F.specs = F.specs.filter((x) => x !== id);
  }
  roomState(room);
}

// size cap + per-connection token bucket, checked BEFORE JSON.parse (returns false = drop)
function admit(ws, raw) {
  const n = raw == null ? 0 : (typeof raw === 'string' ? raw.length : (raw.byteLength ?? raw.length ?? 0));
  if (!(n > 0) || n > MAX_MSG) return false;
  const now = Date.now();
  let b = ws.__ftBucket;
  if (!b) b = ws.__ftBucket = { tok: BURST, t: now, drops: 0 };
  b.tok = Math.min(BURST, b.tok + ((now - b.t) * RATE) / 1000);
  b.t = now;
  if (b.tok < 1) { b.drops++; return false; }
  b.tok -= 1;
  return true;
}

function vInputs(v) {
  if (!Array.isArray(v) || v.length < 1 || v.length > 32) return false;
  for (let i = 0; i < v.length; i++) if (!isInt(v[i], 0, 0xffff)) return false;
  return true;
}

// message from member `id` of a tekken room (msg = parsed object with a string t starting with 'f')
function handle(room, id, msg) {
  const F = fight(room);
  const seat = seatOf(room, id);
  if (seat === -2) return;
  const S = seat >= 0 ? F.seats[seat] : null;
  switch (msg.t) {
    case 'fhello': {
      if (!S || !isInt(msg.v, 0, 1e6) || (msg.b !== undefined && !(typeof msg.b === 'string' && BUILD_RE.test(msg.b)))) return;
      S.v = msg.v;
      relay(room, id, { t: 'fhello', seat, v: msg.v, b: msg.b || '', name: S.name });
      return;
    }
    case 'fpick': {
      if (!S || !isId(msg.char) || typeof msg.locked !== 'boolean') return;
      S.char = msg.char; S.locked = msg.locked;
      relay(room, id, { t: 'fpick', seat, char: msg.char, locked: msg.locked });
      return;
    }
    case 'fstage': {
      if (seat !== 0 || !isId(msg.stage)) return;
      F.stage = msg.stage;
      relay(room, id, { t: 'fstage', seat, stage: msg.stage });
      return;
    }
    case 'fready': {
      if (!S || !isId(msg.char) || !isInt(msg.n, 0, U31)) return;
      S.ready = true; S.char = msg.char;
      relay(room, id, { t: 'fready', seat, char: msg.char, n: msg.n });
      return;
    }
    case 'fstart': {
      if (seat !== 0 || !isInt(msg.e, 1, U31) || !isInt(msg.seed, 0, U32) || !isId(msg.stage) || !Array.isArray(msg.chars) || msg.chars.length !== 2
        || !isId(msg.chars[0]) || !isId(msg.chars[1]) || !isInt(msg.rounds, 1, 5) || !isInt(msg.roundTime, 10, 999) || !isInt(msg.delay, 0, 8)) return;
      for (const q of F.seats) if (q) q.ready = false;
      relay(room, id, { t: 'fstart', seat, e: msg.e, seed: msg.seed, stage: msg.stage, chars: [msg.chars[0], msg.chars[1]], rounds: msg.rounds,
        roundTime: msg.roundTime, delay: msg.delay });
      return;
    }
    case 'fi': {
      if (!S || !isInt(msg.e, 1, U31) || !isInt(msg.s, 0, U31) || !isInt(msg.a, -1, U31) || !isInt(msg.d, -128, 127) || !vInputs(msg.v)) return;
      const out = { t: 'fi', seat, e: msg.e, s: msg.s, a: msg.a, d: msg.d, v: msg.v };
      if (msg.h !== undefined) {
        if (!Array.isArray(msg.h) || msg.h.length !== 2 || !isInt(msg.h[0], 0, U31) || !isInt(msg.h[1], 0, U32)) return;
        out.h = [msg.h[0], msg.h[1]];
      }
      relay(room, id, out);
      return;
    }
    case 'fping': case 'fpong': {
      if (!isInt(msg.q, 0, U31) || !(typeof msg.ts === 'number' && Number.isFinite(msg.ts))) return;
      relay(room, id, { t: msg.t, seat, q: msg.q, ts: msg.ts });
      return;
    }
    case 'fdesync': {
      if (!S || !isInt(msg.e, 1, U31) || !isInt(msg.f, 0, U31) || !isInt(msg.h, 0, U32)) return;
      console.warn(`[fight ${room.code}] seat ${seat} reports a desync at frame ${msg.f}`);
      relay(room, id, { t: 'fdesync', seat, e: msg.e, f: msg.f, h: msg.h });
      return;
    }
    default: return;   // unknown 'f' message: dropped
  }
}

module.exports = { MAX_MSG, RATE, BURST, defaults, onCreate, canJoin, onJoin, onLeave, admit, handle };
