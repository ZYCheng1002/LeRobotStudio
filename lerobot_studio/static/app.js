/* 所有视图以已完成解码的帧为准；拖动请求合并，防止旧响应覆盖新帧。 */
const $ = id => document.getElementById(id);
const COLORS = ['#3975e7', '#dc6352', '#2ca480', '#9362d5', '#d4a12d', '#32a7bb', '#c85da5', '#59677c'];

class JointChart {
  constructor(parent, group, timestamps, seek) {
    this.group = group; this.timestamps = timestamps; this.seek = seek;
    this.frame = 0; this.start = 0; this.end = Math.max(1, timestamps.length - 1);
    this.visible = group.series.map(() => true);
    this.element = document.createElement('div'); this.element.className = 'chart';
    const title = document.createElement('div'); title.className = 'chartTitle'; title.textContent = group.title;
    const legend = document.createElement('div'); legend.className = 'legend';
    group.series.forEach((series, i) => {
      const label = document.createElement('label'); label.style.color = COLORS[i % COLORS.length];
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
      checkbox.onchange = () => { this.visible[i] = checkbox.checked; this.draw(); };
      label.append(checkbox, document.createTextNode(series.name)); legend.append(label);
    });
    if (!group.series.length) legend.textContent = '未匹配关节，请在 config.yaml 设置 prefix 或 indices';
    this.canvas = document.createElement('canvas');
    this.element.append(title, legend, this.canvas); parent.append(this.element);
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(this.canvas);
    this.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const ratio = this.ratio(event), width = this.end - this.start;
      const next = Math.min(Math.max(1, timestamps.length - 1), Math.max(4, width * (event.deltaY > 0 ? 1.2 : .8)));
      this.window(this.start + width * ratio - next * ratio, next);
    }, {passive: false});
    this.canvas.onpointerdown = event => {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = {x: event.clientX, start: this.start, pan: event.shiftKey};
      if (!event.shiftKey) this.locate(event);
    };
    this.canvas.onpointermove = event => {
      if (!this.drag) return;
      if (this.drag.pan) this.window(this.drag.start - (event.clientX - this.drag.x) / Math.max(1, this.canvas.clientWidth - 64) * (this.end - this.start), this.end - this.start);
      else this.locate(event);
    };
    this.canvas.onpointerup = this.canvas.onpointercancel = () => { this.drag = null; };
    this.canvas.ondblclick = () => this.window(0, Math.max(1, timestamps.length - 1));
  }
  ratio(event) { return Math.max(0, Math.min(1, (event.clientX - this.canvas.getBoundingClientRect().left - 46) / Math.max(1, this.canvas.clientWidth - 64))); }
  locate(event) { this.seek(Math.round(this.start + this.ratio(event) * (this.end - this.start))); }
  window(start, width) { this.start = Math.max(0, Math.min(start, Math.max(0, this.timestamps.length - 1 - width))); this.end = this.start + width; this.draw(); }
  destroy() { this.observer.disconnect(); this.element.remove(); }
  draw() {
    const canvas = this.canvas, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
    const left = 46, right = w - 18, top = 15, bottom = h - 26;
    const x = index => left + (index - this.start) / (this.end - this.start) * (right - left);
    let min = Infinity, max = -Infinity;
    this.group.series.forEach((series, j) => {
      if (this.visible[j]) for (let i = Math.floor(this.start); i <= Math.min(Math.ceil(this.end), series.values.length - 1); i++) {
        const value = series.values[i]; if (value !== null) { min = Math.min(min, value); max = Math.max(max, value); }
      }
    });
    if (!Number.isFinite(min)) { min = -1; max = 1; }
    const pad = Math.max(.01, (max - min) * .08); min -= pad; max += pad;
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    ctx.font = '10px system-ui'; ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const py = top + (bottom - top) * i / 4;
      ctx.strokeStyle = '#e9edf3'; ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke();
      ctx.fillStyle = '#8692a4'; ctx.fillText((max - (max - min) * i / 4).toFixed(2), 2, py + 3);
      const f = Math.min(this.timestamps.length - 1, Math.round(this.start + (this.end - this.start) * i / 4));
      const px = left + (right - left) * i / 4;
      ctx.fillText(`${this.timestamps[f].toFixed(1)}s`, px - 12, h - 7);
    }
    ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
    this.group.series.forEach((series, j) => {
      if (!this.visible[j]) return;
      ctx.strokeStyle = COLORS[j % COLORS.length]; ctx.lineWidth = 1.3; ctx.beginPath();
      let connected = false;
      for (let i = Math.floor(this.start); i <= Math.min(Math.ceil(this.end), series.values.length - 1); i++) {
        const value = series.values[i]; if (value === null) { connected = false; continue; }
        if (connected) ctx.lineTo(x(i), y(value)); else ctx.moveTo(x(i), y(value)); connected = true;
      }
      ctx.stroke();
      const value = series.values[this.frame];
      if (value != null) { ctx.beginPath(); ctx.arc(x(this.frame), y(value), 3, 0, Math.PI * 2); ctx.fillStyle = COLORS[j % COLORS.length]; ctx.fill(); }
    });
    ctx.strokeStyle = '#e35263'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x(this.frame), top); ctx.lineTo(x(this.frame), bottom); ctx.stroke(); ctx.restore();
  }
}

class StudioApp {
  constructor() {
    this.charts = []; this.generation = 0; this.frame = 0; this.playing = false;
    this.busy = false; this.pending = null; this.dirty = false; this.loading = false;
    this.bind(); this.initialize();
  }
  async api(route, data, post = false) {
    const response = await fetch(`/api/${route}${post ? '' : '?' + new URLSearchParams(data || {})}`, post ? {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)
    } : {});
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
  }
  message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  async attempt(action) { try { await action(); } catch (error) { this.pause(); this.message(error.message, true); } }
  bind() {
    $('import').onclick = () => this.attempt(async () => { this.pause(); $('browser').showModal(); await this.browse(this.config.dataset.browse_root); });
    $('browse').onclick = () => this.attempt(() => this.browse($('path').value));
    $('closeBrowser').onclick = () => $('browser').close();
    $('open').onclick = () => this.attempt(() => this.open($('path').value));
    $('search').oninput = $('filter').onchange = () => this.renderEpisodes();
    $('play').onclick = () => this.togglePlay();
    $('previous').onclick = () => this.seek(this.frame - 1);
    $('next').onclick = () => this.seek(this.frame + 1);
    $('timeline').oninput = event => this.seek(Number(event.target.value));
    $('frame').onchange = event => this.seek(Number(event.target.value));
    $('speed').onchange = () => { if (this.playing) { this.anchorFrame = this.frame; this.anchorTime = performance.now(); } };
    $('save').onclick = () => this.attempt(() => this.save());
    $('note').oninput = () => this.markDirty();
    window.addEventListener('beforeunload', event => { if (this.dirty) { event.preventDefault(); event.returnValue = ''; } });
    document.addEventListener('keydown', event => {
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(event.target.tagName) || $('browser').open) return;
      if (event.code === 'Space') { event.preventDefault(); this.togglePlay(); }
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') { event.preventDefault(); this.seek(this.frame + (event.code === 'ArrowLeft' ? -1 : 1)); }
    });
  }
  async initialize() {
    await this.attempt(async () => {
      this.config = await this.api('config');
      this.config.playback.speeds.forEach(speed => { const option = new Option(`${speed}×`, speed); $('speed').add(option); });
      this.config.annotation.labels.forEach(label => {
        const element = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.value = label; input.onchange = () => this.markDirty();
        element.append(input, document.createTextNode(label)); $('labels').append(element);
      });
    });
  }
  async browse(path) {
    const result = await this.api('browse', {path}); $('path').value = result.path; $('folders').replaceChildren();
    const add = (label, path) => { const button = document.createElement('button'); button.textContent = label; button.onclick = () => this.attempt(() => this.browse(path)); $('folders').append(button); };
    if (result.parent) add('↑ 上一级', result.parent);
    result.folders.forEach(folder => add(`${folder.dataset ? '▣' : '▸'} ${folder.name}${folder.dataset ? '  · LeRobot 数据集' : ''}`, folder.path));
  }
  async flush() { if (this.dirty) await this.save(); }
  async open(path) {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.flush(); this.pause();
      const dataset = await this.api('open', {path}, true);
      this.dataset = dataset; this.detail = null; ++this.generation; this.pending = null;
      $('datasetName').textContent = dataset.name; $('datasetName').title = dataset.path;
      $('browser').close(); this.renderEpisodes();
    } finally { this.loading = false; }
    await this.select(this.dataset.episodes[0].id);
  }
  renderEpisodes() {
    if (!this.dataset) return;
    const query = $('search').value.toLowerCase(), filter = $('filter').value;
    $('episodes').replaceChildren();
    let count = 0;
    this.dataset.episodes.forEach(episode => {
      const annotation = this.dataset.annotations[episode.id];
      const reviewed = Boolean(annotation?.labels?.length);
      if (reviewed) count++;
      if (filter === 'done' && !reviewed || filter === 'pending' && reviewed) return;
      if (!`${episode.id} ${episode.tasks.join(' ')}`.toLowerCase().includes(query)) return;
      const button = document.createElement('button'); button.className = `episode${this.detail?.id === episode.id ? ' active' : ''}`;
      const line = document.createElement('div'); line.className = 'line';
      const id = document.createElement('b'); id.textContent = `# ${episode.id}`;
      const duration = document.createElement('small'); duration.textContent = `${(episode.length / this.dataset.fps).toFixed(1)}s`;
      line.append(id, duration); const task = document.createElement('p'); task.textContent = episode.tasks.join(' / '); task.title = task.textContent;
      const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = reviewed ? `✓ ${annotation.labels.join(' · ')}` : '待标注';
      button.append(line, task, badge); button.onclick = () => this.attempt(() => this.select(episode.id)); $('episodes').append(button);
    });
    $('count').textContent = this.dataset.episodes.length;
    $('progress').textContent = `已标注 ${count} / ${this.dataset.episodes.length}`;
  }
  async select(id) {
    if (this.loading) return;
    this.loading = true;
    try {
      await this.flush(); this.pause();
      const generation = ++this.generation; this.pending = null; this.message(`正在加载 Episode #${id}…`);
      this.detail = null;
      const detail = await this.api('episode', {token: this.dataset.token, episode: id});
      if (generation !== this.generation) return;
      this.detail = detail; this.frame = 0;
      this.charts.forEach(chart => chart.destroy()); this.charts = detail.groups.map(group => new JointChart($('charts'), group, detail.timestamps, frame => this.seek(frame)));
      $('cameras').replaceChildren(); this.images = [];
      const slots = Math.max(detail.cameras.length, Math.min(4, Math.max(2, this.config.ui.camera_slots)));
      for (let i = 0; i < slots; i++) {
        const element = document.createElement('div'); element.className = 'camera';
        if (i < detail.cameras.length) {
          const title = document.createElement('span'); title.className = 'cameraTitle'; title.textContent = detail.cameras[i].replace('observation.images.', '');
          const img = document.createElement('img'); img.alt = title.textContent; this.images.push(img); element.append(img, title);
        } else { element.classList.add('empty'); element.textContent = `相机 ${i + 1} · 预留位置`; }
        $('cameras').append(element);
      }
      $('timeline').max = $('frame').max = detail.length - 1;
      const annotation = this.dataset.annotations[id];
      document.querySelectorAll('#labels input').forEach(input => { input.checked = annotation?.labels.includes(input.value) || false; });
      $('note').value = annotation?.note || ''; this.dirty = false;
      $('saved').textContent = annotation?.labels?.length ? `已标注 · 复查帧 ${annotation.review_frame}` : '未标注';
      this.renderEpisodes(); this.requestFrame(0);
    } finally { this.loading = false; }
  }
  seek(frame) { this.pause(); if (this.detail && Number.isFinite(frame)) this.requestFrame(Math.max(0, Math.min(this.detail.length - 1, Math.round(frame)))); }
  requestFrame(frame) {
    this.pending = {frame, generation: this.generation, token: this.dataset.token, episode: this.detail.id};
    this.pump();
  }
  async pump() {
    if (this.busy || !this.pending) return;
    this.busy = true;
    const request = this.pending; this.pending = null;
    try {
      const result = await this.api('frames', request);
      const decoded = await Promise.all(result.images.map(src => { const img = new Image(); img.src = src; return img.decode().then(() => img); }));
      if (request.generation !== this.generation || this.pending) return;
      this.images.forEach((image, i) => { image.src = decoded[i].src; });
      this.frame = result.frame;
      $('timeline').value = $('frame').value = this.frame;
      $('time').textContent = `${this.detail.timestamps[this.frame].toFixed(2)}s · ${this.frame + 1}/${this.detail.length}`;
      this.charts.forEach(chart => { chart.frame = this.frame; chart.draw(); });
      this.message(`Episode #${this.detail.id} · ${this.detail.cameras.length} 路相机 · ${this.detail.fps} FPS`);
    } catch (error) { if (request.generation === this.generation) { this.pause(); this.message(error.message, true); } }
    finally { this.busy = false; if (this.pending) this.pump(); }
  }
  togglePlay() {
    if (this.playing) return this.pause();
    if (!this.detail || this.loading) return;
    if (this.frame === this.detail.length - 1) { this.seek(0); return; }
    this.playing = true; $('play').textContent = 'Ⅱ 暂停'; this.anchorTime = performance.now(); this.anchorFrame = this.frame;
    const tick = now => {
      if (!this.playing) return;
      const targetTime = this.detail.timestamps[this.anchorFrame] + (now - this.anchorTime) / 1000 * Number($('speed').value);
      // 按真实时间戳二分查找；慢机器允许跳过显示帧，单帧操作始终精确。
      let low = this.anchorFrame, high = this.detail.length - 1;
      while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.detail.timestamps[mid] <= targetTime) low = mid; else high = mid - 1; }
      if (!this.busy && low !== this.frame) this.requestFrame(low);
      if (this.frame === this.detail.length - 1) this.pause();
      else this.animation = requestAnimationFrame(tick);
    };
    this.animation = requestAnimationFrame(tick);
  }
  pause() { this.playing = false; cancelAnimationFrame(this.animation); $('play').textContent = '▶ 播放'; }
  markDirty() { if (this.detail) { this.dirty = true; $('saved').textContent = '未保存 · 切换时自动保存'; } }
  async save() {
    if (!this.detail) return;
    if (this.saving) { await this.saving; return; }
    const labels = [...document.querySelectorAll('#labels input:checked')].map(input => input.value);
    if (!labels.length) throw new Error('请至少选择一项标注');
    if (labels.includes('其他') && !$('note').value.trim()) throw new Error('选择“其他”后请填写备注');
    $('save').disabled = true;
    const id = this.detail.id, token = this.dataset.token;
    const note = $('note').value;
    const controls = [...document.querySelectorAll('#labels input'), $('note')];
    controls.forEach(input => { input.disabled = true; });
    try {
      this.saving = this.api('annotation', {token, episode: id, labels, note, frame: this.frame}, true);
      const annotation = await this.saving;
      this.dataset.annotations[id] = annotation;
      const currentLabels = [...document.querySelectorAll('#labels input:checked')].map(input => input.value);
      this.dirty = $('note').value !== note || JSON.stringify(labels) !== JSON.stringify(currentLabels);
      $('saved').textContent = this.dirty ? '存在未保存修改' : `已保存 · 复查帧 ${annotation.review_frame}`;
      this.renderEpisodes();
    } finally { this.saving = null; $('save').disabled = false; controls.forEach(input => { input.disabled = false; }); }
  }
}
new StudioApp();
