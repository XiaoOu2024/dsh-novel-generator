/**
 * dsh-novel-studio — Client half.
 *
 * A frame-wide studio owned by two slots: a launcher at the sidebar foot and a
 * full-window overlay. The overlay holds the project list, the draggable
 * timeline with the world snapshot it selects, the chapter story and the
 * chapter outline, which slide horizontally past one another.
 */
window.__ModuleLoader__.load({
  id: 'dsh-novel-studio',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const API = '/dsh-novel-studio/api';
    const DAY_MS = 24 * 60 * 60 * 1000;
    const UNIT_CHOICES = [30, 90, 365];
    const DEFAULT_SYNOPSIS_MIN = 100;

    /* ------------------------------------------------------- shared state */

    const openState = { open: false };
    const openListeners = new Set();
    function setOverlayOpen(next) {
      openState.open = next;
      for (const listener of openListeners) listener(next);
    }
    function useOverlayOpen() {
      const [open, setOpen] = useState(openState.open);
      useEffect(() => {
        const listener = (value) => setOpen(value);
        openListeners.add(listener);
        return () => openListeners.delete(listener);
      }, []);
      return open;
    }

    /* -------------------------------------------------------------- helper */

    async function api(path, body) {
      const init = body === undefined
        ? { cache: 'no-store' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        };
      const response = await fetch(API + path, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || (payload && payload.error)) {
        throw new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`);
      }
      return payload;
    }

    function dateForDay(detail, day) {
      const origin = detail && detail.timeline && /^\d{4}-\d{2}-\d{2}$/.test(detail.timeline.origin)
        ? detail.timeline.origin
        : '2026-01-01';
      const base = Date.parse(`${origin}T00:00:00Z`);
      return new Date(base + Math.round(day) * DAY_MS).toISOString().slice(0, 10);
    }

    function chapterWindow(detail, chapter) {
      const start = Number(chapter.startDay) || 0;
      const duration = Math.max(1, Number(chapter.durationDays) || detail.timeline.unitDays || 30);
      return { start, end: start + duration };
    }

    function snapshotAt(detail, day) {
      const snapshots = (detail.snapshots || []).filter((snapshot) => snapshot.day <= day);
      return snapshots.length ? snapshots[snapshots.length - 1] : null;
    }

    function countWords(text) {
      return String(text || '').replace(/\s+/gu, '').length;
    }

    function formatTime(ms) {
      if (!ms) return '';
      const date = new Date(ms);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /* -------------------------------------------------------------- styles */

    const CSS = `
.dsn-launch{display:flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer}
.dsn-launch:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.dsn-launch svg{width:14px;height:14px;display:block}
.dsn-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.3);pointer-events:auto;padding:24px}
.dsn-shell{position:relative;width:min(1240px,100%);height:min(860px,100%);display:flex;flex-direction:column;
  overflow:hidden;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.3)}
.dsn-topbar{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1)}
.dsn-title{font-size:14px;font-weight:600}
.dsn-sub{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsn-spacer{flex:1}
.dsn-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsn-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}
.dsn-btn:disabled{opacity:.45;cursor:not-allowed}
.dsn-btn.primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsn-btn.ghost{background:transparent}
.dsn-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dsn-body{flex:1;display:flex;min-height:0;background:var(--dsw-alias-bg-base)}
.dsn-error{margin:12px 16px;padding:10px 12px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsn-note{margin:0;padding:8px 12px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dsn-empty{padding:32px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsn-toast{position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:5;
  padding:8px 16px;border-radius:999px;font-size:12px;color:#fff;background:var(--dsw-alias-state-success-primary)}
.dsn-toast.error{background:var(--dsw-alias-state-error-primary)}
.dsn-scroll{flex:1;overflow:auto;min-height:0;display:flex}

/* projects */
.dsn-projects{padding:16px;display:flex;flex-direction:column;gap:14px;width:100%}
.dsn-create{display:grid;grid-template-columns:1.1fr 1.7fr 1fr 1fr 0.9fr auto;gap:10px;align-items:end;
  padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
.dsn-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dsn-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsn-input,.dsn-select,.dsn-textarea{width:100%;box-sizing:border-box;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:7px 10px;outline:none}
.dsn-input:focus,.dsn-select:focus,.dsn-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dsn-path{display:flex;gap:6px}
.dsn-list{display:flex;flex-direction:column;gap:8px}
.dsn-row{display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:12px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);cursor:pointer}
.dsn-row:hover{border-color:var(--dsw-alias-brand-primary)}
.dsn-row-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsn-row-name{font-size:13px;font-weight:600}
.dsn-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* workspace track */
.dsn-stage{flex:1;position:relative;overflow:hidden;min-width:0}
.dsn-track{display:flex;height:100%;transition:transform .28s ease}
.dsn-page{width:100%;height:100%;flex:0 0 100%;display:flex;flex-direction:column;min-width:0}
.dsn-pagehead{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsn-pagehead .dsn-title{font-size:13px}

/* timeline */
.dsn-timeline{padding:12px 16px 4px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsn-timeline-head{display:flex;align-items:center;gap:10px;margin-bottom:6px}
.dsn-date{font-size:16px;font-weight:600;letter-spacing:.02em}
.dsn-units{display:flex;gap:6px}
.dsn-unit{height:24px;padding:0 10px;border-radius:999px;font:inherit;font-size:11px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary)}
.dsn-unit.on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsn-range{width:100%;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:2px 0 0}
.dsn-ticks{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-secondary);padding:0 2px}
.dsn-chips{display:flex;gap:6px;overflow-x:auto;padding:8px 0 4px}
.dsn-chip{flex:0 0 auto;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  height:24px;padding:0 10px;border-radius:999px;font:inherit;font-size:11px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dsn-chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dsn-chip.snap{background:transparent;border-style:dashed;cursor:default}
.dsn-grid{flex:1;overflow:auto;padding:14px 16px;display:grid;gap:12px;
  grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);align-content:start}
.dsn-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);
  padding:12px 14px;min-width:0}
.dsn-card h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}
.dsn-text{font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word}
.dsn-entries{display:flex;flex-direction:column;gap:6px}
.dsn-entry{display:flex;gap:8px;font-size:12px;line-height:1.6}
.dsn-entry b{font-weight:600;flex:0 0 auto}
.dsn-entry span{color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsn-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}

/* story + outline */
.dsn-editor{flex:1;display:flex;flex-direction:column;min-height:0;padding:14px 16px;gap:10px}
.dsn-story{flex:1;resize:none;min-height:0;line-height:1.9;font-size:13px}
.dsn-foot{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsn-form{flex:1;overflow:auto;padding:14px 16px;display:grid;gap:12px;
  grid-template-columns:repeat(4,minmax(0,1fr));align-content:start}
.dsn-form .span2{grid-column:span 2}
.dsn-form .span4{grid-column:span 4}
.dsn-synopsis{min-height:220px;resize:vertical;line-height:1.8;font-size:13px}
.dsn-hint{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsn-hint.warn{color:var(--dsw-alias-state-warn-primary)}
.dsn-progress{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.dsn-spin{width:12px;height:12px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);
  border-top-color:var(--dsw-alias-brand-primary);animation:dsn-spin .9s linear infinite}
@keyframes dsn-spin{to{transform:rotate(360deg)}}
`;

    function StyleSheet() {
      return h('style', null, CSS);
    }

    /* ------------------------------------------------------------- launcher */

    function Launcher(props) {
      const wide = !props || props.wide !== false;
      return h('button', {
        type: 'button',
        className: 'dsn-launch',
        title: '小说工坊',
        onClick: () => setOverlayOpen(true),
      },
      h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z' })),
      wide ? h('span', null, '小说工坊') : null);
    }

    /* --------------------------------------------------------------- toast */

    function useToast() {
      const [toast, setToast] = useState(null);
      useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), 4200);
        return () => clearTimeout(timer);
      }, [toast]);
      return [toast, setToast];
    }

    function Toast({ value }) {
      if (!value) return null;
      return h('div', { className: `dsn-toast${value.kind === 'error' ? ' error' : ''}` }, value.text);
    }

    /* ------------------------------------------------------------ job poll */

    function useJob() {
      const [job, setJob] = useState(null);
      const jobId = job ? job.jobId : null;
      const state = job ? job.state : null;
      useEffect(() => {
        if (!jobId || state !== 'running') return undefined;
        let cancelled = false;
        const timer = setInterval(async () => {
          try {
            const next = await api(`/job?id=${encodeURIComponent(jobId)}`);
            if (!cancelled) setJob((current) => ({ ...current, ...next }));
          } catch (error) {
            if (!cancelled) setJob((current) => ({ ...current, state: 'error', error: messageOf(error) }));
          }
        }, 2000);
        return () => {
          cancelled = true;
          clearInterval(timer);
        };
      }, [jobId, state]);
      return [job, setJob];
    }

    /* -------------------------------------------------------- projects page */

    function ProjectsPage({ boot, workspace, onOpen, onReload }) {
      const [title, setTitle] = useState('');
      const [cwd, setCwd] = useState('');
      const [preset, setPreset] = useState('');
      const [provider, setProvider] = useState(
        boot.models && boot.models.default ? boot.models.default.provider : '',
      );
      const [model, setModel] = useState(boot.models && boot.models.default ? boot.models.default.model : '');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      const groups = (boot.models && boot.models.groups) || [];
      const models = useMemo(() => {
        const group = groups.find((entry) => entry.id === provider);
        return group ? group.models : [];
      }, [groups, provider]);

      useEffect(() => {
        if (models.length && !models.some((entry) => entry.id === model)) setModel(models[0].id);
      }, [models]);

      const pickDirectory = useCallback(async () => {
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setError('当前界面无法调用目录选择器，请手动填写工作目录的绝对路径');
          return;
        }
        try {
          const picked = await workspace.pickDirectory();
          if (picked) setCwd(picked);
        } catch (pickError) {
          setError(messageOf(pickError));
        }
      }, [workspace]);

      const create = useCallback(async () => {
        setError('');
        if (!cwd.trim()) {
          setError('请选择或填写工作目录');
          return;
        }
        setBusy(true);
        try {
          const result = await api('/project/create', {
            title: title.trim() || '未命名作品',
            cwd: cwd.trim(),
            agentPreset: preset || undefined,
            model: provider && model ? { provider, model } : null,
          });
          if (result.warning) setError(result.warning);
          await onReload();
          onOpen(result.project.projectId);
        } catch (createError) {
          setError(messageOf(createError));
        } finally {
          setBusy(false);
        }
      }, [title, cwd, preset, provider, model, onOpen, onReload]);

      const remove = useCallback(async (project) => {
        if (!window.confirm(`确定删除作品「${project.title}」？章节与快照会一并删除，作品的会话本身保留。`)) return;
        try {
          await api('/project/delete', { projectId: project.projectId });
          await onReload();
        } catch (removeError) {
          setError(messageOf(removeError));
        }
      }, [onReload]);

      return h('div', { className: 'dsn-projects' },
        h('div', { className: 'dsn-create' },
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '作品名称'),
            h('input', {
              className: 'dsn-input',
              value: title,
              placeholder: '例如：长夜将尽',
              onChange: (event) => setTitle(event.target.value),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '工作目录'),
            h('div', { className: 'dsn-path' },
              h('input', {
                className: 'dsn-input',
                value: cwd,
                placeholder: '会话的工作目录（绝对路径）',
                onChange: (event) => setCwd(event.target.value),
              }),
              h('button', { className: 'dsn-btn ghost', type: 'button', onClick: pickDirectory }, '选择'))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '模型'),
            h('select', {
              className: 'dsn-select',
              value: provider,
              onChange: (event) => setProvider(event.target.value),
            }, groups.length === 0
              ? h('option', { value: '' }, '未发现可用模型')
              : groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '模型实例'),
            h('select', {
              className: 'dsn-select',
              value: model,
              onChange: (event) => setModel(event.target.value),
            }, models.length === 0
              ? h('option', { value: '' }, '—')
              : models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '预设'),
            h('select', {
              className: 'dsn-select',
              value: preset,
              onChange: (event) => setPreset(event.target.value),
            },
            h('option', { value: '' }, '默认预设'),
            boot.presets.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
          h('div', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, ' '),
            h('button', {
              className: 'dsn-btn primary',
              type: 'button',
              disabled: busy,
              onClick: create,
            }, busy ? '创建中…' : '创建作品并开会话'))),

        error ? h('div', { className: 'dsn-error', style: { margin: 0 } }, error) : null,

        h('div', { className: 'dsn-list' },
          boot.projects.length === 0
            ? h('div', { className: 'dsn-empty' }, '还没有作品。填好名称、工作目录和模型后创建一部，界面会自动为它开一个会话。')
            : boot.projects.map((project) => h('div', {
              key: project.projectId,
              className: 'dsn-row',
              onClick: () => onOpen(project.projectId),
            },
            h('div', { className: 'dsn-row-main', style: { flex: 1 } },
              h('div', { className: 'dsn-row-name' }, project.title),
              h('div', { className: 'dsn-row-meta' },
                `${project.chapterCount} 章 · ${project.snapshotCount} 个快照 · ${project.cwd}`),
              h('div', { className: 'dsn-row-meta' },
                `更新于 ${formatTime(project.updatedAt)}${project.lastChapterTitle ? ` · 最近：${project.lastChapterTitle}` : ''}`)),
            h('button', {
              className: 'dsn-btn danger ghost',
              type: 'button',
              onClick: (event) => {
                event.stopPropagation();
                remove(project);
              },
            }, '删除')))));
    }

    /* -------------------------------------------------------------- timeline */

    function Timeline({ detail, unitDays, cursor, onChange, onOpenChapter }) {
      const chapters = detail.chapters || [];
      const snapshots = detail.snapshots || [];
      const maxDay = chapters.reduce((max, chapter) => Math.max(max, chapterWindow(detail, chapter).end), unitDays);
      const maxTick = Math.max(12, Math.ceil(maxDay / unitDays) + 2);
      const ticks = [];
      const stride = Math.max(1, Math.round(maxTick / 6));
      for (let tick = 0; tick <= maxTick; tick += stride) ticks.push(tick);

      return h('div', { className: 'dsn-timeline' },
        h('div', { className: 'dsn-timeline-head' },
          h('div', { className: 'dsn-date' }, dateForDay(detail, cursor * unitDays)),
          h('div', { className: 'dsn-sub' }, `第 ${cursor} 格 · 每格 ${unitDays} 天`),
          h('div', { className: 'dsn-spacer' }),
          h('div', { className: 'dsn-units' }, UNIT_CHOICES.map((unit) => h('button', {
            key: unit,
            type: 'button',
            className: `dsn-unit${unit === unitDays ? ' on' : ''}`,
            onClick: () => onChange(unit, cursor),
          }, `${unit} 天`)))),
        h('input', {
          className: 'dsn-range',
          type: 'range',
          min: 0,
          max: maxTick,
          step: 1,
          value: cursor,
          onChange: (event) => onChange(unitDays, Number(event.target.value)),
        }),
        h('div', { className: 'dsn-ticks' }, ticks.map((tick) => h('span', { key: tick }, dateForDay(detail, tick * unitDays)))),
        (chapters.length || snapshots.length)
          ? h('div', { className: 'dsn-chips' },
            snapshots.map((snapshot) => h('span', {
              key: `snap-${snapshot.snapshotId}`,
              className: 'dsn-chip snap',
              title: snapshot.summary || '世界快照',
            }, `快照 · ${dateForDay(detail, snapshot.day)}`)),
            chapters.map((chapter) => h('button', {
              key: chapter.chapterId,
              type: 'button',
              className: 'dsn-chip',
              onClick: () => onOpenChapter(chapter.chapterId),
            }, `${chapter.index + 1}. ${chapter.title || '未命名'} · ${dateForDay(detail, chapterWindow(detail, chapter).start)}`)))
          : null);
    }

    /* ------------------------------------------------------------ world page */

    function WorldPage({ detail, onTimeline, onEnterStory, onNewChapter, onOpenChapter, onRefreshSnapshot, snapshotBusy }) {
      const initialUnit = detail.timeline.unitDays || 30;
      const [unitDays, setUnitDays] = useState(initialUnit);
      const [cursor, setCursor] = useState(detail.timeline.cursor || 0);
      const commitTimer = useRef(null);

      useEffect(() => {
        setUnitDays(detail.timeline.unitDays || 30);
        setCursor(detail.timeline.cursor || 0);
      }, [detail.projectId, detail.timeline.unitDays, detail.timeline.cursor]);

      useEffect(() => () => {
        if (commitTimer.current) clearTimeout(commitTimer.current);
      }, []);

      const change = useCallback((nextUnit, nextCursor) => {
        setUnitDays(nextUnit);
        setCursor(nextCursor);
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => onTimeline(nextUnit, nextCursor), 400);
      }, [onTimeline]);

      const cursorDay = cursor * unitDays;
      const snapshot = snapshotAt(detail, cursorDay);
      const chapters = detail.chapters || [];
      const nearest = useMemo(() => {
        if (chapters.length === 0) return null;
        let best = chapters[0];
        let bestDistance = Infinity;
        for (const chapter of chapters) {
          const distance = Math.abs(chapterWindow(detail, chapter).start - cursorDay);
          if (distance < bestDistance) {
            best = chapter;
            bestDistance = distance;
          }
        }
        return best;
      }, [chapters, cursorDay]);

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('div', { className: 'dsn-title' }, detail.title),
          h('div', { className: 'dsn-sub' }, detail.cwd),
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: () => onNewChapter(cursorDay) }, '新建章节'),
          h('button', {
            className: 'dsn-btn ghost',
            type: 'button',
            disabled: snapshotBusy,
            onClick: () => onRefreshSnapshot(cursorDay),
            title: '阅读自上一版快照以来的章节，更新世界观、角色、势力与关系',
          }, snapshotBusy ? '快照更新中…' : '同步世界快照'),
          h('button', { className: 'dsn-btn primary', type: 'button', onClick: () => onEnterStory(cursorDay) },
            nearest ? `进入故事 · 第 ${nearest.index + 1} 章` : '进入故事')),
        h(Timeline, { detail, unitDays, cursor, onChange: change, onOpenChapter }),
        h('div', { className: 'dsn-grid' },
          h('div', { className: 'dsn-card', style: { gridColumn: 'span 2' } },
            h('h4', null, '世界观'),
            snapshot && snapshot.world
              ? h('div', { className: 'dsn-text' }, snapshot.world)
              : h('div', { className: 'dsn-muted' }, '该时间点还没有世界快照。世界快照会在章节生成后按时间线阈值自动写入。')),
          h('div', { className: 'dsn-card' },
            h('h4', null, '角色列表'),
            snapshot && snapshot.characters.length
              ? h('div', { className: 'dsn-entries' }, snapshot.characters.map((character, index) => h('div', {
                key: `${character.name}-${index}`,
                className: 'dsn-entry',
              }, h('b', null, character.name), h('span', null, character.desc))))
              : h('div', { className: 'dsn-muted' }, '暂无')),
          h('div', { className: 'dsn-card' },
            h('h4', null, '势力列表'),
            snapshot && snapshot.factions.length
              ? h('div', { className: 'dsn-entries' }, snapshot.factions.map((faction, index) => h('div', {
                key: `${faction.name}-${index}`,
                className: 'dsn-entry',
              }, h('b', null, faction.name), h('span', null, faction.desc))))
              : h('div', { className: 'dsn-muted' }, '暂无')),
          h('div', { className: 'dsn-card' },
            h('h4', null, '关系'),
            snapshot && snapshot.relations.length
              ? h('div', { className: 'dsn-entries' }, snapshot.relations.map((relation, index) => h('div', {
                key: index,
                className: 'dsn-entry',
              }, h('span', null, relation))))
              : h('div', { className: 'dsn-muted' }, '暂无'))));
    }

    /* ------------------------------------------------------------ story page */

    function StoryPage({ detail, chapter, onBack, onOutline, onSaved }) {
      const [text, setText] = useState(chapter ? chapter.content || '' : '');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const chapterId = chapter ? chapter.chapterId : null;

      useEffect(() => {
        setText(chapter ? chapter.content || '' : '');
        setMessage('');
      }, [chapterId]);

      const save = useCallback(async () => {
        if (!chapter) return;
        setBusy(true);
        setMessage('');
        try {
          await api('/chapter/save', { projectId: detail.projectId, chapterId: chapter.chapterId, content: text });
          setMessage('已保存');
          await onSaved();
        } catch (error) {
          setMessage(messageOf(error));
        } finally {
          setBusy(false);
        }
      }, [chapter, detail.projectId, text, onSaved]);

      const words = countWords(text);
      const window = chapter ? chapterWindow(detail, chapter) : null;

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, '← 时间长河'),
          h('div', { className: 'dsn-title' }, chapter ? `第 ${chapter.index + 1} 章 · ${chapter.title || '未命名'}` : '章节故事'),
          h('div', { className: 'dsn-sub' }, window ? `${dateForDay(detail, window.start)} → ${dateForDay(detail, window.end)}` : ''),
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn', type: 'button', onClick: onOutline }, '章节大纲 →')),
        !chapter
          ? h('div', { className: 'dsn-empty' }, '还没有章节。回到时间长河新建一章，或是从章节大纲开始。')
          : h(React.Fragment, null,
            h('div', { className: 'dsn-editor' },
              !chapter.outline ? h('div', { className: 'dsn-note' }, '这一章还没有保存过章节大纲，可以先回章节大纲里填写并生成。') : null,
              h('textarea', {
                className: 'dsn-textarea dsn-story',
                value: text,
                placeholder: '章节正文：生成后可以直接在这里修改，改完点保存。',
                onChange: (event) => setText(event.target.value),
              })),
            h('div', { className: 'dsn-foot' },
              h('div', { className: 'dsn-muted' },
                `${words} 字${chapter.outline ? ` · 大纲要求 ${chapter.outline.minWords}–${chapter.outline.maxWords} 字` : ''}`),
              h('div', { className: 'dsn-spacer' }),
              message ? h('div', { className: 'dsn-hint' }, message) : null,
              h('button', { className: 'dsn-btn primary', type: 'button', disabled: busy, onClick: save },
                busy ? '保存中…' : '保存'))));
    }

    /* ---------------------------------------------------------- outline page */

    function OutlinePage({ detail, chapter, onBack, onSaved, notify }) {
      const buildForm = useCallback(() => ({
        title: chapter ? chapter.title || '' : '',
        durationDays: chapter && chapter.outline ? chapter.outline.durationDays : (detail.timeline.unitDays || 30),
        minWords: chapter && chapter.outline ? chapter.outline.minWords : 1200,
        maxWords: chapter && chapter.outline ? chapter.outline.maxWords : 3500,
        synopsisMinChars: chapter && chapter.outline ? chapter.outline.synopsisMinChars : DEFAULT_SYNOPSIS_MIN,
        synopsis: chapter && chapter.outline ? chapter.outline.synopsis : '',
      }), [chapter, detail.timeline.unitDays]);

      const [form, setForm] = useState(buildForm);
      const [savedAt, setSavedAt] = useState(chapter && chapter.outline ? chapter.outline.savedAt : 0);
      const [saving, setSaving] = useState(false);
      const [message, setMessage] = useState('');
      const [job, setJob] = useJob();
      const chapterId = chapter ? chapter.chapterId : null;

      useEffect(() => {
        setForm(buildForm());
        setSavedAt(chapter && chapter.outline ? chapter.outline.savedAt : 0);
        setMessage('');
        setJob(null);
      }, [chapterId]);

      const synopsisLength = form.synopsis.trim().length;
      const complete = form.durationDays >= 1
        && form.minWords >= 1
        && form.maxWords >= form.minWords
        && synopsisLength >= form.synopsisMinChars;

      const patch = useCallback((field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
        setSavedAt(0);
      }, []);

      const save = useCallback(async () => {
        setSaving(true);
        setMessage('');
        try {
          const result = await api('/outline/save', {
            projectId: detail.projectId,
            chapterId: chapter ? chapter.chapterId : '',
            title: form.title,
            outline: {
              durationDays: Number(form.durationDays),
              minWords: Number(form.minWords),
              maxWords: Number(form.maxWords),
              synopsisMinChars: Number(form.synopsisMinChars),
              synopsis: form.synopsis,
            },
          });
          setSavedAt(Date.now());
          setMessage('大纲已保存，可以生成章节故事了');
          await onSaved(result.chapter.chapterId);
        } catch (error) {
          setMessage(messageOf(error));
        } finally {
          setSaving(false);
        }
      }, [detail.projectId, chapter, form, onSaved]);

      const startJob = useCallback(async (path) => {
        setMessage('');
        try {
          const started = await api(path, {
            projectId: detail.projectId,
            chapterId: chapter ? chapter.chapterId : '',
          });
          setJob(started);
        } catch (error) {
          setMessage(messageOf(error));
        }
      }, [detail.projectId, chapter, setJob]);

      const generating = job && job.state === 'running' && job.kind === 'generate';
      const deducing = job && job.state === 'running' && job.kind === 'deduce';

      useEffect(() => {
        if (!job) return;
        if (job.kind === 'deduce' && job.state === 'done' && job.result) {
          setForm((current) => ({
            ...current,
            synopsis: job.result.synopsis || current.synopsis,
            durationDays: job.result.durationDays || current.durationDays,
            minWords: job.result.minWords || current.minWords,
            maxWords: job.result.maxWords || current.maxWords,
            title: current.title || job.result.title || '',
          }));
          setSavedAt(0);
          setMessage('自动推演完成，检查后记得保存');
        }
        if (job.kind === 'generate' && job.state === 'done') {
          setMessage('章节生成成功');
          notify('章节生成成功', 'success');
          onSaved(chapter ? chapter.chapterId : null);
        }
        if (job.state === 'error') {
          setMessage(job.error || '任务失败');
          notify(job.error || '任务失败', 'error');
        }
      }, [job ? job.jobId : null, job ? job.state : null]);

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, '← 章节故事'),
          h('div', { className: 'dsn-title' }, chapter ? `章节大纲 · 第 ${chapter.index + 1} 章` : '章节大纲 · 新章节'),
          h('div', { className: 'dsn-sub' }, `起始 ${dateForDay(detail, chapter ? chapterWindow(detail, chapter).start : (detail.timeline.cursor || 0) * (detail.timeline.unitDays || 30))}`),
          h('div', { className: 'dsn-spacer' }),
          h('button', {
            className: 'dsn-btn ghost',
            type: 'button',
            disabled: Boolean(deducing || generating),
            onClick: () => startJob('/deduce'),
          }, deducing ? '推演中…' : '自动推演')),
        h('div', { className: 'dsn-form' },
          h('label', { className: 'dsn-field span2' },
            h('span', { className: 'dsn-label' }, '章节标题'),
            h('input', {
              className: 'dsn-input',
              value: form.title,
              placeholder: '例如：雨夜来客',
              onChange: (event) => patch('title', event.target.value),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '故事时间长度（天）'),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.durationDays,
              onChange: (event) => patch('durationDays', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '章节最低字数'),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.minWords,
              onChange: (event) => patch('minWords', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '章节最多字数'),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.maxWords,
              onChange: (event) => patch('maxWords', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, '梗概最低字数'),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.synopsisMinChars,
              onChange: (event) => patch('synopsisMinChars', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field span4' },
            h('span', { className: 'dsn-label' }, `故事梗概（已写 ${synopsisLength} / 至少 ${form.synopsisMinChars} 字）`),
            h('textarea', {
              className: 'dsn-textarea dsn-synopsis',
              value: form.synopsis,
              placeholder: '这一章要发生什么：起因、经过、转折、结果。',
              onChange: (event) => patch('synopsis', event.target.value),
            }))),
        h('div', { className: 'dsn-foot' },
          h('div', { className: `dsn-hint${complete ? '' : ' warn'}` },
            message || (complete ? '设定完整，可以保存' : '梗概达到最低字数并填完其他项后可以保存')),
          generating ? h('div', { className: 'dsn-progress' }, h('span', { className: 'dsn-spin' }), '正在生成章节故事…') : null,
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn', type: 'button', disabled: !complete || saving, onClick: save },
            saving ? '保存中…' : '保存'),
          h('button', {
            className: 'dsn-btn primary',
            type: 'button',
            disabled: !savedAt || Boolean(generating) || !chapter,
            onClick: () => startJob('/generate'),
          }, generating ? '生成中…' : '生成章节故事')));
    }

    /* ------------------------------------------------------------- workspace */

    function ProjectWorkspace({ detail, onReload, notify }) {
      const [view, setView] = useState('world');
      const [chapterId, setChapterId] = useState(null);
      const [snapshotBusy, setSnapshotBusy] = useState(false);
      const chapters = detail.chapters || [];
      const chapter = chapters.find((entry) => entry.chapterId === chapterId) || null;

      const openStory = useCallback((id) => {
        setChapterId(id);
        setView('story');
      }, []);

      const enterStory = useCallback((cursorDay) => {
        if (chapters.length === 0) {
          setChapterId(null);
          setView('outline');
          return;
        }
        let best = chapters[0];
        let bestDistance = Infinity;
        for (const entry of chapters) {
          const distance = Math.abs(chapterWindow(detail, entry).start - cursorDay);
          if (distance < bestDistance) {
            best = entry;
            bestDistance = distance;
          }
        }
        openStory(best.chapterId);
      }, [chapters, detail, openStory]);

      const newChapter = useCallback(async (cursorDay) => {
        try {
          const created = await api('/chapter/create', { projectId: detail.projectId, startDay: cursorDay });
          setChapterId(created.chapterId);
          setView('outline');
          await onReload();
        } catch (error) {
          notify(messageOf(error), 'error');
        }
      }, [detail.projectId, onReload, notify]);

      const saveTimeline = useCallback(async (unitDays, cursor) => {
        try {
          await api('/project/timeline', { projectId: detail.projectId, unitDays, cursor });
          await onReload();
        } catch (error) {
          notify(messageOf(error), 'error');
        }
      }, [detail.projectId, onReload, notify]);

      const refreshSnapshot = useCallback(async (cursorDay) => {
        setSnapshotBusy(true);
        try {
          const started = await api('/snapshot/refresh', { projectId: detail.projectId, day: cursorDay });
          notify('正在更新世界快照…', 'success');
          const timer = setInterval(async () => {
            try {
              const job = await api(`/job?id=${encodeURIComponent(started.jobId)}`);
              if (job.state === 'running') return;
              clearInterval(timer);
              setSnapshotBusy(false);
              if (job.state === 'done') {
                notify('世界快照已更新', 'success');
                await onReload();
              } else {
                notify(job.error || '世界快照更新失败', 'error');
              }
            } catch (error) {
              clearInterval(timer);
              setSnapshotBusy(false);
              notify(messageOf(error), 'error');
            }
          }, 2500);
        } catch (error) {
          setSnapshotBusy(false);
          notify(messageOf(error), 'error');
        }
      }, [detail.projectId, onReload, notify]);

      const trackIndex = view === 'world' ? 0 : view === 'story' ? 1 : 2;

      return h('div', { className: 'dsn-stage' },
        h('div', { className: 'dsn-track', style: { transform: `translateX(-${trackIndex * 100}%)` } },
          h('section', { className: 'dsn-page' },
            h(WorldPage, {
              detail,
              onTimeline: saveTimeline,
              onEnterStory: enterStory,
              onNewChapter: newChapter,
              onOpenChapter: openStory,
              onRefreshSnapshot: refreshSnapshot,
              snapshotBusy,
            })),
          h('section', { className: 'dsn-page' },
            h(StoryPage, {
              detail,
              chapter,
              onBack: () => setView('world'),
              onOutline: () => setView('outline'),
              onSaved: onReload,
            })),
          h('section', { className: 'dsn-page' },
            h(OutlinePage, {
              detail,
              chapter,
              onBack: () => setView(chapter ? 'story' : 'world'),
              onSaved: async (id) => {
                if (id) setChapterId(id);
                await onReload();
              },
              notify,
            }))));
    }

    /* ------------------------------------------------------------ studio app */

    function StudioApp({ workspace }) {
      const [boot, setBoot] = useState(null);
      const [error, setError] = useState('');
      const [projectId, setProjectId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [toast, setToast] = useToast();
      const close = useCallback(() => setOverlayOpen(false), []);

      const loadBoot = useCallback(async () => {
        try {
          setBoot(await api('/bootstrap'));
          setError('');
        } catch (loadError) {
          setError(messageOf(loadError));
        }
      }, []);

      useEffect(() => {
        loadBoot();
      }, [loadBoot]);

      const loadDetail = useCallback(async (id) => {
        try {
          const next = await api(`/project?projectId=${encodeURIComponent(id)}`);
          setDetail(next);
          setError('');
          return next;
        } catch (loadError) {
          setError(messageOf(loadError));
          return null;
        }
      }, []);

      const openProject = useCallback(async (id) => {
        setProjectId(id);
        await loadDetail(id);
      }, [loadDetail]);

      const reloadDetail = useCallback(async () => {
        if (!projectId) return;
        await loadDetail(projectId);
        await loadBoot();
      }, [projectId, loadDetail, loadBoot]);

      const notify = useCallback((text, kind) => setToast({ text, kind }), [setToast]);

      return h('div', { className: 'dsn-shell' },
        h(StyleSheet),
        h(Toast, { value: toast }),
        h('div', { className: 'dsn-topbar' },
          projectId
            ? h('button', {
              className: 'dsn-btn ghost',
              type: 'button',
              onClick: () => {
                setProjectId(null);
                setDetail(null);
                loadBoot();
              },
            }, '← 作品列表')
            : h('div', { className: 'dsn-title' }, '小说工坊'),
          projectId && detail ? h('div', { className: 'dsn-sub' }, detail.title) : null,
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: close }, '关闭')),
        error ? h('div', { className: 'dsn-error' }, error) : null,
        h('div', { className: 'dsn-body' },
          boot === null
            ? h('div', { className: 'dsn-empty', style: { margin: 'auto' } }, '正在载入…')
            : projectId === null
              ? h('div', { className: 'dsn-scroll' },
                h(ProjectsPage, { boot, workspace, onOpen: openProject, onReload: loadBoot }))
              : detail === null
                ? h('div', { className: 'dsn-empty', style: { margin: 'auto' } }, '正在载入作品…')
                : h(ProjectWorkspace, { detail, onReload: reloadDetail, notify })));
    }

    function StudioOverlay({ workspace }) {
      const open = useOverlayOpen();
      if (!open) return null;
      return h('div', {
        className: 'dsn-overlay',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget) setOverlayOpen(false);
        },
      }, h(StudioApp, { workspace }));
    }

    /* ---------------------------------------------------------------- apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        const uiWorkspace = ctx.get('uiWorkspace');
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-novel-studio-launch',
          order: 30,
        }, Launcher));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-novel-studio-studio',
          order: 40,
        }, () => h(StudioOverlay, { workspace: uiWorkspace })));
      },
    };
  },
});
