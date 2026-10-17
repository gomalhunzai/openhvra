// Map controls: area-drawing toolbar and basemap switcher.

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

export class BasemapControl {
  constructor(basemaps, current, onSelect) {
    this.basemaps = basemaps;
    this.current = current;
    this.onSelect = onSelect;
  }
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-ctrl';
    const toggle = button('layers', 'Change basemap', () => {
      menu.hidden = !menu.hidden;
      toggle.setAttribute('aria-expanded', String(!menu.hidden));
    });
    const menu = document.createElement('div');
    menu.className = 'basemap-menu';
    menu.hidden = true;
    for (const [id, b] of Object.entries(this.basemaps)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.dataset.id = id;
      item.innerHTML = `<span class="swatch" style="background:${b.swatch}"></span>${b.label}`;
      item.classList.toggle('active', id === this.current);
      item.addEventListener('click', () => {
        this.current = id;
        menu.querySelectorAll('button').forEach((x) => x.classList.toggle('active', x.dataset.id === id));
        menu.hidden = true;
        this.onSelect(id);
      });
      menu.appendChild(item);
    }
    div.append(toggle, menu);
    document.addEventListener('click', (e) => {
      if (!div.contains(e.target)) menu.hidden = true;
    });
    return (this.el = div);
  }
  onRemove() {
    this.el.remove();
  }
}
