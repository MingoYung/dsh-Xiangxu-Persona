(function (global) {
  'use strict';
  const LIMITS = Object.freeze({ nodes: 120, edges: 200, layoutRounds: 36, maxPixels: 2097152, maxDimension: 2048 });
  const defaults = { background: 'transparent', text: '#20242b', muted: '#69717e', edge: '#8d98a8', node: '#75889f', selected: '#3269a8', neighbor: '#557caa', kinds: {} };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const label = (value, limit) => Array.from(String(value ?? '')).slice(0, limit).join('');
  const key = value => typeof value === 'string' && value.length > 0 && value.length <= 2048;
  const hash = value => { let result = 2166136261; for (const char of value) result = Math.imul(result ^ char.codePointAt(0), 16777619); return result >>> 0; };
  const modes = ['brain', '3d', '2d'];
  const brainColors = {
    background: '#06131d', cyan: '#55e5ef',
    text: '#e2f2fa', muted: '#acc4d4', selected: '#8ff7ff', neighbor: '#d7ecff',
    kinds: { record: '#fff2d6', source: '#81d9ff', person: '#ffc398', session: '#d9acff' },
  };
  const brainParts = {
    left: [222, 165, 112], right: [177, 134, 222], cerebellum: [114, 180, 181], stem: [173, 176, 205],
  };
  const runtimeColors = { awake: '#63e6a0', sleeping: '#ffae67', error: '#ff7588', unloaded: '#a4b0be', unknown: '#a4b0be' };
  const brainViews = { exterior: { yaw: .91, pitch: -.10 }, cutaway: { yaw: 1.57, pitch: 0 } };
  const rotationFrameInterval = 1000 / 24;

  function meshEdges(triangles) {
    const edges = new Map();
    for (let i = 0; i < triangles.length; i += 3) {
      for (let side = 0; side < 3; side++) {
        const a = triangles[i + side], b = triangles[i + (side + 1) % 3];
        const signature = Math.min(a, b) + ':' + Math.max(a, b);
        const edge = edges.get(signature);
        if (edge) edge.second = i / 3;
        else edges.set(signature, { a, b, first: i / 3, second: -1 });
      }
    }
    return [...edges.values()];
  }

  const frontFace = (a, b, c) => (b.x - a.x) * (c.y - a.y) > (b.y - a.y) * (c.x - a.x);

  function makeMesh(part) {
    const points = [];
    for (let i = 0; i < part.points.length; i += 3) points.push({ x: part.points[i], y: part.points[i + 1], z: part.points[i + 2] });
    return { id: part.id, points, triangles: part.triangles, edges: meshEdges(part.triangles) };
  }

  // The anatomy is a scene layer. Graph nodes use surface positions for
  // display, while their identity and links still come from the graph query.
  function makeBrain() {
    const atlas = global.XiangxuBrainAnatomy;
    if (!atlas?.parts?.length) throw new Error('脑形视图的解剖模型未加载，请重新打开插件页面。');
    const parts = atlas.parts.filter(part => part.id !== 'pineal').map(part => ({
      ...makeMesh(part), color: `rgb(${brainParts[part.id].join(',')})`,
    }));
    const hemispheres = parts.filter(part => part.id === 'left' || part.id === 'right');
    const surface = hemispheres.flatMap(part => part.points.filter(point => Math.abs(point.x) > 15));
    const rightPoints = parts.find(part => part.id === 'right').points;
    const medial = rightPoints.filter(point => Math.abs(point.x) < 23);
    const exposed = medial.length >= LIMITS.nodes ? medial : rightPoints;
    if (surface.length < LIMITS.nodes || exposed.length < LIMITS.nodes) {
      throw new Error('脑形模型的表面点不完整。');
    }
    const [x, y, z] = atlas.pineal;
    const pineal = makeMesh(atlas.parts.find(part => part.id === 'pineal'));
    // Magnify the small anatomical mesh around its atlas center for legibility.
    const scale = 2.5;
    pineal.points = pineal.points.map(point => ({
      x: x + (point.x - x) * scale, y: y + (point.y - y) * scale, z: z + (point.z - z) * scale,
    }));
    return { parts, surface, exposed, pineal: { ...pineal, center: { x, y, z } } };
  }
  let brain;

  function layout(nodes, edges) {
    const count = nodes.length, byKey = new Map();
    nodes.forEach((node, index) => {
      const height = 1 - 2 * (index + .5) / Math.max(1, count), angle = index * 2.399963229728653 + (hash(node.data.key) % 1000) * .0008;
      const ring = Math.sqrt(Math.max(0, 1 - height * height));
      node.x = Math.cos(angle) * ring * 130; node.y = height * 130; node.z = Math.sin(angle) * ring * 130; byKey.set(node.data.key, node);
    });
    if (count < 2) { if (count) nodes[0].x = nodes[0].y = nodes[0].z = 0; return; }
    // A finite local arrangement of supplied links. No similarity or new links
    // are inferred, and no model, storage, timer or external service is used.
    for (let round = 0; round < LIMITS.layoutRounds; round++) {
      const forces = nodes.map(() => ({ x: 0, y: 0, z: 0 }));
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
        const a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
        const distance = Math.max(10, Math.hypot(dx, dy, dz)), strength = 420 / (distance * distance);
        for (const [axis, delta] of [['x', dx], ['y', dy], ['z', dz]]) { const force = delta / distance * strength; forces[i][axis] += force; forces[j][axis] -= force; }
      }
      for (const edge of edges) {
        const a = byKey.get(edge.source), b = byKey.get(edge.target), dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const distance = Math.max(1, Math.hypot(dx, dy, dz)), strength = (distance - 105) * .012;
        for (const [axis, delta] of [['x', dx], ['y', dy], ['z', dz]]) { const force = delta / distance * strength; forces[a.index][axis] += force; forces[b.index][axis] -= force; }
      }
      nodes.forEach((node, index) => { for (const axis of ['x', 'y', 'z']) node[axis] += clamp(forces[index][axis] - node[axis] * .001, -4, 4); });
    }
    const radius = Math.max(1, ...nodes.map(node => Math.hypot(node.x, node.y, node.z)));
    for (const node of nodes) for (const axis of ['x', 'y', 'z']) node[axis] = node[axis] / radius * 155;
  }

  function create(canvas, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') throw new TypeError('A canvas is required for the memory graph');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D rendering is unavailable');
    const document = canvas.ownerDocument ?? global.document, removers = [], pointers = new Map();
    const originalTabindex = canvas.getAttribute?.('tabindex') ?? null, originalTouchAction = canvas.style?.touchAction ?? '';
    const requestFrame = typeof global.requestAnimationFrame === 'function' && typeof global.cancelAnimationFrame === 'function' ? global.requestAnimationFrame.bind(global) : null;
    const cancelFrame = typeof global.cancelAnimationFrame === 'function' ? global.cancelAnimationFrame.bind(global) : null;
    let nodes = [], edges = [], colors = { ...defaults, kinds: {} }, selected = null, disposed = false, frame = null, inView = true, focused = false, gesture = null;
    let width = 0, height = 0, pixelScaleX = 1, pixelScaleY = 1, yaw = .34, pitch = -.18, zoom = 1, panX = 0, panY = 0, mode = modes.includes(options.mode) ? options.mode : '3d';
    let hovered = null, cutaway = false, pointerOver = false, dirty = false, lastRotationFrame = null;
    let runtimeStatus = Object.hasOwn(runtimeColors, options.runtimeStatus) ? options.runtimeStatus : 'unknown';
    let rotationSpeed = finite(options.rotationSpeed) ? clamp(options.rotationSpeed, 0, 2) : 0;
    if (mode === 'brain') { brain ??= makeBrain(); ({ yaw, pitch } = brainViews.exterior); }
    if (originalTabindex === null) canvas.setAttribute?.('tabindex', '0');
    const visible = () => !disposed && inView && document?.visibilityState !== 'hidden' && width > 0 && height > 0;
    const cancelPaint = () => { if (frame !== null && cancelFrame) cancelFrame(frame); frame = null; lastRotationFrame = null; };
    const listen = (target, name, callback, settings) => { if (!target?.addEventListener) return; target.addEventListener(name, callback, settings); removers.push(() => target.removeEventListener(name, callback, settings)); };
    function endInteraction() {
      const captured = [...pointers.keys()]; pointers.clear(); gesture = null;
      for (const id of captured) try { canvas.releasePointerCapture?.(id); } catch {}
    }
    function hover(node = null) {
      if (node === hovered) return;
      hovered = node;
      options.onHover?.(node);
    }
    function leaveInteraction() { focused = false; endInteraction(); hover(); if (canvas.style) canvas.style.touchAction = originalTouchAction; }
    function enterInteraction() { focused = true; if (canvas.style) canvas.style.touchAction = 'none'; }
    function camera() {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const isBrain = mode === 'brain', fit = (isBrain ? Math.min(width / 258, height / 273) : Math.min(width, height) / 410) * zoom;
      return point => {
        const x = mode === '2d' ? point.x : point.x * cy + point.z * sy, z = mode === '2d' ? 0 : -point.x * sy + point.z * cy;
        const y = mode === '2d' ? point.y : point.y * cp - z * sp, depth = mode === '2d' ? 0 : point.y * sp + z * cp;
        const perspective = 460 / (460 - depth);
        return { depth, perspective, horizontal: x, vertical: y, x: width / 2 + x * fit * perspective + panX,
          y: height * (isBrain ? .42 : .5) + y * fit * perspective + panY };
      };
    }
    function project(view = camera()) {
      return nodes.map(node => {
        const point = view(mode === 'brain' ? node.brainPoint : node);
        return { ...point, node, radius: clamp((mode === 'brain' ? 3.1 : 6.5) * point.perspective * Math.sqrt(zoom), mode === 'brain' ? 2.2 : 4, 13) };
      }).sort((a, b) => a.depth - b.depth || a.node.index - b.node.index);
    }
    function paintBrain(view) {
      const center = width / 2, base = height * .84, radius = Math.min(width * .32, height * .29);
      context.fillStyle = brainColors.background;
      context.fillRect(0, 0, width, height);
      const wash = context.createRadialGradient(center, base, 0, center, base, radius * 1.8);
      wash.addColorStop(0, '#48ddec76'); wash.addColorStop(.42, '#13788946'); wash.addColorStop(1, '#06131d00');
      context.fillStyle = wash;
      context.fillRect(0, 0, width, height);
      const beam = context.createLinearGradient(center, height * .05, center, base);
      beam.addColorStop(0, '#58edff00'); beam.addColorStop(.43, '#58edff20'); beam.addColorStop(1, '#58edffad');
      context.fillStyle = beam;
      context.fillRect(center - .75, height * .05, 1.5, base - height * .05);
      context.strokeStyle = brainColors.cyan;
      for (const [scale, alpha] of [[.14, .78], [.4, .28], [.67, .62], [.78, .27], [1, .38], [1.28, .12]]) {
        context.globalAlpha = alpha;
        context.lineWidth = scale === .67 ? 2 : 1;
        if (scale === .67) { context.shadowColor = brainColors.cyan; context.shadowBlur = 13; }
        context.beginPath(); context.ellipse(center, base, radius * scale, radius * scale * .27, 0, 0, Math.PI * 2); context.stroke();
        context.shadowBlur = 0;
      }
      context.globalAlpha = 1;
      for (const part of brain.parts) {
        if (cutaway && part.id === 'left') continue;
        const mesh = part.points.map(view);
        const facing = [], highlights = [];
        context.fillStyle = context.strokeStyle = part.color;
        context.beginPath();
        for (let i = 0; i < part.triangles.length; i += 3) {
          const a = mesh[part.triangles[i]], b = mesh[part.triangles[i + 1]], c = mesh[part.triangles[i + 2]];
          const front = frontFace(a, b, c);
          facing.push(front);
          if (!front) continue;
          context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); context.closePath();
          const projectedArea = Math.abs((b.horizontal - a.horizontal) * (c.vertical - a.vertical) - (b.vertical - a.vertical) * (c.horizontal - a.horizontal));
          const edgeDepth = Math.abs(a.depth - b.depth) + Math.abs(a.depth - c.depth);
          if (edgeDepth > 3 && projectedArea < edgeDepth * 2.3) highlights.push([a, b, c]);
        }
        context.globalAlpha = .11;
        context.fill();
        context.globalAlpha = .17; context.lineWidth = .55;
        context.beginPath();
        for (const [a, b, c] of highlights) { context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); }
        context.stroke();
        context.globalAlpha = .44; context.lineWidth = .85;
        context.beginPath();
        for (const { a, b, first, second } of part.edges) {
          if (second >= 0 && facing[first] === facing[second]) continue;
          context.moveTo(mesh[a].x, mesh[a].y); context.lineTo(mesh[b].x, mesh[b].y);
        }
        context.stroke();
      }
      context.globalAlpha = 1;
    }
    function paintRuntimeStatus(view) {
      const { points, triangles, edges, center } = brain.pineal;
      const mesh = points.map(view), point = view(center);
      const radius = Math.max(4, ...mesh.map(vertex => Math.hypot(vertex.x - point.x, vertex.y - point.y)));
      if (point.x + radius < 0 || point.x - radius > width || point.y + radius < 0 || point.y - radius > height) return;

      const color = runtimeColors[runtimeStatus], haloSize = radius * 2;
      const halo = context.createRadialGradient(point.x, point.y, 0, point.x, point.y, haloSize);
      halo.addColorStop(0, color + '3d'); halo.addColorStop(.55, color + '18'); halo.addColorStop(1, color + '00');
      context.fillStyle = halo;
      context.fillRect(point.x - haloSize, point.y - haloSize, haloSize * 2, haloSize * 2);

      const facing = [];
      context.fillStyle = context.strokeStyle = color;
      context.globalAlpha = .15;
      context.beginPath();
      for (let i = 0; i < triangles.length; i += 3) {
        const a = mesh[triangles[i]], b = mesh[triangles[i + 1]], c = mesh[triangles[i + 2]];
        const front = frontFace(a, b, c);
        facing.push(front);
        if (!front) continue;
        context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.lineTo(c.x, c.y); context.closePath();
      }
      context.fill();

      const layers = [[], [], []];
      for (const edge of edges) {
        const front = facing[edge.first], otherFront = edge.second >= 0 && facing[edge.second];
        layers[front !== otherFront ? 2 : front ? 1 : 0].push(edge);
      }
      const lineStyles = [
        { alpha: .26, width: .55, blur: 0 },
        { alpha: .65, width: .72, blur: 0 },
        { alpha: 1, width: 1.35, blur: clamp(radius * .7, 6, 14) },
      ];
      for (const [index, layer] of layers.entries()) {
        const style = lineStyles[index];
        context.globalAlpha = style.alpha; context.lineWidth = style.width;
        context.shadowColor = color; context.shadowBlur = style.blur;
        context.beginPath();
        for (const { a, b } of layer) {
          context.moveTo(mesh[a].x, mesh[a].y); context.lineTo(mesh[b].x, mesh[b].y);
        }
        context.stroke();
      }
      context.shadowBlur = 0;
      context.globalAlpha = 1;
    }
    function placeLabels(scene, neighbors) {
      const margin = 7, padding = 4, boxHeight = 20, occupied = [], placed = [];
      const measure = text => {
        const measured = context.measureText?.(text)?.width;
        return finite(measured) ? measured : Array.from(text).length * 7.2;
      };
      const overlaps = (a, b, gap = 3) => a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
      const inside = box => box.x >= margin && box.y >= margin && box.x + box.width <= width - margin && box.y + box.height <= height - margin;
      const priority = point => point.node.data.key === selected ? 0 : neighbors.has(point.node.data.key) ? 1 : point.node.data.kind === 'record' ? 2 : point.node.data.kind === 'person' ? 3 : 4;
      const candidates = [...scene].sort((a, b) => priority(a) - priority(b) || b.depth - a.depth || a.node.index - b.node.index);
      const obstacles = scene.map(point => ({ point, x: point.x - point.radius - 2, y: point.y - point.radius - 2, width: (point.radius + 2) * 2, height: (point.radius + 2) * 2 }));
      for (const point of candidates) {
        if (placed.length >= 40) break;
        const chosen = point.node.data.key === selected;
        if (!chosen && (point.x < 0 || point.x > width || point.y < 0 || point.y > height)) continue;
        const maximum = width - margin * 2 - padding * 2;
        if (maximum < measure('…') || height < margin * 2 + boxHeight) continue;
        const letters = Array.from(label(point.node.data.label || point.node.data.key, 28)); let text = letters.join('');
        if (measure(text) > maximum) {
          while (letters.length && measure(letters.join('') + '…') > maximum) letters.pop();
          text = letters.join('') + '…';
        }
        const boxWidth = measure(text) + padding * 2, positions = [];
        // At most 24 screen positions per node; labels never start another
        // layout, move a record, or imply an additional relationship.
        for (const distance of [6, 20, 36]) {
          const offset = point.radius + distance, left = point.x - boxWidth / 2, top = point.y - boxHeight / 2;
          positions.push({ x: point.x + offset, y: top }, { x: point.x - offset - boxWidth, y: top },
            { x: left, y: point.y - offset - boxHeight }, { x: left, y: point.y + offset },
            { x: point.x + offset, y: point.y - offset - boxHeight }, { x: point.x - offset - boxWidth, y: point.y - offset - boxHeight },
            { x: point.x + offset, y: point.y + offset }, { x: point.x - offset - boxWidth, y: point.y + offset });
        }
        let box = positions.map(position => ({ ...position, width: boxWidth, height: boxHeight })).find(candidate => inside(candidate) && !occupied.some(other => overlaps(candidate, other)) &&
          !obstacles.some(other => other.point !== point && overlaps(candidate, other, 1)));
        // The selected name reserves space first, even if tightly packed node
        // dots leave no completely free position. Other names may be hidden.
        if (!box && chosen) box = { x: clamp(point.x + point.radius + 6, margin, width - margin - boxWidth), y: clamp(point.y - boxHeight / 2, margin, height - margin - boxHeight), width: boxWidth, height: boxHeight };
        if (!box) continue;
        occupied.push(box); placed.push({ point, box, text, chosen, padding });
      }
      return placed;
    }
    function draw() {
      if (!visible()) return;
      context.setTransform(pixelScaleX, 0, 0, pixelScaleY, 0, 0); context.clearRect(0, 0, width, height);
      if (colors.background !== 'transparent') { context.fillStyle = colors.background; context.fillRect(0, 0, width, height); }
      const isBrain = mode === 'brain', view = camera(), palette = isBrain ? brainColors : colors;
      if (isBrain) { paintBrain(view); paintRuntimeStatus(view); }
      const scene = project(view), byKey = new Map(scene.map(point => [point.node.data.key, point])), neighbors = new Set();
      if (selected) for (const edge of edges) { if (edge.source === selected) neighbors.add(edge.target); if (edge.target === selected) neighbors.add(edge.source); }
      const links = edges.map(edge => ({ edge, a: byKey.get(edge.source), b: byKey.get(edge.target) })).sort((a, b) => (a.a.depth + a.b.depth) - (b.a.depth + b.b.depth));
      for (const { edge, a, b } of links) {
        const highlighted = selected && (edge.source === selected || edge.target === selected);
        if (isBrain && !highlighted) continue;
        context.globalAlpha = selected ? highlighted ? .95 : .22 : .62; context.strokeStyle = highlighted ? palette.selected : palette.edge; context.lineWidth = highlighted ? 1.8 : 1;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        if (highlighted || edges.length <= 35) {
          const angle = Math.atan2(b.y - a.y, b.x - a.x), tipX = b.x - Math.cos(angle) * (b.radius + 2), tipY = b.y - Math.sin(angle) * (b.radius + 2);
          context.beginPath(); context.moveTo(tipX - Math.cos(angle - .5) * 5, tipY - Math.sin(angle - .5) * 5); context.lineTo(tipX, tipY); context.lineTo(tipX - Math.cos(angle + .5) * 5, tipY - Math.sin(angle + .5) * 5); context.stroke();
        }
      }
      context.font = '12px system-ui, sans-serif'; context.textBaseline = 'middle';
      for (const point of scene) {
        const data = point.node.data, chosen = data.key === selected, related = neighbors.has(data.key);
        context.globalAlpha = selected && !chosen && !related ? .45 : 1;
        context.fillStyle = chosen ? palette.selected : related ? palette.neighbor : palette.kinds[data.kind] ?? colors.node;
        if (isBrain) { context.shadowColor = context.fillStyle; context.shadowBlur = chosen ? 16 : 9; }
        context.beginPath(); context.arc(point.x, point.y, point.radius, 0, Math.PI * 2); context.fill();
        if (isBrain) context.shadowBlur = 0;
        if (chosen) { context.strokeStyle = palette.selected; context.lineWidth = 2; context.beginPath(); context.arc(point.x, point.y, point.radius + 4, 0, Math.PI * 2); context.stroke(); }
      }
      // Paint text after the depth-sorted dots, preserving the selected label
      // without allowing later nodes or lower-priority names to cover it.
      const labelScene = isBrain ? scene.filter(point => point.node.data.key === selected) : scene;
      for (const item of placeLabels(labelScene, neighbors).reverse()) {
        const { point, box, text, chosen, padding } = item;
        if (chosen) {
          context.globalAlpha = .7; context.strokeStyle = palette.muted; context.lineWidth = .8;
          context.beginPath(); context.moveTo(point.x, point.y); context.lineTo(clamp(point.x, box.x, box.x + box.width), clamp(point.y, box.y, box.y + box.height)); context.stroke();
          if (palette.background !== 'transparent') { context.globalAlpha = .94; context.fillStyle = palette.background; context.fillRect(box.x, box.y, box.width, box.height); }
        }
        context.globalAlpha = 1; context.fillStyle = chosen ? palette.selected : palette.text;
        context.fillText(text, box.x + padding, box.y + box.height / 2);
      }
      context.globalAlpha = 1;
    }
    const rotates = () => mode === 'brain' && rotationSpeed > 0 && !cutaway && !pointerOver && !focused && pointers.size === 0;
    function renderFrame(now) {
      frame = null;
      if (!visible()) return;
      if (rotates() && finite(now)) {
        lastRotationFrame ??= now;
        const elapsed = now - lastRotationFrame;
        if (elapsed >= rotationFrameInterval) {
          yaw = (yaw + Math.min(elapsed, 100) / 1000 * rotationSpeed) % (2 * Math.PI);
          lastRotationFrame = now;
          dirty = true;
        }
        frame = requestFrame(renderFrame);
      } else lastRotationFrame = null;
      if (dirty) { dirty = false; draw(); }
    }
    function paint() {
      if (!visible()) return;
      dirty = true;
      if (!requestFrame) { dirty = false; draw(); return; }
      if (frame === null) frame = requestFrame(renderFrame);
    }
    function resize() {
      if (disposed) return;
      const rect = canvas.getBoundingClientRect?.(), nextWidth = rect?.width ?? canvas.clientWidth ?? 0, nextHeight = rect?.height ?? canvas.clientHeight ?? 0;
      width = finite(nextWidth) ? Math.max(0, nextWidth) : 0; height = finite(nextHeight) ? Math.max(0, nextHeight) : 0;
      if (!width || !height) { cancelPaint(); leaveInteraction(); return; }
      // CSS space remains the projection and hit-test coordinate system. Bound
      // the actual backing buffer too, even for very large CSS containers. The
      // dimension pass keeps the area calculation finite before its own cap.
      const requestedDpr = finite(global.devicePixelRatio) ? clamp(global.devicePixelRatio, 1, 2) : 1;
      const dimensionScale = Math.min(requestedDpr, LIMITS.maxDimension / width, LIMITS.maxDimension / height);
      const area = (width * dimensionScale) * (height * dimensionScale);
      const effectiveDpr = dimensionScale * Math.min(1, Math.sqrt(LIMITS.maxPixels / area));
      const pixelsWide = Math.max(1, Math.floor(width * effectiveDpr)), pixelsHigh = Math.max(1, Math.floor(height * effectiveDpr));
      // Use the actual integer dimensions on each axis, so rounding the buffer
      // never changes the CSS position corresponding to a pointer coordinate.
      pixelScaleX = pixelsWide / width; pixelScaleY = pixelsHigh / height;
      if (canvas.width !== pixelsWide) canvas.width = pixelsWide;
      if (canvas.height !== pixelsHigh) canvas.height = pixelsHigh;
      paint();
    }
    function pointFrom(event) { const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0 }; return { x: (finite(event.clientX) ? event.clientX : 0) - (rect.left ?? 0), y: (finite(event.clientY) ? event.clientY : 0) - (rect.top ?? 0) }; }
    function hitAt(point) {
      return project().reverse().find(item => Math.hypot(point.x - item.x, point.y - item.y) <= item.radius + 6);
    }
    function choose(point) {
      const hit = hitAt(point);
      selected = hit?.node.data.key ?? null; paint();
      if (typeof options.onSelect === 'function') options.onSelect(hit?.node.original ?? null);
    }
    function beginGesture() {
      const values = [...pointers.values()];
      if (values.length === 1) gesture = { ...values[0], yaw, pitch, panX, panY, dragged: gesture?.dragged === true };
      else if (values.length >= 2) gesture = { distance: Math.max(1, Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y)), zoom, dragged: true };
    }
    listen(canvas, 'pointerdown', event => {
      if (!visible() || event.button !== undefined && event.button !== 0) return;
      canvas.focus?.({ preventScroll: true }); enterInteraction(); hover();
      pointers.set(event.pointerId, pointFrom(event)); beginGesture();
      try { canvas.setPointerCapture?.(event.pointerId); } catch {}
    });
    listen(canvas, 'pointermove', event => {
      if (!visible()) return;
      if (!pointers.has(event.pointerId)) {
        if (mode === 'brain' && event.pointerType === 'mouse' && pointers.size === 0) hover(hitAt(pointFrom(event))?.node.original);
        return;
      }
      if (event.pointerType === 'mouse' && event.buttons === 0) { endInteraction(); return; }
      const point = pointFrom(event); pointers.set(event.pointerId, point);
      if (pointers.size >= 2) {
        const values = [...pointers.values()]; zoom = clamp(gesture.zoom * Math.hypot(values[0].x - values[1].x, values[0].y - values[1].y) / gesture.distance, .45, 2.8); paint(); return;
      }
      const dx = point.x - gesture.x, dy = point.y - gesture.y;
      if (Math.hypot(dx, dy) <= 5 && !gesture.dragged) return;
      gesture.dragged = true;
      if (mode !== '2d') { yaw = gesture.yaw + dx * .008; pitch = clamp(gesture.pitch + dy * .008, -1.3, 1.3); }
      else { panX = gesture.panX + dx; panY = gesture.panY + dy; }
      paint();
    });
    listen(canvas, 'pointerup', event => {
      if (!pointers.has(event.pointerId)) return;
      const point = pointFrom(event), click = pointers.size === 1 && !gesture?.dragged && Math.hypot(point.x - gesture.x, point.y - gesture.y) <= 5;
      pointers.delete(event.pointerId); try { canvas.releasePointerCapture?.(event.pointerId); } catch {}
      if (pointers.size) beginGesture(); else gesture = null;
      if (click && visible()) choose(point);
    });
    const cancelPointer = event => { if (pointers.has(event.pointerId)) endInteraction(); };
    listen(canvas, 'pointercancel', cancelPointer); listen(canvas, 'lostpointercapture', cancelPointer);
    listen(canvas, 'pointerenter', event => { if (event.pointerType === 'mouse') pointerOver = true; });
    listen(canvas, 'pointerleave', () => { pointerOver = false; hover(); if (rotates()) paint(); });
    listen(canvas, 'focus', enterInteraction);
    listen(canvas, 'blur', () => { leaveInteraction(); if (rotates()) paint(); });
    function changeZoom(delta) { if (disposed || !finite(delta)) return; zoom = clamp(zoom * Math.pow(1.2, clamp(delta, -10, 10)), .45, 2.8); paint(); }
    function reset() {
      if (disposed) return;
      ({ yaw, pitch } = mode === 'brain' ? brainViews[cutaway ? 'cutaway' : 'exterior'] : { yaw: .34, pitch: -.18 });
      zoom = 1; panX = panY = 0; endInteraction(); hover(); paint();
    }
    listen(canvas, 'keydown', event => {
      if (event.key === 'Escape') { leaveInteraction(); canvas.blur?.(); }
      else if (focused && ['+', '=', '-', '_', '0'].includes(event.key)) { event.preventDefault(); if (event.key === '0') reset(); else changeZoom(['+', '='].includes(event.key) ? 1 : -1); }
    });
    listen(canvas, 'wheel', event => {
      if (!focused || !visible() || !finite(event.deltaY) || event.deltaY === 0) return;
      event.preventDefault(); const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
      zoom = clamp(zoom * Math.exp(-clamp(delta, -300, 300) * .0015), .45, 2.8); paint();
    }, { passive: false });
    listen(document, 'visibilitychange', () => { if (document.visibilityState === 'hidden') { cancelPaint(); pointerOver = false; leaveInteraction(); } else resize(); });
    listen(global, 'resize', resize);
    const resizeObserver = typeof global.ResizeObserver === 'function' ? new global.ResizeObserver(resize) : null; resizeObserver?.observe(canvas);
    const intersectionObserver = typeof global.IntersectionObserver === 'function' ? new global.IntersectionObserver(entries => {
      if (disposed) return;
      const entry = entries.find(item => item.target === canvas); if (!entry) return;
      inView = entry.isIntersecting; if (inView) resize(); else { cancelPaint(); pointerOver = false; leaveInteraction(); }
    }) : null; intersectionObserver?.observe(canvas);
    function setColors(next = {}) {
      if (disposed) return;
      if (!next || typeof next !== 'object') next = {};
      const result = { ...defaults, kinds: {} };
      for (const name of Object.keys(defaults).filter(name => name !== 'kinds')) if (typeof next[name] === 'string' && next[name].length <= 200) result[name] = next[name];
      for (const [name, value] of Object.entries(next.kinds ?? {})) if (typeof value === 'string' && value.length <= 200) result.kinds[name] = value;
      colors = result; paint();
    }
    const api = {
      setData(data = {}) {
        if (disposed) return { nodes: 0, edges: 0, disposed: true };
        if (!data || typeof data !== 'object') data = {};
        const sourceNodes = Array.isArray(data.nodes) ? data.nodes : [], sourceEdges = Array.isArray(data.edges) ? data.edges : [], known = new Set();
        hover(); nodes = [];
        for (const input of sourceNodes.slice(0, LIMITS.nodes)) {
          const identifier = input?.key ?? input?.id;
          if (!input || !key(identifier) || known.has(identifier)) continue;
          known.add(identifier); nodes.push({ index: nodes.length, original: input, data: { ...input, key: identifier, label: label(input.label, 120), kind: label(input.kind, 64) } });
        }
        const links = new Set(); edges = [];
        for (const input of sourceEdges.slice(0, LIMITS.edges)) {
          if (!input || !known.has(input.source) || !known.has(input.target) || input.source === input.target) continue;
          const signature = JSON.stringify([input.source, input.target, input.kind ?? '']); if (links.has(signature)) continue;
          links.add(signature); edges.push({ source: input.source, target: input.target, kind: label(input.kind, 64) });
        }
        layout(nodes, edges); placeBrainNodes(); if (!known.has(selected)) selected = null; paint();
        return { nodes: nodes.length, edges: edges.length, totalNodes: sourceNodes.length, totalEdges: sourceEdges.length, omittedNodes: sourceNodes.length - nodes.length, omittedEdges: sourceEdges.length - edges.length };
      },
      setMode(value) {
        if (disposed || mode === value) return;
        if (!modes.includes(value)) throw new TypeError('Unknown memory graph mode');
        const changesScenery = mode === 'brain' || value === 'brain';
        mode = value;
        placeBrainNodes();
        if (changesScenery) reset();
        else { panX = panY = 0; endInteraction(); paint(); }
      },
      setCutaway(value) {
        if (disposed || cutaway === Boolean(value)) return;
        cutaway = Boolean(value);
        if (mode === 'brain') { placeBrainNodes(); reset(); }
      },
      setRotationSpeed(value) {
        if (disposed || !finite(value)) return;
        rotationSpeed = clamp(value, 0, 2);
        lastRotationFrame = null;
        paint();
      },
      setRuntimeStatus(value) {
        const next = Object.hasOwn(runtimeColors, value) ? value : 'unknown';
        if (disposed || runtimeStatus === next) return;
        runtimeStatus = next;
        if (mode === 'brain') paint();
      },
      select(value) { if (disposed) return; selected = nodes.some(node => node.data.key === value) ? value : null; paint(); },
      setColors, resize,
      zoom: changeZoom, zoomIn() { changeZoom(1); }, zoomOut() { changeZoom(-1); }, reset,
      dispose() {
        if (disposed) return; disposed = true; cancelPaint(); leaveInteraction(); resizeObserver?.disconnect(); intersectionObserver?.disconnect();
        for (const remove of removers.splice(0)) remove(); nodes = []; edges = [];
        if (originalTabindex === null) canvas.removeAttribute?.('tabindex');
      },
    };
    function placeBrainNodes() {
      if (mode !== 'brain') return;
      brain ??= makeBrain();
      const slots = cutaway ? brain.exposed : brain.surface;
      const occupied = new Set();
      for (const node of nodes) {
        let slot = hash(node.data.key) % slots.length;
        while (occupied.has(slot)) slot = (slot + 1) % slots.length;
        occupied.add(slot);
        node.brainPoint = slots[slot];
      }
    }
    setColors(options.colors); resize();
    return api;
  }
  global.XiangxuMemoryGraph = Object.freeze({ create, limits: LIMITS });
})(globalThis);
