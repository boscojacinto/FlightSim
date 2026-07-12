/* =============================================================================
 * FlightSim — a self-contained 3D flight simulator in vanilla JavaScript.
 *
 * Everything (renderer, physics, terrain, HUD) is built from scratch on a 2D
 * canvas using a hand-rolled perspective projection. No engines, no assets, no
 * network — open index.html and fly.
 * ===========================================================================*/

"use strict";

/* -------------------------------------------------------------------------- *
 *  Small vector / matrix helpers (right-handed: x = right, y = up, z = fwd)   *
 * -------------------------------------------------------------------------- */
const V = {
  add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
  sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
  scale: (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s }),
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  len: (a) => Math.hypot(a.x, a.y, a.z),
  norm: (a) => { const l = Math.hypot(a.x, a.y, a.z) || 1; return { x: a.x / l, y: a.y / l, z: a.z / l }; },
};

// Rotation matrix (body -> world) from yaw (Y), pitch (X), roll (Z).
// Applied as R = Ryaw * Rpitch * Rroll. Positive pitch = nose up.
function orientationMatrix(yaw, pitch, roll) {
  pitch = -pitch; // so that +pitch tilts the nose up in world space
  const cy = Math.cos(yaw),   sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll),  sr = Math.sin(roll);

  // Ry * Rx * Rz, expanded.
  return [
    cy * cr + sy * sp * sr,   -cy * sr + sy * sp * cr,   sy * cp,
    cp * sr,                   cp * cr,                  -sp,
    -sy * cr + cy * sp * sr,   sy * sr + cy * sp * cr,   cy * cp,
  ];
}
// Matrix * vector.
function mul(m, v) {
  return {
    x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
    y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
    z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
  };
}
// Transpose * vector (world -> body, since R is orthonormal).
function mulT(m, v) {
  return {
    x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
    y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
    z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
  };
}
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const DEG = 180 / Math.PI;

/* -------------------------------------------------------------------------- *
 *  Canvas + camera                                                            *
 * -------------------------------------------------------------------------- */
const canvas = document.getElementById("view");
const ctx = canvas.getContext("2d");
let Wp = 0, Hp = 0, focal = 0;
const FOV = 72 * Math.PI / 180;
const NEAR = 0.6;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  Wp = Math.floor(window.innerWidth);
  Hp = Math.floor(window.innerHeight);
  canvas.width = Math.floor(Wp * dpr);
  canvas.height = Math.floor(Hp * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  focal = (Wp / 2) / Math.tan(FOV / 2);
}
window.addEventListener("resize", resize);
resize();

/* -------------------------------------------------------------------------- *
 *  World: terrain height, colours, mountains, runway                          *
 * -------------------------------------------------------------------------- */
const SKY_TOP = [92, 156, 232];
const SKY_HORIZON = [186, 214, 240];

// Deterministic hash -> [0,1)
function hash2(ix, iz) {
  let h = ix * 374761393 + iz * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

// The approach corridor: a flat, obstacle-free valley the runway sits in and
// the aircraft spawns above, so you always have clear air on final.
const CORRIDOR = { halfW: 260, ramp: 320, z0: -3400, z1: 800 };
function corridorClear(x, z) {
  if (z < CORRIDOR.z0 || z > CORRIDOR.z1) return 1;
  return clamp((Math.abs(x) - CORRIDOR.halfW) / CORRIDOR.ramp, 0, 1);
}

// --- Mumbai geography ---------------------------------------------------------
// The Arabian Sea lies to the west (−x); the city is the land to the east. The
// shoreline is a wandering north–south curve, giving bays and headlands.
function shoreX(z) {
  return -1300
    + Math.sin(z * 0.00085) * 320        // large bays (e.g. Back Bay / Mahim)
    + Math.sin(z * 0.0022 + 1.1) * 120;  // smaller inlets
}
function isWater(x, z) { return x < shoreX(z); }

// Terrain height (metres). Sea is flat at 0; the city is low-lying with a couple
// of gentle rises (think Malabar Hill), staying flat over the airfield/approach.
function terrainHeight(x, z) {
  if (x < shoreX(z)) return 0; // sea surface
  const inland = x - shoreX(z);
  let h = 5 + Math.min(inland * 0.015, 26);
  h += Math.max(0, Math.sin(x * 0.0011 + 2) * Math.cos(z * 0.0013)) * 34; // hills
  const d = Math.hypot(x, z);
  const factor = Math.min(clamp((d - 900) / 1600, 0, 1), corridorClear(x, z));
  return h * factor;
}

// Sea colour by how far offshore, blended toward fog with distance.
function seaColor(x, z, fog) {
  const depth = clamp((shoreX(z) - x) / 1400, 0, 1);
  const base = [
    Math.round(lerp(70, 26, depth)),
    Math.round(lerp(150, 78, depth)),
    Math.round(lerp(176, 128, depth)),
  ];
  return blendFog(base, fog);
}
// Land colour: sandy at the water's edge, then dense-city greyish-green.
function groundColor(x, z, h, fog) {
  const beach = clamp(1 - (x - shoreX(z)) / 90, 0, 1);
  const urban = [96, 108, 92];
  const sand = [214, 200, 162];
  const base = [
    Math.round(lerp(urban[0], sand[0], beach)),
    Math.round(lerp(urban[1], sand[1], beach)),
    Math.round(lerp(urban[2], sand[2], beach)),
  ];
  if (h > 22) { base[0] -= 6; base[1] += 4; } // greener on the hills
  return blendFog(base, fog);
}
function blendFog(rgb, fog) {
  return [
    Math.round(lerp(rgb[0], SKY_HORIZON[0], fog)),
    Math.round(lerp(rgb[1], SKY_HORIZON[1], fog)),
    Math.round(lerp(rgb[2], SKY_HORIZON[2], fog)),
  ];
}
const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

// Runway: axis-aligned strip centred at the origin, running along +z.
const RWY = { x0: -22, x1: 22, z0: -650, z1: 650, y: 0.4 };

/* -------------------------------------------------------------------------- *
 *  Aircraft state + flight model                                              *
 * -------------------------------------------------------------------------- */
const SPAWN = () => ({
  pos: { x: 0, y: 220, z: -2600 },
  yaw: 0, pitch: -0.03, roll: 0,
  speed: 95,            // m/s along the nose
  throttle: 0.65,
  gearDown: true,
  crashed: false,
  landed: false,
  onGround: false,
  vspeed: 0,
});
let ac = SPAWN();

const G = 9.81;
const MAX_THRUST = 24;      // accel authority from engine (m/s^2 at full throttle)
const DRAG_K = 0.0014;      // quadratic drag; sets top speed vs thrust
const CRUISE = 106;         // reference speed for full control authority
const STALL = 42;           // below this, lift fades and the nose drops

function stepPhysics(dt) {
  if (ac.crashed) return;

  const R = orientationMatrix(ac.yaw, ac.pitch, ac.roll);
  const fwd = mul(R, { x: 0, y: 0, z: 1 });
  const authority = clamp(ac.speed / CRUISE, 0.15, 1.3); // sluggish when slow

  // --- Control inputs. Three sources are blended: keyboard, the on-screen
  //     touch joystick, and (on phones) positional tilt from the gyroscope. ---
  const kbPitch = (keyDown("KeyW") ? 1 : 0) - (keyDown("KeyS") ? 1 : 0);
  const kbRoll  = (keyDown("KeyD") ? 1 : 0) - (keyDown("KeyA") ? 1 : 0);
  const kbYaw   = (keyDown("KeyE") ? 1 : 0) - (keyDown("KeyQ") ? 1 : 0);
  const pitchIn = clamp(kbPitch + touch.pitch, -1, 1);
  const rollIn  = clamp(kbRoll + touch.roll, -1, 1);
  const yawIn   = clamp(kbYaw + touch.yaw, -1, 1);

  if (tilt.active) {
    // Positional: the phone's tilt angle *is* the target attitude, so holding a
    // steady tilt holds a steady bank/pitch (unlike a rate stick).
    const tR = clamp(tilt.roll, -1.25, 1.25);
    const tP = clamp(tilt.pitch, -0.9, 0.9);
    ac.roll  += (tR - ac.roll) * 3.6 * dt;
    ac.pitch += (tP - ac.pitch) * 3.0 * dt;
    ac.pitch += pitchIn * 0.4 * authority * dt; // fine trim still available
  } else {
    ac.pitch += pitchIn * 1.1 * authority * dt;
    ac.roll  += rollIn  * 2.2 * authority * dt;
    // Gentle roll self-levelling when hands off the ailerons.
    if (rollIn === 0 && !ac.onGround) ac.roll -= ac.roll * 0.6 * dt;
  }
  ac.yaw += yawIn * 0.7 * authority * dt;

  // Banked turns: lift's horizontal component yaws the nose (coordinated turn).
  if (!ac.onGround) {
    ac.yaw += (G * Math.tan(clamp(ac.roll, -1.3, 1.3)) / Math.max(ac.speed, 30)) * dt;
  }

  ac.pitch = clamp(ac.pitch, -1.35, 1.35);
  ac.yaw = (ac.yaw + Math.PI * 2) % (Math.PI * 2);
  ac.roll = ((ac.roll + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;

  // --- Throttle (keyboard nudges; the touch slider sets it directly) ---
  if (touch.throttleSet != null) ac.throttle = touch.throttleSet;
  if (keyDown("ShiftLeft") || keyDown("ShiftRight")) ac.throttle += 0.6 * dt;
  if (keyDown("ControlLeft") || keyDown("ControlRight")) ac.throttle -= 0.6 * dt;
  ac.throttle = clamp(ac.throttle, 0, 1);

  // --- Speed along the nose: thrust vs drag vs gravity component ---
  const thrust = ac.throttle * MAX_THRUST;
  const drag = DRAG_K * ac.speed * ac.speed + (ac.gearDown ? 0.9 : 0);
  const gravAlong = G * fwd.y; // climbing bleeds speed, diving builds it
  ac.speed += (thrust - drag - gravAlong) * dt;
  ac.speed = clamp(ac.speed, 0, 260);

  // --- Stall: not enough airflow over the wings, the nose sags ---
  if (ac.speed < STALL && !ac.onGround) {
    ac.pitch -= (1 - ac.speed / STALL) * 0.9 * dt;
  }

  // --- Velocity: mostly along the nose, plus gravity-driven sink when lift is weak.
  // At/above cruise the wing carries the aircraft (no sink); slower than that it
  // settles, and near the stall speed it drops away quickly. ---
  const liftFactor = clamp((ac.speed - STALL * 0.5) / (CRUISE - STALL * 0.5), 0, 1);
  const vel = V.scale(fwd, ac.speed);
  vel.y -= (1 - liftFactor) * 22; // sink rate (m/s) grows as the wing loses lift

  const next = V.add(ac.pos, V.scale(vel, dt));
  ac.vspeed = (next.y - ac.pos.y) / dt;

  // --- Ground interaction ---
  const ground = terrainHeight(next.x, next.z);
  const onRunway =
    next.x > RWY.x0 - 4 && next.x < RWY.x1 + 4 &&
    next.z > RWY.z0 && next.z < RWY.z1;
  const floor = onRunway ? RWY.y : ground;

  if (next.y <= floor + 1.2) {
    const level = Math.abs(ac.roll) < 0.25 && ac.pitch > -0.15 && ac.pitch < 0.35;
    const gentle = ac.vspeed > -6.5;
    if (onRunway && level && gentle && ac.gearDown) {
      // Successful contact — roll it out on the tarmac.
      next.y = floor + 1.2;
      ac.onGround = true;
      ac.roll = lerp(ac.roll, 0, 0.2);
      ac.pitch = lerp(ac.pitch, 0.02, 0.2);
      ac.speed -= (24 + (ac.throttle < 0.15 ? 30 : 0)) * dt; // brakes/rolling drag
      ac.speed = Math.max(ac.speed, 0);
      if (!ac.landed && ac.speed < 4) { ac.landed = true; onLanded(); }
    } else {
      ac.crashed = true;
      onCrashed();
      next.y = floor + 1.2;
    }
  } else {
    ac.onGround = false;
  }

  ac.pos = next;
}

/* -------------------------------------------------------------------------- *
 *  Renderer                                                                   *
 * -------------------------------------------------------------------------- */
let camMode = 0; // 0 = cockpit, 1 = chase
let viewR, camPos;

function project(world) {
  const rel = V.sub(world, camPos);
  return mulT(viewR, rel); // camera space: x right, y up, z forward
}
function toScreen(cs) {
  return { x: Wp / 2 + focal * (cs.x / cs.z), y: Hp / 2 - focal * (cs.y / cs.z) };
}

// Clip a convex polygon (camera-space points) against the near plane z = NEAR.
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ain = a.z >= NEAR, bin = b.z >= NEAR;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (NEAR - a.z) / (b.z - a.z);
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: NEAR });
    }
  }
  return out;
}

function fillPoly(csPoly, color) {
  const clipped = clipNear(csPoly);
  if (clipped.length < 3) return;
  ctx.beginPath();
  for (let i = 0; i < clipped.length; i++) {
    const s = toScreen(clipped[i]);
    if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawSky() {
  // Sky gradient; where the ground meets it, terrain tiles paint over.
  const horizonY = Hp / 2 + focal * Math.tan(ac.pitch); // approx, cosmetic only
  const stop = clamp(Number.isFinite(horizonY) ? horizonY / Hp : 0.5, 0.05, 0.95) * 0.9;
  const g = ctx.createLinearGradient(0, 0, 0, Hp);
  g.addColorStop(0, rgb(SKY_TOP));
  g.addColorStop(stop, rgb([130, 180, 232]));
  g.addColorStop(1, rgb(SKY_HORIZON));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, Wp, Hp);
}

const TILE = 150;
const GRID = 22; // tiles each side of the aircraft (fog hides the far edge)
function drawTerrain() {
  const cx = Math.round(ac.pos.x / TILE);
  const cz = Math.round(ac.pos.z / TILE);
  const far = GRID * TILE;

  // Painter's order: far tiles first. Iterate rings from outside in.
  for (let ring = GRID; ring >= 0; ring--) {
    for (let gx = -ring; gx <= ring; gx++) {
      for (let gz = -ring; gz <= ring; gz++) {
        if (Math.max(Math.abs(gx), Math.abs(gz)) !== ring) continue;
        const ix = cx + gx, iz = cz + gz;
        const wx = ix * TILE, wz = iz * TILE;

        // Quick cull: skip tiles well behind the camera.
        const centre = { x: wx + TILE / 2, y: 0, z: wz + TILE / 2 };
        const c = project(centre);
        if (c.z < -TILE) continue;
        const dist = Math.hypot(centre.x - ac.pos.x, centre.z - ac.pos.z);
        if (dist > far) continue;

        const h00 = terrainHeight(wx, wz);
        const h10 = terrainHeight(wx + TILE, wz);
        const h11 = terrainHeight(wx + TILE, wz + TILE);
        const h01 = terrainHeight(wx, wz + TILE);
        const fog = clamp((dist - far * 0.35) / (far * 0.65), 0, 1);
        const avgH = (h00 + h10 + h11 + h01) / 4;

        let col, shade;
        if (isWater(centre.x, centre.z)) {
          // Faint static ripple banding so the sea isn't a flat sheet.
          shade = 1 + 0.05 * Math.sin(centre.x * 0.012) * Math.sin(centre.z * 0.01);
          col = seaColor(centre.x, centre.z, fog);
        } else {
          const slope = (h10 - h00) + (h11 - h01); // cheap directional shading
          shade = clamp(1 - slope * 0.0016, 0.8, 1.1);
          col = groundColor(centre.x, centre.z, avgH, fog);
        }
        col = [
          clamp(Math.round(col[0] * shade), 0, 255),
          clamp(Math.round(col[1] * shade), 0, 255),
          clamp(Math.round(col[2] * shade), 0, 255),
        ];

        const poly = [
          project({ x: wx, y: h00, z: wz }),
          project({ x: wx + TILE, y: h10, z: wz }),
          project({ x: wx + TILE, y: h11, z: wz + TILE }),
          project({ x: wx, y: h01, z: wz + TILE }),
        ];
        fillPoly(poly, rgb(col));
      }
    }
  }
}

function drawRunway() {
  const y = RWY.y;
  // Tarmac.
  fillPoly([
    project({ x: RWY.x0, y, z: RWY.z0 }),
    project({ x: RWY.x1, y, z: RWY.z0 }),
    project({ x: RWY.x1, y, z: RWY.z1 }),
    project({ x: RWY.x0, y, z: RWY.z1 }),
  ], "rgb(58,60,66)");

  // Threshold aprons.
  for (const z of [RWY.z0, RWY.z1 - 40]) {
    fillPoly([
      project({ x: RWY.x0, y: y + 0.05, z }),
      project({ x: RWY.x1, y: y + 0.05, z }),
      project({ x: RWY.x1, y: y + 0.05, z: z + 40 }),
      project({ x: RWY.x0, y: y + 0.05, z: z + 40 }),
    ], "rgb(228,232,238)");
  }

  // Dashed centreline.
  for (let z = RWY.z0 + 60; z < RWY.z1 - 60; z += 90) {
    fillPoly([
      project({ x: -2, y: y + 0.05, z }),
      project({ x: 2, y: y + 0.05, z }),
      project({ x: 2, y: y + 0.05, z: z + 45 }),
      project({ x: -2, y: y + 0.05, z: z + 45 }),
    ], "rgb(226,208,120)");
  }
}

const scaleC = (c, f) => [c[0] * f, c[1] * f, c[2] * f];

// Draw an axis-aligned box (a building or bridge segment): the camera-facing
// walls (back-face culled) plus the roof.
function drawBox(x0, z0, x1, z1, top, base, cols, roofCol) {
  const cp = camPos;
  const wall = (ax, az, bx2, bz2, col) => fillPoly([
    project({ x: ax, y: base, z: az }), project({ x: bx2, y: base, z: bz2 }),
    project({ x: bx2, y: top, z: bz2 }), project({ x: ax, y: top, z: az }),
  ], col);
  if (cp.x < x0) wall(x0, z0, x0, z1, cols.w);
  if (cp.x > x1) wall(x1, z1, x1, z0, cols.e);
  if (cp.z < z0) wall(x1, z0, x0, z0, cols.s);
  if (cp.z > z1) wall(x0, z1, x1, z1, cols.n);
  if (cp.y > top) fillPoly([
    project({ x: x0, y: top, z: z0 }), project({ x: x1, y: top, z: z0 }),
    project({ x: x1, y: top, z: z1 }), project({ x: x0, y: top, z: z1 }),
  ], roofCol);
}

// Mumbai skyline: procedural blocks of towers hugging the coast, tallest at the
// waterfront and around a downtown cluster (Nariman Point / Lower Parel-ish).
const CITY = { block: 100, cull: 3200 };
function drawCity() {
  const B = CITY.block;
  const cix = Math.round(ac.pos.x / B), ciz = Math.round(ac.pos.z / B);
  const R = Math.ceil(CITY.cull / B);
  const list = [];
  for (let gx = -R; gx <= R; gx++) {
    for (let gz = -R; gz <= R; gz++) {
      const ix = cix + gx, iz = ciz + gz;
      const cxw = ix * B + B / 2, czw = iz * B + B / 2;
      if (isWater(cxw, czw)) continue;
      const inland = cxw - shoreX(czw);
      if (inland < 30 || inland > 1500) continue;      // coastal city strip only
      if (Math.abs(cxw) < 700 && czw > -3600 && czw < 900) continue; // airport/approach
      if (hash2(ix * 3 + 11, iz * 5 - 7) > 0.84 - inland * 0.00035) continue; // density
      const dist = Math.hypot(cxw - ac.pos.x, czw - ac.pos.z);
      if (dist > CITY.cull) continue;
      const coastBias = clamp(1 - inland / 1200, 0, 1);
      const dtBias = clamp(1 - Math.hypot(cxw + 1050, czw - 250) / 1400, 0, 1);
      const r = hash2(ix * 7 - 3, iz * 9 + 5);
      const base = terrainHeight(cxw, czw);
      const h = base + 22 + r * r * (60 + 170 * coastBias + 230 * dtBias);
      const m = 14 + r * 8;
      list.push({
        x0: ix * B + m, z0: iz * B + m, x1: (ix + 1) * B - m, z1: (iz + 1) * B - m,
        top: h, base, dist, glass: hash2(ix - 2, iz + 4) > 0.5,
        fog: clamp((dist - 1500) / 1900, 0, 1),
      });
    }
  }
  list.sort((a, b) => b.dist - a.dist);

  for (const b of list) {
    const tone = b.glass ? [120, 150, 186] : [148, 149, 156];
    const cols = {
      w: rgb(blendFog(scaleC(tone, 1.12), b.fog)),
      e: rgb(blendFog(scaleC(tone, 0.84), b.fog)),
      s: rgb(blendFog(scaleC(tone, 0.94), b.fog)),
      n: rgb(blendFog(scaleC(tone, 1.03), b.fog)),
    };
    drawBox(b.x0, b.z0, b.x1, b.z1, b.top, b.base, cols, rgb(blendFog(scaleC(tone, 0.68), b.fog)));

    // Antenna + blinking aviation light on the tallest towers.
    if (b.top - b.base > 210 && b.dist < 2600) {
      const mx = (b.x0 + b.x1) / 2, mz = (b.z0 + b.z1) / 2;
      const a = project({ x: mx, y: b.top, z: mz }), t = project({ x: mx, y: b.top + 26, z: mz });
      if (a.z > NEAR && t.z > NEAR) {
        const sa = toScreen(a), st = toScreen(t);
        ctx.strokeStyle = "rgba(40,44,52,0.85)"; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(st.x, st.y); ctx.stroke();
        if (Math.floor(performance.now() / 600) % 2 === 0) {
          ctx.fillStyle = "#ff5a5a";
          ctx.beginPath(); ctx.arc(st.x, st.y, 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }
}

// The Bandra–Worli Sea Link — a cable-stayed bridge out over the Arabian Sea.
function drawSeaLink() {
  const bx = -1750, z0 = 200, z1 = 2100, w = 11, deckY = 15;
  const dist = Math.hypot(bx - ac.pos.x, (z0 + z1) / 2 - ac.pos.z);
  if (dist > 7500) return;
  const fog = clamp((dist - 2600) / 4500, 0, 1);
  drawBox(bx - w, z0, bx + w, z1, deckY, 7, {
    w: rgb(blendFog([152, 154, 160], fog)), e: rgb(blendFog([120, 122, 128], fog)),
    s: rgb(blendFog([136, 138, 144], fog)), n: rgb(blendFog([136, 138, 144], fog)),
  }, rgb(blendFog([172, 174, 180], fog)));

  for (const pz of [z0 + (z1 - z0) * 0.34, z0 + (z1 - z0) * 0.66]) {
    const topY = deckY + 120;
    drawBox(bx - 3, pz - 3, bx + 3, pz + 3, topY, deckY, {
      w: rgb(blendFog([196, 198, 204], fog)), e: rgb(blendFog([150, 152, 158], fog)),
      s: rgb(blendFog([172, 174, 180], fog)), n: rgb(blendFog([172, 174, 180], fog)),
    }, rgb(blendFog([206, 208, 214], fog)));

    const a = project({ x: bx, y: topY, z: pz });
    if (a.z > NEAR) {
      const sa = toScreen(a);
      ctx.strokeStyle = `rgba(232,236,244,${(1 - fog) * 0.8})`;
      ctx.lineWidth = 1;
      for (let k = 1; k <= 6; k++) for (const dir of [-1, 1]) {
        const pd = project({ x: bx, y: deckY + 1, z: pz + dir * (k / 6) * (z1 - z0) * 0.28 });
        if (pd.z <= NEAR) continue;
        const sd = toScreen(pd);
        ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sd.x, sd.y); ctx.stroke();
      }
    }
  }
}

// Distant green hills far inland (the Western Ghats) as a backdrop behind the city.
function drawHills() {
  const S = 900;
  const cix = Math.round(ac.pos.x / S), ciz = Math.round(ac.pos.z / S);
  const list = [];
  for (let gx = -4; gx <= 9; gx++) {
    for (let gz = -6; gz <= 6; gz++) {
      const ix = cix + gx, iz = ciz + gz;
      if (hash2(ix + 40, iz + 40) < 0.62) continue;
      const bx = ix * S + (hash2(ix + 9, iz) - 0.5) * S * 0.6;
      const bz = iz * S + (hash2(ix, iz + 9) - 0.5) * S * 0.6;
      if (bx < shoreX(bz) + 1900) continue; // only well inland, east of the city
      const dist = Math.hypot(bx - ac.pos.x, bz - ac.pos.z);
      if (dist > 8000 || dist < 1600) continue;
      list.push({ bx, bz, dist, baseH: terrainHeight(bx, bz),
        height: 170 + hash2(ix + 2, iz + 2) * 250, rad: 260 + hash2(ix + 4, iz + 1) * 260 });
    }
  }
  list.sort((a, b) => b.dist - a.dist);
  for (const m of list) {
    const apex = { x: m.bx, y: m.baseH + m.height, z: m.bz };
    const fog = clamp((m.dist - 2600) / 5000, 0, 1);
    const b = [
      { x: m.bx - m.rad, y: m.baseH, z: m.bz - m.rad }, { x: m.bx + m.rad, y: m.baseH, z: m.bz - m.rad },
      { x: m.bx + m.rad, y: m.baseH, z: m.bz + m.rad }, { x: m.bx - m.rad, y: m.baseH, z: m.bz + m.rad },
    ];
    for (let i = 0; i < 4; i++) {
      const face = [0.82, 1.05, 1.12, 0.92][i];
      const col = blendFog(scaleC([70, 98, 64], face), fog).map((v) => clamp(Math.round(v), 0, 255));
      fillPoly([project(b[i]), project(b[(i + 1) % 4]), project(apex)], rgb(col));
    }
  }
}

function render() {
  // Camera orientation. Chase cam sits behind and above the aircraft.
  viewR = orientationMatrix(ac.yaw, ac.pitch, ac.roll);
  if (camMode === 1) {
    const back = mul(viewR, { x: 0, y: 2.2, z: -14 });
    camPos = V.add(ac.pos, back);
  } else {
    camPos = { x: ac.pos.x, y: ac.pos.y, z: ac.pos.z };
  }

  drawSky();
  drawTerrain();
  drawHills();
  drawSeaLink();
  drawRunway();
  drawCity();
  if (camMode === 1) drawAircraftModel();
  drawHUD();
}

// Simple aircraft silhouette for the chase camera.
function drawAircraftModel() {
  const R = orientationMatrix(ac.yaw, ac.pitch, ac.roll);
  const P = (x, y, z) => project(V.add(ac.pos, mul(R, { x, y, z })));
  // Fuselage.
  fillPoly([P(0, 0, 6), P(0.9, -0.3, -4), P(-0.9, -0.3, -4)], "rgb(210,216,226)");
  fillPoly([P(0, 0, 6), P(0, 0.7, -4), P(0.9, -0.3, -4)], "rgb(232,236,242)");
  fillPoly([P(0, 0, 6), P(-0.9, -0.3, -4), P(0, 0.7, -4)], "rgb(190,196,206)");
  // Wings.
  fillPoly([P(6.5, 0, -0.5), P(-6.5, 0, -0.5), P(-4, 0, -3), P(4, 0, -3)], "rgb(70,120,200)");
  // Tail.
  fillPoly([P(0, 0, -4), P(0, 2.2, -4.6), P(0, 0, -5)], "rgb(70,120,200)");
  fillPoly([P(2.4, 0, -4), P(-2.4, 0, -4), P(0, 0, -5)], "rgb(200,206,216)");
}

/* -------------------------------------------------------------------------- *
 *  HUD                                                                        *
 * -------------------------------------------------------------------------- */
let compactHud = false; // switched on for touch devices (frees the edges)
function drawHUD() {
  const KN = ac.speed * 1.94384;     // m/s -> knots
  const FT = ac.pos.y * 3.28084;     // m -> feet
  const FPM = ac.vspeed * 196.85;    // m/s -> feet/min
  const HDG = ((ac.yaw * DEG) % 360 + 360) % 360;
  const green = ac.crashed ? "#ff6b6b" : "#4dffa0";

  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = green;
  ctx.fillStyle = green;
  ctx.font = "14px 'Consolas','Menlo',monospace";
  ctx.textBaseline = "middle";

  const cx = Wp / 2, cy = Hp / 2;

  // Boresight / flight reference.
  ctx.beginPath();
  ctx.moveTo(cx - 40, cy); ctx.lineTo(cx - 12, cy);
  ctx.moveTo(cx + 12, cy); ctx.lineTo(cx + 40, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.stroke();

  // Pitch ladder (rotates with roll, slides with pitch).
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-ac.roll);
  const pxPerDeg = focal * Math.PI / 180 * 1.0;
  ctx.font = "12px monospace";
  for (let a = -80; a <= 80; a += 10) {
    if (a === 0) continue;
    const yy = (ac.pitch * DEG - a) * pxPerDeg;
    if (Math.abs(yy) > Hp * 0.42) continue;
    const w = a > 0 ? 60 : 44;
    ctx.beginPath();
    if (a > 0) { ctx.moveTo(-w, yy); ctx.lineTo(w, yy); }
    else {
      // dashed for negative (below horizon)
      for (let x = -w; x < w; x += 12) { ctx.moveTo(x, yy); ctx.lineTo(x + 6, yy); }
    }
    ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(String(a), w + 6, yy);
    ctx.textAlign = "right";
    ctx.fillText(String(a), -w - 6, yy);
  }
  // Horizon line.
  const hy = ac.pitch * DEG * pxPerDeg;
  ctx.beginPath(); ctx.moveTo(-Wp, hy); ctx.lineTo(Wp, hy); ctx.stroke();
  ctx.restore();

  // Roll pointer arc.
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath(); ctx.arc(0, 0, 120, -Math.PI * 0.72, -Math.PI * 0.28); ctx.stroke();
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const ang = -Math.PI / 2 + a * Math.PI / 180;
    const r0 = 120, r1 = a % 30 === 0 ? 132 : 127;
    ctx.beginPath();
    ctx.moveTo(Math.cos(ang) * r0, Math.sin(ang) * r0);
    ctx.lineTo(Math.cos(ang) * r1, Math.sin(ang) * r1);
    ctx.stroke();
  }
  ctx.rotate(-ac.roll);
  ctx.beginPath();
  ctx.moveTo(0, -120); ctx.lineTo(-7, -108); ctx.lineTo(7, -108); ctx.closePath();
  ctx.fill();
  ctx.restore();

  // --- Airspeed / altitude. On phones the screen edges belong to the on-screen
  //     controls, so use compact top-corner readouts instead of tall tapes. ---
  if (compactHud) {
    readout(78, 78, "SPD", Math.round(KN), "kt");
    readout(Wp - 78, 78, "ALT", Math.round(FT), "ft");
  } else {
    tape(70, cy, "SPD", Math.round(KN), "kt");
    tape(Wp - 70, cy, "ALT", Math.round(FT), "ft", true);
  }

  // Heading tape (top).
  ctx.textAlign = "center";
  ctx.font = "12px monospace";
  const hw = 220;
  ctx.strokeRect(cx - hw, 18, hw * 2, 26);
  ctx.save();
  ctx.beginPath();
  ctx.rect(cx - hw, 18, hw * 2, 26);
  ctx.clip();
  for (let d = -60; d <= 60; d += 10) {
    const shown = (Math.round(HDG / 10) * 10 + d);
    const sx = cx + (d - (HDG - Math.round(HDG / 10) * 10)) * (hw * 2) / 120;
    const norm = ((shown % 360) + 360) % 360;
    ctx.beginPath(); ctx.moveTo(sx, 38); ctx.lineTo(sx, 44); ctx.stroke();
    if (norm % 30 === 0) {
      const lbl = norm === 0 ? "N" : norm === 90 ? "E" : norm === 180 ? "S" : norm === 270 ? "W" : String(norm);
      ctx.fillText(lbl, sx, 28);
    }
  }
  ctx.restore();
  ctx.beginPath(); ctx.moveTo(cx, 44); ctx.lineTo(cx - 5, 50); ctx.lineTo(cx + 5, 50); ctx.closePath(); ctx.fill();
  ctx.fillText(String(Math.round(HDG)).padStart(3, "0"), cx, 60);

  if (compactHud) {
    // Vertical speed + gear sit under the altitude readout, clear of controls.
    ctx.textAlign = "right";
    ctx.font = "12px monospace";
    ctx.fillText((FPM >= 0 ? "+" : "") + Math.round(FPM / 10) * 10 + " fpm", Wp - 20, 120);
    ctx.fillStyle = ac.gearDown ? "#4dffa0" : "#ffb14d";
    ctx.fillText("GEAR " + (ac.gearDown ? "DN" : "UP"), Wp - 20, 138);
    ctx.fillStyle = green;
  } else {
    // --- Bottom-left panel: throttle + gear + vspeed ---
    const px = 26, py = Hp - 118;
    ctx.textAlign = "left";
    ctx.font = "12px monospace";
    ctx.fillText("THR", px, py);
    ctx.strokeRect(px + 34, py - 7, 120, 12);
    ctx.fillRect(px + 34, py - 7, 120 * ac.throttle, 12);
    ctx.fillText(Math.round(ac.throttle * 100) + "%", px + 164, py);

    ctx.fillText("V/S", px, py + 22);
    ctx.fillText((FPM >= 0 ? "+" : "") + Math.round(FPM / 10) * 10 + " fpm", px + 34, py + 22);

    ctx.fillText("GEAR", px, py + 44);
    ctx.fillStyle = ac.gearDown ? "#4dffa0" : "#ffb14d";
    ctx.fillText(ac.gearDown ? "DOWN" : "UP", px + 44, py + 44);
    ctx.fillStyle = green;

    ctx.fillText("HDG " + String(Math.round(HDG)).padStart(3, "0"), px, py + 66);
  }

  // Stall warning.
  if (ac.speed < STALL && !ac.onGround && !ac.crashed) {
    ctx.fillStyle = "#ff5a5a";
    ctx.font = "bold 20px monospace";
    ctx.textAlign = "center";
    if (Math.floor(performance.now() / 300) % 2 === 0) ctx.fillText("STALL", cx, cy - 150);
  }

  ctx.restore();

  function tape(x, cyy, label, val, unit, right) {
    ctx.save();
    ctx.strokeStyle = green; ctx.fillStyle = green;
    ctx.font = "12px monospace";
    ctx.textAlign = "center";
    ctx.strokeRect(x - 44, cyy - 90, 88, 180);
    ctx.fillText(label, x, cyy - 78);
    // moving scale
    ctx.save();
    ctx.beginPath(); ctx.rect(x - 44, cyy - 66, 88, 150); ctx.clip();
    const step = 10;
    const base = Math.round(val / step) * step;
    for (let i = -8; i <= 8; i++) {
      const tv = base + i * step;
      const yy = cyy + (val - tv) * 3.0;
      ctx.beginPath(); ctx.moveTo(x - 44, yy); ctx.lineTo(x - 36, yy); ctx.stroke();
      if (tv % 20 === 0) ctx.fillText(String(tv), x, yy);
    }
    ctx.restore();
    // current value box
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - 40, cyy - 12, 80, 24);
    ctx.strokeStyle = green;
    ctx.strokeRect(x - 40, cyy - 12, 80, 24);
    ctx.fillStyle = green;
    ctx.font = "bold 18px monospace";
    ctx.fillText(String(val), x, cyy);
    ctx.font = "10px monospace";
    ctx.fillText(unit, x, cyy + 22);
    ctx.restore();
  }

  // Compact boxed readout for phones (top corners).
  function readout(x, y, label, val, unit) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(x - 52, y - 20, 104, 40);
    ctx.strokeStyle = green;
    ctx.strokeRect(x - 52, y - 20, 104, 40);
    ctx.fillStyle = green;
    ctx.font = "10px monospace";
    ctx.fillText(label, x - 30, y - 6);
    ctx.fillText(unit, x + 34, y - 6);
    ctx.font = "bold 20px monospace";
    ctx.fillText(String(val), x, y + 8);
    ctx.restore();
  }
}

/* -------------------------------------------------------------------------- *
 *  Input                                                                      *
 * -------------------------------------------------------------------------- */
const keys = Object.create(null);
const keyDown = (code) => !!keys[code];

// Touch (on-screen joystick / rudder / throttle) and tilt (gyroscope) inputs.
// stepPhysics() reads these every frame alongside the keyboard.
const touch = { pitch: 0, roll: 0, yaw: 0, throttleSet: null };
const tilt = {
  active: false, supported: false,
  pitch: 0, roll: 0,          // -1..1 target deflection after calibration
  curP: 0, curR: 0,           // latest raw reading (degrees, axis-mapped)
  refP: 0, refR: 0,           // calibration reference captured on "recenter"
};
window.addEventListener("keydown", (e) => {
  keys[e.code] = true;
  if (["KeyW","KeyA","KeyS","KeyD","KeyQ","KeyE","ShiftLeft","ShiftRight",
       "ControlLeft","ControlRight","Space","KeyV","KeyR","KeyP","KeyG"].includes(e.code)) {
    e.preventDefault();
  }
  if (e.code === "KeyV" && running) camMode = camMode ? 0 : 1;
  if (e.code === "KeyR") resetFlight();
  if (e.code === "KeyP" && started) togglePause();
  if (e.code === "KeyG" && running) ac.gearDown = !ac.gearDown;
});
window.addEventListener("keyup", (e) => { keys[e.code] = false; });
window.addEventListener("blur", () => { for (const k in keys) keys[k] = false; });

/* -------------------------------------------------------------------------- *
 *  Phone controls: tilt (gyroscope) + on-screen touch                         *
 * -------------------------------------------------------------------------- */

// Map raw DeviceOrientation (beta/gamma, in the phone's natural portrait frame)
// into pitch/roll for the current screen orientation. Designed for landscape.
function onDeviceOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  tilt.supported = true;
  const angle =
    (screen.orientation && typeof screen.orientation.angle === "number")
      ? screen.orientation.angle
      : (window.orientation || 0);
  const b = e.beta, g = e.gamma;
  let pitchDeg, rollDeg;
  if (angle === 90) { pitchDeg = -g; rollDeg = -b; }        // landscape-primary
  else if (angle === 270 || angle === -90) { pitchDeg = g; rollDeg = b; } // other way
  else if (angle === 180) { pitchDeg = -(b - 45); rollDeg = -g; }         // upside-down portrait
  else { pitchDeg = b - 45; rollDeg = g; }                  // portrait (tilt ~45° = neutral)

  tilt.curP = pitchDeg;
  tilt.curR = rollDeg;
  const DEFLECT = 35; // degrees of tilt for full control deflection
  tilt.pitch = clamp((pitchDeg - tilt.refP) / DEFLECT, -1.25, 1.25);
  tilt.roll  = clamp((rollDeg - tilt.refR) / DEFLECT, -1.4, 1.4);
}
function recenterTilt() { tilt.refP = tilt.curP; tilt.refR = tilt.curR; }

// Enable tilt, requesting permission on iOS 13+ (must be from a user gesture).
async function enableTilt() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      const res = await DOE.requestPermission();
      if (res !== "granted") { flashHint("Motion access denied — using touch"); return false; }
    }
    window.addEventListener("deviceorientation", onDeviceOrientation, true);
    tilt.active = true;
    setTimeout(recenterTilt, 250); // calibrate to however the phone is being held
    syncTiltButton();
    flashHint("Tilt ON — hold level, then tilt to fly");
    return true;
  } catch (err) {
    flashHint("Tilt unavailable on this device");
    return false;
  }
}
function disableTilt() {
  window.removeEventListener("deviceorientation", onDeviceOrientation, true);
  tilt.active = false; tilt.pitch = 0; tilt.roll = 0;
  syncTiltButton();
}
function syncTiltButton() {
  const btn = document.querySelector('[data-k="tilt"]');
  if (btn) { btn.classList.toggle("on", tilt.active); btn.textContent = tilt.active ? "TILT ✓" : "TILT"; }
  const stick = document.getElementById("stick");
  if (stick) stick.classList.toggle("hidden", tilt.active); // tilt replaces the attitude stick
}

let hintTimer = 0;
function flashHint(text) {
  const el = document.getElementById("touchhint");
  if (!el) return;
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// Attach a press-and-hold handler that sets `keyOrFn` while the control is held.
function holdButton(el, onDown, onUp) {
  if (!el) return;
  const down = (e) => { e.preventDefault(); onDown(); };
  const up = (e) => { e.preventDefault(); if (onUp) onUp(); };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", up);
}

function setupMobile() {
  const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
  if (isTouch) { document.body.classList.add("touch"); compactHud = true; }

  // --- Attitude joystick (pitch/roll) ---
  const stick = document.getElementById("stick");
  const nub = document.getElementById("sticknub");
  if (stick) {
    let active = false, id = null;
    const setFromEvent = (e) => {
      const r = stick.getBoundingClientRect();
      if (!r.width || !r.height) return; // hidden (e.g. tilt mode) — ignore
      const nx = clamp((e.clientX - (r.left + r.width / 2)) / (r.width / 2), -1, 1);
      const ny = clamp((e.clientY - (r.top + r.height / 2)) / (r.height / 2), -1, 1);
      touch.roll = nx;
      touch.pitch = -ny;           // push up = nose up
      nub.style.transform = `translate(${nx * 42}px, ${ny * 42}px)`;
    };
    stick.addEventListener("pointerdown", (e) => {
      e.preventDefault(); active = true; id = e.pointerId;
      stick.setPointerCapture(id); setFromEvent(e);
    });
    stick.addEventListener("pointermove", (e) => { if (active && e.pointerId === id) setFromEvent(e); });
    const release = (e) => {
      if (!active || (id != null && e.pointerId !== id)) return;
      active = false; id = null;
      touch.roll = 0; touch.pitch = 0;
      nub.style.transform = "translate(0,0)";
    };
    stick.addEventListener("pointerup", release);
    stick.addEventListener("pointercancel", release);
  }

  // --- Throttle slider (vertical) ---
  const thr = document.getElementById("throttle");
  const thrFill = document.getElementById("thrfill");
  if (thr) {
    let active = false, id = null;
    const setFromEvent = (e) => {
      const r = thr.getBoundingClientRect();
      if (!r.height) return;
      const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      touch.throttleSet = v;
      if (started && running) ac.throttle = v;
      thrFill.style.height = (v * 100) + "%";
    };
    thr.addEventListener("pointerdown", (e) => {
      e.preventDefault(); active = true; id = e.pointerId;
      thr.setPointerCapture(id); setFromEvent(e);
    });
    thr.addEventListener("pointermove", (e) => { if (active && e.pointerId === id) setFromEvent(e); });
    const release = (e) => {
      if (!active || (id != null && e.pointerId !== id)) return;
      active = false; id = null; touch.throttleSet = null; // hand back to keyboard
    };
    thr.addEventListener("pointerup", release);
    thr.addEventListener("pointercancel", release);
  }

  // --- Rudder buttons ---
  holdButton(document.getElementById("rudl"), () => (touch.yaw = -1), () => (touch.yaw = 0));
  holdButton(document.getElementById("rudr"), () => (touch.yaw = 1), () => (touch.yaw = 0));

  // --- Action buttons ---
  const act = {
    tilt: () => (tilt.active ? disableTilt() : enableTilt()),
    center: () => { recenterTilt(); flashHint("Re-centered"); },
    cam: () => { if (running) camMode = camMode ? 0 : 1; },
    gear: () => { if (running) ac.gearDown = !ac.gearDown; },
    reset: () => resetFlight(),
  };
  document.querySelectorAll("#actionbtns button").forEach((btn) => {
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); act[btn.dataset.k](); });
  });

  updateOrientationHint();
  window.addEventListener("orientationchange", () => setTimeout(updateOrientationHint, 200));
  window.addEventListener("resize", updateOrientationHint);
}

// Nudge the player to landscape while in portrait on a phone.
function updateOrientationHint() {
  const el = document.getElementById("rotatehint");
  if (!el) return;
  const portrait = window.innerHeight > window.innerWidth;
  const phone = document.body.classList.contains("touch");
  el.classList.toggle("hidden", !(phone && portrait && started));
}

/* -------------------------------------------------------------------------- *
 *  Game state + loop                                                          *
 * -------------------------------------------------------------------------- */
let started = false, running = false, paused = false;
let lastT = 0;

const overlay = document.getElementById("overlay");
const pauseBadge = document.getElementById("pausebadge");
const msgEl = document.getElementById("msg");

function startGame() {
  started = true;
  running = true;
  paused = false;
  overlay.classList.add("hidden");
  resetFlight();

  // On a phone, the Start tap is a user gesture — the moment iOS lets us ask
  // for motion access. Turn tilt on by default and go fullscreen/landscape.
  if (document.body.classList.contains("touch")) {
    enableTilt();
    goImmersive();
  }
  updateOrientationHint();

  lastT = performance.now();
  requestAnimationFrame(loop);
}

function goImmersive() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (req) { try { req.call(el); } catch (e) {} }
  if (screen.orientation && screen.orientation.lock) {
    screen.orientation.lock("landscape").catch(() => {});
  }
}
function resetFlight() {
  ac = SPAWN();
  msgEl.classList.add("hidden");
  running = true;
}
function togglePause() {
  paused = !paused;
  pauseBadge.classList.toggle("hidden", !paused);
}
function onCrashed() {
  running = false;
  showMsg("bad", "CRASHED", "Press R to respawn on approach");
}
function onLanded() {
  running = false;
  showMsg("good", "TOUCHDOWN ✈", "Nice landing! Press R to fly again");
}
function showMsg(kind, big, sub) {
  msgEl.className = "msg " + kind;
  msgEl.innerHTML = `<div class="big">${big}</div><div class="sub">${sub}</div>`;
  msgEl.classList.remove("hidden");
}

function loop(now) {
  let dt = (now - lastT) / 1000;
  lastT = now;
  dt = Math.min(dt, 0.05); // clamp to keep physics stable on frame hitches

  if (!paused) {
    if (running) {
      // Sub-step for a steadier simulation at low frame rates.
      const steps = 2;
      for (let i = 0; i < steps; i++) stepPhysics(dt / steps);
    }
    render();
    // Keep the on-screen throttle slider in sync when it isn't being dragged.
    if (touch.throttleSet == null && thrFillEl) thrFillEl.style.height = (ac.throttle * 100) + "%";
  }
  requestAnimationFrame(loop);
}

const thrFillEl = document.getElementById("thrfill");
document.getElementById("startBtn").addEventListener("click", startGame);
setupMobile();

// Draw a static preview frame behind the menu before the game starts.
(function previewFrame() {
  ac = SPAWN();
  viewR = orientationMatrix(ac.yaw, ac.pitch, ac.roll);
  camPos = { ...ac.pos };
  drawSky(); drawTerrain(); drawHills(); drawSeaLink(); drawRunway(); drawCity();
})();
