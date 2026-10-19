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
    const UNIT_CHOICES = [7, 15, 30, 90, 180, 365];
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
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 28%, transparent);
  background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;cursor:pointer}
.dsn-launch:hover{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, var(--dsw-alias-state-business-tertiary));
  border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}
.dsn-launch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsn-launch svg{width:14px;height:14px;display:block}
.dsn-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.3);pointer-events:auto;padding:24px}
.dsn-shell{position:relative;width:min(1240px,100%);height:min(860px,100%);display:flex;flex-direction:column;
  overflow:hidden;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.3);color-scheme:light}
body[data-ds-dark-theme] .dsn-shell{color-scheme:dark}
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
.dsn-btn.primary{background:var(--dsw-alias-label-primary);border-color:transparent;
  color:var(--dsw-alias-bg-layer-3);font-weight:500}
.dsn-btn.primary:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-label-primary) 88%, var(--dsw-alias-bg-layer-1))}
.dsn-btn.ghost{background:transparent}
.dsn-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dsn-body{flex:1;display:flex;min-height:0;background:var(--dsw-alias-bg-base)}
.dsn-error{margin:12px 16px;padding:10px 12px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsn-note{margin:0;padding:8px 12px;border-radius:10px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dsn-empty{padding:32px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.dsn-toast{position:absolute;top:58px;left:50%;transform:translateX(-50%);z-index:30;
  padding:8px 16px;border-radius:999px;font-size:12px;border-left:3px solid var(--dsw-alias-state-success-primary);
  color:var(--dsw-alias-toast-label);background:var(--dsw-alias-toast-bg);box-shadow:0 8px 24px rgba(0,0,0,.24)}
.dsn-toast.error{border-left-color:var(--dsw-alias-state-error-primary)}
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
.dsn-input.dsn-readonly{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:default}
.dsn-input.dsn-readonly:focus{border-color:var(--dsw-alias-border-l1)}
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
.dsn-units{display:flex;align-items:center;gap:6px}
.dsn-unit-input{width:78px;height:26px;padding:2px 8px;text-align:right;font-size:12px}
.dsn-range{width:100%;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;margin:2px 0 0}
.dsn-range:disabled{cursor:default;opacity:.5}
.dsn-trackwrap{position:relative;padding:2px 0 0}
.dsn-marks{position:relative;height:9px;margin:0 9px}
.dsn-mark{position:absolute;top:1px;width:6px;height:6px;margin-left:-3px;border-radius:50%;
  background:var(--dsw-alias-state-business-primary);opacity:.65}
.dsn-mark.next{background:transparent;border:1.5px dashed var(--dsw-alias-state-business-primary);opacity:.9;
  width:8px;height:8px;margin-left:-4px;top:0}
.dsn-ticks{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-secondary);padding:0 2px}
.dsn-chart-wrap{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);padding:8px 16px 10px}
.dsn-chart-head{display:flex;align-items:baseline;gap:10px;margin-bottom:2px}
.dsn-chart{display:block;width:100%;height:auto}
.dsn-chart .grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}
.dsn-chart .axis{fill:var(--dsw-alias-label-secondary);font-size:10px}
.dsn-chart .line{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:2;
  stroke-linejoin:round;stroke-linecap:round}
.dsn-chart .dot{fill:var(--dsw-alias-state-business-primary);stroke:var(--dsw-alias-bg-layer-1);stroke-width:1.5}
.dsn-chart .snap{stroke:var(--dsw-alias-state-warn-primary);stroke-width:1;stroke-dasharray:5 4}
.dsn-chart .span{stroke:var(--dsw-alias-state-business-primary);stroke-width:7;opacity:.22;stroke-linecap:round}
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

/* new-chapter dialog */
.dsn-dialog-backdrop{position:absolute;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;
  background:rgba(0,0,0,.32);pointer-events:auto}
.dsn-dialog{width:min(560px,calc(100% - 48px));display:flex;flex-direction:column;overflow:hidden;
  border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.32)}
.dsn-dialog-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsn-dialog-body{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px 16px}
.dsn-dialog-body .span2{grid-column:span 2}
.dsn-dialog-foot{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
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
          setError('当前界面无法调用目录选择器，这个部署暂时不能创建作品');
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
          setError('请先点「选择」挑一个工作目录');
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
                className: 'dsn-input dsn-readonly',
                value: cwd,
                readOnly: true,
                title: cwd || '只能通过右侧「选择」挑选目录',
                placeholder: '点右侧「选择」挑一个目录',
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

    /**
     * The timeline runs from day 0 to the newest world snapshot, plus however
     * far the story has been written past it — the next snapshot point lives in
     * that stretch, so the slider has to reach it.
     */
    function Timeline({ detail, unitDays, day, onChange }) {
      const [unitText, setUnitText] = useState(String(unitDays));
      useEffect(() => {
        setUnitText(String(unitDays));
      }, [unitDays]);
      const snapshots = detail.snapshots || [];
      const facts = detail.timelineFacts || {};
      const latest = facts.latestSnapshotDay !== undefined
        ? facts.latestSnapshotDay
        : (snapshots.length ? snapshots[snapshots.length - 1].day : 0);
      const storyEnd = facts.storyEnd !== undefined ? facts.storyEnd : latest;
      const nextDay = facts.nextSnapshotDay !== undefined ? facts.nextSnapshotDay : latest + unitDays;
      const max = Math.max(0, latest, storyEnd);
      const ticks = [];
      const stride = Math.max(1, Math.round(max / 6));
      for (let tick = 0; tick <= max; tick += stride) ticks.push(tick);
      if (max > 0 && ticks[ticks.length - 1] !== max) ticks.push(max);
      const marks = snapshots.map((snapshot) => snapshot.day);

      return h('div', { className: 'dsn-timeline' },
        h('div', { className: 'dsn-timeline-head' },
          h('div', { className: 'dsn-date' }, `第 ${day} 天`),
          h('div', { className: 'dsn-sub' },
            max === 0
              ? '还没有世界快照'
              : `共 ${max} 天 · 每 ${unitDays} 天一份快照 · 已写入 ${snapshots.length} 份${nextDay <= max ? ` · 下一快照点 第 ${nextDay} 天` : ''}`),
          h('div', { className: 'dsn-spacer' }),
          h('div', { className: 'dsn-units' },
            h('span', { className: 'dsn-label' }, '快照间隔'),
            h('input', {
              className: 'dsn-input dsn-unit-input',
              type: 'text',
              inputMode: 'numeric',
              list: 'dsn-unit-options',
              value: unitText,
              title: '每多少天结算一份世界快照，可从 7 / 15 / 30 / 90 / 180 / 365 里选，也可以直接输入',
              onChange: (event) => {
                // Typing only edits the text: committing per keystroke would
                // persist the intermediate values ("1", "18") as the setting.
                const text = event.target.value;
                setUnitText(text);
                const next = Number(text);
                // A value straight from the candidate list applies at once.
                if (UNIT_CHOICES.includes(next) && next !== unitDays) onChange(next, day);
              },
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const next = Number(unitText);
                if (Number.isInteger(next) && next >= 1) {
                  setUnitText(String(next));
                  if (next !== unitDays) onChange(next, day);
                } else {
                  setUnitText(String(unitDays));
                }
              },
              onBlur: () => {
                const next = Number(unitText);
                if (Number.isInteger(next) && next >= 1) {
                  setUnitText(String(next));
                  if (next !== unitDays) onChange(next, day);
                } else {
                  setUnitText(String(unitDays));
                }
              },
            }),
            h('span', { className: 'dsn-label' }, '天'),
            h('datalist', { id: 'dsn-unit-options' },
              UNIT_CHOICES.map((unit) => h('option', { key: unit, value: String(unit) }))))),
        h('div', { className: 'dsn-trackwrap' },
          h('input', {
            className: 'dsn-range',
            type: 'range',
            min: 0,
            max: max,
            step: 1,
            value: Math.min(day, max),
            disabled: max === 0,
            onChange: (event) => onChange(unitDays, Number(event.target.value)),
          }),
          max > 0
            ? h('div', { className: 'dsn-marks' },
              marks.map((mark) => h('span', {
                key: `snap-${mark}`,
                className: 'dsn-mark',
                style: { left: `${(mark / max) * 100}%` },
                title: `快照 · 第 ${mark} 天`,
              })),
              nextDay > latest && nextDay <= max
                ? h('span', {
                  key: 'next',
                  className: 'dsn-mark next',
                  style: { left: `${(nextDay / max) * 100}%` },
                  title: `下一个快照点 · 第 ${nextDay} 天`,
                })
                : null)
            : null),
        h('div', { className: 'dsn-ticks' }, ticks.map((tick) => h('span', { key: tick }, tick === max ? `${tick} 天` : String(tick)))),
        max === 0
          ? h('div', { className: 'dsn-hint' }, `生成章节后，故事时间每走过 ${unitDays} 天就会写入第一份世界快照，时间线随之生长。`)
          : null);
    }

    /* ------------------------------------------------------------ world page */

    function WorldPage({ detail, onTimeline, onEnterStory, onRefreshSnapshot, snapshotBusy, requestConfirm }) {
      const snapshots = detail.snapshots || [];
      const facts = detail.timelineFacts || {};
      const latest = facts.latestSnapshotDay !== undefined
        ? facts.latestSnapshotDay
        : (snapshots.length ? snapshots[snapshots.length - 1].day : 0);
      const storyEnd = facts.storyEnd !== undefined ? facts.storyEnd : latest;
      const nextDay = facts.nextSnapshotDay !== undefined ? facts.nextSnapshotDay : latest + 30;
      const max = Math.max(0, latest, storyEnd);
      const [unitDays, setUnitDays] = useState(detail.timeline.unitDays || 30);
      const [day, setDay] = useState(Math.min(Math.max(0, detail.timeline.cursor || 0), max));
      const [showChart, setShowChart] = useState(true);
      const commitTimer = useRef(null);

      useEffect(() => {
        setUnitDays(detail.timeline.unitDays || 30);
        setDay(Math.min(Math.max(0, detail.timeline.cursor || 0), max));
      }, [detail.projectId, detail.timeline.unitDays, detail.timeline.cursor, max]);

      useEffect(() => () => {
        if (commitTimer.current) clearTimeout(commitTimer.current);
      }, []);

      const change = useCallback((nextUnit, nextDay) => {
        setUnitDays(nextUnit);
        setDay(nextDay);
        if (commitTimer.current) clearTimeout(commitTimer.current);
        commitTimer.current = setTimeout(() => onTimeline(nextUnit, nextDay), 400);
      }, [onTimeline]);

      const snapshot = snapshotAt(detail, day);
      const chapters = detail.chapters || [];
      // The button only exists where the story has actually reached the next
      // snapshot point the project's own unit defines.
      const canSnapshot = chapters.length > 0 && storyEnd >= nextDay && day >= nextDay;
      const nearest = useMemo(() => {
        if (chapters.length === 0) return null;
        let best = chapters[0];
        let bestDistance = Infinity;
        for (const chapter of chapters) {
          const distance = Math.abs(chapterWindow(detail, chapter).start - day);
          if (distance < bestDistance) {
            best = chapter;
            bestDistance = distance;
          }
        }
        return best;
      }, [chapters, day]);

      const askSnapshot = useCallback(() => {
        requestConfirm({
          title: '是否为当前时间生成世界快照？',
          text: `将为第 ${day} 天生成一份世界快照：以上一份快照和这段时间的章节梗概为依据，时间线会延伸到这一天。`,
          confirmLabel: '生成快照',
          action: () => onRefreshSnapshot(day),
        });
      }, [requestConfirm, day, detail, onRefreshSnapshot]);

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('div', { className: 'dsn-title' }, detail.title),
          h('div', { className: 'dsn-sub' }, detail.cwd),
          h('div', { className: 'dsn-spacer' }),
          h('button', {
            className: 'dsn-btn ghost',
            type: 'button',
            'aria-pressed': showChart,
            onClick: () => setShowChart((value) => !value),
          }, showChart ? '隐藏统计图' : '显示统计图'),
          canSnapshot
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              disabled: snapshotBusy,
              onClick: askSnapshot,
            }, snapshotBusy ? '生成中…' : `生成世界快照 · 第 ${day} 天`)
            : null,
          h('button', { className: 'dsn-btn primary', type: 'button', onClick: () => onEnterStory(day) },
            nearest ? `进入故事 · 第 ${nearest.index + 1} 章` : '进入故事')),
        h(Timeline, { detail, unitDays, day, onChange: change }),
        h('div', { className: 'dsn-grid' },
          h('div', { className: 'dsn-card', style: { gridColumn: 'span 2' } },
            h('h4', null, '世界观'),
            snapshot && snapshot.world
              ? h('div', { className: 'dsn-text' }, snapshot.world)
              : h('div', { className: 'dsn-muted' }, '还没有落在这一时间点的世界快照。')),
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
              : h('div', { className: 'dsn-muted' }, '暂无'))),
        showChart ? h(ChapterChart, { detail }) : null);
    }

    /* ----------------------------------------------------------- chapter chart */

    /**
     * Story time per chapter: x is the chapter's position, y is the day the
     * chapter starts on. Hand-drawn SVG so the panel owns no chart library.
     */
    function ChapterChart({ detail }) {
      const chapters = useMemo(() => [...(detail.chapters || [])]
        .sort((a, b) => a.startDay - b.startDay || a.index - b.index), [detail.chapters]);

      if (chapters.length === 0) {
        return h('div', { className: 'dsn-chart-wrap' },
          h('div', { className: 'dsn-hint' }, '章节时间曲线：还没有章节，生成第一章后这里会画出每章在故事时间里的位置。'));
      }

      const width = 1000;
      const height = 152;
      const pad = { left: 52, right: 18, top: 14, bottom: 24 };
      const plotWidth = width - pad.left - pad.right;
      const plotHeight = height - pad.top - pad.bottom;
      const windows = chapters.map((chapter) => chapterWindow(detail, chapter));
      const maxDay = Math.max(1, ...windows.map((span) => span.end));
      const xFor = (index) => pad.left + (chapters.length === 1
        ? plotWidth / 2
        : (index / (chapters.length - 1)) * plotWidth);
      const yFor = (value) => pad.top + (1 - value / maxDay) * plotHeight;
      const yTicks = [...new Set([0, Math.round(maxDay / 2), maxDay])];
      const labelStride = Math.max(1, Math.ceil(chapters.length / 10));
      const lastSnapshotDay = detail.timelineFacts ? detail.timelineFacts.latestSnapshotDay : 0;
      const points = windows.map((span, index) => `${xFor(index)},${yFor(span.start)}`).join(' ');

      return h('div', { className: 'dsn-chart-wrap' },
        h('div', { className: 'dsn-chart-head' },
          h('span', { className: 'dsn-label' }, '章节时间曲线'),
          h('span', { className: 'dsn-hint' },
            `纵轴：故事天数 · 横轴：第几章 · 共 ${chapters.length} 章（竖条是该章的时间跨度）`)),
        h('svg', { className: 'dsn-chart', viewBox: `0 0 ${width} ${height}`, role: 'img' },
          yTicks.map((tick) => h('g', { key: `y-${tick}` },
            h('line', {
              className: 'grid',
              x1: pad.left,
              x2: width - pad.right,
              y1: yFor(tick),
              y2: yFor(tick),
            }),
            h('text', {
              className: 'axis',
              x: pad.left - 8,
              y: yFor(tick) + 3,
              textAnchor: 'end',
            }, `${tick} 天`))),
          lastSnapshotDay > 0 && lastSnapshotDay <= maxDay
            ? h('g', null,
              h('line', {
                className: 'snap',
                x1: pad.left,
                x2: width - pad.right,
                y1: yFor(lastSnapshotDay),
                y2: yFor(lastSnapshotDay),
              }),
              h('text', {
                className: 'axis',
                x: width - pad.right,
                y: yFor(lastSnapshotDay) - 4,
                textAnchor: 'end',
              }, `最新快照 ${lastSnapshotDay} 天`))
            : null,
          windows.map((span, index) => h('line', {
            key: `span-${chapters[index].chapterId}`,
            className: 'span',
            x1: xFor(index),
            x2: xFor(index),
            y1: yFor(span.start),
            y2: yFor(span.end),
          })),
          chapters.length > 1
            ? h('polyline', { className: 'line', points })
            : null,
          windows.map((span, index) => h('g', { key: chapters[index].chapterId },
            h('circle', {
              className: 'dot',
              cx: xFor(index),
              cy: yFor(span.start),
              r: 3.5,
            },
            h('title', null,
              `第 ${index + 1} 章 ${chapters[index].title || ''} · 第 ${span.start} → ${span.end} 天`)),
            index % labelStride === 0 || index === chapters.length - 1
              ? h('text', {
                className: 'axis',
                x: xFor(index),
                y: height - 8,
                textAnchor: 'middle',
              }, String(index + 1))
              : null))));
    }

    /* ------------------------------------------------------------ story page */

    /**
     * The editor is controlled: the workspace owns the draft so that every way
     * out of the page — back, next chapter, the outline, another project, or
     * closing the studio — can ask about unsaved text first.
     */
    function StoryPage({ detail, chapter, previous, next, text, saving, onEdit, onSave, onBack, onOutline, onOpenChapter, onNewChapter }) {
      const words = countWords(text);
      const window = chapter ? chapterWindow(detail, chapter) : null;

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, '← 时间长河'),
          h('div', { className: 'dsn-title' }, chapter ? `第 ${chapter.index + 1} 章 · ${chapter.title || '未命名'}` : '章节故事'),
          h('div', { className: 'dsn-sub' }, window ? `第 ${window.start} → ${window.end} 天` : ''),
          h('div', { className: 'dsn-spacer' }),
          previous
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              title: `第 ${previous.index + 1} 章 · ${previous.title || '未命名'}`,
              onClick: () => onOpenChapter(previous.chapterId),
            }, '← 上一章')
            : null,
          next
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              title: `第 ${next.index + 1} 章 · ${next.title || '未命名'}`,
              onClick: () => onOpenChapter(next.chapterId),
            }, '下一章 →')
            : h('button', { className: 'dsn-btn primary', type: 'button', onClick: onNewChapter }, '＋ 新建章节'),
          h('button', { className: 'dsn-btn ghost', type: 'button', disabled: !chapter, onClick: onOutline }, '章节大纲 →')),
        !chapter
          ? h('div', { className: 'dsn-empty' }, '还没有章节。点右上角「＋ 新建章节」开始第一章。')
          : h(React.Fragment, null,
            h('div', { className: 'dsn-editor' },
              !chapter.outline ? h('div', { className: 'dsn-note' }, '这一章还没有保存过章节大纲，可以先回章节大纲里填写并生成。') : null,
              h('textarea', {
                className: 'dsn-textarea dsn-story',
                value: text,
                placeholder: '章节正文：生成后可以直接在这里修改，改完点保存。',
                onChange: (event) => onEdit(event.target.value),
              })),
            h('div', { className: 'dsn-foot' },
              h('div', { className: 'dsn-muted' },
                `${words} 字${chapter.outline ? ` · 大纲要求 ${chapter.outline.minWords}–${chapter.outline.maxWords} 字` : ''}`),
              h('div', { className: 'dsn-spacer' }),
              h('button', { className: 'dsn-btn primary', type: 'button', disabled: saving, onClick: onSave },
                saving ? '保存中…' : '保存'))));
    }

    /* ---------------------------------------------------------- outline page */

    function OutlinePage({ detail, chapter, isFirstChapter, onBack, onSaved, notify, onRegisterGuard, requestConfirm }) {
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
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [job, setJob] = useJob();
      const chapterId = chapter ? chapter.chapterId : null;

      useEffect(() => {
        setForm(buildForm());
        setSavedAt(chapter && chapter.outline ? chapter.outline.savedAt : 0);
        setDirty(false);
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
        setDirty(true);
      }, []);

      const submit = useCallback(async (silent) => {
        if (!complete) {
          notify('梗概还没有达到最低字数，或字数与时间长度没填完', 'error');
          return false;
        }
        setSaving(true);
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
          setDirty(false);
          if (silent !== true) notify('章节大纲已保存', 'success');
          await onSaved(result.chapter.chapterId);
          return true;
        } catch (error) {
          notify(messageOf(error), 'error');
          return false;
        } finally {
          setSaving(false);
        }
      }, [complete, detail.projectId, chapter, form, onSaved, notify]);

      // The workspace asks this page before any navigation discards its edits.
      const guardRef = useRef(null);
      guardRef.current = {
        dirty,
        save: () => submit(true),
        reset: () => {
          setForm(buildForm());
          setSavedAt(chapter && chapter.outline ? chapter.outline.savedAt : 0);
          setDirty(false);
        },
      };
      useEffect(() => {
        if (typeof onRegisterGuard !== 'function') return undefined;
        onRegisterGuard({
          isDirty: () => guardRef.current.dirty,
          save: () => guardRef.current.save(),
          reset: () => guardRef.current.reset(),
        });
        return () => onRegisterGuard(null);
      }, [onRegisterGuard]);

      const startJob = useCallback(async (path) => {
        try {
          const started = await api(path, {
            projectId: detail.projectId,
            chapterId: chapter ? chapter.chapterId : '',
          });
          setJob(started);
        } catch (error) {
          notify(messageOf(error), 'error');
        }
      }, [detail.projectId, chapter, setJob, notify]);

      const generating = job && job.state === 'running' && job.kind === 'generate';
      const composing = job && job.state === 'running' && job.kind === 'compose';

      /** 自动推演: deduce synopsis, title and the whole chapter, then save. */
      const deduce = useCallback(() => {
        if (isFirstChapter) {
          notify('第一章没有世界快照和上一章可依据，自动推演不可用', 'error');
          return;
        }
        requestConfirm({
          title: '自动推演会覆盖现有内容',
          text: '将重新生成故事梗概、章节名称和整章正文，当前的大纲与已写的正文都会被打断覆盖，生成完直接保存。确定继续吗？',
          confirmLabel: '覆盖并生成',
          action: async () => {
            try {
              const started = await api('/compose', {
                projectId: detail.projectId,
                chapterId: chapter ? chapter.chapterId : '',
                minWords: Number(form.minWords),
                maxWords: Number(form.maxWords),
                durationDays: Number(form.durationDays),
              });
              setJob(started);
            } catch (error) {
              notify(messageOf(error), 'error');
            }
          },
        });
      }, [requestConfirm, detail.projectId, chapter, form, setJob, notify]);

      /** 生成章节故事: rewrite the body from the saved synopsis. */
      const generate = useCallback(() => {
        requestConfirm({
          title: '以当前故事梗概生成章节故事？',
          text: '会用已保存的梗概、字数限制和时间长度重写这一章的正文，现有正文会被覆盖。',
          confirmLabel: '开始生成',
          action: () => startJob('/generate'),
        });
      }, [requestConfirm, startJob]);

      useEffect(() => {
        if (!job) return;
        if (job.kind === 'generate' && job.state === 'done') {
          notify('章节生成成功', 'success');
          onSaved(chapter ? chapter.chapterId : null);
        }
        if (job.kind === 'compose' && job.state === 'done') {
          const result = job.result || {};
          setForm((current) => ({
            ...current,
            title: result.title || current.title,
            synopsis: result.synopsis || current.synopsis,
          }));
          setSavedAt(Date.now());
          setDirty(false);
          notify('已重新推演并保存章节', 'success');
          onSaved(chapter ? chapter.chapterId : null);
        }
        if (job.state === 'error') {
          notify(job.error || '任务失败', 'error');
        }
      }, [job ? job.jobId : null, job ? job.state : null]);

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, '← 章节故事'),
          h('div', { className: 'dsn-title' }, chapter ? `章节大纲 · 第 ${chapter.index + 1} 章` : '章节大纲 · 新章节'),
          h('div', { className: 'dsn-sub' }, `起始 第 ${chapter ? chapterWindow(detail, chapter).start : (detail.timeline.cursor || 0)} 天`),
          h('div', { className: 'dsn-spacer' }),
          h('button', {
            className: 'dsn-btn ghost',
            type: 'button',
            disabled: !complete || isFirstChapter || saving || Boolean(generating || composing),
            title: isFirstChapter
              ? '第一章没有世界快照和上一章可依据，自动推演不可用；请自己写梗概后生成'
              : '按当前字数与时间长度，重新推演梗概、章节名称与整章正文',
            onClick: deduce,
          }, composing ? '推演中…' : '自动推演')),
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
            complete ? (savedAt ? '设定完整，可以生成章节故事' : '设定完整，可以保存') : '梗概达到最低字数并填完其他项后可以保存'),
          generating || composing
            ? h('div', { className: 'dsn-progress' }, h('span', { className: 'dsn-spin' }),
              composing ? (job.message || '正在自动推演…') : '正在生成章节故事…')
            : null,
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn', type: 'button', disabled: !complete || saving || Boolean(generating || composing), onClick: () => submit(false) },
            saving ? '保存中…' : '保存'),
          h('button', {
            className: 'dsn-btn primary',
            type: 'button',
            disabled: !savedAt || Boolean(generating || composing) || !chapter,
            onClick: generate,
          }, generating ? '生成中…' : '生成章节故事')));
    }

    /* --------------------------------------------------------- new chapter */

    /**
     * The only place a chapter is created: word bounds and the story length are
     * required, and one button can deduce the synopsis and write the chapter.
     */
    function NewChapterDialog({ detail, startDay, onCancel, onCreated, notify }) {
      const [form, setForm] = useState({
        title: '',
        minWords: 1200,
        maxWords: 3500,
        durationDays: detail.timeline.unitDays || 30,
      });
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [job, setJob] = useJob();

      const complete = Number(form.minWords) >= 1
        && Number(form.maxWords) >= Number(form.minWords)
        && Number(form.durationDays) >= 1;

      // A work's first chapter has no snapshot and no previous chapter to
      // deduce from, so auto-deduction stays off for it.
      const isFirstChapter = (detail.chapters || []).length === 0;

      const patch = useCallback((field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
      }, []);

      const composing = Boolean(job && job.state === 'running' && job.kind === 'compose');

      const create = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const result = await api('/outline/save', {
            projectId: detail.projectId,
            chapterId: '',
            title: form.title,
            startDay,
            outline: {
              durationDays: Number(form.durationDays),
              minWords: Number(form.minWords),
              maxWords: Number(form.maxWords),
              synopsisMinChars: DEFAULT_SYNOPSIS_MIN,
              synopsis: '',
            },
          });
          await onCreated(result.chapter.chapterId);
        } catch (createError) {
          setError(messageOf(createError));
        } finally {
          setBusy(false);
        }
      }, [detail.projectId, form, startDay, onCreated]);

      const compose = useCallback(async () => {
        if (isFirstChapter) {
          setError('第一章没有可依据的世界快照和上一章，自动推演不可用');
          return;
        }
        setError('');
        try {
          const started = await api('/compose', {
            projectId: detail.projectId,
            startDay,
            title: form.title,
            minWords: Number(form.minWords),
            maxWords: Number(form.maxWords),
            durationDays: Number(form.durationDays),
          });
          setJob(started);
        } catch (composeError) {
          setError(messageOf(composeError));
        }
      }, [detail.projectId, form, startDay, setJob]);

      useEffect(() => {
        if (!job) return;
        if (job.state === 'running') return;
        if (job.state === 'done' && job.kind === 'compose') {
          notify('章节已生成', 'success');
          onCreated(job.result && job.result.chapterId);
          return;
        }
        if (job.state === 'error') setError(job.error || '自动推演失败');
      }, [job ? job.jobId : null, job ? job.state : null]);

      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog' },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, '新建章节'),
            h('div', { className: 'dsn-sub' }, `起始 第 ${startDay} 天`),
            h('div', { className: 'dsn-spacer' }),
            h('button', {
              className: 'dsn-btn ghost',
              type: 'button',
              disabled: composing || busy,
              onClick: onCancel,
            }, '取消')),
          h('div', { className: 'dsn-dialog-body' },
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, '章节名称（可留空，自动推演会补上）'),
              h('input', {
                className: 'dsn-input',
                value: form.title,
                placeholder: '例如：雨夜来客',
                onChange: (event) => patch('title', event.target.value),
              })),
            h('label', { className: 'dsn-field' },
              h('span', { className: 'dsn-label' }, '章节最低字数 *'),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.minWords,
                onChange: (event) => patch('minWords', Number(event.target.value)),
              })),
            h('label', { className: 'dsn-field' },
              h('span', { className: 'dsn-label' }, '章节最多字数 *'),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.maxWords,
                onChange: (event) => patch('maxWords', Number(event.target.value)),
              })),
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, '故事时间长度（天）*'),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.durationDays,
                onChange: (event) => patch('durationDays', Number(event.target.value)),
              })),
            error ? h('div', { className: 'dsn-hint warn span2' }, error) : null,
            isFirstChapter
              ? h('div', { className: 'dsn-hint span2' }, '这是作品的第一章：没有世界快照和上一章可依据，自动推演不可用。先创建空章节，再自己写梗概生成。')
              : null),
          h('div', { className: 'dsn-dialog-foot' },
            composing ? h('div', { className: 'dsn-progress' }, h('span', { className: 'dsn-spin' }), job.message || '正在自动推演…') : null,
            h('div', { className: 'dsn-spacer' }),
            h('button', {
              className: 'dsn-btn',
              type: 'button',
              disabled: !complete || busy || composing,
              onClick: create,
            }, busy ? '创建中…' : '创建空章节'),
            h('button', {
              className: 'dsn-btn primary',
              type: 'button',
              disabled: !complete || busy || composing || isFirstChapter,
              title: isFirstChapter ? '第一章没有可依据的快照与上一章，自动推演不可用' : '',
              onClick: compose,
            }, composing ? '自动推演中…' : '自动推演'))));
    }

    /** A plain yes/no dialog for an action that overwrites something. */
    function ConfirmDialog({ title, text, confirmLabel, cancelLabel, onConfirm, onCancel }) {
      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog', style: { width: 'min(440px, calc(100% - 48px))' } },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, title),
            h('div', { className: 'dsn-spacer' })),
          h('div', { className: 'dsn-dialog-body', style: { gridTemplateColumns: '1fr' } },
            h('div', { className: 'dsn-text', style: { fontSize: 12 } }, text)),
          h('div', { className: 'dsn-dialog-foot' },
            h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onCancel }, cancelLabel || '取消'),
            h('div', { className: 'dsn-spacer' }),
            h('button', { className: 'dsn-btn primary', type: 'button', onClick: onConfirm }, confirmLabel || '确定'))));
    }

    /* --------------------------------------------------------- leave confirm */

    /** Asked whenever unsaved chapter text or outline edits would be left behind. */
    function LeaveConfirm({ what, onCancel, onDiscard, onSave }) {
      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog', style: { width: 'min(420px, calc(100% - 48px))' } },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, `${what || '这一章'}还没有保存`),
            h('div', { className: 'dsn-spacer' })),
          h('div', { className: 'dsn-dialog-body', style: { gridTemplateColumns: '1fr' } },
            h('div', { className: 'dsn-text', style: { fontSize: 12 } },
              '离开这个界面会丢掉刚才的修改。要先保存吗？')),
          h('div', { className: 'dsn-dialog-foot' },
            h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onCancel }, '取消'),
            h('div', { className: 'dsn-spacer' }),
            h('button', { className: 'dsn-btn', type: 'button', onClick: onDiscard }, '不保存离开'),
            h('button', { className: 'dsn-btn primary', type: 'button', onClick: onSave }, '保存并离开'))));
    }

    /* ------------------------------------------------------------- workspace */

    function ProjectWorkspace({ detail, onReload, notify, onRegisterLeaveGuard }) {
      const [view, setView] = useState('world');
      const [chapterId, setChapterId] = useState(null);
      const [snapshotBusy, setSnapshotBusy] = useState(false);
      const [dialogOpen, setDialogOpen] = useState(false);
      const [text, setText] = useState('');
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [pendingLeave, setPendingLeave] = useState(null);
      const [confirmRequest, setConfirmRequest] = useState(null);
      const outlineGuard = useRef({ isDirty: () => false, save: async () => true, reset: () => {} });
      const registerOutlineGuard = useCallback((guard) => {
        outlineGuard.current = guard || { isDirty: () => false, save: async () => true, reset: () => {} };
      }, []);
      const chapters = useMemo(
        () => [...(detail.chapters || [])].sort((a, b) => a.startDay - b.startDay || a.index - b.index),
        [detail.chapters],
      );
      const position = chapters.findIndex((entry) => entry.chapterId === chapterId);
      const chapter = position >= 0 ? chapters[position] : null;
      const previous = position > 0 ? chapters[position - 1] : null;
      const next = position >= 0 && position < chapters.length - 1 ? chapters[position + 1] : null;

      // The draft follows the open chapter, and a generated body replaces it
      // only while the user has nothing unsaved of their own.
      const stored = chapter ? chapter.content || '' : '';
      useEffect(() => {
        setText(stored);
        setDirty(false);
      }, [chapterId]);
      useEffect(() => {
        if (dirty) return;
        setText((current) => (current === stored ? current : stored));
      }, [stored, dirty]);

      const saveDraft = useCallback(async (silent) => {
        if (!chapter) return true;
        setSaving(true);
        try {
          await api('/chapter/save', { projectId: detail.projectId, chapterId: chapter.chapterId, content: text });
          setDirty(false);
          if (silent !== true) notify('章节已保存', 'success');
          await onReload();
          return true;
        } catch (error) {
          notify(messageOf(error), 'error');
          return false;
        } finally {
          setSaving(false);
        }
      }, [chapter, detail.projectId, text, onReload, notify]);

      /** Run a navigation step, asking about the active page's unsaved edits. */
      const leave = useCallback((action) => {
        const unsaved = view === 'outline' ? outlineGuard.current.isDirty() : dirty;
        if (!unsaved) {
          action();
          return;
        }
        setPendingLeave({ action, page: view });
      }, [view, dirty]);

      // Leaving the whole studio or the project goes through the same gate.
      const leaveRef = useRef(leave);
      leaveRef.current = leave;
      useEffect(() => {
        if (typeof onRegisterLeaveGuard !== 'function') return undefined;
        onRegisterLeaveGuard((proceed) => leaveRef.current(proceed));
        return () => onRegisterLeaveGuard(null);
      }, [onRegisterLeaveGuard]);

      const openStory = useCallback((id) => {
        leave(() => {
          setChapterId(id);
          setView('story');
        });
      }, [leave]);

      const enterStory = useCallback((day) => {
        leave(() => {
          if (chapters.length === 0) {
            setChapterId(null);
            setView('story');
            return;
          }
          let best = chapters[0];
          let bestDistance = Infinity;
          for (const entry of chapters) {
            const distance = Math.abs(chapterWindow(detail, entry).start - day);
            if (distance < bestDistance) {
              best = entry;
              bestDistance = distance;
            }
          }
          setChapterId(best.chapterId);
          setView('story');
        });
      }, [chapters, detail, leave]);

      const lastEnd = useMemo(() => {
        let end = 0;
        for (const entry of chapters) end = Math.max(end, chapterWindow(detail, entry).end);
        return end;
      }, [chapters, detail]);

      const created = useCallback(async (id) => {
        setDialogOpen(false);
        if (id) setChapterId(id);
        setView('story');
        await onReload();
      }, [onReload]);

      const saveTimeline = useCallback(async (unitDays, day) => {
        try {
          await api('/project/timeline', { projectId: detail.projectId, unitDays, cursor: day });
          await onReload();
        } catch (error) {
          notify(messageOf(error), 'error');
        }
      }, [detail.projectId, onReload, notify]);

      const refreshSnapshot = useCallback(async (day) => {
        setSnapshotBusy(true);
        try {
          const started = await api('/snapshot/refresh', { projectId: detail.projectId, day });
          notify('正在结算世界快照…', 'success');
          const timer = setInterval(async () => {
            try {
              const job = await api(`/job?id=${encodeURIComponent(started.jobId)}`);
              if (job.state === 'running') return;
              clearInterval(timer);
              setSnapshotBusy(false);
              if (job.state === 'done') {
                notify('世界快照已更新，时间线向前延伸', 'success');
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
              onRefreshSnapshot: refreshSnapshot,
              snapshotBusy,
              requestConfirm: setConfirmRequest,
            })),
          h('section', { className: 'dsn-page' },
            h(StoryPage, {
              detail,
              chapter,
              previous,
              next,
              text,
              saving,
              onEdit: (value) => {
                setDirty(true);
                setText(value);
              },
              onSave: () => saveDraft(false),
              onBack: () => leave(() => setView('world')),
              onOutline: () => leave(() => setView('outline')),
              onOpenChapter: openStory,
              onNewChapter: () => leave(() => setDialogOpen(true)),
            })),
          h('section', { className: 'dsn-page' },
            h(OutlinePage, {
              detail,
              chapter,
              onBack: () => leave(() => setView(chapter ? 'story' : 'world')),
              onSaved: async (id) => {
                if (id) setChapterId(id);
                await onReload();
              },
              notify,
              onRegisterGuard: registerOutlineGuard,
              requestConfirm: setConfirmRequest,
              isFirstChapter: Boolean(chapter && chapters.length > 0 && chapter.chapterId === chapters[0].chapterId),
            }))),
        confirmRequest
          ? h(ConfirmDialog, {
            title: confirmRequest.title,
            text: confirmRequest.text,
            confirmLabel: confirmRequest.confirmLabel,
            onCancel: () => setConfirmRequest(null),
            onConfirm: async () => {
              const request = confirmRequest;
              setConfirmRequest(null);
              await request.action();
            },
          })
          : null,
        pendingLeave
          ? h(LeaveConfirm, {
            what: pendingLeave.page === 'outline' ? '这份章节大纲' : '这一章的正文',
            onCancel: () => setPendingLeave(null),
            onDiscard: () => {
              const { action, page } = pendingLeave;
              setPendingLeave(null);
              if (page === 'outline') {
                outlineGuard.current.reset();
              } else {
                setDirty(false);
                setText(stored);
              }
              action();
            },
            onSave: async () => {
              const { action, page } = pendingLeave;
              const saved = page === 'outline'
                ? await outlineGuard.current.save()
                : await saveDraft(true);
              if (!saved) return;
              setPendingLeave(null);
              action();
            },
          })
          : null,
        dialogOpen
          ? h(NewChapterDialog, {
            detail,
            startDay: lastEnd,
            onCancel: () => setDialogOpen(false),
            onCreated: created,
            notify,
          })
          : null);
    }

    /* ------------------------------------------------------------ studio app */

    function StudioApp({ workspace }) {
      const [boot, setBoot] = useState(null);
      const [error, setError] = useState('');
      const [projectId, setProjectId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [toast, setToast] = useToast();
      const leaveGuard = useRef(null);
      const registerLeaveGuard = useCallback((guard) => {
        leaveGuard.current = guard;
      }, []);
      /** Every way out of the studio asks the workspace first. */
      const requestLeave = useCallback((proceed) => {
        const guard = leaveGuard.current;
        if (typeof guard === 'function') {
          guard(proceed);
          return;
        }
        proceed();
      }, []);
      const close = useCallback(() => requestLeave(() => setOverlayOpen(false)), [requestLeave]);

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
              onClick: () => requestLeave(() => {
                setProjectId(null);
                setDetail(null);
                loadBoot();
              }),
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
                : h(ProjectWorkspace, {
                  key: detail.projectId,
                  detail,
                  onReload: reloadDetail,
                  notify,
                  onRegisterLeaveGuard: registerLeaveGuard,
                })));
    }

    function StudioOverlay({ workspace }) {
      const open = useOverlayOpen();
      if (!open) return null;
      // No backdrop-click close: leaving with unsaved chapter text goes through
      // the 关闭 button, which asks first.
      return h('div', { className: 'dsn-overlay' }, h(StudioApp, { workspace }));
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
