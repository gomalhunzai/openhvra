// Map controls: area-drawing toolbar, and the layers box (basemap + overlays + legend).

const ICONS = {
  rect: '<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>',
  circle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  polygon: '<svg viewBox="0 0 24 24"><path d="M12 3l8.5 6.2-3.2 10H6.7L3.5 9.2z"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M5 20h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
};

function button(icon, title, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctrl-icon';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = ICONS[icon];
  b.addEventListener('click', onClick);
  return b;
}

export class DrawControl {
  constructor({ onDraw, onClear, onUpload }) {
    this.onDraw = onDraw;
    this.onClear = onClear;
    this.onUpload = onUpload;
    this.buttons = {};
  }
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    for (const [mode, title] of [['rect', 'Select area: rectangle'], ['circle', 'Select area: circle'], ['polygon', 'Select area: polygon']]) {
      div.appendChild((this.buttons[mode] = button(mode, title, () => this.onDraw(mode))));
    }
    div.appendChild(button('upload', 'Upload area boundary (Shapefile zip, GeoJSON, KML, KMZ, GPX, GeoPackage, WKT)', () => this.onUpload()));
    div.appendChild(button('trash', 'Clear selected area (use the current view)', () => this.onClear()));
    return (this.el = div);
  }
  setActive(mode) {
    for (const [m, b] of Object.entries(this.buttons)) b.classList.toggle('active', m === mode);
  }
  onRemove() {
    this.el.remove();
  }
}


// Layers box: basemap choice, overlay switches and each layer's legend in one
// vertical list on the map. Layers in the same `exclusive` group never show at
// once (the building colourings: flood depth, social vulnerability, multi-hazard).
//   layers: [{ key, label, ids: [mapLayerId], symbol: { kind: 'fill'|'line'|'dot', color },
//              items?: [{ label, color }], ramp?: [{ label, color }], exclusive?, hint?, available? }]
export class LayerControl {
  constructor({ basemaps, basemap, layers }) {
    this.basemaps = basemaps;
    this.basemap = basemap;
    this.layers = layers.map((l) => ({ available: true, visible: true, ...l }));
    this.rows = {};
  }

  onAdd(map) {
    this.map = map;
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl layer-ctrl';
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'layer-head';
    head.innerHTML = `${ICONS.layers}<span>Layers</span><span class="chev" aria-hidden="true">▾</span>`;
    const body = document.createElement('div');
    body.className = 'layer-body';
    body.id = 'layer-body';
    head.setAttribute('aria-controls', body.id);
    head.addEventListener('click', () => this.setOpen(body.hidden));

    let html = '<div class="layer-sec">Basemap</div>';
    for (const [id, b] of Object.entries(this.basemaps)) {
      html += `<label class="layer-row"><input type="radio" name="basemap" value="${id}" ${id === this.basemap ? 'checked' : ''}>
        <span class="swatch" style="background:${b.swatch}"></span><span>${b.label}</span></label>`;
    }
    html += '<div class="layer-sec">Layers</div>';
    for (const l of this.layers) {
      html += `<div class="layer-item" data-key="${l.key}">
        <label class="layer-row"><input type="checkbox" data-key="${l.key}" checked>
          <span class="sym sym-${l.symbol.kind}" style="--c:${l.symbol.color}"></span><span class="name">${l.label}</span>
          ${l.items ? '<button type="button" class="more" aria-expanded="false" title="Show legend">▸</button>' : ''}</label>
        <div class="layer-hint">${l.hint ?? ''}</div>
        ${l.items ? `<ul class="layer-items" hidden>${l.items.map((i) => `<li><span class="sym sym-${l.symbol.kind}" style="--c:${i.color}"></span>${i.label}</li>`).join('')}</ul>` : ''}
        ${l.ramp ? `<div class="layer-ramp"><div class="ramp">${l.ramp.map((r) => `<span style="background:${r.color}" title="${r.label}"></span>`).join('')}</div>
          <div class="ramp-labels"><span>${l.ramp[0].label}</span><span>${l.ramp[l.ramp.length - 1].label}</span></div></div>` : ''}
      </div>`;
    }
    body.innerHTML = html;

    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.name === 'basemap') {
        this.basemap = t.value;
        for (const k of Object.keys(this.basemaps)) this._vis(`base-${k}`, k === t.value);
      } else if (t.dataset.key) {
        this.setVisible(t.dataset.key, t.checked);
      }
    });
    body.addEventListener('click', (e) => {
      const more = e.target.closest('.more');
      if (!more) return;
      e.preventDefault();
      const list = more.closest('.layer-item').querySelector('.layer-items');
      list.hidden = !list.hidden;
      more.setAttribute('aria-expanded', String(!list.hidden));
      more.textContent = list.hidden ? '▸' : '▾';
    });

    div.append(head, body);
    this.el = div;
    this.body = body;
    this.head = head;
    let open = window.matchMedia('(min-width: 761px)').matches;
    try {
      const saved = localStorage.getItem('openhvra-layers-open');
      if (saved != null) open = saved === '1';
    } catch {
      /* default by screen size */
    }
    this.setOpen(open, false);
    for (const l of this.layers) this._render(l);
    map.on('load', () => this.layers.forEach((l) => this._apply(l)));
    return div;
  }

  onRemove() {
    this.el.remove();
  }

  setOpen(open, remember = true) {
    this.body.hidden = !open;
    this.head.setAttribute('aria-expanded', String(open));
    this.el.classList.toggle('closed', !open);
    if (remember) {
      try {
        localStorage.setItem('openhvra-layers-open', open ? '1' : '0');
      } catch {
        /* not remembered */
      }
    }
  }

  _get(key) {
    return this.layers.find((l) => l.key === key);
  }

  _vis(id, on) {
    if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  _apply(l) {
    for (const id of l.ids) this._vis(id, l.visible && l.available);
  }

  _render(l) {
    const item = this.body.querySelector(`.layer-item[data-key="${l.key}"]`);
    const box = item.querySelector('input');
    box.checked = l.visible;
    box.disabled = !l.available;
    item.classList.toggle('unavailable', !l.available);
    item.classList.toggle('on', l.visible && l.available);
  }

  setVisible(key, on) {
    const l = this._get(key);
    l.visible = on;
    if (on && l.exclusive) {
      for (const o of this.layers) {
        if (o !== l && o.exclusive === l.exclusive && o.visible) {
          o.visible = false;
          this._apply(o);
          this._render(o);
        }
      }
    }
    this._apply(l);
    this._render(l);
  }

  // Mark a layer as having data (or not); `show` also switches it on.
  setAvailable(key, available, show = false) {
    const l = this._get(key);
    l.available = available;
    if (show) this.setVisible(key, true);
    else {
      this._apply(l);
      this._render(l);
    }
  }
}
