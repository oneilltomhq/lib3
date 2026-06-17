const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { alpha: false });
const tabs = document.getElementById("tabs");
const copy = document.getElementById("copy");

const steps = [
  {
    id: "sources",
    label: "sources",
    text: "Each moving sphere contributes one signed distance: negative inside, zero on the surface, positive outside.",
  },
  {
    id: "field",
    label: "field",
    text: "The field combines every sphere with smooth-min, which rounds the union where surfaces get close.",
  },
  {
    id: "slice",
    label: "slice",
    text: "The cyan contour is the zero crossing of the smooth field. That contour is the metaball surface.",
  },
  {
    id: "march",
    label: "march",
    text: "Raymarching samples the field and advances by the returned distance until the ray reaches the surface.",
  },
  {
    id: "normal",
    label: "normal",
    text: "The normal comes from tiny field samples around the hit point. It points in the direction where distance increases.",
  },
  {
    id: "shade",
    label: "shade",
    text: "The final material bends the background sample by the normal and adds fresnel at glancing angles.",
  },
];

let activeStep = steps[0].id;
let width = 0;
let height = 0;
let dpr = 1;
let time = 0;

const sources = Array.from({ length: 5 }, (_, i) => ({
  x: 0,
  y: 0,
  r: 0.2 + i * 0.018,
  phase: i * 1.37,
}));

for (const step of steps) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = step.label;
  button.dataset.step = step.id;
  button.addEventListener("click", () => setStep(step.id));
  tabs.append(button);
}

function setStep(id) {
  activeStep = id;
  for (const button of tabs.children) {
    button.setAttribute("aria-pressed", String(button.dataset.step === id));
  }
  copy.textContent = steps.find((step) => step.id === id).text;
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updateSources() {
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const t = time * (0.55 + i * 0.04) + source.phase;
    source.x = Math.sin(t * 1.1) * 0.72 + Math.sin(t * 0.37) * 0.18;
    source.y = Math.cos(t * 0.9) * 0.42 + Math.sin(t * 1.7) * 0.12;
  }
}

function sphereSdf(x, y, source) {
  return Math.hypot(x - source.x, y - source.y) - source.r;
}

function smoothMin(a, b, k) {
  const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k));
  return a * h + b * (1 - h) - k * h * (1 - h);
}

function field(x, y, smooth = true) {
  let d = 20;
  for (const source of sources) {
    const next = sphereSdf(x, y, source);
    d = smooth ? smoothMin(d, next, 0.32) : Math.min(d, next);
  }
  return d;
}

function normalAt(x, y) {
  const e = 0.004;
  const nx = field(x + e, y) - field(x - e, y);
  const ny = field(x, y + e) - field(x, y - e);
  const len = Math.hypot(nx, ny) || 1;
  return { x: nx / len, y: ny / len };
}

function worldToScreen(x, y) {
  const scale = Math.min(width, height) * 0.34;
  return {
    x: width * 0.56 + x * scale,
    y: height * 0.53 - y * scale,
  };
}

function screenToWorld(x, y) {
  const scale = Math.min(width, height) * 0.34;
  return {
    x: (x - width * 0.56) / scale,
    y: -(y - height * 0.53) / scale,
  };
}

function drawBackground() {
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#111827");
  gradient.addColorStop(0.5, "#201633");
  gradient.addColorStop(1, "#0b3437");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  ctx.globalAlpha = 0.24;
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  for (let x = -width; x < width * 2; x += 34) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + height * 0.7, height);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawField() {
  const cell = Math.max(8, Math.floor(Math.min(width, height) / 70));
  for (let sy = 0; sy < height; sy += cell) {
    for (let sx = 0; sx < width; sx += cell) {
      const p = screenToWorld(sx + cell * 0.5, sy + cell * 0.5);
      const d = field(p.x, p.y, activeStep !== "field-hard");
      const inside = d < 0;
      const a = Math.max(0, 1 - Math.abs(d) * 3.2);
      ctx.fillStyle = inside
        ? `rgba(122, 240, 255, ${0.16 + a * 0.26})`
        : `rgba(255, 220, 122, ${a * 0.2})`;
      ctx.fillRect(sx, sy, cell + 1, cell + 1);
    }
  }
}

function drawContours() {
  const cell = Math.max(7, Math.floor(Math.min(width, height) / 90));
  ctx.fillStyle = "#7af0ff";
  for (let sy = 0; sy < height; sy += cell) {
    for (let sx = 0; sx < width; sx += cell) {
      const p = screenToWorld(sx + cell * 0.5, sy + cell * 0.5);
      if (Math.abs(field(p.x, p.y)) < 0.018) {
        ctx.fillRect(sx, sy, cell * 0.72, cell * 0.72);
      }
    }
  }
}

function drawSources() {
  for (const source of sources) {
    const p = worldToScreen(source.x, source.y);
    const edge = worldToScreen(source.x + source.r, source.y);
    const radius = Math.abs(edge.x - p.x);

    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.07)";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.58)";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ff7aa8";
    ctx.fill();
  }
}

function raymarch() {
  const origin = { x: -1.65, y: 0.18 + Math.sin(time * 0.8) * 0.08 };
  const direction = { x: 1, y: -0.07 };
  const len = Math.hypot(direction.x, direction.y);
  direction.x /= len;
  direction.y /= len;

  const samples = [];
  let t = 0;
  let hit = null;
  for (let i = 0; i < 34; i++) {
    const p = {
      x: origin.x + direction.x * t,
      y: origin.y + direction.y * t,
    };
    const d = field(p.x, p.y);
    samples.push({ ...p, d });
    if (d < 0.01) {
      hit = p;
      break;
    }
    t += Math.max(d, 0.012);
    if (t > 3.5) break;
  }

  return { origin, direction, samples, hit };
}

function drawRay() {
  const march = raymarch();
  const start = worldToScreen(march.origin.x, march.origin.y);
  const end = worldToScreen(
    march.origin.x + march.direction.x * 3.4,
    march.origin.y + march.direction.y * 3.4
  );

  ctx.strokeStyle = "#ffdc7a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  for (const sample of march.samples) {
    const p = worldToScreen(sample.x, sample.y);
    const edge = worldToScreen(sample.x + Math.max(sample.d, 0.012), sample.y);
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.abs(edge.x - p.x), 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,220,122,0.24)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = "#ffdc7a";
    ctx.fill();
  }

  return march.hit;
}

function drawNormal(hit) {
  if (!hit) return;
  const n = normalAt(hit.x, hit.y);
  const p = worldToScreen(hit.x, hit.y);
  const tip = worldToScreen(hit.x + n.x * 0.38, hit.y + n.y * 0.38);
  ctx.strokeStyle = "#7af0ff";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
}

function drawShade() {
  drawContours();
  const cell = Math.max(6, Math.floor(Math.min(width, height) / 115));
  for (let sy = 0; sy < height; sy += cell) {
    for (let sx = 0; sx < width; sx += cell) {
      const p = screenToWorld(sx + cell * 0.5, sy + cell * 0.5);
      const d = field(p.x, p.y);
      if (Math.abs(d) > 0.04) continue;
      const n = normalAt(p.x, p.y);
      const view = { x: -0.55, y: 0.83 };
      const fresnel = Math.pow(1 - Math.abs(n.x * view.x + n.y * view.y), 2);
      ctx.fillStyle = `rgba(${80 + fresnel * 175}, ${120 + fresnel * 120}, 255, ${0.25 + fresnel * 0.55})`;
      ctx.fillRect(sx, sy, cell + 1, cell + 1);
    }
  }
}

function render(now) {
  time = now / 1000;
  updateSources();
  drawBackground();

  if (activeStep !== "sources") drawField();
  if (activeStep === "slice" || activeStep === "normal") drawContours();
  if (activeStep === "shade") drawShade();
  drawSources();

  let hit = null;
  if (activeStep === "march" || activeStep === "normal") hit = drawRay();
  if (activeStep === "normal") drawNormal(hit);

  requestAnimationFrame(render);
}

window.addEventListener("resize", resize);
resize();
setStep("sources");
requestAnimationFrame(render);
