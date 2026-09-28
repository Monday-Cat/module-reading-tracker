'use strict';

const {
	Plugin,
	PluginSettingTab,
	ItemView,
	Setting,
	Notice,
	TFolder,
	TFile,
	Modal,
	Menu
} = require('obsidian');

const VIEW_TYPE = 'module-reading-tracker-view';

const DEFAULT_LEVELS = [
	{ id: 'urgent', name: '紧急复习', color: '#e93147' },
	{ id: 'focus', name: '重点掌握', color: '#ec7500' },
	{ id: 'periodic', name: '定期回顾', color: '#086ddd' },
	{ id: 'mastered', name: '已掌握', color: '#00a67d' }
];

const DEFAULT_SETTINGS = {
	folderDepth: 1,        // 模块聚合层级（按第几级文件夹聚合）
	ignoreFolders: [],     // 忽略的文件夹路径列表
	showUnopened: true,    // 是否显示 0 次浏览的文件/模块
	sortMode: 'count',     // count | last | name | level
	defaultFileMode: false, // 视图默认打开"文件"还是"模块"页签
	levels: DEFAULT_LEVELS, // 可自定义的颜色等级
	// 每日复习目标
	dailyEnabled: true,     // 是否启用每日复习目标
	dailyCount: 5,          // 每天抽取的文件数
	dailyScope: 'all',      // all=全部文件 | marked=仅已标记等级
	dailyLevelFirst: true,  // 优先抽取等级靠前（如"紧急复习"）的文件
	dailyPreferStale: true, // 优先抽取更久未浏览的文件
	dailyLogNode: true,     // 完成复习时自动记录学习节点
	dailyAutoOpen: false    // 打开面板时自动进入复习页签
};

function pad2(n) {
	return n < 10 ? '0' + n : '' + n;
}

function formatFull(ts) {
	if (!ts) return '从未浏览';
	const d = new Date(ts);
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
		' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function formatRelative(ts) {
	if (!ts) return '—';
	const diff = Date.now() - ts;
	const MIN = 60000, HOUR = 3600000, DAY = 86400000;
	if (diff < MIN) return '刚刚';
	if (diff < HOUR) return Math.floor(diff / MIN) + ' 分钟前';
	if (diff < DAY) return Math.floor(diff / HOUR) + ' 小时前';
	if (diff < 30 * DAY) return Math.floor(diff / DAY) + ' 天前';
	const d = new Date(ts);
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 本地日期键，格式 YYYY-MM-DD（用于每日复习目标按天分组）
function todayKey() {
	const d = new Date();
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 任意时间戳 -> 本地日期键
function dateKeyOf(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 相对今天的日期键：offsetDays=0 今天，-1 昨天
function keyWithOffset(offsetDays) {
	const d = new Date(Date.now() + offsetDays * 86400000);
	return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

class ReadingTrackerPlugin extends Plugin {
	async onload() {
		const stored = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored.settings || {});
		if (!this.settings.levels) this.settings.levels = DEFAULT_LEVELS.slice();
		this.data = {
			records: stored.records || {},
			marks: stored.marks || {},
			daily: stored.daily || null // { date, items: [{path, done}], generatedAt }
		};
		this.lastRecordedPath = null;
		this._dirty = false;
		this._saveTimer = null;

		this.registerView(VIEW_TYPE, (leaf) => new ReadingStatsView(leaf, this));

		this.addRibbonIcon('bar-chart-3', '打开 Reading Tracker', () => {
			this.activateView();
		});
		this.addCommand({
			id: 'open-module-reading-stats',
			name: '打开 Reading Tracker',
			callback: () => {
				this.activateView();
			}
		});
		this.addCommand({
			id: 'mark-level-current-file',
			name: '标记当前文件的复习等级',
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice('当前没有打开的文件');
					return;
				}
				new LevelPickerModal(this.app, this, file).open();
			}
		});
		this.addCommand({
			id: 'add-node-current-file',
			name: '为当前文件添加学习节点',
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice('当前没有打开的文件');
					return;
				}
				new NodesModal(this.app, this, file).open();
			}
		});
		this.addCommand({
			id: 'open-daily-review',
			name: '打开每日复习目标',
			callback: () => {
				this.openDailyView();
			}
		});
		this.addCommand({
			id: 'regenerate-daily-review',
			name: '重新生成今日复习目标',
			callback: () => {
				const d = this.generateDaily();
				if (d && d.items.length > 0) {
					new Notice('已生成今日复习目标（' + d.items.length + ' 个文件）');
					this.openDailyView();
				} else {
					new Notice('没有符合条件的文件，可在设置中调整复习范围');
				}
			}
		});

		// 文件被打开（含标签页切换）时记录一次浏览
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => this.handleView(file))
		);
		// 兜底：切换已打开的标签页/分屏时同样视为一次浏览
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', (leaf) => {
				const view = leaf ? leaf.view : null;
				this.handleView(view && view.file ? view.file : null);
			})
		);

		// 文件右键菜单：标记等级 / 学习节点
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!(file instanceof TFile)) return;
				this.attachFileMenuItems(menu, file);
			})
		);
		// 编辑器内右键菜单同样可用
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor, view) => {
				const file = view && view.file;
				if (!(file instanceof TFile)) return;
				this.attachFileMenuItems(menu, file);
			})
		);

		// 重命名/移动时迁移记录与标记，删除时清理
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.handleRename(file, oldPath))
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => this.handleDelete(file))
		);

		this.addSettingTab(new TrackerSettingTab(this.app, this));
		this.register(() => this.flushSave());
	}

	onunload() {}

	// ---------- 浏览记录逻辑 ----------

	handleView(file) {
		if (!file || !(file instanceof TFile)) return;
		if (this.isIgnored(file.path)) return;
		// 去重：同一文件连续触发只记一次，切换到其他文件后再回来才重新计数
		if (this.lastRecordedPath === file.path) return;
		this.lastRecordedPath = file.path;

		let rec = this.data.records[file.path];
		if (!rec) {
			rec = { count: 0, last: 0 };
			this.data.records[file.path] = rec;
		}
		rec.count += 1;
		rec.last = Date.now();
		this.scheduleSave();
		this.refreshViews();
	}

	handleRename(file, oldPath) {
		if (oldPath === file.path) return;
		// 迁移浏览记录
		const rec = this.data.records[oldPath];
		if (rec) {
			delete this.data.records[oldPath];
			this.data.records[file.path] = rec;
		}
		// 迁移等级标记与学习节点
		const mark = this.data.marks[oldPath];
		if (mark) {
			delete this.data.marks[oldPath];
			this.data.marks[file.path] = mark;
		}
		if (this.lastRecordedPath === oldPath) this.lastRecordedPath = file.path;
		this.scheduleSave();
		this.refreshViews();
	}

	handleDelete(file) {
		const hadRecord = !!this.data.records[file.path];
		const hadMark = !!this.data.marks[file.path];
		if (!hadRecord && !hadMark) return;
		delete this.data.records[file.path];
		delete this.data.marks[file.path];
		if (this.lastRecordedPath === file.path) this.lastRecordedPath = null;
		this.scheduleSave();
		this.refreshViews();
	}

	isIgnored(path) {
		const rules = this.settings.ignoreFolders || [];
		for (const raw of rules) {
			const rule = String(raw || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
			if (!rule) continue;
			if (path === rule || path.startsWith(rule + '/')) return true;
		}
		return false;
	}

	// ---------- 标记与学习节点 ----------

	getMark(path) {
		return this.data.marks[path];
	}

	ensureMark(path) {
		if (!this.data.marks[path]) {
			this.data.marks[path] = { level: null, nodes: [] };
		}
		return this.data.marks[path];
	}

	pruneMark(path) {
		const mark = this.data.marks[path];
		if (mark && !mark.level && (!mark.nodes || mark.nodes.length === 0)) {
			delete this.data.marks[path];
		}
	}

	setFileLevel(path, levelId) {
		const mark = this.ensureMark(path);
		mark.level = levelId || null;
		this.pruneMark(path);
		this.scheduleSave();
		this.refreshViews();
	}

	addNode(path, text) {
		const mark = this.ensureMark(path);
		if (!mark.nodes) mark.nodes = [];
		mark.nodes.push({ ts: Date.now(), text: text });
		this.scheduleSave();
		this.refreshViews();
	}

	removeNode(path, ts) {
		const mark = this.getMark(path);
		if (!mark || !mark.nodes) return;
		mark.nodes = mark.nodes.filter((n) => n.ts !== ts);
		this.pruneMark(path);
		this.scheduleSave();
		this.refreshViews();
	}

	getLevel(levelId) {
		if (!levelId) return null;
		return (this.settings.levels || []).find((lv) => lv.id === levelId) || null;
	}

	levelIndex(levelId) {
		return (this.settings.levels || []).findIndex((lv) => lv.id === levelId);
	}

	buildLevelMenu(menu, file) {
		const mark = this.getMark(file.path);
		const current = mark && mark.level ? mark.level : null;
		for (const lv of this.settings.levels || []) {
			menu.addItem((item) => {
				item.setTitle(lv.name);
				item.setChecked(current === lv.id);
				item.onClick(() => this.setFileLevel(file.path, lv.id));
			});
		}
		menu.addItem((item) => {
			item.setTitle('清除标记');
			item.setIcon('x');
			item.onClick(() => this.setFileLevel(file.path, null));
		});
	}

	attachFileMenuItems(menu, file) {
		menu.addItem((item) => {
			item.setTitle('标记复习等级');
			item.setIcon('tag');
			const sub = item.setSubmenu();
			this.buildLevelMenu(sub, file);
		});
		menu.addItem((item) => {
			item.setTitle('学习节点…');
			item.setIcon('flag');
			item.onClick(() => new NodesModal(this.app, this, file).open());
		});
	}

	// ---------- 每日复习目标 ----------

	// 获取今天的复习目标；不存在或跨天则自动生成（不静默覆盖未完成的当天目标）
	getDaily() {
		const daily = this.data.daily;
		if (daily && daily.date === todayKey()) return daily;
		return null;
	}

	// 收集候选文件池
	dailyCandidates() {
		const pool = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.isIgnored(f.path)) continue;
			if (this.settings.dailyScope === 'marked' && !this.getMark(f.path)) continue;
			pool.push(f);
		}
		return pool;
	}

	// 生成今日复习目标（抽取逻辑：等级优先 + 更久未复习优先 + 组内随机）
	generateDaily() {
		const pool = this.dailyCandidates();
		const n = Math.max(1, this.settings.dailyCount || 5);

		// 优先级得分：等级索引越小分越高；未复习时长按天折算加分
		const scored = pool.map((f) => {
			const mark = this.getMark(f.path);
			const li = mark && mark.level ? this.levelIndex(mark.level) : -1;
			const levelScore = this.settings.dailyLevelFirst && li >= 0
				? (1000 - li * 100)
				: 0;
			const rec = this.data.records[f.path];
			const lastSeen = rec && rec.last ? rec.last : 0;
			const staleDays = lastSeen ? (Date.now() - lastSeen) / 86400000 : 999;
			const staleScore = this.settings.dailyPreferStale ? Math.min(staleDays, 999) : 0;
			return { file: f, score: levelScore + staleScore + Math.random() * 50 };
		});
		scored.sort((a, b) => b.score - a.score);

		const picked = scored.slice(0, n);
		this.data.daily = {
			date: todayKey(),
			generatedAt: Date.now(),
			items: picked.map((p) => ({ path: p.file.path, done: false }))
		};
		this.scheduleSave();
		this.refreshViews();
		return this.data.daily;
	}

	// 换一个目标：把某项替换为池中的其他候选
	rerollDailyItem(path) {
		const daily = this.getDaily();
		if (!daily) return;
		const inSet = new Set(daily.items.map((i) => i.path));
		const candidates = this.dailyCandidates().filter((f) => !inSet.has(f.path));
		if (candidates.length === 0) {
			new Notice('没有可替换的候选文件');
			return;
		}
		const next = candidates[Math.floor(Math.random() * candidates.length)];
		const item = daily.items.find((i) => i.path === path);
		if (item) item.path = next.path;
		this.scheduleSave();
		this.refreshViews();
	}

	// 完成一项复习：标记完成，并按设置追加学习节点
	completeDaily(path, done) {
		const daily = this.getDaily();
		if (!daily) return;
		const item = daily.items.find((i) => i.path === path);
		if (!item) return;
		if (item.done === done) return;
		item.done = done;
		if (done && this.settings.dailyLogNode) {
			this.addNode(path, '完成每日复习');
		}
		this.scheduleSave();
		this.refreshViews();
	}

	// ---------- 数据聚合 ----------

	// 列出指定层级的所有文件夹（用于展示 0 次浏览的模块）
	listFoldersAtDepth(depth) {
		const folders = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (!(f instanceof TFolder)) continue;
			if (f.path === '/') continue;
			if (f.path.startsWith('.')) continue;
			if (this.isIgnored(f.path)) continue;
			if (f.path.split('/').length === depth) folders.push(f.path);
		}
		return folders;
	}

	// 按层级聚合：模块 -> { count, last, files }
	aggregateFolders(depth) {
		const agg = {};
		const touch = (key) => {
			if (!agg[key]) agg[key] = { count: 0, last: 0, files: 0 };
			return agg[key];
		};
		for (const [path, rec] of Object.entries(this.data.records)) {
			if (this.isIgnored(path)) continue;
			const segs = path.split('/');
			const folderSegs = segs.slice(0, segs.length - 1);
			const key = folderSegs.slice(0, depth).join('/'); // '' 表示根目录文件
			const a = touch(key);
			a.count += rec.count;
			a.files += 1;
			if (rec.last > a.last) a.last = rec.last;
		}
		if (this.settings.showUnopened) {
			for (const folder of this.listFoldersAtDepth(depth)) touch(folder);
		}
		return agg;
	}

	// 按层级聚合各等级标记数量：模块 -> { levelId: n }
	aggregateMarks(depth) {
		const res = {};
		for (const [path, mark] of Object.entries(this.data.marks)) {
			if (!mark.level) continue;
			if (this.isIgnored(path)) continue;
			const segs = path.split('/');
			const key = segs.slice(0, segs.length - 1).slice(0, depth).join('/');
			if (!res[key]) res[key] = {};
			res[key][mark.level] = (res[key][mark.level] || 0) + 1;
		}
		return res;
	}

	// 文件视图行数据
	listFileRows(filterPath) {
		const rows = [];
		const seen = new Set();
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (this.isIgnored(f.path)) continue;
			if (filterPath && !f.path.startsWith(filterPath + '/')) continue;
			seen.add(f.path);
			const rec = this.data.records[f.path];
			if (!rec && !this.settings.showUnopened && !this.getMark(f.path)) continue;
			rows.push({
				path: f.path,
				file: f,
				count: rec ? rec.count : 0,
				last: rec ? rec.last : 0,
				ctime: f.stat ? f.stat.ctime : 0
			});
		}
		// 有浏览记录或标记、但非 md 的文件（如 canvas / pdf）也纳入
		for (const path of new Set([
			...Object.keys(this.data.records),
			...Object.keys(this.data.marks)
		])) {
			if (seen.has(path) || this.isIgnored(path)) continue;
			if (filterPath && !path.startsWith(filterPath + '/')) continue;
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) continue;
			const rec = this.data.records[path];
			if (!rec && !this.settings.showUnopened && !this.getMark(path)) continue;
			rows.push({
				path,
				file: f,
				count: rec ? rec.count : 0,
				last: rec ? rec.last : 0,
				ctime: f.stat ? f.stat.ctime : 0
			});
		}
		return rows;
	}

	// ---------- 视图与持久化 ----------

	refreshViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && typeof leaf.view.render === 'function') leaf.view.render();
		}
	}

	async activateView() {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		if (leaves.length > 0) {
			this.app.workspace.revealLeaf(leaves[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	// 打开面板并切换到"每日复习"页签
	async openDailyView() {
		await this.activateView();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view && leaf.view.mode !== undefined) {
				leaf.view.mode = 'daily';
				if (typeof leaf.view.render === 'function') leaf.view.render();
			}
		}
	}

	scheduleSave() {
		this._dirty = true;
		if (this._saveTimer) return;
		this._saveTimer = window.setTimeout(() => {
			this._saveTimer = null;
			this.flushSave();
		}, 1500);
	}

	flushSave() {
		if (this._saveTimer) {
			clearTimeout(this._saveTimer);
			this._saveTimer = null;
		}
		if (!this._dirty) return;
		this._dirty = false;
		this.saveData({
			settings: this.settings,
			records: this.data.records,
			marks: this.data.marks,
			daily: this.data.daily
		});
	}

	saveSettingsNow() {
		this._dirty = true;
		this.flushSave();
		this.refreshViews();
	}
}

class ReadingStatsView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.mode = plugin.settings.defaultFileMode ? 'file' : 'folder';
		if (plugin.settings.dailyAutoOpen && plugin.settings.dailyEnabled !== false) {
			this.mode = 'daily';
		}
		this.filterPath = null;
		this.levelFilter = 'all'; // all | none | <levelId>
		this.dateFilter = 'all'; // all | today | yesterday | custom
		this.customDate = ''; // YYYY-MM-DD，dateFilter=custom 时使用
		this._timer = null;
	}

	getViewType() {
		return VIEW_TYPE;
	}

	getDisplayText() {
		return 'Reading Tracker';
	}

	getIcon() {
		return 'bar-chart-3';
	}

	async onOpen() {
		this.render();
		// 定期刷新相对时间显示（"x 分钟前"）
		this._timer = window.setInterval(() => this.render(), 30000);
	}

	async onClose() {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}
		this.containerEl.empty();
	}

	sortRows(rows) {
		const mode = this.plugin.settings.sortMode;
		const arr = rows.slice();
		if (mode === 'name') {
			arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
		} else if (mode === 'last') {
			arr.sort((a, b) => (b.last || 0) - (a.last || 0));
		} else if (mode === 'created' && arr.length && 'ctime' in arr[0]) {
			arr.sort((a, b) => (b.ctime || 0) - (a.ctime || 0));
		} else if (mode === 'level' && arr.length && 'levelId' in arr[0]) {
			const idx = (id) => {
				if (!id) return Number.MAX_SAFE_INTEGER;
				const i = this.plugin.levelIndex(id);
				return i < 0 ? Number.MAX_SAFE_INTEGER : i;
			};
			arr.sort((a, b) => (idx(a.levelId) - idx(b.levelId)) || ((b.last || 0) - (a.last || 0)));
		} else {
			arr.sort((a, b) => (b.count - a.count) || ((b.last || 0) - (a.last || 0)));
		}
		return arr;
	}

	showLevelMenu(event, file) {
		const menu = new Menu();
		this.plugin.buildLevelMenu(menu, file);
		menu.showAtMouseEvent(event);
	}

	render() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('mrt-root');

		// ---- 工具栏 ----
		const toolbar = containerEl.createDiv({ cls: 'mrt-toolbar' });
		const btnFolder = toolbar.createEl('button', {
			text: '模块',
			cls: 'mrt-mode-btn' + (this.mode === 'folder' ? ' is-active' : '')
		});
		const btnFile = toolbar.createEl('button', {
			text: '文件',
			cls: 'mrt-mode-btn' + (this.mode === 'file' ? ' is-active' : '')
		});
		btnFolder.onclick = () => {
			this.mode = 'folder';
			this.filterPath = null;
			this.render();
		};
		btnFile.onclick = () => {
			this.mode = 'file';
			this.render();
		};

		if (this.plugin.settings.dailyEnabled !== false) {
			const daily = this.plugin.getDaily();
			const doneCount = daily ? daily.items.filter((i) => i.done).length : 0;
			const total = daily ? daily.items.length : 0;
			const btnDaily = toolbar.createEl('button', {
				text: '每日复习' + (total ? ' ' + doneCount + '/' + total : ''),
				cls: 'mrt-mode-btn mrt-daily-btn' + (this.mode === 'daily' ? ' is-active' : '')
			});
			if (daily && total > 0 && doneCount === total) btnDaily.addClass('is-done');
			btnDaily.onclick = () => {
				this.mode = 'daily';
				this.render();
			};
		}

		if (this.mode === 'daily') {
			this.renderDaily(containerEl);
			return;
		}

		// 文件模式下的等级筛选
		if (this.mode === 'file') {
			const filterSel = toolbar.createEl('select', { cls: 'mrt-filter' });
			const filterOptions = [['all', '全部等级']];
			for (const lv of this.plugin.settings.levels || []) {
				filterOptions.push([lv.id, lv.name]);
			}
			filterOptions.push(['none', '未标记']);
			for (const [val, label] of filterOptions) {
				const opt = filterSel.createEl('option', { text: label, value: val });
				if (this.levelFilter === val) opt.selected = true;
			}
			filterSel.onchange = () => {
				this.levelFilter = filterSel.value;
				this.render();
			};

			// 添加日期筛选
			const dateSel = toolbar.createEl('select', { cls: 'mrt-filter' });
			const dateOptions = [
				['all', '全部日期'],
				['today', '今日添加'],
				['yesterday', '昨日添加'],
				['custom', '指定日期…']
			];
			for (const [val, label] of dateOptions) {
				const opt = dateSel.createEl('option', { text: label, value: val });
				if (this.dateFilter === val) opt.selected = true;
			}
			dateSel.onchange = () => {
				this.dateFilter = dateSel.value;
				this.render();
			};

			// 指定日期时显示日期选择器
			if (this.dateFilter === 'custom') {
				const dateInput = toolbar.createEl('input', {
					type: 'date',
					cls: 'mrt-filter mrt-date-input'
				});
				if (this.customDate) dateInput.value = this.customDate;
				dateInput.onchange = () => {
					this.customDate = dateInput.value;
					this.render();
				};
			}
		}

		const sortSel = toolbar.createEl('select', { cls: 'mrt-sort' });
		const sortOptions = [
			['count', '按浏览次数'],
			['last', '按最近浏览'],
			['name', '按名称'],
			['level', '按标记等级'],
			['created', '按添加时间']
		];
		for (const [val, label] of sortOptions) {
			const opt = sortSel.createEl('option', { text: label, value: val });
			if (this.plugin.settings.sortMode === val) opt.selected = true;
		}
		sortSel.onchange = () => {
			this.plugin.settings.sortMode = sortSel.value;
			this.plugin.saveSettingsNow();
			this.render();
		};

		// ---- 准备行数据 ----
		let rows = [];
		let summaryText = '';
		if (this.mode === 'folder') {
			const depth = Math.max(1, this.plugin.settings.folderDepth || 1);
			const agg = this.plugin.aggregateFolders(depth);
			const marksAgg = this.plugin.aggregateMarks(depth);
			rows = Object.entries(agg).map(([key, a]) => ({
				key,
				name: key || '(根目录)',
				count: a.count,
				last: a.last,
				files: a.files,
				levelCounts: marksAgg[key] || null
			}));
			rows = this.sortRows(rows);
			const total = rows.reduce((s, r) => s + r.count, 0);
			summaryText = '共 ' + rows.length + ' 个模块 · 总浏览 ' + total + ' 次';
		} else {
			rows = this.plugin.listFileRows(this.filterPath).map((r) => {
				const mark = this.plugin.getMark(r.path);
				return {
					key: r.path,
					file: r.file,
					name: r.file.basename,
					sub: r.file.parent && r.file.parent.path !== '/' ? r.file.parent.path : '(根目录)',
					count: r.count,
					last: r.last,
					ctime: r.ctime,
					levelId: mark && mark.level ? mark.level : null,
					nodeCount: mark && mark.nodes ? mark.nodes.length : 0
				};
			});
			if (this.levelFilter !== 'all') {
				rows = rows.filter((r) =>
					this.levelFilter === 'none' ? !r.levelId : r.levelId === this.levelFilter
				);
			}
			// 按添加日期筛选（基于文件创建时间）
			if (this.dateFilter !== 'all') {
				let targetKey = '';
				if (this.dateFilter === 'today') targetKey = keyWithOffset(0);
				else if (this.dateFilter === 'yesterday') targetKey = keyWithOffset(-1);
				else if (this.dateFilter === 'custom') targetKey = this.customDate;
				if (targetKey) {
					rows = rows.filter((r) => r.ctime && dateKeyOf(r.ctime) === targetKey);
				}
			}
			rows = this.sortRows(rows);
			const total = rows.reduce((s, r) => s + r.count, 0);
			const marked = rows.filter((r) => r.levelId).length;
			summaryText = '共 ' + rows.length + ' 个文件 · 总浏览 ' + total + ' 次 · 已标记 ' + marked;
		}

		// ---- 筛选提示（文件视图按模块筛选时） ----
		if (this.mode === 'file' && this.filterPath) {
			const back = containerEl.createDiv({ cls: 'mrt-back' });
			back.setText('← 返回全部（当前模块：' + this.filterPath + '）');
			back.onclick = () => {
				this.filterPath = null;
				this.render();
			};
		}

		containerEl.createDiv({ cls: 'mrt-summary', text: summaryText });

		// ---- 表格 ----
		const table = containerEl.createEl('table', { cls: 'mrt-table' });
		const hr = table.createEl('thead').createEl('tr');
		hr.createEl('th', { text: '名称' });
		hr.createEl('th', { text: '浏览次数', cls: 'mrt-num' });
		hr.createEl('th', { text: '最近浏览', cls: 'mrt-num' });
		const tbody = table.createEl('tbody');

		if (rows.length === 0) {
			const tr = tbody.createEl('tr');
			tr.createEl('td', { text: '暂无数据', cls: 'mrt-empty', attr: { colspan: '3' } });
		}

		for (const r of rows) {
			const tr = tbody.createEl('tr', { cls: 'mrt-row' });
			const tdName = tr.createEl('td');

			if (this.mode === 'folder') {
				tdName.createSpan({ text: r.name, cls: 'mrt-name' });
				let subText = r.files + ' 个文件';
				if (r.levelCounts) {
					for (const lv of this.plugin.settings.levels || []) {
						const n = r.levelCounts[lv.id];
						if (n) subText += ' · ' + lv.name + ' ' + n;
					}
				}
				tdName.createSpan({ text: subText, cls: 'mrt-sub' });
				tr.createEl('td', { text: String(r.count), cls: 'mrt-num mrt-count' });
				const tdTime = tr.createEl('td', { cls: 'mrt-num mrt-time' });
				tdTime.setText(formatRelative(r.last));
				tdTime.setAttr('title', formatFull(r.last));
				if (r.key) {
					tr.addClass('clickable');
					tr.onclick = () => {
						this.mode = 'file';
						this.filterPath = r.key;
						this.render();
					};
				}
			} else {
				// 等级色点：点击弹出等级菜单
				const level = this.plugin.getLevel(r.levelId);
				const dot = tdName.createSpan({ cls: 'mrt-dot' + (level ? '' : ' empty') });
				if (level) {
					dot.style.background = level.color;
					dot.setAttr('title', '等级：' + level.name + '（点击修改）');
				} else {
					dot.setAttr('title', '点击标记复习等级');
				}
				dot.onclick = (e) => {
					e.stopPropagation();
					this.showLevelMenu(e, r.file);
				};

				tdName.createSpan({ text: r.name, cls: 'mrt-name-inline' });

				if (r.nodeCount > 0) {
					const badge = tdName.createSpan({
						cls: 'mrt-node-badge',
						text: '✎ ' + r.nodeCount
					});
					badge.setAttr('title', '点击查看/添加学习节点');
					badge.onclick = (e) => {
						e.stopPropagation();
						new NodesModal(this.app, this.plugin, r.file).open();
					};
				}

				tdName.createDiv({ text: r.sub, cls: 'mrt-sub' });

				tr.createEl('td', { text: String(r.count), cls: 'mrt-num mrt-count' });
				const tdTime = tr.createEl('td', { cls: 'mrt-num mrt-time' });
				tdTime.setText(formatRelative(r.last));
				tdTime.setAttr('title', formatFull(r.last));

				tr.addClass('clickable');
				tr.onclick = () => {
					const f = r.file;
					if (f) this.app.workspace.getLeaf(false).openFile(f);
				};
			}
		}
	}

	// ---------- 每日复习页签 ----------

	renderDaily(containerEl) {
		const plugin = this.plugin;
		let daily = plugin.getDaily();

		const header = containerEl.createDiv({ cls: 'mrt-daily-header' });
		header.createDiv({
			cls: 'mrt-daily-title',
			text: '今日复习目标 · ' + todayKey()
		});

		const actions = header.createDiv({ cls: 'mrt-daily-actions' });
		const regenBtn = actions.createEl('button', { text: '重新抽取' });
		regenBtn.onclick = () => {
			plugin.generateDaily();
			this.render();
		};

		if (!daily) {
			const box = containerEl.createDiv({ cls: 'mrt-daily-empty' });
			box.createDiv({ text: '今天的复习目标还没有生成' });
			const genBtn = box.createEl('button', { text: '生成今日复习目标' });
			genBtn.onclick = () => {
				const d = plugin.generateDaily();
				if (!d || d.items.length === 0) {
					new Notice('没有符合条件的文件，可在设置中调整复习范围');
				}
				this.render();
			};
			return;
		}

		const items = daily.items;
		const done = items.filter((i) => i.done).length;

		// 进度条
		const bar = containerEl.createDiv({ cls: 'mrt-daily-progress' });
		const fill = bar.createDiv({ cls: 'mrt-daily-progress-fill' });
		fill.style.width = items.length ? (done / items.length) * 100 + '%' : '0%';
		containerEl.createDiv({
			cls: 'mrt-daily-progress-text',
			text: done + ' / ' + items.length + ' 已完成' + (done === items.length && items.length > 0 ? ' · 全部完成！' : '')
		});

		if (items.length === 0) {
			containerEl.createDiv({
				cls: 'mrt-empty',
				text: '没有符合条件的文件，可在设置中调整复习范围或数量'
			});
			return;
		}

		for (const item of items) {
			const file = this.app.vault.getAbstractFileByPath(item.path);
			const row = containerEl.createDiv({ cls: 'mrt-daily-row' + (item.done ? ' is-done' : '') });

			const cb = row.createEl('button', { cls: 'mrt-daily-check' });
			cb.setText(item.done ? '✓' : '');
			cb.setAttr('title', item.done ? '取消完成' : '标记完成');
			cb.onclick = (e) => {
				e.stopPropagation();
				plugin.completeDaily(item.path, !item.done);
				this.render();
			};

			const info = row.createDiv({ cls: 'mrt-daily-info' });
			const mark = plugin.getMark(item.path);
			const level = plugin.getLevel(mark && mark.level);
			const nameRow = info.createDiv({ cls: 'mrt-daily-name' });
			if (level) {
				const dot = nameRow.createSpan({ cls: 'mrt-dot' });
				dot.style.background = level.color;
				dot.setAttr('title', level.name);
			}
			nameRow.createSpan({
				text: file ? file.basename : item.path.split('/').pop(),
				cls: item.done ? 'strikethrough' : ''
			});
			info.createDiv({
				cls: 'mrt-daily-sub',
				text: file && file.parent && file.parent.path !== '/'
					? file.parent.path
					: '(根目录)'
			});

			if (file instanceof TFile) {
				row.addClass('clickable');
				row.onclick = () => {
					this.app.workspace.getLeaf(false).openFile(file);
				};
			}

			const reroll = row.createEl('button', { cls: 'mrt-daily-reroll', text: '换一个' });
			reroll.setAttr('title', '随机替换为其他候选文件');
			reroll.onclick = (e) => {
				e.stopPropagation();
				plugin.rerollDailyItem(item.path);
				this.render();
			};
		}

		containerEl.createDiv({
			cls: 'mrt-daily-hint',
			text: plugin.settings.dailyLogNode
				? '勾选完成时会自动为该文件记录学习节点'
				: '可在设置中开启"完成时自动记录学习节点"'
		});
	}
}

// ---------- 学习节点弹窗 ----------

class NodesModal extends Modal {
	constructor(app, plugin, file) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		this.titleEl.setText('学习节点 · ' + this.file.basename);
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('mrt-nodes-modal');

		const inputRow = contentEl.createDiv({ cls: 'mrt-node-input-row' });
		const input = inputRow.createEl('input', {
			type: 'text',
			placeholder: '记录一个学习节点，例如：完成第一轮复习'
		});
		const addBtn = inputRow.createEl('button', { text: '添加' });
		const doAdd = () => {
			const text = input.value.trim();
			if (!text) {
				new Notice('请输入节点内容');
				return;
			}
			this.plugin.addNode(this.file.path, text);
			this.render();
			const inp = this.contentEl.querySelector('input');
			if (inp) inp.focus();
		};
		addBtn.onclick = doAdd;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') doAdd();
		});

		const mark = this.plugin.getMark(this.file.path);
		const nodes = mark && mark.nodes ? mark.nodes.slice().sort((a, b) => b.ts - a.ts) : [];

		if (nodes.length === 0) {
			contentEl.createDiv({ cls: 'mrt-empty', text: '还没有学习节点，在上方输入后回车添加' });
		} else {
			for (const n of nodes) {
				const row = contentEl.createDiv({ cls: 'mrt-node-row' });
				row.createDiv({ cls: 'mrt-node-meta', text: formatFull(n.ts) });
				row.createDiv({ cls: 'mrt-node-text', text: n.text });
				const del = row.createEl('button', { cls: 'mrt-node-del', text: '✕' });
				del.setAttr('aria-label', '删除该节点');
				del.onclick = () => {
					this.plugin.removeNode(this.file.path, n.ts);
					this.render();
				};
			}
		}
	}
}

// ---------- 等级选择弹窗（命令面板用） ----------

class LevelPickerModal extends Modal {
	constructor(app, plugin, file) {
		super(app);
		this.plugin = plugin;
		this.file = file;
	}

	onOpen() {
		this.titleEl.setText('标记复习等级 · ' + this.file.basename);
		const { contentEl } = this;
		contentEl.empty();

		const mark = this.plugin.getMark(this.file.path);
		const current = mark && mark.level ? mark.level : null;

		for (const lv of this.plugin.settings.levels || []) {
			const row = contentEl.createDiv({ cls: 'mrt-level-row' });
			const dot = row.createSpan({ cls: 'mrt-dot' });
			dot.style.background = lv.color;
			row.createSpan({ text: lv.name });
			if (current === lv.id) row.createSpan({ cls: 'mrt-check', text: '✓ 当前' });
			row.onclick = () => {
				this.plugin.setFileLevel(this.file.path, lv.id);
				this.close();
			};
		}

		const clearRow = contentEl.createDiv({ cls: 'mrt-level-row mrt-clear-row' });
		clearRow.createSpan({ text: '清除标记' });
		clearRow.onclick = () => {
			this.plugin.setFileLevel(this.file.path, null);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------- 设置页 ----------

class TrackerSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
		this._confirming = '';
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Reading Tracker · 设置' });

		new Setting(containerEl)
			.setName('模块聚合层级')
			.setDesc('按第几级文件夹聚合模块。1 = 顶层目录（如 技术/、心理学/），2 = 二级目录（如 技术/算法/）')
			.addText((t) => {
				t.setPlaceholder('1');
				t.setValue(String(this.plugin.settings.folderDepth));
				t.inputEl.style.width = '60px';
				t.onChange((v) => {
					const n = parseInt(v, 10);
					this.plugin.settings.folderDepth = isNaN(n) || n < 1 ? 1 : Math.min(n, 6);
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('忽略的文件夹')
			.setDesc('不参与统计的文件夹路径，每行一个，例如：模板 或 归档/旧笔记')
			.addTextArea((t) => {
				t.setPlaceholder('每行一个文件夹路径');
				t.setValue((this.plugin.settings.ignoreFolders || []).join('\n'));
				t.inputEl.rows = 4;
				t.inputEl.style.minWidth = '260px';
				t.onChange((v) => {
					this.plugin.settings.ignoreFolders = v
						.split('\n')
						.map((s) => s.trim())
						.filter((s) => s.length > 0);
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('显示未浏览项')
			.setDesc('列表中同时展示浏览次数为 0 的模块/文件')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.showUnopened);
				t.onChange((v) => {
					this.plugin.settings.showUnopened = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('默认打开文件视图')
			.setDesc('关闭时默认展示"模块"聚合视图，开启时默认展示"文件"明细视图')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.defaultFileMode);
				t.onChange((v) => {
					this.plugin.settings.defaultFileMode = v;
					this.plugin.saveSettingsNow();
				});
			});

		// ---- 复习等级管理 ----
		containerEl.createEl('h3', { text: '复习等级（颜色标记）' });
		containerEl.createEl('p', {
			text: '在文件列表、文件右键菜单中标记文件的等级，用于复习优先级管理。等级名称、颜色均可自定义，删除等级会同时清除文件上的对应标记。',
			cls: 'setting-item-description'
		});

		const levels = this.plugin.settings.levels;
		levels.forEach((lv, i) => {
			new Setting(containerEl)
				.addColorPicker((c) => {
					c.setValue(lv.color);
					c.onChange((v) => {
						lv.color = v;
						this.plugin.saveSettingsNow();
					});
				})
				.addText((t) => {
					t.setValue(lv.name);
					t.onChange((v) => {
						lv.name = v.trim() || lv.name;
						this.plugin.saveSettingsNow();
					});
				})
				.addButton((b) => {
					b.setIcon('trash');
					b.setTooltip('删除该等级');
					b.onClick(() => {
						levels.splice(i, 1);
						// 清除使用了该等级的文件标记
						for (const [path, mark] of Object.entries(this.plugin.data.marks)) {
							if (mark.level === lv.id) mark.level = null;
							this.plugin.pruneMark(path);
						}
						this.plugin.saveSettingsNow();
						this.display();
					});
				});
		});

		new Setting(containerEl).addButton((b) => {
			b.setButtonText('添加等级');
			b.onClick(() => {
				const palette = ['#e93147', '#ec7500', '#086ddd', '#00a67d', '#7852ee', '#d53984'];
				levels.push({
					id: 'lv' + Date.now().toString(36),
					name: '新等级',
					color: palette[levels.length % palette.length]
				});
				this.plugin.saveSettingsNow();
				this.display();
			});
		});

		// ---- 每日复习目标 ----
		containerEl.createEl('h3', { text: '每日复习目标' });
		containerEl.createEl('p', {
			text: '每天自动生成一组待复习文件，优先抽取等级靠前、更久未浏览的文件；完成时可自动记录学习节点。',
			cls: 'setting-item-description'
		});

		new Setting(containerEl)
			.setName('启用每日复习目标')
			.setDesc('关闭后隐藏"每日复习"页签与相关命令')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.dailyEnabled !== false);
				t.onChange((v) => {
					this.plugin.settings.dailyEnabled = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('每日文件数量')
			.setDesc('每天随机抽取的文件数（1-30）')
			.addText((t) => {
				t.setValue(String(this.plugin.settings.dailyCount));
				t.inputEl.style.width = '60px';
				t.onChange((v) => {
					const n = parseInt(v, 10);
					if (!isNaN(n)) {
						this.plugin.settings.dailyCount = Math.max(1, Math.min(30, n));
						this.plugin.saveSettingsNow();
					}
				});
			});

		new Setting(containerEl)
			.setName('抽取范围')
			.setDesc('从全部文件中抽取，或仅从已标记复习等级的文件中抽取')
			.addDropdown((d) => {
				d.addOption('all', '全部文件');
				d.addOption('marked', '仅已标记等级的文件');
				d.setValue(this.plugin.settings.dailyScope);
				d.onChange((v) => {
					this.plugin.settings.dailyScope = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('等级优先')
			.setDesc('优先抽取等级靠前（如"紧急复习"）的文件')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.dailyLevelFirst !== false);
				t.onChange((v) => {
					this.plugin.settings.dailyLevelFirst = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('更久未复习优先')
			.setDesc('优先抽取最近浏览时间更早（更久没看）的文件')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.dailyPreferStale !== false);
				t.onChange((v) => {
					this.plugin.settings.dailyPreferStale = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('完成时记录学习节点')
			.setDesc('勾选完成某文件复习时，自动追加一条"完成每日复习"学习节点')
			.addToggle((t) => {
				t.setValue(this.plugin.settings.dailyLogNode !== false);
				t.onChange((v) => {
					this.plugin.settings.dailyLogNode = v;
					this.plugin.saveSettingsNow();
				});
			});

		new Setting(containerEl)
			.setName('打开面板时进入复习页签')
			.setDesc('开启后，打开 Reading Tracker 面板时默认显示"每日复习"')
			.addToggle((t) => {
				t.setValue(!!this.plugin.settings.dailyAutoOpen);
				t.onChange((v) => {
					this.plugin.settings.dailyAutoOpen = v;
					this.plugin.saveSettingsNow();
				});
			});

		// ---- 危险操作 ----
		containerEl.createEl('h3', { text: '数据管理' });

		new Setting(containerEl)
			.setName('清空浏览统计')
			.setDesc('删除全部浏览次数与最近浏览记录（不影响等级标记与学习节点），操作不可恢复')
			.addButton((btn) => {
				btn.setButtonText('清空').setWarning();
				btn.onClick(() => {
					if (this._confirming !== 'stats') {
						this._confirming = 'stats';
						btn.setButtonText('再次点击确认清空');
						window.setTimeout(() => {
							this._confirming = '';
							btn.setButtonText('清空');
						}, 3000);
					} else {
						this.plugin.data.records = {};
						this.plugin.lastRecordedPath = null;
						this.plugin.saveSettingsNow();
						new Notice('浏览统计数据已清空');
						this._confirming = '';
						btn.setButtonText('清空');
					}
				});
			});

		new Setting(containerEl)
			.setName('清空等级标记与学习节点')
			.setDesc('删除全部文件的颜色等级标记和学习节点记录（不影响浏览统计），操作不可恢复')
			.addButton((btn) => {
				btn.setButtonText('清空').setWarning();
				btn.onClick(() => {
					if (this._confirming !== 'marks') {
						this._confirming = 'marks';
						btn.setButtonText('再次点击确认清空');
						window.setTimeout(() => {
							this._confirming = '';
							btn.setButtonText('清空');
						}, 3000);
					} else {
						this.plugin.data.marks = {};
						this.plugin.saveSettingsNow();
						new Notice('等级标记与学习节点已清空');
						this._confirming = '';
						btn.setButtonText('清空');
					}
				});
			});
	}
}

module.exports = ReadingTrackerPlugin;
