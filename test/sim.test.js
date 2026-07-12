// Headless smoke + physics test. Stubs the browser APIs main.js touches, runs
// the real code, then drives the actual stepPhysics() through some scenarios.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const noop = () => {};
function fakeCtx() {
  return new Proxy(
    { canvas: { width: 1280, height: 720 } },
    { get: (t, k) => (k in t ? t[k] : (typeof k === "string" && k.startsWith("create")
        ? () => ({ addColorStop: noop }) : noop)) }
  );
}
function fakeEl() {
  return {
    getContext: () => fakeCtx(),
    addEventListener: noop,
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    style: {}, width: 1280, height: 720,
  };
}
const sandbox = {
  window: { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, addEventListener: noop },
  document: { getElementById: () => fakeEl() },
  performance: { now: () => Date.now() },
  requestAnimationFrame: noop,
  Math, console, Object, Array, String, Number, JSON, isNaN, isFinite,
};
sandbox.global = sandbox;

const src = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const harness = `
  // ---- test hooks appended to the real module scope ----
  globalThis.__sim = {
    run(seconds, keyMap) {
      for (const k in keys) keys[k] = false;
      Object.assign(keys, keyMap || {});
      const dt = 1 / 60;
      for (let i = 0; i < seconds * 60; i++) stepPhysics(dt);
      return { alt: ac.pos.y, spd: ac.speed, pitch: ac.pitch, roll: ac.roll,
               yaw: ac.yaw, vs: ac.vspeed, crashed: ac.crashed, onGround: ac.onGround };
    },
    reset() { ac = SPAWN(); ac.pos.y = 500; },
  };
`;
const ctxObj = vm.createContext(sandbox);
vm.runInContext(src + harness, ctxObj, { filename: "main.js" });
const sim = sandbox.__sim || ctxObj.__sim || globalThis.__sim;

let failures = 0;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// 1) Level cruise at full-ish throttle holds altitude reasonably.
sandbox.__sim.reset();
let r = sandbox.__sim.run(20, { ShiftLeft: true }); // spool up to cruise, hands off
check("finite state after 20s", Number.isFinite(r.alt) && Number.isFinite(r.spd), JSON.stringify(r));
check("reaches cruising speed", r.spd > 90 && r.spd < 140, "spd=" + r.spd.toFixed(1));
check("does not fall out of the sky", r.alt > 200, "alt=" + r.alt.toFixed(0));

// 2) Pulling up (W) climbs; pushing down (S) descends.
sandbox.__sim.reset();
const up = sandbox.__sim.run(6, { KeyW: true, ShiftLeft: true });
sandbox.__sim.reset();
const down = sandbox.__sim.run(6, { KeyS: true });
check("W climbs", up.alt > 500, "alt=" + up.alt.toFixed(0));
check("S descends", down.alt < 500, "alt=" + down.alt.toFixed(0));
check("W raises pitch (nose up)", up.pitch > 0, "pitch=" + up.pitch.toFixed(2));

// 3) Banking right (D) turns heading to the right (increasing yaw).
sandbox.__sim.reset();
const turn = sandbox.__sim.run(6, { KeyD: true, ShiftLeft: true });
check("D banks right", turn.roll > 0, "roll=" + turn.roll.toFixed(2));
check("bank yaws toward the turn", turn.yaw > 0.05, "yaw=" + turn.yaw.toFixed(2));

// 4) Idle throttle bleeds speed and the aircraft sinks (no free lift).
sandbox.__sim.reset();
const glide = sandbox.__sim.run(15, { ControlLeft: true });
check("idle throttle slows down", glide.spd < 95, "spd=" + glide.spd.toFixed(1));
check("idle glide loses altitude", glide.alt < 500, "alt=" + glide.alt.toFixed(0));

// 5) Flying into the ground at speed crashes.
sandbox.__sim.reset();
const dive = sandbox.__sim.run(30, { KeyS: true, ShiftLeft: true });
check("steep dive into terrain crashes", dive.crashed === true, "alt=" + dive.alt.toFixed(0));

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
