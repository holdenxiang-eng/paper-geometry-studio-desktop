import { evaluateScene, validateScene } from './geometry.js';

// Compile only explicit, recognized conditions. Pixel geometry supplies positions;
// it never supplies unstated equal lengths, right angles or answers.
export function applyRecognizedRelations(input, stem) {
  let scene = structuredClone(input);
  const original = evaluateScene(scene).points, warnings = [];
  // Circled candidate statements are claims to assess, not givens. They must
  // never constrain the drawing, even when an assertion contains an equation.
  const givens = String(stem).split(/[①②③④⑤⑥⑦⑧⑨⑩]/u)[0];
  const text = givens.replace(/\\angle/g, '∠').replace(/\\perp/g, '⊥').replace(/\\parallel/g, '∥')
    .replace(/\\(?:triangle|circ|mathrm|text|left|right)/g, '').replace(/[\s${}^\\]/g, '').replace(/\u3001/g, ',');
  const point = label => scene.points.find(p => (p.label || p.id) === label && p.visible !== false);
  const has = (...labels) => labels.every(label => point(label) && original[point(label).id]);
  const pos = label => original[point(label).id];
  const length = (a, b) => Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y);
  const signed = (a, center, b) => Math.sign((pos(a).x - pos(center).x) * (pos(b).y - pos(center).y) - (pos(a).y - pos(center).y) * (pos(b).x - pos(center).x)) || 1;
  let serial = 0;
  const helper = (target, fields) => {
    let id; do { id = `_relation-${++serial}`; } while (target.points.some(p => p.id === id));
    target.points.push({ id, visible: false, ...fields }); return id;
  };
  const set = (target, label, fields) => {
    const p = point(label), { id, label: name, labelOffset, visible } = p;
    target.points[target.points.findIndex(entry => entry.id === id)] = { id, ...(name === undefined ? {} : { label: name }), ...(labelOffset ? { labelOffset } : {}), ...(visible === undefined ? {} : { visible }), ...fields };
  };
  const id = label => point(label).id;
  const attempt = (description, change) => {
    const next = structuredClone(scene);
    change(next);
    const errors = validateScene(next);
    if (errors.length) warnings.push(`${description}尚未建立联动，请核对：${errors[0]}`);
    else scene = next;
  };

  const rectangle = /(?:长方形|矩形)([A-Z])([A-Z])([A-Z])([A-Z])/.exec(text);
  if (rectangle && has(...rectangle.slice(1))) {
    const [, a, b, c, d] = rectangle;
    attempt('矩形关系', next => {
      const turn = helper(next, { kind: 'rotate', source: id(a), center: id(b), angle: signed(a, b, c) * 90 });
      set(next, c, { kind: 'onLine', from: id(b), to: turn, t: length(b, c) / length(a, b) });
      const center = helper(next, { kind: 'midpoint', from: id(a), to: id(c) });
      set(next, d, { kind: 'rotate', source: id(b), center, angle: 180 });
    });
  }

  for (const match of text.matchAll(/([A-Z])为([A-Z])([A-Z])的?中点/g)) {
    const [, middle, a, b] = match;
    if (has(middle, a, b)) attempt('中点关系', next => set(next, middle, { kind: 'midpoint', from: id(a), to: id(b) }));
  }
  for (const match of text.matchAll(/([A-Z])(?:为|在)([A-Z])([A-Z])(?:上|上的)/g)) {
    const [, middle, a, b] = match;
    if (!has(middle, a, b) || [a, b].includes(middle)) continue;
    const p = pos(middle), u = pos(a), v = pos(b), dx = v.x - u.x, dy = v.y - u.y;
    const t = ((p.x - u.x) * dx + (p.y - u.y) * dy) / (dx * dx + dy * dy);
    attempt('线上动点关系', next => set(next, middle, { kind: 'onLine', from: id(a), to: id(b), t }));
  }

  // An explicitly given area ratio can determine a point already constrained
  // to a side. Solve the signed, linear determinant equation; no answer choices
  // or requested answer are used. The visible point becomes derived/locked.
  const areaRatio = /S(?:△|_)?([A-Z]{3}):S(?:△|_)?([A-Z]{3})=(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)/.exec(text);
  if (areaRatio && has(...new Set((areaRatio[1] + areaRatio[2]).split(''))) && Number(areaRatio[3]) > 0 && Number(areaRatio[4]) > 0) {
    const labels = new Set(areaRatio[1].split('').filter(label => areaRatio[2].includes(label)));
    const moving = scene.points.filter(p => p.kind === 'onLine' && labels.has(p.label || p.id));
    if (moving.length === 1) {
      const variable = moving[0], points = evaluateScene(scene).points;
      const determinant = (triangle, t) => {
        const from = points[variable.from], to = points[variable.to];
        const coordinates = triangle.split('').map(label => id(label) === variable.id ? { x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) } : points[id(label)]);
        const [a, b, c] = coordinates;
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      };
      const ratio = Number(areaRatio[3]) / Number(areaRatio[4]);
      const sign = Math.sign(determinant(areaRatio[1], variable.t) * determinant(areaRatio[2], variable.t)) || 1;
      const left0 = determinant(areaRatio[1], 0), left1 = determinant(areaRatio[1], 1) - left0;
      const right0 = determinant(areaRatio[2], 0), right1 = determinant(areaRatio[2], 1) - right0;
      const denominator = left1 - sign * ratio * right1;
      const t = (sign * ratio * right0 - left0) / denominator;
      if (Number.isFinite(t) && t > 0 && t < 1 && Math.abs(determinant(areaRatio[2], t)) > 1e-8) attempt('题设面积比', next => {
        const source = helper(next, { kind: 'onLine', from: variable.from, to: variable.to, t });
        set(next, variable.label || variable.id, { kind: 'project', point: source, from: variable.from, to: variable.to });
      });
    }
  }

  const right = /∠([A-Z])([A-Z])([A-Z])=90/.exec(text);
  const rightCompatible = right && has(...right.slice(1)) && Math.abs(((pos(right[1]).x - pos(right[2]).x) * (pos(right[3]).x - pos(right[2]).x) + (pos(right[1]).y - pos(right[2]).y) * (pos(right[3]).y - pos(right[2]).y)) / (length(right[1], right[2]) * length(right[3], right[2]))) < .3;
  if (right && has(...right.slice(1)) && !rightCompatible) warnings.push('题干直角条件与本图位置不一致，未自动套用，请核对该图对应的条件。');
  if (rightCompatible) {
    const [, a, center, b] = right;
    attempt('直角关系', next => {
      const equal = text.includes(`${a}${center}=${b}${center}`) || text.includes(`${center}${a}=${center}${b}`) || text.includes(`${a}${center}=${center}${b}`) || text.includes(`${center}${a}=${b}${center}`);
      const angle = signed(a, center, b) * 90;
      const givenLength = (u, v) => Number(new RegExp(`(?<![A-Z∠])(?:${u}${v}|${v}${u})=(\\d+(?:\\.\\d+)?)`).exec(text)?.[1]);
      const firstLength = givenLength(a, center), secondLength = givenLength(b, center);
      if (firstLength > 0 && secondLength > 0) set(next, a, { kind: 'onCircle', center: id(center), radius: length(a, center), angle: Math.atan2(pos(a).y - pos(center).y, pos(a).x - pos(center).x) * 180 / Math.PI });
      if (equal) set(next, b, { kind: 'rotate', source: id(a), center: id(center), angle });
      else {
        const direction = helper(next, { kind: 'rotate', source: id(a), center: id(center), angle });
        set(next, b, { kind: 'onLine', from: id(center), to: direction, t: firstLength > 0 && secondLength > 0 ? secondLength / firstLength : length(center, b) / length(center, a) });
      }
      if (!next.angles.some(mark => mark.vertex === id(center))) next.angles.push({ id: `_right-${serial++}`, a: id(a), vertex: id(center), b: id(b), right: true });
    });
  }

  const perpendicularGroups = new Map();
  for (const match of text.matchAll(/([A-Z])([A-Z])⊥([a-z])/g)) {
    if (!has(match[1], match[2])) continue;
    const group = perpendicularGroups.get(match[3]) || [];
    group.push({ source: match[1], foot: match[2] }); perpendicularGroups.set(match[3], group);
  }
  for (const [name, group] of perpendicularGroups) {
    if (group.length < 2) continue;
    const u = pos(group[0].foot), v = pos(group[1].foot), dx = v.x - u.x, dy = v.y - u.y, magnitude = Math.hypot(dx, dy);
    const compatible = magnitude > .05 && group.every(({ source, foot }) => Math.abs((pos(source).x - pos(foot).x) * dx + (pos(source).y - pos(foot).y) * dy) / (length(source, foot) * magnitude) < .3);
    if (!compatible) { warnings.push(`直线 ${name} 的垂足条件与本图位置不一致，未自动套用。`); continue; }
    attempt('垂足联动', next => {
      const start = helper(next, { kind: 'free', x: u.x - dx * .2, y: u.y - dy * .2 });
      const end = helper(next, { kind: 'free', x: v.x + dx * .2, y: v.y + dy * .2 });
      const center = rightCompatible ? right[2] : null;
      if (center && has(center) && Math.abs(dx * (pos(center).y - u.y) - dy * (pos(center).x - u.x)) / magnitude < .08) {
        const p = pos(center), a = next.points.find(point => point.id === start), b = next.points.find(point => point.id === end);
        const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
        set(next, center, { kind: 'onLine', from: start, to: end, t });
      }
      for (const { source, foot } of group) {
        set(next, foot, { kind: 'project', point: id(source), from: start, to: end });
        next.angles.push({ id: `_foot-${serial++}`, a: id(source), vertex: id(foot), b: end, right: true });
      }
      next.lines.push({ id: `_baseline-${serial++}`, from: start, to: end, label: name });
    });
  }

  // Fixed given angles define the triangle rays; their half-angle rays define
  // the named intersection, rather than a visually guessed interior point.
  const angleValues = [...text.matchAll(/∠([A-Z])=(\d+(?:\.\d+)?)/g)].map(match => [match[1], Number(match[2])]);
  angleValues.push(...[...text.matchAll(/∠([A-Z])([A-Z])([A-Z])=(\d+(?:\.\d+)?)/g)].map(match => [match[2], Number(match[4])]));
  const triangle = /(?:三角形|△)([A-Z])([A-Z])([A-Z])/.exec(text) || /在([A-Z])([A-Z])([A-Z])中/.exec(text);
  if (triangle && has(...triangle.slice(1)) && angleValues.length >= 2) {
    const labels = triangle.slice(1), known = new Map(angleValues);
    const unknown = labels.filter(label => !known.has(label));
    if (unknown.length === 1) known.set(unknown[0], 180 - labels.reduce((sum, label) => sum + (known.get(label) || 0), 0));
    if (labels.every(label => known.get(label) > 0 && known.get(label) < 180)) {
      const [a, b, c] = labels;
      attempt('题设角度', next => {
        const rb = helper(next, { kind: 'rotate', source: id(c), center: id(b), angle: signed(c, b, a) * known.get(b) });
        const rc = helper(next, { kind: 'rotate', source: id(b), center: id(c), angle: signed(b, c, a) * known.get(c) });
        set(next, a, { kind: 'intersection', a: id(b), b: rb, c: id(c), d: rc });
        const bisectors = /∠([A-Z]),?∠([A-Z])的(?:角)?平分线相交于(?:点)?([A-Z])/.exec(text);
        if (bisectors && has(...bisectors.slice(1)) && labels.includes(bisectors[1]) && labels.includes(bisectors[2])) {
          const [, u, v, f] = bisectors;
          const otherU = labels.find(label => label !== u && label !== a) || a;
          const otherV = labels.find(label => label !== v && label !== a) || a;
          const hu = helper(next, { kind: 'rotate', source: id(otherU), center: id(u), angle: signed(otherU, u, a) * known.get(u) / 2 });
          const hv = helper(next, { kind: 'rotate', source: id(otherV), center: id(v), angle: signed(otherV, v, a) * known.get(v) / 2 });
          set(next, f, { kind: 'intersection', a: id(u), b: hu, c: id(v), d: hv });
        }
      });
    }
  }

  for (const match of text.matchAll(/过(?:点)?([A-Z])(?:作)?([A-Z])([A-Z])∥([A-Z])([A-Z])/g)) {
    const [, through, d, e, a, b] = match;
    if (!has(through, d, e, a, b)) continue;
    attempt('平行线关系', next => {
      const midpoint = helper(next, { kind: 'midpoint', from: id(through), to: id(b) });
      const direction = helper(next, { kind: 'rotate', source: id(a), center: midpoint, angle: 180 });
      for (const endpoint of [d, e]) {
        const others = scene.points.filter(p => p.visible !== false && ![d, e, through].includes(p.label || p.id));
        let best;
        for (let i = 0; i < others.length; i++) for (let j = i + 1; j < others.length; j++) {
          const u = original[others[i].id], v = original[others[j].id], p = pos(endpoint), len = Math.hypot(v.x - u.x, v.y - u.y);
          const distance = Math.abs((v.x - u.x) * (p.y - u.y) - (v.y - u.y) * (p.x - u.x)) / len;
          if (!best || distance < best.distance) best = { u: others[i].id, v: others[j].id, distance };
        }
        if (best && best.distance < .08) set(next, endpoint, { kind: 'intersection', a: id(through), b: direction, c: best.u, d: best.v });
        else warnings.push(`${endpoint} 的边界交点未可靠确定，请核对。`);
      }
    });
  }
  // A point splitting the same straight ink stroke stays on that stroke.
  // This encodes visible incidence, not a guessed metric relationship.
  for (const middle of [...scene.points].filter(point => point.kind === 'free' && point.visible !== false)) {
    const neighbors = scene.segments.filter(edge => edge.from === middle.id || edge.to === middle.id).map(edge => edge.from === middle.id ? edge.to : edge.from);
    let best;
    for (let i = 0; i < neighbors.length; i++) for (let j = i + 1; j < neighbors.length; j++) {
      const u = original[neighbors[i]], v = original[neighbors[j]], p = original[middle.id];
      if (!u || !v || !p) continue;
      const dx = v.x - u.x, dy = v.y - u.y, square = dx * dx + dy * dy, t = ((p.x - u.x) * dx + (p.y - u.y) * dy) / square;
      const residual = Math.abs(dx * (p.y - u.y) - dy * (p.x - u.x)) / Math.sqrt(square);
      if (t > .03 && t < .97 && residual < .035 && (!best || square > best.square)) best = { from: neighbors[i], to: neighbors[j], t, square };
    }
    if (best) {
      const next = structuredClone(scene), target = next.points.find(point => point.id === middle.id);
      delete target.x; delete target.y; Object.assign(target, { kind: 'onLine', from: best.from, to: best.to, t: best.t });
      if (!validateScene(next).length) scene = next;
    }
  }
  return { scene, warnings };
}

