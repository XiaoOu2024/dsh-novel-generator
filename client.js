/**
 * dsh-novel-generator — Client half.
 *
 * A frame-wide studio owned by two slots: a launcher at the sidebar foot and a
 * full-window overlay. The overlay holds the project list, the draggable
 * timeline with the world snapshot it selects, the chapter story and the
 * chapter outline, which slide horizontally past one another.
 */
window.__ModuleLoader__.load({
  id: 'dsh-novel-generator',
  factory(require) {
    const React = require('react');
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const API = '/dsh-novel-generator/api';
    const UNIT_CHOICES = [7, 15, 30, 90, 180, 365];
    const DEFAULT_SYNOPSIS_MIN = 100;

    /* ------------------------------------------------------- shared state */

    /** Set from `apply`; the Harness locale service, when the host ships one. */
    let localeService = null;
    /** Mirrors the Harness language setting for `t()`; 'zh' until it says otherwise. */
    let activeLocale = 'zh';

    function readLocaleId() {
      try {
        const snapshot = localeService ? localeService.getLocale() : null;
        if (typeof snapshot === 'string') return snapshot;
        if (snapshot && typeof snapshot === 'object') {
          // LocaleSnapshot carries the active id in `active`.
          return snapshot.active || snapshot.locale || snapshot.id || 'zh';
        }
      } catch {
        // A snapshot shape we do not know reads as the default.
      }
      return 'zh';
    }

    /** The active locale id, re-rendered whenever Settings → General → Language changes. */
    function useLocaleId() {
      const [id, setId] = useState(readLocaleId);
      useEffect(() => {
        if (!localeService || typeof localeService.subscribe !== 'function') return undefined;
        const listener = () => setId(readLocaleId());
        listener();
        return localeService.subscribe(listener);
      }, []);
      activeLocale = id;
      return id;
    }

    /**
     * The UI follows Settings → General → Language. Every label is written as
     * `t('中文', 'English')`; templates pass `{named}` values as the third
     * argument so the sentence can be re-ordered per language.
     */
    function t(zh, en, vars) {
      let text = String(activeLocale).toLowerCase().startsWith('zh') ? zh : en;
      if (vars) {
        text = text.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined ? match : String(vars[key])));
      }
      return text;
    }

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
        throw new Error((payload && payload.error) || t('请求失败（HTTP {code}）', 'Request failed (HTTP {code})', { code: response.status }));
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
.dsn-input.dsn-input-invalid{border-color:var(--dsw-alias-state-warn-primary)}
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
.dsn-chart .span{stroke:var(--dsw-alias-state-business-primary);opacity:.32;stroke-linecap:round}
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
      // Subscribes this slot to Settings → General → Language.
      useLocaleId();
      const wide = !props || props.wide !== false;
      return h('button', {
        type: 'button',
        className: 'dsn-launch',
        title: t('小说工坊', 'Novel Studio'),
        onClick: () => setOverlayOpen(true),
      },
      h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H4z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z' })),
      wide ? h('span', null, t('小说工坊', 'Novel Studio')) : null);
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

    const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

    /** The same title rules the Host enforces, so the form can answer first. */
    function titleProblem(title) {
      const text = String(title === undefined || title === null ? '' : title);
      if (text.trim() === '') return t('作品名称不能为空', "Title cannot be empty.");
      if (text.length > 60) return t('作品名称最多 60 个字符', "Title can be at most 60 characters.");
      if (/^[.\s]/.test(text) || /[.\s]$/.test(text)) return t('作品名称不能以空格或点开头、结尾', "Title cannot start or end with a space or a dot.");
      if (/[\\/:*?"<>|]/.test(text)) return t('作品名称不能包含 \\ / : * ? " < > |', "Title cannot contain \\\\ / : * ? \" < > |.");
      if (/[\u0000-\u001f]/.test(text)) return t('作品名称不能包含控制字符', "Title cannot contain control characters.");
      if (RESERVED_NAMES.test(text.trim())) return t('作品名称不能使用 CON、PRN、NUL、COM1 这类系统保留名', "Title cannot be a reserved name such as CON, PRN, NUL or COM1.");
      return null;
    }

    /* -------------------------------------------------------- projects page */

    /** Display name of a stored model selection. */
    function modelLabel(models, selection) {
      if (!selection || !selection.provider || !selection.model) return t('默认模型', "Default model");
      const groups = (models && models.groups) || [];
      const group = groups.find((entry) => entry.id === selection.provider);
      const model = group && group.models.find((entry) => entry.id === selection.model);
      return model ? model.name : `${selection.provider} / ${selection.model}`;
    }

    /** Change one project's model; the Host also switches its Session. */
    function ModelDialog({ project, models, onCancel, onSaved }) {
      const groups = (models && models.groups) || [];
      const current = project.model || (models && models.default) || null;
      const [provider, setProvider] = useState(
        current && current.provider ? current.provider : (groups[0] ? groups[0].id : ''),
      );
      const [model, setModel] = useState(current && current.model ? current.model : '');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const list = (groups.find((entry) => entry.id === provider) || { models: [] }).models;

      useEffect(() => {
        if (list.length && !list.some((entry) => entry.id === model)) setModel(list[0].id);
      }, [provider]);

      const save = useCallback(async () => {
        setBusy(true);
        setError('');
        try {
          const result = await api('/project/model', {
            projectId: project.projectId,
            model: { provider, model },
          });
          await onSaved(result.warning || '');
        } catch (saveError) {
          setError(messageOf(saveError));
        } finally {
          setBusy(false);
        }
      }, [project.projectId, provider, model, onSaved]);

      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog', style: { width: 'min(460px, calc(100% - 48px))' } },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, t('修改作品模型', "Change work model")),
            h('div', { className: 'dsn-sub' }, project.title),
            h('div', { className: 'dsn-spacer' })),
          h('div', { className: 'dsn-dialog-body' },
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, t('模型', "Model")),
              h('select', {
                className: 'dsn-select',
                value: provider,
                onChange: (event) => setProvider(event.target.value),
              }, groups.length === 0
                ? h('option', { value: '' }, t('未发现可用模型', "No model available"))
                : groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)))),
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, t('模型实例', "Model")),
              h('select', {
                className: 'dsn-select',
                value: model,
                onChange: (event) => setModel(event.target.value),
              }, list.length === 0
                ? h('option', { value: '' }, '—')
                : list.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
            h('div', { className: 'dsn-hint span2' }, t('切换后会同时改到这部作品绑定的会话上。', "This also switches the model of the session bound to this work.")),
            error ? h('div', { className: 'dsn-hint warn span2' }, error) : null),
          h('div', { className: 'dsn-dialog-foot' },
            h('button', { className: 'dsn-btn ghost', type: 'button', disabled: busy, onClick: onCancel }, t('取消', "Cancel")),
            h('div', { className: 'dsn-spacer' }),
            h('button', {
              className: 'dsn-btn primary',
              type: 'button',
              disabled: busy || !provider || !model,
              onClick: save,
            }, busy ? t('保存中…', "Saving…") : t('保存', "Save")))));
    }

    function ProjectsPage({ boot, resolveWorkspace, onOpen, onReload, onEditModel }) {
      const [title, setTitle] = useState('');
      const [cwd, setCwd] = useState('');
      const [preset, setPreset] = useState('');
      const [provider, setProvider] = useState(
        boot.models && boot.models.default ? boot.models.default.provider : '',
      );
      const [model, setModel] = useState(boot.models && boot.models.default ? boot.models.default.model : '');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      // The title becomes a folder name inside the working directory.
      const effectiveTitle = title.trim() === '' ? t('未命名作品', "Untitled work") : title;
      const titleIssue = titleProblem(effectiveTitle);

      const groups = (boot.models && boot.models.groups) || [];
      const models = useMemo(() => {
        const group = groups.find((entry) => entry.id === provider);
        return group ? group.models : [];
      }, [groups, provider]);

      useEffect(() => {
        if (models.length && !models.some((entry) => entry.id === model)) setModel(models[0].id);
      }, [models]);

      const pickDirectory = useCallback(async () => {
        // Resolved at click time: the workspace service may activate after this
        // plugin, so an instance captured in `apply` can come back undefined.
        const ui = typeof resolveWorkspace === 'function' ? resolveWorkspace() : null;
        if (!ui || typeof ui.pickDirectory !== 'function') {
          setError(t('目录选择器还没就绪，请稍后再点一次「选择」', 'The directory picker is not ready yet — try "Select" again in a moment.'));
          return;
        }
        try {
          const picked = await ui.pickDirectory();
          if (picked) setCwd(picked);
        } catch (pickError) {
          setError(messageOf(pickError));
        }
      }, [resolveWorkspace]);

      const create = useCallback(async () => {
        setError('');
        if (!cwd.trim()) {
          setError(t('请先点「选择」挑一个工作目录', "Pick a working directory with \"Select\" first."));
          return;
        }
        setBusy(true);
        try {
          const result = await api('/project/create', {
            title: title.trim() || t('未命名作品', "Untitled work"),
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
        if (!window.confirm(t('确定删除作品「{title}」？这会同时删除工作目录下的作品文件夹（正文、梗概、世界快照）。作品的会话本身保留。', 'Delete the work “{title}”? This also deletes its folder in the working directory (chapters, outlines, world snapshots). The session itself stays.', { title: project.title }))) return;
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
            h('span', { className: 'dsn-label' }, t('作品名称', "Title")),
            h('input', {
              className: `dsn-input${titleIssue ? ' dsn-input-invalid' : ''}`,
              value: title,
              placeholder: t('例如：长夜将尽', "e.g. The Long Night Ends"),
              title: titleIssue || t('会成为工作目录下的文件夹名', "Becomes a folder name inside the working directory."),
              onChange: (event) => setTitle(event.target.value),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('工作目录', "Working directory")),
            h('div', { className: 'dsn-path' },
              h('input', {
                className: 'dsn-input dsn-readonly',
                value: cwd,
                readOnly: true,
                title: cwd || t('只能通过右侧「选择」挑选目录', "Choose it with \"Select\" on the right."),
                placeholder: t('点右侧「选择」挑一个目录', "Pick a directory with \"Select\" on the right."),
              }),
              h('button', { className: 'dsn-btn ghost', type: 'button', onClick: pickDirectory }, t('选择', "Select")))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('模型', "Model")),
            h('select', {
              className: 'dsn-select',
              value: provider,
              onChange: (event) => setProvider(event.target.value),
            }, groups.length === 0
              ? h('option', { value: '' }, t('未发现可用模型', "No model available"))
              : groups.map((group) => h('option', { key: group.id, value: group.id }, group.name)))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('模型实例', "Model")),
            h('select', {
              className: 'dsn-select',
              value: model,
              onChange: (event) => setModel(event.target.value),
            }, models.length === 0
              ? h('option', { value: '' }, '—')
              : models.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('预设', "Preset")),
            h('select', {
              className: 'dsn-select',
              value: preset,
              onChange: (event) => setPreset(event.target.value),
            },
            h('option', { value: '' }, t('默认预设', "Default preset")),
            boot.presets.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name)))),
          h('div', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, ' '),
            h('button', {
              className: 'dsn-btn primary',
              type: 'button',
              disabled: busy || Boolean(titleIssue),
              title: titleIssue || '',
              onClick: create,
            }, busy ? t('创建中…', "Creating…") : t('创建作品并开会话', "Create work and open its session")))),

        error || titleIssue
          ? h('div', { className: 'dsn-error', style: { margin: 0 } }, error || titleIssue)
          : null,

        h('div', { className: 'dsn-list' },
          boot.projects.length === 0
            ? h('div', { className: 'dsn-empty' }, t('还没有作品。填好名称、工作目录和模型后创建一部，界面会自动为它开一个会话。', "No works yet. Fill in a title, a working directory and a model; creating one also opens its own session."))
            : boot.projects.map((project) => h('div', {
              key: project.projectId,
              className: 'dsn-row',
              onClick: () => onOpen(project.projectId),
            },
            h('div', { className: 'dsn-row-main', style: { flex: 1 } },
              h('div', { className: 'dsn-row-name' }, project.title),
              h('div', { className: 'dsn-row-meta' },
                t('{chapters} 章 · {snapshots} 个快照 · 模型：{model}', '{chapters} chapters · {snapshots} snapshots · model: {model}', { chapters: project.chapterCount, snapshots: project.snapshotCount, model: modelLabel(boot.models, project.model) })),
              h('div', { className: 'dsn-row-meta' },
                t('{cwd} · 更新于 {time}{recent}', '{cwd} · updated {time}{recent}', { cwd: project.cwd, time: formatTime(project.updatedAt), recent: project.lastChapterTitle ? t(' · 最近：{title}', ' · latest: {title}', { title: project.lastChapterTitle }) : '' }))),
            h('button', {
              className: 'dsn-btn ghost',
              type: 'button',
              title: t('修改这部作品使用的模型', "Change the model this work uses"),
              onClick: (event) => {
                event.stopPropagation();
                onEditModel(project);
              },
            }, t('模型', "Model")),
            h('button', {
              className: 'dsn-btn danger ghost',
              type: 'button',
              onClick: (event) => {
                event.stopPropagation();
                remove(project);
              },
            }, t('删除', "Delete"))))));
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
          h('div', { className: 'dsn-date' }, t('第 {n} 天', 'Day {n}', { n: day })),
          h('div', { className: 'dsn-sub' },
            max === 0
              ? t('还没有世界快照', "No world snapshot yet")
              : t('共 {total} 天 · 每 {unit} 天一份快照 · 已写入 {count} 份{next}', '{total} days · one snapshot every {unit} days · {count} written{next}', { total: max, unit: unitDays, count: snapshots.length, next: nextDay <= max ? t(' · 下一快照点 第 {day} 天', ' · next snapshot point on day {day}', { day: nextDay }) : '' })),
          h('div', { className: 'dsn-spacer' }),
          h('div', { className: 'dsn-units' },
            h('span', { className: 'dsn-label' }, t('快照间隔', "Snapshot interval")),
            h('input', {
              className: 'dsn-input dsn-unit-input',
              type: 'text',
              inputMode: 'numeric',
              list: 'dsn-unit-options',
              value: unitText,
              title: t('每多少天结算一份世界快照，可从 7 / 15 / 30 / 90 / 180 / 365 里选，也可以直接输入', "How many days per world snapshot — pick 7 / 15 / 30 / 90 / 180 / 365 or type another number."),
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
            h('span', { className: 'dsn-label' }, t('天', "days")),
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
                title: t('快照 · 第 {day} 天', 'Snapshot · day {day}', { day: mark }),
              })),
              nextDay > latest && nextDay <= max
                ? h('span', {
                  key: 'next',
                  className: 'dsn-mark next',
                  style: { left: `${(nextDay / max) * 100}%` },
                  title: t('下一个快照点 · 第 {day} 天', 'Next snapshot point · day {day}', { day: nextDay }),
                })
                : null)
            : null),
        h('div', { className: 'dsn-ticks' }, ticks.map((tick) => h('span', { key: tick }, tick === max ? t('{n} 天', '{n} days', { n: tick }) : String(tick)))),
        max === 0
          ? h('div', { className: 'dsn-hint' }, t('生成章节后，故事时间每走过 {unit} 天就会写入第一份世界快照，时间线随之生长。', 'Once you generate a chapter, a first world snapshot is written every {unit} days of story time and the timeline grows with it.', { unit: unitDays }))
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
          title: t('是否为当前时间生成世界快照？', "Generate a world snapshot for this point in time?"),
          text: t('将为第 {day} 天生成一份世界快照：以上一份快照和这段时间的章节梗概为依据，时间线会延伸到这一天。', 'A world snapshot will be generated for day {day} from the previous snapshot and the synopses of this stretch; the timeline extends to that day.', { day }),
          confirmLabel: t('生成快照', "Generate snapshot"),
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
          }, showChart ? t('隐藏统计图', "Hide chart") : t('显示统计图', "Show chart")),
          canSnapshot
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              disabled: snapshotBusy,
              onClick: askSnapshot,
            }, snapshotBusy ? t('生成中…', "Generating…") : t('生成世界快照 · 第 {day} 天', 'Generate snapshot · day {day}', { day }))
            : null,
          h('button', { className: 'dsn-btn primary', type: 'button', onClick: () => onEnterStory(day) },
            nearest ? t('进入故事 · 第 {n} 章', 'Enter story · chapter {n}', { n: nearest.index + 1 }) : t('进入故事', "Enter story"))),
        h(Timeline, { detail, unitDays, day, onChange: change }),
        h('div', { className: 'dsn-grid' },
          h('div', { className: 'dsn-card', style: { gridColumn: 'span 2' } },
            h('h4', null, t('世界观', "World")),
            snapshot && snapshot.world
              ? h('div', { className: 'dsn-text' }, snapshot.world)
              : h('div', { className: 'dsn-muted' }, t('还没有落在这一时间点的世界快照。', "No world snapshot covers this point in time yet."))),
          h('div', { className: 'dsn-card' },
            h('h4', null, t('角色列表', "Characters")),
            snapshot && snapshot.characters.length
              ? h('div', { className: 'dsn-entries' }, snapshot.characters.map((character, index) => h('div', {
                key: `${character.name}-${index}`,
                className: 'dsn-entry',
              }, h('b', null, character.name), h('span', null, character.desc))))
              : h('div', { className: 'dsn-muted' }, t('暂无', "None yet"))),
          h('div', { className: 'dsn-card' },
            h('h4', null, t('势力列表', "Factions")),
            snapshot && snapshot.factions.length
              ? h('div', { className: 'dsn-entries' }, snapshot.factions.map((faction, index) => h('div', {
                key: `${faction.name}-${index}`,
                className: 'dsn-entry',
              }, h('b', null, faction.name), h('span', null, faction.desc))))
              : h('div', { className: 'dsn-muted' }, t('暂无', "None yet"))),
          h('div', { className: 'dsn-card' },
            h('h4', null, t('关系', "Relations")),
            snapshot && snapshot.relations.length
              ? h('div', { className: 'dsn-entries' }, snapshot.relations.map((relation, index) => h('div', {
                key: index,
                className: 'dsn-entry',
              }, h('span', null, relation))))
              : h('div', { className: 'dsn-muted' }, t('暂无', "None yet")))),
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
          h('div', { className: 'dsn-hint' }, t('章节天数统计：还没有章节，生成第一章后这里会画出每章的天数。', "Chapter length chart: no chapters yet. Generate the first one and each chapter's day count appears here.")));
      }

      const width = 1000;
      const height = 152;
      const pad = { left: 52, right: 18, top: 14, bottom: 24 };
      const plotWidth = width - pad.left - pad.right;
      const plotHeight = height - pad.top - pad.bottom;
      // The bars are plain day counts: how many days each chapter spans.
      const weeks = chapters.map((chapter) => {
        const span = chapterWindow(detail, chapter);
        return { start: span.start, end: span.end, days: Math.max(1, span.end - span.start) };
      });
      const maxDays = Math.max(1, ...weeks.map((entry) => entry.days));
      // Round the axis top to a readable step so the gridlines are not "23 天".
      const rawStep = Math.max(1, maxDays / 4);
      const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
      const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rawStep) || maxDays;
      const axisTop = Math.max(step, Math.ceil(maxDays / step) * step);
      const yTicks = [];
      for (let value = 0; value <= axisTop + 0.5; value += step) yTicks.push(Math.round(value));
      // One slot per chapter, drawn in the middle of its slot.
      const slot = plotWidth / chapters.length;
      const xFor = (index) => pad.left + slot * (index + 0.5);
      const yFor = (value) => pad.top + (1 - value / axisTop) * plotHeight;
      const labelStride = Math.max(1, Math.ceil(chapters.length / 10));
      const points = weeks.map((entry, index) => `${xFor(index)},${yFor(entry.days)}`).join(' ');

      return h('div', { className: 'dsn-chart-wrap' },
        h('div', { className: 'dsn-chart-head' },
          h('span', { className: 'dsn-label' }, t('每章天数', "Days per chapter")),
          h('span', { className: 'dsn-hint' },
            t('纵轴：本章天数 · 横轴：第几章 · 共 {count} 章', 'Y: days in the chapter · X: chapter · {count} in total', { count: chapters.length }))),
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
            }, t('{n} 天', '{n} days', { n: tick })))),
          weeks.map((entry, index) => h('line', {
            key: `bar-${chapters[index].chapterId}`,
            className: 'span',
            style: { strokeWidth: Math.max(6, Math.min(28, slot * 0.42)) },
            x1: xFor(index),
            x2: xFor(index),
            y1: yFor(0),
            y2: yFor(entry.days),
          })),
          chapters.length > 1
            ? h('polyline', { className: 'line', points })
            : null,
          weeks.map((entry, index) => h('g', { key: chapters[index].chapterId },
            h('circle', {
              className: 'dot',
              cx: xFor(index),
              cy: yFor(entry.days),
              r: 3.5,
            },
            h('title', null,
              t('第 {n} 章 {title} · 本章 {days} 天（第 {start} → {end} 天）', 'Chapter {n} {title} · {days} days (day {start} → {end})', { n: index + 1, title: chapters[index].title || '', days: entry.days, start: entry.start, end: entry.end }))),
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
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, t('← 时间长河', "← Timeline")),
          h('div', { className: 'dsn-title' }, chapter ? t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: chapter.index + 1, title: chapter.title || t('未命名', 'Untitled') }) : t('章节故事', "Chapter")),
          h('div', { className: 'dsn-sub' }, window ? t('第 {start} → {end} 天', 'Day {start} → {end}', { start: window.start, end: window.end }) : ''),
          h('div', { className: 'dsn-spacer' }),
          previous
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              title: t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: previous.index + 1, title: previous.title || t('未命名', 'Untitled') }),
              onClick: () => onOpenChapter(previous.chapterId),
            }, t('← 上一章', "← Previous"))
            : null,
          next
            ? h('button', {
              className: 'dsn-btn',
              type: 'button',
              title: t('第 {n} 章 · {title}', 'Chapter {n} · {title}', { n: next.index + 1, title: next.title || t('未命名', 'Untitled') }),
              onClick: () => onOpenChapter(next.chapterId),
            }, t('下一章 →', "Next →"))
            : h('button', { className: 'dsn-btn primary', type: 'button', onClick: onNewChapter }, t('＋ 新建章节', "+ New chapter")),
          h('button', { className: 'dsn-btn ghost', type: 'button', disabled: !chapter, onClick: onOutline }, t('章节大纲 →', "Outline →"))),
        !chapter
          ? h('div', { className: 'dsn-empty' }, t('还没有章节。点右上角「＋ 新建章节」开始第一章。', "No chapters yet. Use \"+ New chapter\" at the top right to start the first one."))
          : h(React.Fragment, null,
            h('div', { className: 'dsn-editor' },
              !chapter.outline ? h('div', { className: 'dsn-note' }, t('这一章还没有保存过章节大纲，可以先回章节大纲里填写并生成。', "This chapter has no saved outline yet; fill one in under \"Outline\" and generate from there.")) : null,
              h('textarea', {
                className: 'dsn-textarea dsn-story',
                value: text,
                placeholder: t('章节正文：生成后可以直接在这里修改，改完点保存。', "Chapter text: edit it here after generation, then save."),
                onChange: (event) => onEdit(event.target.value),
              })),
            h('div', { className: 'dsn-foot' },
              h('div', { className: 'dsn-muted' },
                t('{words} 字{req}', '{words} words{req}', { words, req: chapter.outline ? t(' · 大纲要求 {min}–{max} 字', ' · outline asks for {min}–{max} words', { min: chapter.outline.minWords, max: chapter.outline.maxWords }) : '' })),
              h('div', { className: 'dsn-spacer' }),
              h('button', { className: 'dsn-btn primary', type: 'button', disabled: saving, onClick: onSave },
                saving ? t('保存中…', "Saving…") : t('保存', "Save")))));
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
          notify(t('梗概还没有达到最低字数，或字数与时间长度没填完', "The synopsis is below its minimum length, or the word bounds and the duration are incomplete."), 'error');
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
          if (silent !== true) notify(t('章节大纲已保存', "Outline saved"), 'success');
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
          notify(t('第一章没有世界快照和上一章可依据，自动推演不可用', "Auto-deduction is unavailable for the first chapter: there is no snapshot or previous chapter to build on."), 'error');
          return;
        }
        requestConfirm({
          title: t('自动推演会覆盖现有内容', "Auto-deduction overwrites everything"),
          text: t('将重新生成故事梗概、章节名称和整章正文，当前的大纲与已写的正文都会被打断覆盖，生成完直接保存。确定继续吗？', "It regenerates the synopsis, the chapter name and the whole text, replacing the current outline and any written text, then saves. Continue?"),
          confirmLabel: t('覆盖并生成', "Overwrite and generate"),
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
          title: t('以当前故事梗概生成章节故事？', "Generate the chapter from the current synopsis?"),
          text: t('会用已保存的梗概、字数限制和时间长度重写这一章的正文，现有正文会被覆盖。', "It rewrites this chapter from the saved synopsis, word bounds and duration, replacing the current text."),
          confirmLabel: t('开始生成', "Generate"),
          action: () => startJob('/generate'),
        });
      }, [requestConfirm, startJob]);

      useEffect(() => {
        if (!job) return;
        if (job.kind === 'generate' && job.state === 'done') {
          notify(t('章节生成成功', "Chapter generated"), 'success');
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
          notify(t('已重新推演并保存章节', "Re-deduced and saved the chapter"), 'success');
          onSaved(chapter ? chapter.chapterId : null);
        }
        if (job.state === 'error') {
          notify(job.error || t('任务失败', "Task failed"), 'error');
        }
      }, [job ? job.jobId : null, job ? job.state : null]);

      return h(React.Fragment, null,
        h('div', { className: 'dsn-pagehead' },
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onBack }, t('← 章节故事', "← Chapter")),
          h('div', { className: 'dsn-title' }, chapter ? t('章节大纲 · 第 {n} 章', 'Outline · chapter {n}', { n: chapter.index + 1 }) : t('章节大纲 · 新章节', "Outline · new chapter")),
          h('div', { className: 'dsn-sub' }, t('起始 第 {day} 天', 'Starts day {day}', { day: chapter ? chapterWindow(detail, chapter).start : (detail.timeline.cursor || 0) })),
          h('div', { className: 'dsn-spacer' }),
          h('button', {
            className: 'dsn-btn ghost',
            type: 'button',
            disabled: !complete || isFirstChapter || saving || Boolean(generating || composing),
            title: isFirstChapter
              ? t('第一章没有世界快照和上一章可依据，自动推演不可用；请自己写梗概后生成', "No snapshot or previous chapter for the first chapter; write its synopsis yourself and generate.")
              : t('按当前字数与时间长度，重新推演梗概、章节名称与整章正文', "Re-deduce the synopsis, the chapter name and the whole text from the current bounds and duration."),
            onClick: deduce,
          }, composing ? t('推演中…', "Deducing…") : t('自动推演', "Auto-deduce"))),
        h('div', { className: 'dsn-form' },
          h('label', { className: 'dsn-field span2' },
            h('span', { className: 'dsn-label' }, t('章节标题', "Chapter title")),
            h('input', {
              className: 'dsn-input',
              value: form.title,
              placeholder: t('例如：雨夜来客', "e.g. A Visitor in the Rain"),
              onChange: (event) => patch('title', event.target.value),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('故事时间长度（天）', "Story duration (days)")),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.durationDays,
              onChange: (event) => patch('durationDays', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('章节最低字数', "Minimum words")),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.minWords,
              onChange: (event) => patch('minWords', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('章节最多字数', "Maximum words")),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.maxWords,
              onChange: (event) => patch('maxWords', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field' },
            h('span', { className: 'dsn-label' }, t('梗概最低字数', "Minimum synopsis length")),
            h('input', {
              className: 'dsn-input',
              type: 'number',
              min: 1,
              value: form.synopsisMinChars,
              onChange: (event) => patch('synopsisMinChars', Number(event.target.value)),
            })),
          h('label', { className: 'dsn-field span4' },
            h('span', { className: 'dsn-label' }, t('故事梗概（已写 {written} / 至少 {min} 字）', 'Synopsis ({written} / at least {min} characters)', { written: synopsisLength, min: form.synopsisMinChars })),
            h('textarea', {
              className: 'dsn-textarea dsn-synopsis',
              value: form.synopsis,
              placeholder: t('这一章要发生什么：起因、经过、转折、结果。', "What happens in this chapter: setup, events, the turn, the outcome."),
              onChange: (event) => patch('synopsis', event.target.value),
            }))),
        h('div', { className: 'dsn-foot' },
          h('div', { className: `dsn-hint${complete ? '' : ' warn'}` },
            complete ? (savedAt ? t('设定完整，可以生成章节故事', "Settings complete — you can generate the chapter.") : t('设定完整，可以保存', "Settings complete — you can save.")) : t('梗概达到最低字数并填完其他项后可以保存', "Reach the synopsis minimum and fill in the rest to save.")),
          generating || composing
            ? h('div', { className: 'dsn-progress' }, h('span', { className: 'dsn-spin' }),
              composing ? (job.message || t('正在自动推演…', "Deducing…")) : t('正在生成章节故事…', "Generating the chapter…"))
            : null,
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn', type: 'button', disabled: !complete || saving || Boolean(generating || composing), onClick: () => submit(false) },
            saving ? t('保存中…', "Saving…") : t('保存', "Save")),
          h('button', {
            className: 'dsn-btn primary',
            type: 'button',
            disabled: !savedAt || Boolean(generating || composing) || !chapter,
            onClick: generate,
          }, generating ? t('生成中…', "Generating…") : t('生成章节故事', "Generate chapter"))));
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
          setError(t('第一章没有可依据的世界快照和上一章，自动推演不可用', "No world snapshot or previous chapter to build on for the first chapter; auto-deduction is unavailable."));
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
          notify(t('章节已生成', "Chapter generated"), 'success');
          onCreated(job.result && job.result.chapterId);
          return;
        }
        if (job.state === 'error') setError(job.error || t('自动推演失败', "Auto-deduction failed"));
      }, [job ? job.jobId : null, job ? job.state : null]);

      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog' },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, t('新建章节', "New chapter")),
            h('div', { className: 'dsn-sub' }, t('起始 第 {day} 天', 'Starts day {day}', { day: startDay })),
            h('div', { className: 'dsn-spacer' }),
            h('button', {
              className: 'dsn-btn ghost',
              type: 'button',
              disabled: composing || busy,
              onClick: onCancel,
            }, t('取消', "Cancel"))),
          h('div', { className: 'dsn-dialog-body' },
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, t('章节名称（可留空，自动推演会补上）', "Chapter name (optional; auto-deduction fills it)")),
              h('input', {
                className: 'dsn-input',
                value: form.title,
                placeholder: t('例如：雨夜来客', "e.g. A Visitor in the Rain"),
                onChange: (event) => patch('title', event.target.value),
              })),
            h('label', { className: 'dsn-field' },
              h('span', { className: 'dsn-label' }, t('章节最低字数 *', "Minimum words *")),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.minWords,
                onChange: (event) => patch('minWords', Number(event.target.value)),
              })),
            h('label', { className: 'dsn-field' },
              h('span', { className: 'dsn-label' }, t('章节最多字数 *', "Maximum words *")),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.maxWords,
                onChange: (event) => patch('maxWords', Number(event.target.value)),
              })),
            h('label', { className: 'dsn-field span2' },
              h('span', { className: 'dsn-label' }, t('故事时间长度（天）*', "Story duration (days) *")),
              h('input', {
                className: 'dsn-input',
                type: 'number',
                min: 1,
                value: form.durationDays,
                onChange: (event) => patch('durationDays', Number(event.target.value)),
              })),
            error ? h('div', { className: 'dsn-hint warn span2' }, error) : null,
            isFirstChapter
              ? h('div', { className: 'dsn-hint span2' }, t('这是作品的第一章：没有世界快照和上一章可依据，自动推演不可用。先创建空章节，再自己写梗概生成。', "This is the work's first chapter: there is no snapshot or previous chapter, so auto-deduction is unavailable. Create an empty chapter, write its synopsis, then generate."))
              : null),
          h('div', { className: 'dsn-dialog-foot' },
            composing ? h('div', { className: 'dsn-progress' }, h('span', { className: 'dsn-spin' }), job.message || t('正在自动推演…', "Deducing…")) : null,
            h('div', { className: 'dsn-spacer' }),
            h('button', {
              className: 'dsn-btn',
              type: 'button',
              disabled: !complete || busy || composing,
              onClick: create,
            }, busy ? t('创建中…', "Creating…") : t('创建空章节', "Create empty chapter")),
            h('button', {
              className: 'dsn-btn primary',
              type: 'button',
              disabled: !complete || busy || composing || isFirstChapter,
              title: isFirstChapter ? t('第一章没有可依据的快照与上一章，自动推演不可用', "No snapshot or previous chapter to build on; auto-deduction is unavailable.") : '',
              onClick: compose,
            }, composing ? t('自动推演中…', "Deducing…") : t('自动推演', "Auto-deduce")))));
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
            h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onCancel }, cancelLabel || t('取消', "Cancel")),
            h('div', { className: 'dsn-spacer' }),
            h('button', { className: 'dsn-btn primary', type: 'button', onClick: onConfirm }, confirmLabel || t('确定', "OK")))));
    }

    /* --------------------------------------------------------- leave confirm */

    /** Asked whenever unsaved chapter text or outline edits would be left behind. */
    function LeaveConfirm({ what, onCancel, onDiscard, onSave }) {
      return h('div', { className: 'dsn-dialog-backdrop' },
        h('div', { className: 'dsn-dialog', style: { width: 'min(420px, calc(100% - 48px))' } },
          h('div', { className: 'dsn-dialog-head' },
            h('div', { className: 'dsn-title' }, t('{what}还没有保存', '{what} has unsaved changes', { what: what || t('这一章', 'This chapter') })),
            h('div', { className: 'dsn-spacer' })),
          h('div', { className: 'dsn-dialog-body', style: { gridTemplateColumns: '1fr' } },
            h('div', { className: 'dsn-text', style: { fontSize: 12 } },
              t('离开这个界面会丢掉刚才的修改。要先保存吗？', "Leaving this screen discards your edits. Save first?"))),
          h('div', { className: 'dsn-dialog-foot' },
            h('button', { className: 'dsn-btn ghost', type: 'button', onClick: onCancel }, t('取消', "Cancel")),
            h('div', { className: 'dsn-spacer' }),
            h('button', { className: 'dsn-btn', type: 'button', onClick: onDiscard }, t('不保存离开', "Leave without saving")),
            h('button', { className: 'dsn-btn primary', type: 'button', onClick: onSave }, t('保存并离开', "Save and leave")))));
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
          if (silent !== true) notify(t('章节已保存', "Chapter saved"), 'success');
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
          notify(t('正在结算世界快照…', "Settling the world snapshot…"), 'success');
          const timer = setInterval(async () => {
            try {
              const job = await api(`/job?id=${encodeURIComponent(started.jobId)}`);
              if (job.state === 'running') return;
              clearInterval(timer);
              setSnapshotBusy(false);
              if (job.state === 'done') {
                notify(t('世界快照已更新，时间线向前延伸', "World snapshot updated; the timeline moved forward."), 'success');
                await onReload();
              } else {
                notify(job.error || t('世界快照更新失败', "World snapshot update failed"), 'error');
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
            what: pendingLeave.page === 'outline' ? t('这份章节大纲', "This outline") : t('这一章的正文', "this chapter's text"),
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

    function StudioApp({ resolveWorkspace }) {
      // Subscribes every screen below to Settings → General → Language.
      useLocaleId();
      const [boot, setBoot] = useState(null);
      const [error, setError] = useState('');
      const [projectId, setProjectId] = useState(null);
      const [detail, setDetail] = useState(null);
      const [toast, setToast] = useToast();
      const [modelTarget, setModelTarget] = useState(null);
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
            }, t('← 作品列表', '← Projects'))
            : h('div', { className: 'dsn-title' }, t('小说工坊', 'Novel Studio')),
          projectId && detail ? h('div', { className: 'dsn-sub' }, detail.title) : null,
          h('div', { className: 'dsn-spacer' }),
          h('button', { className: 'dsn-btn ghost', type: 'button', onClick: close }, t('关闭', 'Close'))),
        error ? h('div', { className: 'dsn-error' }, error) : null,
        h('div', { className: 'dsn-body' },
          boot === null
            ? h('div', { className: 'dsn-empty', style: { margin: 'auto' } }, t('正在载入…', 'Loading…'))
            : projectId === null
              ? h('div', { className: 'dsn-scroll' },
                h(ProjectsPage, {
                  boot,
                  resolveWorkspace,
                  onOpen: openProject,
                  onReload: loadBoot,
                  onEditModel: setModelTarget,
                }))
              : detail === null
                ? h('div', { className: 'dsn-empty', style: { margin: 'auto' } }, t('正在载入作品…', "Loading the work…"))
                : h(ProjectWorkspace, {
                  key: detail.projectId,
                  detail,
                  onReload: reloadDetail,
                  notify,
                  onRegisterLeaveGuard: registerLeaveGuard,
                })),
        modelTarget
          ? h(ModelDialog, {
            project: modelTarget,
            models: boot ? boot.models : null,
            onCancel: () => setModelTarget(null),
            onSaved: async (warning) => {
              const target = modelTarget;
              setModelTarget(null);
              await loadBoot();
              if (target && projectId === target.projectId) await loadDetail(target.projectId);
              if (warning) setError(warning);
            },
          })
          : null);
    }

    function StudioOverlay({ resolveWorkspace }) {
      const open = useOverlayOpen();
      if (!open) return null;
      // No backdrop-click close: leaving with unsaved chapter text goes through
      // the 关闭 button, which asks first.
      return h('div', { className: 'dsn-overlay' }, h(StudioApp, { resolveWorkspace }));
    }

    /* ---------------------------------------------------------------- apply */

    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * Read at use time, not at activation: this plugin may mount before the
         * workspace UI that owns `uiWorkspace`, and a captured instance would
         * then be undefined for the life of the page.
         */
        const resolveWorkspace = () => ctx.get('uiWorkspace') || null;
        // Settings → General → Language drives every string that goes through
        // the translator below; a host without the service stays Chinese.
        localeService = ctx.get('locale') || null;
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dsh-novel-generator-launch',
          order: 30,
        }, Launcher));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-novel-generator-studio',
          order: 40,
        }, () => h(StudioOverlay, { resolveWorkspace })));
      },
    };
  },
});
