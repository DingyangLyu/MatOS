import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Express, Response } from 'express';
import { projectFilePage } from '../../services/project-file-page.js';
import {
  type ChatSessionMode,
  type ProjectFile,
  type ProjectFileVersion,
  type ProjectFileVersionPromptSource,
  type ProjectFileVersionSource,
  type ProjectFileVersionWarning,
  type ProjectEditorWorkspaceResponse,
} from '@open-design/contracts';
import { changedProjectName, reserveUntitledProjectName, validatedProjectName } from '../../services/project-names.js';
import { syncProjectEditorWorkspace } from '../../services/project-editor-workspace.js';
import { listProjectConversationOverviews } from '../../db.js';
import { createProjectArtifactFile } from '../../artifacts/create.js';
import { ArtifactPublicationBlockedError } from '../../artifacts/publication-guard.js';
import { ArtifactRegressionError } from '../../artifacts/stub-guard.js';
import {
  createProjectFileVersion,
  isProjectFileVersionPath,
  listProjectFileVersions,
  markProjectFileVersionStoreDeleted,
  readProjectFileVersion,
  renameProjectFileVersionStore,
  withProjectFileVersionLock,
} from '../../project-file-versions.js';
import type { RouteDeps } from '../../server-context.js';
import { listSkills } from '../../skills.js';
import {
  dropCachedProjectFiles,
  invalidateCachedProjectFiles,
  isProjectFileCommitIntermediateEventPath,
  isSafeId,
  listCachedProjectFiles,
  retainCachedProjectFilesWatcher,
  updateCachedProjectFilesFromEvent,
} from '../../projects.js';
import {
  BUILT_IN_PROJECT_LOCATION_ID,
  SHARED_WORKSPACES_PROJECT_LOCATION_ID,
  allProjectLocations,
  createLocationProjectDir,
  ensureProjectLocation,
  envDefaultProjectLocation,
  readProjectManifest,
  scanProjectLocation,
  type ProjectLocation,
  writeProjectManifest,
} from '../../project-locations.js';
import { parseOrchestratorWorkspace } from '../../workspace-contract.js';
import { registerProjectConversationRoutes } from './conversations.js';
import {
  mergeMatOSProjectAuthorityMetadata,
  readMatOSProjectAuthority,
  syncMatOSProjectConversationsAuthority,
  syncMatOSProjectAuthority,
} from '../../services/matos-project-authority.js';

export interface RegisterProjectRoutesDeps extends RouteDeps<'db' | 'design' | 'http' | 'paths' | 'projectStore' | 'projectFiles' | 'conversations' | 'templates' | 'status' | 'events' | 'ids' | 'appConfig' | 'agents' | 'validation' | 'chat' | 'messages' | 'lifecycle'> {}

// SQLite stores a projection of `.matos/project.json`. Serializing PATCHes
// per project prevents an older request from syncing the native authority and
// then overwriting SQLite after a newer request has already committed.
const projectPatchQueues = new Map<string, Promise<void>>();

async function enterProjectPatchQueue(projectId: string): Promise<() => void> {
  const previous = projectPatchQueues.get(projectId) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>(resolve => {
    releaseCurrent = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  projectPatchQueues.set(projectId, next);
  await previous.catch(() => undefined);
  return () => {
    releaseCurrent();
    if (projectPatchQueues.get(projectId) === next) {
      projectPatchQueues.delete(projectId);
    }
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await mapper(items[index]!);
      }
    },
  ));
  return results;
}

export function projectDetailResolvedDir(
  projectsRoot: string,
  project: any,
  resolveProjectDir: (
    projectsRoot: string,
    projectId: string,
    metadata?: unknown,
    opts?: { allowUnavailableSandboxImportedProject?: boolean },
  ) => string,
): string {
  const baseDir = typeof project?.metadata?.baseDir === 'string'
    ? path.normalize(project.metadata.baseDir)
    : null;
  if (baseDir && path.isAbsolute(baseDir)) return baseDir;
  return resolveProjectDir(projectsRoot, project.id, project.metadata, {
    allowUnavailableSandboxImportedProject: true,
  });
}

/**
 * Materialize a *managed* project's folder before it is referenced as
 * read-only context for another run.
 *
 * Invariant: after this resolves for a managed project, `PROJECTS_DIR/<id>`
 * exists on disk. A brand-new project has a DB row but no on-disk directory
 * until its first file write, so without this a reference resolves to a path
 * that fails both the composer's existence probe and the daemon's
 * all-or-nothing linkedDirs validation. External / imported roots (an absolute
 * `metadata.baseDir`) are the user's own folders and are never created here.
 * Materialization failures are required failures: callers must surface them
 * instead of continuing with a resolvedDir that may not exist.
 */
export async function ensureReferencedProjectDir(
  projectsRoot: string,
  project: { id: string; metadata?: unknown },
  ensureProject: (projectsRoot: string, projectId: string, metadata?: unknown) => Promise<string>,
): Promise<void> {
  const metadata = (project?.metadata ?? null) as { baseDir?: unknown } | null;
  const baseDir = typeof metadata?.baseDir === 'string'
    ? path.normalize(metadata.baseDir)
    : null;
  const managedRoot = !(baseDir && path.isAbsolute(baseDir));
  if (!managedRoot) return;
  await ensureProject(projectsRoot, project.id, project.metadata);
}

const URL_PREVIEW_SCROLL_BRIDGE = `<script data-od-url-scroll-bridge>
(function(){
  if (window.__odUrlScrollBridge) return;
  window.__odUrlScrollBridge = true;
  var pending = false;
  function scrollElement(){
    return document.querySelector('.design-canvas') || document.scrollingElement || document.documentElement;
  }
  function num(value){
    var next = Number(value || 0);
    return Number.isFinite(next) ? next : 0;
  }
  function post(){
    var el = scrollElement();
    if (!el) return;
    var frame = document.scrollingElement || document.documentElement;
    window.parent.postMessage({
      type: 'od:preview-scroll',
      canvasLeft: Math.round(el.scrollLeft || 0),
      canvasTop: Math.round(el.scrollTop || 0),
      frameLeft: Math.round(frame.scrollLeft || 0),
      frameTop: Math.round(frame.scrollTop || 0)
    }, '*');
  }
  function schedule(){
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function(){
      pending = false;
      post();
    });
  }
  function scrollTo(el, left, top){
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo(num(left), num(top));
    else {
      el.scrollLeft = num(left);
      el.scrollTop = num(top);
    }
  }
  function scrollBy(el, left, top){
    if (!el) return;
    var dx = num(left);
    var dy = num(top);
    if (!dx && !dy) return;
    if (typeof el.scrollBy === 'function') el.scrollBy({ left: dx, top: dy, behavior: 'auto' });
    else {
      el.scrollLeft = (el.scrollLeft || 0) + dx;
      el.scrollTop = (el.scrollTop || 0) + dy;
    }
  }
  function requestRestore(){
    window.parent.postMessage({ type: 'od:preview-scroll-request' }, '*');
  }
  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || !data.type) return;
    if (data.type === 'od:preview-scroll-restore') {
      scrollTo(document.scrollingElement || document.documentElement, data.frameLeft, data.frameTop);
      scrollTo(scrollElement(), data.canvasLeft, data.canvasTop);
      setTimeout(post, 0);
      return;
    }
    if (data.type === 'od:preview-scroll-by') {
      scrollBy(scrollElement(), data.left, data.top);
      schedule();
    }
  });
  window.addEventListener('scroll', schedule, true);
  document.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function(){
      requestRestore();
      schedule();
    });
  } else {
    setTimeout(function(){
      requestRestore();
      schedule();
    }, 0);
  }
})();
</script>`;

function sameOrchestratorWorkspace(a: unknown, b: unknown): boolean {
  const parsedA = parseOrchestratorWorkspace(a);
  const parsedB = parseOrchestratorWorkspace(b);
  if (!parsedA.ok || !parsedB.ok) return false;
  return JSON.stringify(parsedA.value) === JSON.stringify(parsedB.value);
}

const URL_PREVIEW_SELECTION_BRIDGE = `<script data-od-url-selection-bridge>
(function(){
  if (window.__odUrlSelectionBridge) return;
  window.__odUrlSelectionBridge = true;
  var commentEnabled = false;
  var mode = 'picker';
  var hoveredId = null;
  var drawing = false;
  var stroke = [];
  var strokeFrame = null;
  var postTargetsPending = false;
  var postTargetsTimer = null;
  var activeCommentElementId = null;
  var activeCommentSelector = null;
  var activeTargetPending = false;
  function esc(value){
    try { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\\\"'); }
    catch (_) { return String(value); }
  }
  function ensureStyle(){
    if (document.querySelector('style[data-od-url-selection-style]')) return;
    var style = document.createElement('style');
    style.setAttribute('data-od-url-selection-style', '');
    style.textContent =
      'html[data-od-comment-mode] body * { cursor: crosshair !important; }' +
      'html[data-od-comment-mode][data-od-comment-mode-kind="pod"] body * { cursor: cell !important; }' +
      'html[data-od-comment-mode] body iframe,html[data-od-comment-mode] body object,html[data-od-comment-mode] body embed { pointer-events: none !important; }';
    (document.head || document.documentElement).appendChild(style);
  }
  function active(){ return commentEnabled; }
  function annotatedSelectorFor(el){
    var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label');
    if (!id) return null;
    return el.hasAttribute('data-od-id') ? '[data-od-id="' + esc(id) + '"]' : '[data-screen-label="' + esc(id) + '"]';
  }
  function domSelectorFor(el){
    if (!el || !el.tagName || el === document.documentElement || el === document.body) return null;
    var parts = [];
    var node = el;
    while (node && node !== document.documentElement && node !== document.body) {
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (!tag || /^(script|style|template|meta|link|title|noscript)$/.test(tag)) return null;
      var parent = node.parentElement;
      if (!parent) return null;
      var index = 1;
      var sibling = node.previousElementSibling;
      while (sibling) {
        if (sibling.tagName && sibling.tagName.toLowerCase() === tag) index++;
        sibling = sibling.previousElementSibling;
      }
      parts.unshift(tag + ':nth-of-type(' + index + ')');
      node = parent;
    }
    return parts.length ? 'body > ' + parts.join(' > ') : null;
  }
  function visibleTarget(el){
    if (!el || !el.getBoundingClientRect) return false;
    if (el === document.documentElement || el === document.body) return false;
    if (/^(script|style|template|meta|link|title|noscript)$/.test(el.tagName ? el.tagName.toLowerCase() : '')) return false;
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      var cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return false;
    } catch (_) { return false; }
    return true;
  }
  function meaningfulDomFallbackTarget(el){
    if (!visibleTarget(el)) return false;
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (/^(a|button|input|textarea|select|label|img|video|canvas|h1|h2|h3|h4|h5|h6|p|li|td|th)$/.test(tag)) return true;
    if (el.getAttribute && (el.getAttribute('role') || el.getAttribute('aria-label') || el.getAttribute('title'))) return true;
    if (tag === 'svg') return !!(el.getAttribute && (el.getAttribute('role') || el.getAttribute('aria-label') || el.getAttribute('title')));
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (!text) return false;
    if (/^(span|strong|em|b|i|small|code|mark)$/.test(tag)) return true;
    var meaningfulChildren = 0;
    for (var child = el.firstElementChild; child; child = child.nextElementSibling) {
      var childTag = child.tagName ? child.tagName.toLowerCase() : '';
      if (/^(script|style|template|meta|link|title|noscript)$/.test(childTag)) continue;
      if ((child.textContent || '').replace(/\\s+/g, ' ').trim() || /^(img|video|canvas|svg|input|textarea|select)$/.test(childTag)) {
        meaningfulChildren++;
        if (meaningfulChildren > 1) return false;
      }
    }
    return true;
  }
  function generatedRootAnnotation(el, id){
    return id === 'path-0' && el && el.parentElement === document.body && el.id === 'root';
  }
  function styleSnapshot(el){
    try {
      var cs = window.getComputedStyle(el);
      return {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        lineHeight: cs.lineHeight,
        paddingTop: cs.paddingTop,
        paddingRight: cs.paddingRight,
        paddingBottom: cs.paddingBottom,
        paddingLeft: cs.paddingLeft,
        borderRadius: cs.borderTopLeftRadius,
        textAlign: cs.textAlign,
        fontFamily: cs.fontFamily
      };
    } catch (_) { return null; }
  }
  function targetFrom(el, allowDomFallback, clickedEl, clickPoint){
    var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label');
    if (allowDomFallback && id && generatedRootAnnotation(el, id)) return null;
    var selector = annotatedSelectorFor(el);
    if (!id && allowDomFallback && meaningfulDomFallbackTarget(el)) {
      selector = domSelectorFor(el);
      if (selector) id = 'dom:' + selector;
    }
    if (!id || !selector) return null;
    var rect = el.getBoundingClientRect();
    var tag = el.tagName ? el.tagName.toLowerCase() : 'element';
    var cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    var html = '';
    try {
      var match = (el.outerHTML || '').replace(/\\s+/g, ' ').match(/^<[^>]+>/);
      html = match ? match[0] : '';
    } catch (_) {}
    var payload = {
      type: 'od:comment-target',
      elementId: id,
      selector: selector,
      label: tag + cls,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
      position: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      htmlHint: html.slice(0, 180),
      style: styleSnapshot(el)
    };
    if (clickPoint) payload.hoverPoint = { x: Math.round(clickPoint.x), y: Math.round(clickPoint.y) };
    if (clickedEl && clickedEl !== el) {
      var clickedTag = clickedEl.tagName ? clickedEl.tagName.toLowerCase() : 'element';
      var clickedCls = typeof clickedEl.className === 'string' && clickedEl.className.trim() ? '.' + clickedEl.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      payload.clickedDescendant = {
        label: clickedTag + clickedCls,
        text: (clickedEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
      };
    }
    return payload;
  }
  function allTargets(){
    var includeDomFallback = commentEnabled && mode === 'picker';
    var nodes = includeDomFallback ? document.querySelectorAll('body *') : document.querySelectorAll('[data-od-id], [data-screen-label]');
    var items = [];
    var seen = Object.create(null);
    for (var i = 0; i < nodes.length; i++) {
      var item = targetFrom(nodes[i], includeDomFallback);
      if (item && !seen[item.elementId]) {
        seen[item.elementId] = true;
        items.push(item);
      }
    }
    return items;
  }
  function postTargets(){
    if (!active()) return;
    window.parent.postMessage({ type: 'od:comment-targets', targets: allTargets() }, '*');
  }
  function schedulePostTargets(){
    if (!active() || postTargetsPending) return;
    postTargetsPending = true;
    if (postTargetsTimer) window.clearTimeout(postTargetsTimer);
    postTargetsTimer = window.setTimeout(function(){
      window.requestAnimationFrame(function(){
        postTargetsPending = false;
        postTargetsTimer = null;
        postTargets();
      });
    }, 120);
  }
  function findCommentTargetByIdentity(elementId, selector){
    var el = null;
    if (selector) {
      try { el = document.querySelector(String(selector)); } catch (_) { el = null; }
    }
    if (!el && elementId) {
      try {
        var id = String(elementId).replace(/"/g, '\\\\"');
        el = document.querySelector('[data-od-id="' + id + '"], [data-screen-label="' + id + '"]');
      } catch (_) { el = null; }
    }
    return el;
  }
  function postActiveCommentTarget(){
    if (!active() || !activeCommentElementId) return;
    var el = findCommentTargetByIdentity(activeCommentElementId, activeCommentSelector);
    if (!el) return;
    var payload = targetFrom(el, commentEnabled && mode === 'picker');
    if (payload) window.parent.postMessage(Object.assign({}, payload, { type: 'od:comment-active-target-update' }), '*');
  }
  function schedulePostActiveCommentTarget(){
    if (!active() || !activeCommentElementId || activeTargetPending) return;
    activeTargetPending = true;
    window.requestAnimationFrame(function(){
      activeTargetPending = false;
      postActiveCommentTarget();
    });
  }
  function eventCandidateElements(event){
    var items = [];
    function push(node){
      if (!node || node.nodeType !== 1) return;
      if (items.indexOf(node) >= 0) return;
      items.push(node);
    }
    try {
      if (event && typeof event.composedPath === 'function') {
        var path = event.composedPath();
        for (var i = 0; i < path.length; i++) push(path[i]);
      }
    } catch (_) {}
    push(event && event.target);
    try {
      if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number' && document.elementsFromPoint) {
        var stack = document.elementsFromPoint(event.clientX, event.clientY);
        for (var s = 0; s < stack.length; s++) push(stack[s]);
      } else if (event && typeof event.clientX === 'number' && typeof event.clientY === 'number' && document.elementFromPoint) {
        push(document.elementFromPoint(event.clientX, event.clientY));
      }
    } catch (_) {}
    return items;
  }
  function closestTarget(event){
    var candidates = eventCandidateElements(event);
    var allowDomFallback = commentEnabled && mode === 'picker';
    var annotatedFallback = null;
    for (var i = 0; i < candidates.length; i++) {
      var clicked = candidates[i];
      var el = clicked;
      while (el && el !== document.documentElement) {
        if (allowDomFallback && meaningfulDomFallbackTarget(el)) return { target: el, clicked: clicked };
        if (el.getAttribute && (el.hasAttribute('data-od-id') || el.hasAttribute('data-screen-label'))) {
          var id = el.getAttribute('data-od-id') || el.getAttribute('data-screen-label');
          if (allowDomFallback && generatedRootAnnotation(el, id)) {
            el = el.parentElement;
            continue;
          }
          if (allowDomFallback && !annotatedFallback) annotatedFallback = { target: el, clicked: clicked };
          if (allowDomFallback) break;
          return { target: el, clicked: clicked };
        }
        el = el.parentElement;
      }
    }
    return annotatedFallback;
  }
  function relativePoint(ev){ return { x: Math.round(ev.clientX), y: Math.round(ev.clientY) }; }
  function postStroke(type){ window.parent.postMessage({ type: type, points: stroke.slice() }, '*'); }
  function schedulePostStroke(){
    if (strokeFrame !== null) return;
    strokeFrame = requestAnimationFrame(function(){
      strokeFrame = null;
      postStroke('od:pod-stroke');
    });
  }
  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || !data.type) return;
    if (data.type === 'od:url-selection-bridge-probe') {
      window.parent.postMessage({ type: 'od:url-selection-bridge-ready' }, '*');
      return;
    }
    if (data.type === 'od:comment-mode') {
      commentEnabled = !!data.enabled;
      mode = data.mode === 'pod' ? 'pod' : 'picker';
      document.documentElement.toggleAttribute('data-od-comment-mode', commentEnabled);
      document.documentElement.setAttribute('data-od-comment-mode-kind', mode);
      if (commentEnabled) setTimeout(postTargets, 0);
      else {
        hoveredId = null;
        activeCommentElementId = null;
        activeCommentSelector = null;
      }
      if (!commentEnabled || mode !== 'pod') {
        drawing = false;
        stroke = [];
        try { window.parent.postMessage({ type: 'od:pod-clear' }, '*'); } catch (_) {}
      }
      return;
    }
    if (data.type === 'od:comment-active-target') {
      activeCommentElementId = data.elementId ? String(data.elementId) : null;
      activeCommentSelector = data.selector ? String(data.selector) : null;
      schedulePostActiveCommentTarget();
    }
  });
  document.addEventListener('mouseover', function(ev){
    if (!commentEnabled || mode !== 'picker') return;
    var result = closestTarget(ev);
    if (!result) return;
    var payload = targetFrom(result.target, true);
    if (!payload || payload.elementId === hoveredId) return;
    hoveredId = payload.elementId;
    window.parent.postMessage(Object.assign({}, payload, { type: 'od:comment-hover' }), '*');
  }, true);
  document.addEventListener('mouseout', function(ev){
    if (!commentEnabled || mode !== 'picker') return;
    var result = closestTarget(ev);
    if (!result) return;
    var next = ev.relatedTarget;
    while (next && next !== document.documentElement) {
      if (next === result.target) return;
      next = next.parentElement;
    }
    hoveredId = null;
    window.parent.postMessage({ type: 'od:comment-leave' }, '*');
  }, true);
  document.addEventListener('click', function(ev){
    if (!commentEnabled || mode !== 'picker') return;
    var result = closestTarget(ev);
    if (result) {
      ev.preventDefault();
      ev.stopPropagation();
      var payload = targetFrom(result.target, true, result.clicked, { x: ev.clientX, y: ev.clientY });
      if (payload) {
        activeCommentElementId = payload.elementId || activeCommentElementId;
        activeCommentSelector = payload.selector || activeCommentSelector;
        window.parent.postMessage(payload, '*');
      }
      return;
    }
    var t = ev.target;
    var walk = t && t.nodeType === 1 ? t : null;
    while (walk && walk !== document.documentElement) {
      var tag = walk.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'LABEL') return;
      if (walk.isContentEditable) return;
      walk = walk.parentElement;
    }
    ev.preventDefault();
    ev.stopPropagation();
    var pinX = Math.round(ev.clientX);
    var pinY = Math.round(ev.clientY);
    var pinId = 'pin-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    window.parent.postMessage({
      type: 'od:comment-target',
      elementId: pinId,
      selector: '[data-od-pin="' + pinId + '"]',
      label: 'pin',
      text: '',
      position: { x: pinX - 12, y: pinY - 12, width: 24, height: 24 },
      hoverPoint: { x: pinX, y: pinY },
      htmlHint: '',
      style: null,
      freePin: true
    }, '*');
  }, true);
  document.addEventListener('pointerdown', function(ev){
    if (!commentEnabled || mode !== 'pod' || ev.button !== 0) return;
    drawing = true;
    stroke = [relativePoint(ev)];
    ev.preventDefault();
    ev.stopPropagation();
    postStroke('od:pod-stroke');
  }, true);
  document.addEventListener('pointermove', function(ev){
    if (!drawing || mode !== 'pod') return;
    var point = relativePoint(ev);
    var last = stroke[stroke.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) < 4) return;
    stroke.push(point);
    ev.preventDefault();
    ev.stopPropagation();
    schedulePostStroke();
  }, true);
  function finishStroke(ev){
    if (!drawing || mode !== 'pod') return;
    drawing = false;
    if (strokeFrame !== null) { cancelAnimationFrame(strokeFrame); strokeFrame = null; }
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    postStroke('od:pod-select');
  }
  document.addEventListener('pointerup', finishStroke, true);
  document.addEventListener('pointercancel', finishStroke, true);
  window.addEventListener('resize', schedulePostTargets);
  document.addEventListener('scroll', function(){
    schedulePostActiveCommentTarget();
    schedulePostTargets();
  }, true);
  var mo = new MutationObserver(schedulePostTargets);
  mo.observe(document.documentElement, { subtree: true, childList: true });
  ensureStyle();
  window.parent.postMessage({ type: 'od:url-selection-bridge-ready' }, '*');
})();
</script>`;

const URL_PREVIEW_SNAPSHOT_BRIDGE = `<script data-od-url-snapshot-bridge>
(function(){
  if (window.__odUrlSnapshotBridge) return;
  window.__odUrlSnapshotBridge = true;
  var SNAPSHOT_STYLE_PROPS = [
    'display','position','box-sizing','width','height','min-width','max-width','min-height','max-height',
    'margin','margin-top','margin-right','margin-bottom','margin-left',
    'padding','padding-top','padding-right','padding-bottom','padding-left',
    'border','border-top','border-right','border-bottom','border-left','border-radius',
    'font','font-family','font-size','font-weight','font-style','line-height','letter-spacing',
    'color','background-color','opacity','transform','transform-origin','overflow','overflow-x','overflow-y',
    'white-space','text-align','vertical-align','object-fit','object-position',
    'flex','flex-direction','flex-wrap','flex-grow','flex-shrink','flex-basis',
    'grid','grid-template-columns','grid-template-rows','grid-column','grid-row',
    'gap','row-gap','column-gap','align-items','align-content','align-self',
    'justify-items','justify-content','justify-self','inset','top','right','bottom','left',
    'z-index','box-shadow','text-shadow'
  ];
  function copyComputedStyle(source, target){
    if (!source || !target || source.nodeType !== 1 || target.nodeType !== 1) return;
    var computed = window.getComputedStyle(source);
    var style = target.getAttribute('style') || '';
    for (var i = 0; i < SNAPSHOT_STYLE_PROPS.length; i++){
      var prop = SNAPSHOT_STYLE_PROPS[i];
      var value = computed.getPropertyValue(prop);
      if (value) style += prop + ':' + value + ';';
    }
    target.setAttribute('style', style);
  }
  function syncElementState(source, target){
    var tag = source.tagName ? source.tagName.toLowerCase() : '';
    if (tag === 'img' && source.currentSrc) target.setAttribute('src', source.currentSrc);
    if (tag === 'input' || tag === 'textarea') target.setAttribute('value', source.value || '');
    if (tag === 'canvas') {
      try {
        var img = document.createElement('img');
        img.setAttribute('src', source.toDataURL('image/png'));
        img.setAttribute('style', target.getAttribute('style') || '');
        target.parentNode && target.parentNode.replaceChild(img, target);
      } catch (_) {}
    }
  }
  function inlineSnapshotStyles(originalRoot, cloneRoot){
    copyComputedStyle(originalRoot, cloneRoot);
    syncElementState(originalRoot, cloneRoot);
    var originals = originalRoot.querySelectorAll('*');
    var clones = cloneRoot.querySelectorAll('*');
    var count = Math.min(originals.length, clones.length, 3500);
    for (var i = 0; i < count; i++){
      copyComputedStyle(originals[i], clones[i]);
      syncElementState(originals[i], clones[i]);
    }
    var scripts = cloneRoot.querySelectorAll('script');
    for (var s = scripts.length - 1; s >= 0; s--) scripts[s].remove();
    var links = cloneRoot.querySelectorAll('link[rel~="stylesheet"], link[rel~="preload"], link[rel~="preconnect"]');
    for (var l = links.length - 1; l >= 0; l--) links[l].remove();
    var styles = cloneRoot.querySelectorAll('style');
    for (var st = 0; st < styles.length; st++) {
      styles[st].textContent = (styles[st].textContent || '')
        .replace(/@import[^;]+;/gi, '')
        .replace(/@font-face\\s*\\{[^}]*\\}/gi, '');
    }
  }
  function pruneHiddenSnapshotNodes(originalRoot, cloneRoot){
    var originals = originalRoot.querySelectorAll('*');
    var clones = cloneRoot.querySelectorAll('*');
    var count = Math.min(originals.length, clones.length);
    var removals = [];
    for (var i = 0; i < count; i++){
      var original = originals[i];
      var clone = clones[i];
      if (!original || !clone || !clone.parentNode) continue;
      var computed = window.getComputedStyle(original);
      if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) removals.push(clone);
    }
    for (var r = removals.length - 1; r >= 0; r--) {
      if (removals[r].parentNode) removals[r].parentNode.removeChild(removals[r]);
    }
  }
  function waitForImages(){
    var imgs = Array.prototype.slice.call(document.images || []);
    return Promise.all(imgs.map(function(img){
      if (img.complete) return Promise.resolve();
      return new Promise(function(resolve){
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }));
  }
  function scrollOffset(){
    var doc = document.documentElement;
    var body = document.body;
    return {
      x: Math.max(window.scrollX || 0, doc ? doc.scrollLeft || 0 : 0, body ? body.scrollLeft || 0 : 0),
      y: Math.max(window.scrollY || 0, doc ? doc.scrollTop || 0 : 0, body ? body.scrollTop || 0 : 0)
    };
  }
  function escapeAttribute(value){
    return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
  function snapshotBackgroundColor(){
    try {
      var probe = window.getComputedStyle(document.body || document.documentElement);
      var bg = probe && probe.backgroundColor || '';
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return '#ffffff';
      return bg;
    } catch (_) { return '#ffffff'; }
  }
  function canvasLooksBlank(ctx, cw, ch){
    try {
      var data = ctx.getImageData(0, 0, cw, ch).data;
      var step = Math.max(4, Math.floor((cw * ch) / 4096)) * 4;
      var first = null, samples = 0;
      for (var i = 0; i + 3 < data.length; i += step){
        samples++;
        if (!first){ first = [data[i], data[i+1], data[i+2], data[i+3]]; continue; }
        if (Math.abs(data[i]-first[0]) > 6 || Math.abs(data[i+1]-first[1]) > 6 ||
            Math.abs(data[i+2]-first[2]) > 6 || Math.abs(data[i+3]-first[3]) > 6) return false;
      }
      return samples > 8;
    } catch (_) { return false; }
  }
  function renderSnapshot(id){
    var w = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    var h = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    var dpr = window.devicePixelRatio || 1;
    var bgColor = snapshotBackgroundColor();
    var docW = Math.max(w, document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0);
    var docH = Math.max(h, document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0);
    var clone = document.documentElement.cloneNode(true);
    clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    inlineSnapshotStyles(document.documentElement, clone);
    pruneHiddenSnapshotNodes(document.documentElement, clone);
    var scroll = scrollOffset();
    var cloneBody = clone.querySelector('body');
    var rootStyle = clone.getAttribute('style') || '';
    var bodyStyle = cloneBody ? cloneBody.getAttribute('style') || '' : '';
    var bodyContent = cloneBody ? cloneBody.innerHTML : clone.innerHTML;
    var wrapperStyle = rootStyle + bodyStyle +
      'margin:0;position:relative;left:' + (-scroll.x) + 'px;top:' + (-scroll.y) + 'px;' +
      'width:' + docW + 'px;height:' + docH + 'px;overflow:visible;';
    var html = '<div xmlns="http://www.w3.org/1999/xhtml" style="' + escapeAttribute(wrapperStyle) + '">' + bodyContent + '</div>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<foreignObject x="0" y="0" width="' + docW + '" height="' + docH + '">' + html + '</foreignObject></svg>';
    var img = new Image();
    img.onload = function(){
      try {
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
        var ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('no 2d context');
        ctx.scale(dpr, dpr);
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        if (canvasLooksBlank(ctx, canvas.width, canvas.height)) {
          window.parent.postMessage({ type: 'od:snapshot:result', id: id, error: 'empty-render' }, '*');
          return;
        }
        window.parent.postMessage({ type: 'od:snapshot:result', id: id, dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height }, '*');
      } catch (err) {
        window.parent.postMessage({ type: 'od:snapshot:result', id: id, error: String(err && err.message || err) }, '*');
      }
    };
    img.onerror = function(){
      window.parent.postMessage({ type: 'od:snapshot:result', id: id, error: 'snapshot image failed' }, '*');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  window.addEventListener('message', function(ev){
    var data = ev && ev.data;
    if (!data || data.type !== 'od:snapshot' || !data.id) return;
    waitForImages().then(function(){ renderSnapshot(String(data.id)); });
  });
})();
</script>`;

function previewBridgeTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(previewBridgeTokens);
  if (typeof value !== 'string') return [];
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function wantsUrlPreviewScrollBridge(value: unknown): boolean {
  return previewBridgeTokens(value).some((token) => token === 'scroll' || token === '1' || token === 'true');
}

function wantsUrlPreviewSelectionBridge(value: unknown): boolean {
  return previewBridgeTokens(value).some((token) => token === 'selection' || token === 'comment' || token === 'comments' || token === 'annotation');
}

function wantsUrlPreviewSnapshotBridge(value: unknown): boolean {
  return previewBridgeTokens(value).some((token) => token === 'snapshot' || token === 'image' || token === 'capture');
}

function injectBeforeBodyClose(html: string, marker: string, injection: string): string {
  if (html.includes(marker)) return html;
  const bodyCloseIndex = html.search(/<\/body\s*>/i);
  if (bodyCloseIndex >= 0) {
    return `${html.slice(0, bodyCloseIndex)}${injection}${html.slice(bodyCloseIndex)}`;
  }
  return `${html}${injection}`;
}

function injectUrlPreviewBridge(html: string, bridge: 'scroll' | 'selection' | 'snapshot'): string {
  if (bridge === 'scroll') {
    return injectBeforeBodyClose(html, 'data-od-url-scroll-bridge', URL_PREVIEW_SCROLL_BRIDGE);
  }
  if (bridge === 'selection') {
    return injectBeforeBodyClose(html, 'data-od-url-selection-bridge', URL_PREVIEW_SELECTION_BRIDGE);
  }
  return injectBeforeBodyClose(html, 'data-od-url-snapshot-bridge', URL_PREVIEW_SNAPSHOT_BRIDGE);
}

// ---------------------------------------------------------------------------
// Teams-safe title sanitization for the URL-load preview path (issue #3918).
//
// When a user prints an HTML preview via Cmd+P → "Save as PDF", Chromium uses
// the iframe's document <title> as the default filename. The URL-load iframe
// uses sandbox="allow-scripts allow-downloads" (no allow-same-origin), so the
// host page cannot access contentDocument to rewrite the title after load.
// Instead we rewrite it here, in the daemon response, before the browser
// parses the document. The web srcDoc path has its own sanitizeTitleInDoc in
// apps/web/src/runtime/srcdoc.ts — keep the two in sync when the logic changes.
// ---------------------------------------------------------------------------

/** Named non-ASCII entities common in business/design document titles. */
const DAEMON_NAMED_ENTITY_MAP: Record<string, string> = {
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  eth: 'ð', ntilde: 'ñ',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  ETH: 'Ð', Ntilde: 'Ñ',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  Yacute: 'Ý', THORN: 'Þ',
  ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', hellip: '…', trade: '™', reg: '®',
  copy: '©', deg: '°', euro: '€', pound: '£', yen: '¥',
};

function daemonSafeFromCodePoint(cp: number): string {
  if (cp < 0 || cp > 0x10ffff) return '�';
  return String.fromCodePoint(cp);
}

function daemonDecodeHtmlEntitiesForTitle(encoded: string): string {
  return encoded
    .replace(/&([A-Za-z]+);/g, (match: string, name: string) => DAEMON_NAMED_ENTITY_MAP[name] ?? match)
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_: string, n: string) => daemonSafeFromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_: string, h: string) => daemonSafeFromCodePoint(parseInt(h, 16)));
}

function daemonSanitizePreviewTitle(text: string): string {
  // Trim first so that leading whitespace cannot hide a ~$ prefix from the
  // anchor-based check below (e.g. "  ~$Invoice" would otherwise survive).
  let result = text.trim();
  // Remove every leading ~$ prefix. A single replace(/^~\$/, '') is not
  // enough when the prefix is doubled ("~$~$Doc"). Loop until stable, then
  // re-trim in case a space followed the prefix ("~$ Invoice" → " Invoice").
  let prev: string;
  do {
    prev = result;
    result = result.replace(/^~\$/, '').trim();
  } while (result !== prev);
  // Replace each disallowed character (or run of them) with a single hyphen.
  // Character class: : # % & * { } \ < > ? / + | "
  // eslint-disable-next-line no-useless-escape
  result = result.replace(/[:#%&*{}\\<>?/+|"]+/g, '-');
  // Final trim to remove any spaces exposed by the substitution.
  return result.trim();
}

/**
 * Find the offset of the first real `<title>` tag in html[0..searchLimit)
 * that is not inside an HTML comment or a `<script>`/`<style>` block.
 * Returns -1 if no real title is found.
 */
function daemonFindRealTitleOffset(html: string, searchLimit: number): number {
  let i = 0;
  const limit = Math.min(html.length, searchLimit);
  while (i < limit) {
    if (html.charCodeAt(i) === 60 /* < */ && html.slice(i, i + 4) === '<!--') {
      const end = html.indexOf('-->', i + 4);
      if (end < 0) return -1;
      i = end + 3;
      continue;
    }
    if (html.charCodeAt(i) === 60 /* < */) {
      const tagMatch = /^<(script|style)\b/i.exec(html.slice(i, i + 20));
      if (tagMatch) {
        const closingTag = `</${tagMatch[1]}`;
        const end = html.toLowerCase().indexOf(closingTag.toLowerCase(), i + tagMatch[0].length);
        if (end < 0) return -1;
        const closeEnd = html.indexOf('>', end);
        i = closeEnd >= 0 ? closeEnd + 1 : end + closingTag.length;
        continue;
      }
    }
    if (html.charCodeAt(i) === 60 /* < */) {
      if (/^<title[\s>]/i.test(html.slice(i, i + 8))) return i;
    }
    i++;
  }
  return -1;
}

/**
 * Rewrite the `<title>` in html so the resulting PDF filename is Teams-safe.
 * Only the real `<head>` title is changed; `<title>` inside comments or script
 * blocks is left untouched. Mirrors sanitizeTitleInDoc in srcdoc.ts.
 *
 * Exported for unit testing; not part of the public API surface.
 */
export function daemonSanitizeTitleInDoc(html: string): string {
  const lower = html.toLowerCase();
  const bodyStart = lower.indexOf('<body');
  const headEnd = lower.lastIndexOf('</head>', bodyStart >= 0 ? bodyStart - 1 : lower.length - 1);
  const searchLimit = headEnd >= 0
    ? headEnd + 7
    : bodyStart >= 0
      ? bodyStart
      : html.length;

  const titleStart = daemonFindRealTitleOffset(html, searchLimit);
  if (titleStart < 0) return html;

  const openTagEnd = html.indexOf('>', titleStart);
  if (openTagEnd < 0) return html;

  const closingTagStart = html.toLowerCase().indexOf('</title>', openTagEnd + 1);
  if (closingTagStart < 0) return html;

  const closingTagEnd = html.indexOf('>', closingTagStart);
  if (closingTagEnd < 0) return html;

  const openTag = html.slice(titleStart, openTagEnd + 1);
  const rawContent = html.slice(openTagEnd + 1, closingTagStart);
  const closeTag = html.slice(closingTagStart, closingTagEnd + 1);

  const decoded = daemonDecodeHtmlEntitiesForTitle(rawContent);
  const safe = daemonSanitizePreviewTitle(decoded);

  return html.slice(0, titleStart) + openTag + safe + closeTag + html.slice(closingTagEnd + 1);
}

function normalizeChatSessionMode(value: unknown): ChatSessionMode {
  return value === 'chat' || value === 'plan' ? value : 'design';
}

function normalizeProjectDuplicateName(value: unknown, sourceProject: any): string {
  const explicit = typeof value === 'string' ? value.trim() : '';
  if (explicit) return explicit.slice(0, 160);
  const sourceName = typeof sourceProject?.name === 'string' && sourceProject.name.trim()
    ? sourceProject.name.trim()
    : 'Untitled';
  return `${sourceName} Copy`.slice(0, 160);
}

function cloneProjectMetadataForDuplicate(sourceProject: any): Record<string, unknown> {
  const sourceMetadata =
    sourceProject?.metadata && typeof sourceProject.metadata === 'object'
      ? { ...sourceProject.metadata }
      : {};
  delete sourceMetadata.baseDir;
  delete sourceMetadata.projectLocationId;
  delete sourceMetadata.fromTrustedPicker;
  delete sourceMetadata.orchestratorWorkspace;
  return {
    ...sourceMetadata,
    sourceProjectId: sourceProject.id,
    sourceProjectName: sourceProject.name,
  };
}

export function registerProjectRoutes(app: Express, ctx: RegisterProjectRoutesDeps) {
  const { db, design } = ctx;
  const { sendApiError, createSseResponse } = ctx.http;
  const { PROJECTS_DIR, SKILLS_DIR } = ctx.paths;
  const { readAppConfig, writeAppConfig } = ctx.appConfig;
  const { insertProject, filterValidLinkedDirs, validateLinkedDirs, getProject, updateProject, dbDeleteProject, removeProjectDir } = ctx.projectStore;
  const { writeProjectFile, readProjectFile, ensureProject, listFiles, listTabs, setTabs, resolveProjectDir } = ctx.projectFiles;
  const { getConversation, insertConversation, listConversations, updateConversation } = ctx.conversations;
  const { getTemplate, listTemplates, deleteTemplate, insertTemplate, findTemplateByNameAndProject, updateTemplate } = ctx.templates;
  const { listLatestProjectRunStatuses, listProjectsAwaitingInput, normalizeProjectDisplayStatus, composeProjectDisplayStatus, listProjects } = ctx.status;
  const { subscribeFileEvents, activeProjectEventSinks } = ctx.events;
  const { randomId } = ctx.ids;
  const { validateProjectSkillId } = ctx.validation;

  async function syncProjectLocationManifest(
    project: any,
    patch: { name?: unknown; skillId?: unknown } = {},
  ): Promise<void> {
    if (
      project?.metadata?.importedFrom !== 'project-location' ||
      typeof project?.metadata?.baseDir !== 'string'
    ) return;
    const cwd = projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir);
    const manifest = await readProjectManifest(cwd);
    if (!manifest || manifest.id !== project.id) return;
    const name = typeof patch.name === 'string' && patch.name.trim()
      ? patch.name.trim()
      : project.name;
    const skillId = Object.prototype.hasOwnProperty.call(patch, 'skillId')
      ? (typeof patch.skillId === 'string' ? patch.skillId : null)
      : (project.skillId ?? null);
    if (
      manifest.name === name &&
      (manifest.skillId ?? null) === skillId
    ) return;
    await writeProjectManifest(cwd, {
      ...manifest,
      name,
      skillId,
      updatedAt: Date.now(),
    });
  }

  async function projectWithMatOSAuthority(project: any) {
    const cwd = projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir);
    try {
      let authority = await readMatOSProjectAuthority(cwd, project.id)
        ?? await syncMatOSProjectAuthority({
          cwd,
          id: project.id,
          name: project.name,
          metadata: project.metadata,
        });
      let conversations = listConversations(db, project.id);
      const sqliteConversationsBefore = new Map(
        conversations.map((conversation: any) => [String(conversation.id), conversation]),
      );
      let nativeNeedsSync = false;
      db.transaction(() => {
        for (const nativeConversation of authority.conversations) {
          const sqliteConversation: any = sqliteConversationsBefore.get(nativeConversation.id);
          if (sqliteConversation) {
            const metadataDiffers =
              (sqliteConversation.title ?? null) !== (nativeConversation.title ?? null) ||
              (sqliteConversation.roleRef ?? null) !== (nativeConversation.roleRef ?? null) ||
              JSON.stringify(sqliteConversation.memberRefs ?? []) !==
                JSON.stringify(nativeConversation.memberRefs ?? []);
            if (!metadataDiffers) continue;
            const nativeUpdatedAt = nativeConversation.updatedAt ?? nativeConversation.createdAt;
            if (nativeUpdatedAt !== undefined && nativeUpdatedAt >= Number(sqliteConversation.updatedAt ?? 0)) {
              updateConversation(db, nativeConversation.id, {
                title: nativeConversation.title ?? null,
                roleRef: nativeConversation.roleRef ?? null,
                memberRefs: nativeConversation.memberRefs,
                updatedAt: nativeUpdatedAt,
              });
            } else {
              nativeNeedsSync = true;
            }
            continue;
          }
          const existing = getConversation(db, nativeConversation.id);
          if (existing && existing.projectId !== project.id) {
            throw new Error(
              `MatOS conversation id collision: ${nativeConversation.id}`,
            );
          }
          if (!existing) {
            insertConversation(db, {
              id: nativeConversation.id,
              projectId: project.id,
              title: nativeConversation.title ?? null,
              roleRef: nativeConversation.roleRef ?? null,
              memberRefs: nativeConversation.memberRefs,
              createdAt: nativeConversation.createdAt ?? Date.now(),
              updatedAt: nativeConversation.updatedAt ?? nativeConversation.createdAt ?? Date.now(),
            });
          }
        }
      })();
      conversations = listConversations(db, project.id);
      const sqliteConversationIds = conversations.map((conversation: any) => String(conversation.id)).sort();
      const nativeConversationIds = [...authority.conversationIds].sort();
      if (
        nativeNeedsSync ||
        JSON.stringify(sqliteConversationIds) !== JSON.stringify(nativeConversationIds)
      ) {
        const latestAuthority = await syncMatOSProjectConversationsAuthority({
          cwd,
          expectedRevision: authority.revision,
          conversations: conversations.map((conversation: any) => ({
            id: String(conversation.id),
            title: typeof conversation.title === 'string' ? conversation.title : null,
            roleRef: typeof conversation.roleRef === 'string' ? conversation.roleRef : null,
            memberRefs: Array.isArray(conversation.memberRefs) ? conversation.memberRefs : [],
            createdAt: Number(conversation.createdAt) || Date.now(),
            updatedAt: Number(conversation.updatedAt) || Date.now(),
          })),
        });
        authority = latestAuthority;
      }
      const metadata = mergeMatOSProjectAuthorityMetadata(project.metadata, authority);
      const name = authority.name ?? project.name;
      if (
        name !== project.name ||
        JSON.stringify(project.metadata ?? {}) !== JSON.stringify(metadata)
      ) {
        updateProject(db, project.id, { name, metadata, updatedAt: project.updatedAt });
      }
      // Older project versions did not keep the discovery manifest in sync
      // after a rename. Repair it opportunistically from the native MatOS
      // authority, while still allowing read-only imported folders to render.
      if (name !== project.name) {
        await syncProjectLocationManifest(project, { name }).catch(() => {});
      }
      return { ...project, name, metadata };
    } catch (error: any) {
      return {
        ...project,
        metadata: {
          ...(project.metadata ?? {}),
          matosProjectAuthorityState: 'error',
          matosProjectAuthorityError: String(error?.message ?? error).slice(0, 500),
        },
      };
    }
  }
  async function configuredProjectLocations() {
    const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
    const all = allProjectLocations(PROJECTS_DIR, config.projectLocations);
    // Deployment-provided workspace location (env-owned, never persisted):
    // slot it right after the built-in managed root so pickers show it as
    // the primary "real folder" choice. A configured location with the same
    // id or path wins over the env entry.
    const envLocation = await envDefaultProjectLocation();
    if (
      envLocation &&
      !all.some((loc) => loc.id === envLocation.id || loc.path === envLocation.path)
    ) {
      all.splice(1, 0, envLocation);
    }
    const valid = all[0] ? [all[0]] : [];
    for (const location of all.slice(1)) {
      const validated = validateLinkedDirs([location.path]);
      if (validated.error) continue;
      const canonical = validated.dirs[0];
      if (!canonical) continue;
      if (locationOverlapsDaemonData(canonical)) continue;
      valid.push({ ...location, path: canonical });
    }
    return valid;
  }

  function locationOverlapsDaemonData(locationPath: string): boolean {
    const runtimeDir = ctx.paths.RUNTIME_DATA_DIR_CANONICAL || ctx.paths.RUNTIME_DATA_DIR;
    const projectsDir = path.join(runtimeDir, 'projects');
    const relativeToRuntime = pathRelative(runtimeDir, locationPath);
    const runtimeInsideLocation = pathRelative(locationPath, runtimeDir);
    const relativeToProjects = pathRelative(projectsDir, locationPath);
    const projectsInsideLocation = pathRelative(locationPath, projectsDir);
    return isInsideOrSame(relativeToRuntime) || isInsideOrSame(runtimeInsideLocation)
      || isInsideOrSame(relativeToProjects) || isInsideOrSame(projectsInsideLocation);
  }

  function pathRelative(from: string, to: string): string {
    return path.relative(from, to);
  }

  function isInsideOrSame(relative: string): boolean {
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  }

  function projectBelongsToLocation(project: any, location: { id: string; path: string }): boolean {
    const metadata = project?.metadata;
    if (typeof metadata?.baseDir !== 'string') return metadata?.projectLocationId === location.id;
    const relative = path.relative(location.path, metadata.baseDir);
    return isInsideOrSame(relative) && relative !== '';
  }

  function isProjectLocationProject(project: any): boolean {
    const metadata = project?.metadata;
    return metadata?.importedFrom === 'project-location'
      || typeof metadata?.projectLocationId === 'string';
  }

  function projectVisibleForLocations(
    project: any,
    locations: Array<{ id: string; path: string; builtIn?: boolean }>,
  ): boolean {
    if (!isProjectLocationProject(project)) return true;
    return locations.some((location) => !location.builtIn && projectBelongsToLocation(project, location));
  }

  async function resolveCreateProjectLocationId(explicitProjectLocationId: unknown): Promise<string> {
    if (typeof explicitProjectLocationId === 'string' && explicitProjectLocationId.trim()) {
      return explicitProjectLocationId.trim();
    }
    // MatOS deployments provide a container-visible workspace project root.
    // It is the operational default even when an old app-config persisted the
    // upstream built-in store, which otherwise leaks hidden UUID directories
    // into terminals and keeps user work outside /workspace/group/shared.
    const envLocation = await envDefaultProjectLocation();
    if (envLocation) return envLocation.id;
    const config = await readAppConfig(ctx.paths.RUNTIME_DATA_DIR);
    const configuredDefault = typeof config.defaultProjectLocationId === 'string'
      ? config.defaultProjectLocationId.trim()
      : '';
    if (!configuredDefault || configuredDefault === BUILT_IN_PROJECT_LOCATION_ID) {
      return BUILT_IN_PROJECT_LOCATION_ID;
    }
    const locations = await configuredProjectLocations();
    return locations.some((location) => !location.builtIn && location.id === configuredDefault)
      ? configuredDefault
      : BUILT_IN_PROJECT_LOCATION_ID;
  }

  function unregisterProjectsForRemovedLocations(
    previousLocations: Array<{ id: string; path: string; builtIn?: boolean }>,
    nextLocations: Array<{ id?: string; path: string }>,
  ): string[] {
    const nextIds = new Set(nextLocations.map((location) => location.id).filter(Boolean));
    const nextPaths = new Set(nextLocations.map((location) => location.path));
    const removed = previousLocations.filter(
      (location) => !location.builtIn && !nextIds.has(location.id) && !nextPaths.has(location.path),
    );
    if (removed.length === 0) return [];
    return listProjects(db)
      .filter((project: any) => removed.some((location) => projectBelongsToLocation(project, location)))
      .map((project: any) => project.id);
  }

  async function scanAndImportProjectLocations(
    locations: ProjectLocation[],
  ) {
    const imported = [];
    const existing: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    let scanned = 0;
    const now = Date.now();
    for (const location of locations) {
      let found;
      try {
        found = await scanProjectLocation(location);
      } catch (err: any) {
        skipped.push({ path: location.path, reason: String(err?.message ?? err) });
        continue;
      }
      scanned += found.length;
      for (const entry of found) {
        const { manifest } = entry;
        if (getProject(db, manifest.id)) {
          existing.push(manifest.id);
          continue;
        }
        try {
          const importedMetadata = {
            // Paper folders re-import as paper projects (Papers list +
            // LatexViewer main document) on every member's daemon.
            kind: manifest.matosPaperProject ? 'other' : 'prototype',
            ...(manifest.matosPaperProject ? { matosPaperProject: true } : {}),
            ...(manifest.latexRoot ? { latexRoot: manifest.latexRoot } : {}),
            baseDir: entry.dir,
            importedFrom: 'project-location',
            projectLocationId: location.id,
          };
          // A mounted shared project already carries the native MatOS
          // authority file written by its owner and the gateway. Import is a
          // read-side catalog operation: preserve that authority verbatim
          // instead of rewriting the team through the recipient's CLI. This
          // also keeps role-less human collaborators out of agent-role
          // resolution on older workspace images.
          let authority = await readMatOSProjectAuthority(entry.dir, manifest.id) ??
            await syncMatOSProjectAuthority({
              cwd: entry.dir,
              id: manifest.id,
              name: manifest.name,
              metadata: importedMetadata,
            });
          const importedConversations = authority.conversations.length > 0
            ? authority.conversations
            : [{
                id: randomId(),
                title: null,
                roleRef: null,
                memberRefs: [],
                createdAt: now,
                updatedAt: now,
              }];
          if (authority.conversations.length === 0) {
            authority = await syncMatOSProjectConversationsAuthority({
              cwd: entry.dir,
              expectedRevision: authority.revision,
              conversations: importedConversations,
            });
          }
          const project = db.transaction(() => {
            const inserted = insertProject(db, {
              id: manifest.id,
              name: authority.name ?? manifest.name,
              skillId: manifest.skillId ?? null,
              pendingPrompt: null,
              metadata: mergeMatOSProjectAuthorityMetadata(importedMetadata, authority),
              customInstructions: null,
              createdAt: manifest.createdAt,
              updatedAt: manifest.updatedAt,
            });
            for (const conversation of importedConversations) {
              insertConversation(db, {
                id: conversation.id,
                projectId: manifest.id,
                title: conversation.title ?? null,
                roleRef: conversation.roleRef ?? null,
                memberRefs: conversation.memberRefs,
                createdAt: conversation.createdAt ?? now,
                updatedAt: conversation.updatedAt ?? conversation.createdAt ?? now,
              });
            }
            return inserted;
          })();
          if (project) imported.push(project);
        } catch (err: any) {
          skipped.push({ path: entry.dir, reason: String(err?.message ?? err) });
        }
      }
    }
    return { scanned, imported, existing, skipped };
  }

  // Project cards are frequently refreshed by several views at once. Keep
  // automatic shared-workspace discovery immediate while coalescing those
  // duplicate scans; manual scans below still inspect every configured root.
  let sharedLocationScanPromise: Promise<unknown> | null = null;
  let sharedLocationScanSignature = '';
  let sharedLocationScanCompletedAt = 0;
  async function discoverSharedProjects(
    locations: ProjectLocation[],
  ): Promise<void> {
    const shared = locations.filter(
      (location) => location.id === SHARED_WORKSPACES_PROJECT_LOCATION_ID,
    );
    if (shared.length === 0) return;
    const signature = shared.map((location) => location.path).sort().join('\n');
    if (
      signature === sharedLocationScanSignature &&
      Date.now() - sharedLocationScanCompletedAt < 2_000
    ) return;
    if (sharedLocationScanPromise) {
      await sharedLocationScanPromise;
      return;
    }
    sharedLocationScanPromise = scanAndImportProjectLocations(shared)
      .then(() => {
        sharedLocationScanSignature = signature;
        sharedLocationScanCompletedAt = Date.now();
      })
      .finally(() => {
        sharedLocationScanPromise = null;
      });
    await sharedLocationScanPromise;
  }

  app.get('/api/project-locations', async (_req, res) => {
    try {
      const locations = await configuredProjectLocations();
      /** @type {import('@open-design/contracts').ProjectLocationsResponse} */
      const body = { locations };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  app.put('/api/project-locations', async (req, res) => {
    try {
      const requested = Array.isArray(req.body?.locations) ? req.body.locations : null;
      if (!requested) return sendApiError(res, 400, 'BAD_REQUEST', 'locations must be an array');
      const previousLocations = await configuredProjectLocations();
      const envLocation = await envDefaultProjectLocation();
      const prepared = [];
      for (const loc of requested) {
        if (!loc || typeof loc !== 'object' || typeof loc.path !== 'string') continue;
        const canonicalPath = await ensureProjectLocation(loc.path);
        // The env-owned workspace location round-trips through GET responses;
        // drop it here so it never gets persisted into app-config.json (env
        // stays authoritative across redeploys) and never counts as removed.
        if (
          envLocation &&
          (loc.id === envLocation.id || canonicalPath === envLocation.path)
        ) {
          continue;
        }
        const validated = validateLinkedDirs([canonicalPath]);
        if (validated.error) return sendApiError(res, 400, 'BAD_REQUEST', validated.error);
        if (locationOverlapsDaemonData(canonicalPath)) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'project location cannot overlap daemon data');
        }
        prepared.push({
          id: typeof loc.id === 'string' ? loc.id : undefined,
          name: typeof loc.name === 'string' ? loc.name : undefined,
          path: canonicalPath,
        });
      }
      const config = await writeAppConfig(ctx.paths.RUNTIME_DATA_DIR, { projectLocations: prepared });
      const locations = await configuredProjectLocations();
      const removedProjectIds = unregisterProjectsForRemovedLocations(
        previousLocations.filter(
          (loc: any) =>
            !envLocation || (loc.id !== envLocation.id && loc.path !== envLocation.path),
        ),
        config.projectLocations ?? [],
      );
      /** @type {import('@open-design/contracts').ProjectLocationsResponse} */
      const body = { locations, removedProjectIds };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post('/api/project-locations/scan', async (_req, res) => {
    try {
      const locations = (await configuredProjectLocations()).filter((loc: any) => !loc.builtIn);
      const { scanned, imported, existing, skipped } =
        await scanAndImportProjectLocations(locations);
      /** @type {import('@open-design/contracts').ScanProjectLocationsResponse} */
      const body = { scanned, imported, existing, skipped };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects', async (_req, res) => {
    try {
      const locations = await configuredProjectLocations();
      // Shared mounts are workspace-runtime state, while this list is backed
      // by the user's private SQLite catalog. Reconcile the two here so a
      // freshly accepted share appears on the first normal project-list load
      // instead of requiring a hidden manual scan endpoint.
      await discoverSharedProjects(locations);
      const latestRunStatuses = listLatestProjectRunStatuses(db);
      const conversationOverviews = listProjectConversationOverviews(db);
      const awaitingInputProjects = listProjectsAwaitingInput(db);
      const activeRunStatuses = new Map();
      for (const run of design.runs.list()) {
        if (!run.projectId) continue;
        const runStatus = projectStatusFromRun(run);
        if (design.runs.isTerminal(run.status)) {
          const existing = latestRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            latestRunStatuses.set(run.projectId, runStatus);
          }
        } else {
          const existing = activeRunStatuses.get(run.projectId);
          if (!existing || run.updatedAt > (existing.updatedAt ?? 0)) {
            activeRunStatuses.set(run.projectId, runStatus);
          }
        }
      }
      const visibleProjects = listProjects(db)
        .filter((project: any) => projectVisibleForLocations(project, locations));
      const canonicalProjects = await mapWithConcurrency(
        visibleProjects,
        4,
        (project: any) => projectWithMatOSAuthority(project),
      );
      /** @type {import('@open-design/contracts').ProjectsResponse} */
      const body = {
        projects: canonicalProjects
          .map((project: any) => ({
            ...project,
            overview: {
              ...(conversationOverviews.get(project.id) ?? { conversationCount: 0 }),
              projectDir: projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir),
            },
            status: composeProjectDisplayStatus(
                activeRunStatuses.get(project.id) ??
                  latestRunStatuses.get(project.id) ?? { value: 'not_started' },
                awaitingInputProjects,
                project.id,
              ),
          })),
      };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 500, 'INTERNAL_ERROR', String(err));
    }
  });

  function projectStatusFromRun(run: any) {
    return {
      value: normalizeProjectDisplayStatus(run.status),
      updatedAt: run.updatedAt,
      runId: run.id,
    };
  }

  app.post('/api/projects', async (req, res) => {
    let releaseCreate: (() => void) | undefined;
    try {
      const requestBody = (req.body || {}) as Record<string, any>;
      const { id, folderName, projectLocationId, skillId, pendingPrompt, metadata, customInstructions, skipDiscoveryBrief } =
        requestBody;
      let name = validatedProjectName(requestBody.name);
      const untitled = metadata?.nameSource === 'untitled';
      const allowInvalidLinkedDirs = requestBody.allowInvalidLinkedDirs === true;
      if (typeof id !== 'string' || !isSafeId(id)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'invalid project id');
      }
      if (folderName !== undefined && (typeof folderName !== 'string' || !folderName.trim())) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'folderName must be a non-empty string');
      }
      releaseCreate = await enterProjectPatchQueue(id);
      if (getProject(db, id)) {
        return sendApiError(res, 409, 'CONFLICT', 'project id already exists');
      }
      // baseDir is privileged: it lets a project root directly inside the
      // user's filesystem. The /api/import/folder endpoint is the only
      // path that's allowed to set it, because that's where realpath() +
      // RUNTIME_DATA_DIR reentry checks live. Block client-supplied
      // metadata.baseDir on this generic create endpoint so an attacker
      // can't smuggle e.g. /etc through here. Same rule for
      // originalBaseDir / importedFrom='folder' — only the import path
      // owns those state fields.
      if (metadata && typeof metadata === 'object') {
        if ('baseDir' in metadata) {
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'baseDir can only be set via POST /api/import/folder',
          );
        }
        if ('fromTrustedPicker' in metadata) {
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'fromTrustedPicker can only be set via POST /api/import/folder',
          );
        }
        if ('orchestratorWorkspace' in metadata) {
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'orchestratorWorkspace can only be set via POST /api/import/folder or POST /api/projects/:id/working-dir',
          );
        }
        // Reject invalid linked working directories up front (consistent with
        // PATCH /api/projects/:id) instead of silently dropping them. The
        // caller promises the agent `--add-dir` access to this folder; if the
        // path is deleted/inaccessible/a system dir, fail loudly so the client
        // can surface it rather than creating a project + auto-running a turn
        // whose linked-dir access never materialises.
        if (Array.isArray(metadata.linkedDirs)) {
          if (allowInvalidLinkedDirs) {
            const filtered = filterValidLinkedDirs(metadata.linkedDirs);
            if (filtered.error) {
              return sendApiError(res, 400, 'INVALID_LINKED_DIR', filtered.error);
            }
            metadata.linkedDirs = filtered.dirs;
          } else {
            const validated = validateLinkedDirs(metadata.linkedDirs);
            if (validated.error) {
              return sendApiError(res, 400, 'INVALID_LINKED_DIR', validated.error);
            }
          }
        }
      }
      if (customInstructions !== undefined
          && typeof customInstructions !== 'string'
          && customInstructions !== null) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'customInstructions must be a string or null');
      }
      if (typeof customInstructions === 'string' && customInstructions.length > 5000) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'customInstructions exceeds 5 000 character limit');
      }
      if (skipDiscoveryBrief !== undefined && typeof skipDiscoveryBrief !== 'boolean') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'skipDiscoveryBrief must be a boolean');
      }
      const skillValidation = await validateProjectSkillId(skillId);
      if (!skillValidation.ok) {
        return sendApiError(res, 400, skillValidation.code, skillValidation.message);
      }
      const normalizedSkillId = skillValidation.id;
      const selectedLocationId = await resolveCreateProjectLocationId(projectLocationId);
      const untitledBase = name;
      if (untitled) name = reserveUntitledProjectName(db, untitledBase);
      let externalProjectDir: string | null = null;
      if (selectedLocationId !== BUILT_IN_PROJECT_LOCATION_ID) {
        const location = (await configuredProjectLocations()).find((loc: any) => loc.id === selectedLocationId);
        if (!location || location.builtIn) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'unknown project location');
        }
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            externalProjectDir = await createLocationProjectDir(
              location, id,
              untitled ? name : typeof folderName === 'string' ? folderName : name,
              { exactName: untitled },
            );
            break;
          } catch (error: any) {
            if (!untitled || error?.code !== 'PROJECT_FOLDER_EXISTS' || attempt === 99) throw error;
            name = reserveUntitledProjectName(db, untitledBase);
          }
        }
      }
      const projectMetadata =
        metadata && typeof metadata === 'object'
          ? {
              ...metadata,
              ...(skipDiscoveryBrief === true ? { skipDiscoveryBrief: true } : {}),
              ...(externalProjectDir
                ? {
                    baseDir: externalProjectDir,
                    importedFrom: 'project-location',
                    projectLocationId: selectedLocationId,
                  }
                : {}),
              ...(Array.isArray(metadata.linkedDirs)
                ? (() => {
                    const v = validateLinkedDirs(metadata.linkedDirs);
                    return v.error ? {} : { linkedDirs: v.dirs };
                  })()
                : {}),
            }
          : skipDiscoveryBrief === true
            ? {
                skipDiscoveryBrief: true,
                ...(externalProjectDir
                  ? {
                      baseDir: externalProjectDir,
                      importedFrom: 'project-location',
                      projectLocationId: selectedLocationId,
                    }
                  : {}),
              }
            : externalProjectDir
              ? {
                  kind: 'prototype',
                  baseDir: externalProjectDir,
                  importedFrom: 'project-location',
                  projectLocationId: selectedLocationId,
                }
              : null;
      const now = Date.now();
      const cid = randomId();
      const initialSessionMode = normalizeChatSessionMode(
        requestBody.conversationMode ?? requestBody.sessionMode,
      );
      let project;
      let materializedProjectDir: string | null = null;
      let removeMaterializedProjectDirOnFailure = false;
      try {
        if (externalProjectDir) {
          materializedProjectDir = externalProjectDir;
          removeMaterializedProjectDirOnFailure = true;
          await writeProjectManifest(externalProjectDir, {
            schemaVersion: 1,
            id,
            name: name.trim(),
            createdAt: now,
            updatedAt: now,
            skillId: normalizedSkillId,
            // Paper identity travels with the folder: when this directory is
            // shared cross-user and imported by a collaborator's daemon, the
            // manifest is all that daemon can see (owner SQLite is private).
            ...(projectMetadata?.matosPaperProject === true ? { matosPaperProject: true } : {}),
            ...(typeof projectMetadata?.latexRoot === 'string' && projectMetadata.latexRoot
              ? { latexRoot: projectMetadata.latexRoot }
              : {}),
          });
        }
        const targetProjectDir = externalProjectDir
          ?? resolveProjectDir(PROJECTS_DIR, id, projectMetadata);
        materializedProjectDir = targetProjectDir;
        if (!externalProjectDir) {
          try {
            // Claim the one-project/one-folder identity atomically. A prior
            // exists-then-mkdir sequence could let concurrent create requests
            // adopt and overwrite the same folder.
            await mkdir(targetProjectDir, { recursive: false });
            removeMaterializedProjectDirOnFailure = true;
          } catch (error: any) {
            if (error?.code === 'EEXIST') {
              const conflict: any = new Error(`project folder already exists: ${targetProjectDir}`);
              conflict.code = 'PROJECT_FOLDER_EXISTS';
              throw conflict;
            }
            throw error;
          }
        }
        let authority = await syncMatOSProjectAuthority({
          cwd: targetProjectDir,
          id,
          name: name.trim(),
          metadata: projectMetadata,
        });
        authority = await syncMatOSProjectConversationsAuthority({
          cwd: targetProjectDir,
          expectedRevision: authority.revision,
          ...(authority.roleResolutionWarnings?.length
            ? { roleResolutionWarnings: authority.roleResolutionWarnings }
            : {}),
          conversations: [{
            id: cid,
            title: null,
            roleRef: null,
            memberRefs: [],
            createdAt: now,
            updatedAt: now,
          }],
        });
        const canonicalProjectMetadata = mergeMatOSProjectAuthorityMetadata(
          projectMetadata,
          authority,
        );
        db.transaction(() => {
          project = insertProject(db, {
            id,
            name: name.trim(),
            skillId: normalizedSkillId,
            pendingPrompt: pendingPrompt || null,
            metadata: canonicalProjectMetadata,
            customInstructions:
              typeof customInstructions === 'string'
                ? customInstructions
                : null,
            createdAt: now,
            updatedAt: now,
          });
          insertConversation(db, {
            id: cid,
            projectId: id,
            title: null,
            sessionMode: initialSessionMode,
            createdAt: now,
            updatedAt: now,
          });
        })();
      } catch (err) {
        // The insert transaction rolls itself back. A concurrent creator in
        // another process may own this id now; never delete its successful row.
        if (removeMaterializedProjectDirOnFailure && materializedProjectDir) {
          await rm(materializedProjectDir, { recursive: true, force: true }).catch(() => {});
        }
        throw err;
      }
      // For "from template" projects, seed the chosen template's snapshot
      // HTML into the new project folder so the agent can Read/edit files
      // on disk (the system prompt also embeds them, but a real on-disk
      // copy lets the agent treat them as the project's working state).
      if (
        metadata &&
        typeof metadata === 'object' &&
        metadata.kind === 'template' &&
        typeof metadata.templateId === 'string'
      ) {
        const tpl = getTemplate(db, metadata.templateId);
        if (tpl && Array.isArray(tpl.files) && tpl.files.length > 0) {
          await ensureProject(PROJECTS_DIR, id, projectMetadata);
          for (const f of tpl.files) {
            if (
              !f ||
              typeof f.name !== 'string' ||
              typeof f.content !== 'string'
            ) {
              continue;
            }
            try {
              await writeProjectFile(
                PROJECTS_DIR,
                id,
                f.name,
                Buffer.from(f.content, 'utf8'),
                {},
                projectMetadata,
              );
            } catch {
              // Skip individual file failures — the template snapshot is
              // best-effort; the agent still has the embedded copy.
            }
          }
        }
      }
      /** @type {import('@open-design/contracts').CreateProjectResponse} */
      const body = {
        project,
        conversationId: cid,
      };
      res.json(body);
    } catch (err: any) {
      if (err?.code === 'PROJECT_FOLDER_EXISTS' || err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
        return sendApiError(res, 409, 'CONFLICT', err.message);
      }
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    } finally {
      releaseCreate?.();
    }
  });

  app.post('/api/projects/:id/duplicate', async (req, res) => {
    const sourceProject = getProject(db, req.params.id);
    try {
      const locations = await configuredProjectLocations();
      if (!sourceProject || !projectVisibleForLocations(sourceProject, locations)) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      }
      const targetProjectId = randomId();
      const targetName = normalizeProjectDuplicateName(req.body?.name, sourceProject);
      const metadata = cloneProjectMetadataForDuplicate(sourceProject);
      let insertedProject = false;
      try {
        await ensureProject(PROJECTS_DIR, targetProjectId, metadata);
        const sourceFiles = await listFiles(PROJECTS_DIR, sourceProject.id, {
          metadata: sourceProject.metadata,
        });
        const copiedFiles: string[] = [];
        for (const file of sourceFiles) {
          if (!file?.name || typeof file.name !== 'string') continue;
          const sourceFile = await readProjectFile(
            PROJECTS_DIR,
            sourceProject.id,
            file.name,
            sourceProject.metadata,
          );
          await writeProjectFile(
            PROJECTS_DIR,
            targetProjectId,
            sourceFile.name,
            sourceFile.buffer,
            {
              overwrite: true,
              ...(sourceFile.artifactManifest ? { artifactManifest: sourceFile.artifactManifest } : {}),
            },
            metadata,
          );
          copiedFiles.push(sourceFile.name);
        }

        const now = Date.now();
        const project = insertProject(db, {
          id: targetProjectId,
          name: targetName,
          skillId: sourceProject.skillId ?? null,
          pendingPrompt: null,
          metadata,
          customInstructions: sourceProject.customInstructions ?? null,
          createdAt: now,
          updatedAt: now,
        });
        insertedProject = true;
        const conversationId = randomId();
        insertConversation(db, {
          id: conversationId,
          projectId: targetProjectId,
          title: null,
          sessionMode: 'design',
          createdAt: now,
          updatedAt: now,
        });
        try {
          const tabs = listTabs(db, sourceProject.id);
          setTabs(db, targetProjectId, tabs);
        } catch {
          // Open-tabs state is convenience metadata; file duplication succeeds
          // without it.
        }
        /** @type {import('@open-design/contracts').DuplicateProjectResponse} */
        const body = {
          project,
          conversationId,
          copiedFiles,
        };
        res.json(body);
      } catch (err) {
        if (insertedProject) dbDeleteProject(db, targetProjectId);
        await removeProjectDir(PROJECTS_DIR, targetProjectId).catch(() => {});
        throw err;
      }
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects/:id', async (req, res) => {
    const storedProject = getProject(db, req.params.id);
    const locations = await configuredProjectLocations();
    if (!storedProject || !projectVisibleForLocations(storedProject, locations))
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    const project = await projectWithMatOSAuthority(storedProject);
    // When a caller is about to *reference* this project (add it as read-only
    // context for another run), materialize its managed folder first so the
    // reference resolves to a real directory. See ensureReferencedProjectDir.
    if (req.query.ensureDir === '1' || req.query.ensureDir === 'true') {
      try {
        await ensureReferencedProjectDir(PROJECTS_DIR, project, ensureProject);
      } catch (err: any) {
        return sendApiError(
          res,
          500,
          'PROJECT_DIR_MATERIALIZATION_FAILED',
          String(err?.message || err),
        );
      }
    }
    const resolvedDir = projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir);
    /** @type {import('@open-design/contracts').ProjectResponse} */
    const body = { project, resolvedDir };
    res.json(body);
  });

  app.post('/api/projects/:id/editor-workspace', async (req, res) => {
    const release = await enterProjectPatchQueue(req.params.id);
    try {
      const stored = getProject(db, req.params.id);
      if (!stored || !projectVisibleForLocations(stored, await configuredProjectLocations())) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      }
      const project = await projectWithMatOSAuthority(stored);
      await ensureReferencedProjectDir(PROJECTS_DIR, project, ensureProject);
      const workspacePath = await syncProjectEditorWorkspace({
        dataDir: ctx.paths.RUNTIME_DATA_DIR,
        projectId: project.id,
        name: project.name,
        projectDir: projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir),
      });
      if (!workspacePath) throw new Error('editor workspace was not created');
      const body: ProjectEditorWorkspaceResponse = { workspacePath };
      res.json(body);
    } catch (error: any) {
      sendApiError(res, 400, 'EDITOR_WORKSPACE_FAILED', String(error?.message || error));
    } finally {
      release();
    }
  });

  app.patch('/api/projects/:id', async (req, res) => {
    // Capture the request-arrival projection before waiting in the queue. Two
    // concurrent clients may carry the same old snapshot; this baseline lets
    // us distinguish the fields each one actually changed.
    const requestBaselineProject = getProject(db, req.params.id);
    const releasePatch = await enterProjectPatchQueue(req.params.id);
    try {
      const patch = req.body || {};
      const existingProject = getProject(db, req.params.id);
      if (!existingProject) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'name')) {
        const name = changedProjectName(patch.name, existingProject.name, requestBaselineProject?.name);
        if (name === undefined) delete patch.name;
        else patch.name = name;
      }
      // baseDir / folder-import state is privileged: it's set only by the
      // import endpoint and otherwise immutable. Two failure modes to
      // guard against here:
      //   1. Explicit attempt to change baseDir → reject with 400.
      //   2. A regular metadata patch that *omits* baseDir (e.g. a UI
      //      that only edits linkedDirs sends `{ metadata: { kind, linkedDirs } }`).
      //      updateProject() replaces metadata wholesale, so without
      //      preservation the existing baseDir gets wiped and the project
      //      detaches from the user's folder — subsequent reads/writes
      //      silently fall back to .od/projects/<id>.
      // For case 2 we re-stamp the immutable fields from the existing
      // project record onto the incoming patch so the user can keep
      // patching other metadata without ever losing their import root.
      if (patch.metadata === null) {
        const existing = getProject(db, req.params.id);
        if (existing?.metadata?.baseDir) {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'metadata cannot be cleared for imported projects',
          );
        }
      }
      if (patch.metadata && typeof patch.metadata === 'object') {
        const existing = getProject(db, req.params.id);
        const existingMeta = existing?.metadata;
        if ('fromTrustedPicker' in patch.metadata
            && patch.metadata.fromTrustedPicker !== existingMeta?.fromTrustedPicker) {
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'fromTrustedPicker can only be set via POST /api/import/folder',
          );
        }
        if ('orchestratorWorkspace' in patch.metadata) {
          const parsedOrchestratorWorkspace = parseOrchestratorWorkspace(
            patch.metadata.orchestratorWorkspace,
          );
          if (!parsedOrchestratorWorkspace.ok) {
            return sendApiError(
              res,
              400,
              'BAD_REQUEST',
              parsedOrchestratorWorkspace.message,
            );
          }
        }
        if (existingMeta?.baseDir) {
          if ('orchestratorWorkspace' in patch.metadata) {
            if (
              existingMeta.orchestratorWorkspace == null ||
              !sameOrchestratorWorkspace(
                patch.metadata.orchestratorWorkspace,
                existingMeta.orchestratorWorkspace,
              )
            ) {
              return sendApiError(
                res, 400, 'BAD_REQUEST',
                'orchestratorWorkspace is immutable after import; use the working-dir route to change it',
              );
            }
          }
          if ('baseDir' in patch.metadata && patch.metadata.baseDir !== existingMeta.baseDir) {
            return sendApiError(
              res, 400, 'BAD_REQUEST',
              'baseDir is immutable after import; use a new import to change it',
            );
          }
          patch.metadata = {
            ...patch.metadata,
            baseDir: existingMeta.baseDir,
            ...(existingMeta.importedFrom === 'folder'
              ? { importedFrom: 'folder' }
              : {}),
            ...(existingMeta.importedFrom === 'project-location'
              ? { importedFrom: 'project-location' }
              : {}),
            ...(typeof existingMeta.projectLocationId === 'string'
              ? { projectLocationId: existingMeta.projectLocationId }
              : {}),
            ...(existingMeta.fromTrustedPicker === true
              ? { fromTrustedPicker: true as const }
              : {}),
            ...(existingMeta.orchestratorWorkspace
              ? { orchestratorWorkspace: existingMeta.orchestratorWorkspace }
              : {}),
          };
        } else if ('baseDir' in patch.metadata) {
          // Non-imported project trying to acquire a baseDir → reject (only
          // /api/import/folder can set it).
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'baseDir can only be set via POST /api/import/folder',
          );
        } else if ('orchestratorWorkspace' in patch.metadata) {
          return sendApiError(
            res, 400, 'BAD_REQUEST',
            'orchestratorWorkspace can only be set via POST /api/import/folder or POST /api/projects/:id/working-dir',
          );
        }
      }
      if (patch.metadata?.linkedDirs) {
        const existing = getProject(db, req.params.id);
        const validated = validateLinkedDirs(patch.metadata.linkedDirs);
        if (validated.error) {
          return sendApiError(res, 400, 'INVALID_LINKED_DIR', validated.error);
        }
        patch.metadata.linkedDirs =
          existing?.metadata?.fromTrustedPicker === true
            ? patch.metadata.linkedDirs
            : validated.dirs;
      }
      if (patch.customInstructions !== undefined
          && typeof patch.customInstructions !== 'string'
          && patch.customInstructions !== null) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'customInstructions must be a string or null');
      }
      if (typeof patch.customInstructions === 'string' && patch.customInstructions.length > 5000) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'customInstructions exceeds 5 000 character limit');
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'skillId')) {
        const skillValidation = await validateProjectSkillId(patch.skillId);
        if (!skillValidation.ok) {
          return sendApiError(res, 400, skillValidation.code, skillValidation.message);
        }
        patch.skillId = skillValidation.id;
      }
      const incomingMetadata = patch.metadata && typeof patch.metadata === 'object'
        ? patch.metadata
        : {};
      const protectedName = ['untitled', 'user'].includes(existingProject.metadata?.nameSource ?? '');
      if (protectedName && ['prompt', 'agent', 'generated'].includes(incomingMetadata.nameSource)) {
        if (typeof patch.name === 'string' && patch.name !== existingProject.name) {
          return sendApiError(res, 409, 'PROJECT_NAME_PROTECTED', 'this project must be renamed explicitly by the user');
        }
        incomingMetadata.nameSource = existingProject.metadata?.nameSource;
      }
      if (typeof patch.name === 'string') {
        // Explicit user renames must survive subsequent first-turn title generation.
        // Preserve legacy automated callers that explicitly identify themselves.
        incomingMetadata.nameSource = ['prompt', 'agent'].includes(incomingMetadata.nameSource)
          && existingProject.metadata?.nameSource !== 'untitled'
          && existingProject.metadata?.nameSource !== 'user'
          ? incomingMetadata.nameSource : 'user';
      }
      const requestedRevision = Number((incomingMetadata as any).matosProjectRevision);
      const baselineMetadata = requestBaselineProject?.metadata ?? existingProject.metadata ?? {};
      const mutableAuthorityKeys = [
        'members',
        'matosActiveRoleRef',
        'matosProjectMembers',
        'matosAssetRefs',
        'goal',
        'memberBriefs',
        'memberNames',
      ] as const;
      const projectedAuthorityKeys = [
        'matosProjectRevision',
        'matosProjectAuthority',
        'roleResolutionWarnings',
      ] as const;
      const intentionallyChangedAuthorityKeys = new Set(
        mutableAuthorityKeys.filter(key =>
          Object.prototype.hasOwnProperty.call(incomingMetadata, key) &&
          !isDeepStrictEqual(
            (incomingMetadata as Record<string, unknown>)[key],
            (baselineMetadata as Record<string, unknown>)[key],
          )),
      );
      let syncedMetadata: Record<string, unknown> | null = null;
      let lastAuthorityConflict: unknown;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const latestProject = attempt === 0 ? existingProject : getProject(db, req.params.id);
        if (!latestProject) {
          return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
        }
        const projectCwd = projectDetailResolvedDir(
          PROJECTS_DIR,
          latestProject,
          resolveProjectDir,
        );
        const latestAuthority = attempt > 0
          ? await readMatOSProjectAuthority(projectCwd, latestProject.id)
          : null;
        const metadataBase = latestAuthority
          ? mergeMatOSProjectAuthorityMetadata(
              latestProject.metadata ?? {},
              latestAuthority,
            )
          : latestProject.metadata ?? {};
        const mergedMetadata = {
          ...metadataBase,
          ...incomingMetadata,
        };
        if (latestAuthority) {
          for (const key of [
            ...mutableAuthorityKeys.filter(
              candidate => !intentionallyChangedAuthorityKeys.has(candidate),
            ),
            ...projectedAuthorityKeys,
          ]) {
            if (Object.prototype.hasOwnProperty.call(metadataBase, key)) {
              mergedMetadata[key] = (metadataBase as Record<string, unknown>)[key];
            } else {
              delete mergedMetadata[key];
            }
          }
        }
        const currentRevision = latestAuthority?.revision ??
          Number(latestProject.metadata?.matosProjectRevision);
        try {
          const authority = await syncMatOSProjectAuthority({
            cwd: projectCwd,
            id: latestProject.id,
            name: typeof patch.name === 'string' && patch.name.trim()
              ? patch.name.trim()
              : latestProject.name,
            metadata: mergedMetadata,
            ...(attempt === 0 && Number.isInteger(requestedRevision)
              ? { expectedRevision: requestedRevision }
              : Number.isInteger(currentRevision)
                ? { expectedRevision: currentRevision }
                : {}),
          });
          syncedMetadata = mergeMatOSProjectAuthorityMetadata(mergedMetadata, authority);
          break;
        } catch (err) {
          lastAuthorityConflict = err;
          if (!/project metadata revision conflict/i.test(String((err as Error)?.message ?? err))) {
            throw err;
          }
        }
      }
      if (!syncedMetadata) {
        throw lastAuthorityConflict ?? new Error('MatOS project authority synchronization failed');
      }
      patch.metadata = syncedMetadata;
      await syncProjectLocationManifest(existingProject, patch);
      const project = updateProject(db, req.params.id, patch);
      if (!project)
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
      if (typeof patch.name === 'string') {
        // This is a regenerable IDE projection, not project authority. A cache
        // write failure must not report an already-committed rename as failed.
        await syncProjectEditorWorkspace({
          dataDir: ctx.paths.RUNTIME_DATA_DIR,
          projectId: project.id,
          name: project.name,
          projectDir: projectDetailResolvedDir(PROJECTS_DIR, project, resolveProjectDir),
          onlyIfPresent: true,
        }).catch(() => { console.warn('[project] editor display refresh failed; retry on next open'); });
      }
      /** @type {import('@open-design/contracts').ProjectResponse} */
      const body = { project };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    } finally {
      releasePatch();
    }
  });

  app.delete('/api/projects/:id', async (req, res) => {
    try {
      const deletedProject = getProject(db, req.params.id);
      dbDeleteProject(db, req.params.id);
      await removeProjectDir(PROJECTS_DIR, req.params.id).catch(() => {});
      dropCachedProjectFiles(PROJECTS_DIR, req.params.id, deletedProject?.metadata);
      /** @type {import('@open-design/contracts').OkResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  // SSE stream of file-changed events for a project. Drives preview live-reload.
  // Receipt of a `file-changed` event triggers a file-list refresh, which
  // propagates new mtimes through to FileViewer iframes (the URL-load
  // `?v=${mtime}` cache-bust from PR #384 then reloads the iframe automatically).
  // Subscribers come and go as users open/close project tabs; the underlying
  // chokidar watcher is refcounted in project-watchers.ts so we never hold
  // descriptors for projects no UI is looking at.
  app.get('/api/projects/:id/events', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    let sub: any;
    let releaseFileCacheWatcher: null | (() => void) = null;
    try {
      const sse = createSseResponse(res);
      const projectEventSink = (payload: any) => {
        sse.send(payload.type, payload);
      };
      let sinks = activeProjectEventSinks.get(req.params.id);
      if (!sinks) {
        sinks = new Set();
        activeProjectEventSinks.set(req.params.id, sinks);
      }
      sinks.add(projectEventSink);
      const watchProject = getProject(db, req.params.id);
      releaseFileCacheWatcher = retainCachedProjectFilesWatcher(
        PROJECTS_DIR,
        req.params.id,
        watchProject?.metadata,
      );
      sub = subscribeFileEvents(PROJECTS_DIR, req.params.id, (evt: any) => {
        // Atomic-write staging temps (`<target>.tmp.<pid>.<uuid>`) are
        // invisible on every listing surface, so their add/unlink churn must
        // not reach the browser either: each forwarded event evicts the
        // preview iframe keep-alive pool and triggers a file-list refetch.
        if (isProjectFileCommitIntermediateEventPath(evt?.path)) return;
        // Update the snapshot before notifying the browser. Its ensuing
        // `?since=<snapshot>` request can then return a tiny deterministic
        // delta instead of racing another recursive tree scan.
        void updateCachedProjectFilesFromEvent(
          PROJECTS_DIR,
          req.params.id,
          evt,
          watchProject?.metadata,
        ).catch(() => {
          invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, watchProject?.metadata);
        }).finally(() => {
          sse.send('file-changed', evt);
        });
      }, { metadata: watchProject?.metadata });
      sub.ready.then(() => sse.send('ready', { projectId: req.params.id })).catch(() => {});
      const cleanup = () => {
        if (sub) {
          const { unsubscribe } = sub;
          sub = null;
          Promise.resolve(unsubscribe()).catch(() => {});
        }
        releaseFileCacheWatcher?.();
        releaseFileCacheWatcher = null;
        const currentSinks = activeProjectEventSinks.get(req.params.id);
        currentSinks?.delete(projectEventSink);
        if (currentSinks?.size === 0) activeProjectEventSinks.delete(req.params.id);
      };
      res.on('close', cleanup);
      res.on('finish', cleanup);
    } catch (err: any) {
      if (sub) Promise.resolve(sub.unsubscribe()).catch(() => {});
      releaseFileCacheWatcher?.();
      if (!res.headersSent) sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  registerProjectConversationRoutes(app, ctx);

  // ---- Tabs -----------------------------------------------------------------

  app.get('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    res.json(listTabs(db, req.params.id));
  });

  app.put('/api/projects/:id/tabs', (req, res) => {
    if (!getProject(db, req.params.id)) {
      return res.status(404).json({ error: 'project not found' });
    }
    const { tabs = [], active = null, browserTabs = [] } = req.body || {};
    if (!Array.isArray(tabs) || !tabs.every((t) => typeof t === 'string')) {
      return res.status(400).json({ error: 'tabs must be string[]' });
    }
    if (!Array.isArray(browserTabs)) {
      return res.status(400).json({ error: 'browserTabs must be an array' });
    }
    const result = setTabs(
      db,
      req.params.id,
      {
        tabs,
        active: typeof active === 'string' ? active : null,
        browserTabs,
      },
    );
    res.json(result);
  });

  // ---- Templates ----------------------------------------------------------
  // User-saved snapshots of a project's HTML files. Surfaced in the
  // "From template" tab of the new-project panel so a user can spin up
  // a fresh project pre-seeded with another project's design as a
  // starting point. Created via the project's Share menu (snapshots
  // every .html file in the project folder at the moment of save).

  app.get('/api/templates', (_req, res) => {
    res.json({ templates: listTemplates(db) });
  });

  app.get('/api/templates/:id', (req, res) => {
    const t = getTemplate(db, req.params.id);
    if (!t) return res.status(404).json({ error: 'not found' });
    res.json({ template: t });
  });

  app.post('/api/templates', async (req, res) => {
    try {
      const { name, description, sourceProjectId } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name required' });
      }
      if (name.length > 100) {
        return res.status(400).json({ error: 'name must be 100 characters or fewer' });
      }
      if (typeof sourceProjectId !== 'string') {
        return res.status(400).json({ error: 'sourceProjectId required' });
      }
      const sourceProject = getProject(db, sourceProjectId);
      if (!sourceProject) {
        return res.status(404).json({ error: 'source project not found' });
      }
      // Snapshot every HTML / sketch / text file in the source project.
      // We deliberately skip binary uploads — templates are about the
      // generated design, not the user's reference imagery.
      const files = await listFiles(PROJECTS_DIR, sourceProjectId, {
        metadata: sourceProject.metadata,
      });
      const snapshot = [];
      for (const f of files) {
        if (f.kind !== 'html' && f.kind !== 'text' && f.kind !== 'code')
          continue;
        const entry = await readProjectFile(
          PROJECTS_DIR,
          sourceProjectId,
          f.name,
          sourceProject.metadata,
        );
        if (entry && Buffer.isBuffer(entry.buffer)) {
          snapshot.push({
            name: f.name,
            content: entry.buffer.toString('utf8'),
          });
        }
      }
      const trimmedName = name.trim();
      const descValue = typeof description === 'string' ? description : null;
      const existing = findTemplateByNameAndProject(db, trimmedName, sourceProjectId);
      let t;
      if (existing) {
        t = updateTemplate(db, existing.id, {
          description: descValue,
          files: snapshot,
        });
      } else {
        t = insertTemplate(db, {
          id: randomId(),
          name: trimmedName,
          description: descValue,
          sourceProjectId,
          files: snapshot,
          createdAt: Date.now(),
        });
      }
      res.json({ template: t });
    } catch (err: any) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.delete('/api/templates/:id', (req, res) => {
    deleteTemplate(db, req.params.id);
    res.json({ ok: true });
  });

}

export interface RegisterProjectArtifactRoutesDeps extends RouteDeps<'http' | 'uploads' | 'paths' | 'node' | 'artifacts'> {}

export function registerProjectArtifactRoutes(app: Express, ctx: RegisterProjectArtifactRoutesDeps) {
  const { upload } = ctx.uploads;
  const { ARTIFACTS_DIR } = ctx.paths;
  const { path, fs } = ctx.node;
  const { sanitizeSlug, lintArtifact, renderFindingsForAgent } = ctx.artifacts;
  app.post('/api/upload', upload.array('images', 8), (req, res) => {
    const files = ((req.files || []) as any[]).map((f: any) => ({
      name: f.originalname,
      path: f.path,
      size: f.size,
    }));
    res.json({ files });
  });

  // Persist a generated artifact (HTML) to disk so the user can re-open it
  // in their browser or hand it off. Returns the on-disk path + a served URL.
  // The body is also passed through the anti-slop linter; findings are
  // returned alongside the path so the UI can render a P0/P1 badge and the
  // chat layer can splice them into a system reminder for the agent.
  app.post('/api/artifacts/save', (req, res) => {
    try {
      const { identifier, title, html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const slug = sanitizeSlug(identifier || title || 'artifact');
      const dir = path.join(ARTIFACTS_DIR, `${stamp}-${slug}`);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'index.html');
      fs.writeFileSync(file, html, 'utf8');
      const findings = lintArtifact(html);
      res.json({
        path: file,
        url: `/artifacts/${path.basename(dir)}/index.html`,
        lint: findings,
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Standalone lint endpoint — POST raw HTML, get findings back.
  // The chat layer uses this to lint streamed-in artifacts without writing
  // them to disk first, so a P0 issue can be surfaced before save.
  app.post('/api/artifacts/lint', (req, res) => {
    try {
      const { html } = req.body || {};
      if (typeof html !== 'string' || html.length === 0) {
        return res.status(400).json({ error: 'html required' });
      }
      const findings = lintArtifact(html);
      res.json({
        findings,
        agentMessage: renderFindingsForAgent(findings),
      });
    } catch (err: any) {
      res.status(500).json({ error: String(err) });
    }
  });

}

export interface RegisterProjectFileRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'uploads' | 'node' | 'projectStore' | 'projectFiles' | 'documents' | 'artifacts' | 'projectPreviewScopes'> {}

export function registerProjectFileRoutes(app: Express, ctx: RegisterProjectFileRoutesDeps) {
  const { db } = ctx;
  const { sendApiError, sendMulterError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { upload } = ctx.uploads;
  const { fs } = ctx.node;
  const { getProject } = ctx.projectStore;
  const { listFiles, listProjectFolders, createProjectFolder, deleteProjectFolder, renameProjectFolder, searchProjectFiles, readProjectFile, resolveProjectDir, resolveProjectFilePath, parseByteRange, renameProjectFile, deleteProjectFile, writeProjectFile, sanitizeName, sanitizePath, ensureProject } = ctx.projectFiles;
  const { buildDocumentPreview } = ctx.documents;
  const { validateArtifactManifestInput } = ctx.artifacts;
  const { projectPreviewScopes } = ctx;
  const projectPreviewIframeSandbox = 'allow-scripts allow-forms';
  const projectPreviewCsp = [
    `sandbox ${projectPreviewIframeSandbox}`,
    "default-src 'self' data: blob:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; ');
  const previewScopeRe = /^[A-Za-z0-9_-]{8,128}$/u;

  function setProjectPreviewHeaders(res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', projectPreviewCsp);
  }

  function rejectInternalVersionPath(res: Response, value: unknown): boolean {
    if (!isProjectFileVersionPath(value)) return false;
    sendApiError(res, 404, 'FILE_NOT_FOUND', 'file not found');
    return true;
  }

  function normalizeProjectFileVersionSource(value: unknown): ProjectFileVersionSource | undefined {
    return value === 'ai' || value === 'manual' || value === 'restore' ? value : undefined;
  }

  function parseProjectFileVersionSourceInput(
    value: unknown,
    fieldName: 'source' | 'versionSource',
  ): ProjectFileVersionSource | undefined {
    if (value === undefined || value === null) return undefined;
    const normalized = normalizeProjectFileVersionSource(value);
    if (normalized) return normalized;
    throw new Error(`invalid ${fieldName}; expected one of: ai, manual, restore`);
  }

  function requestProjectFileVersionSource(value: unknown): ProjectFileVersionSource {
    return parseProjectFileVersionSourceInput(value, 'source') ?? 'manual';
  }

  function requestProjectFileVersionUploadSource(body: any): ProjectFileVersionSource {
    const hasVersionSource = body?.versionSource !== undefined && body?.versionSource !== null;
    return parseProjectFileVersionSourceInput(
      hasVersionSource ? body.versionSource : body?.source,
      hasVersionSource ? 'versionSource' : 'source',
    ) ?? 'manual';
  }

  function latestProjectPrompt(project: any): { prompt: string | null; promptSource?: Extract<ProjectFileVersionPromptSource, 'message' | 'project'> } {
    try {
      const row = db.prepare(
        `SELECT m.content
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE c.project_id = ?
            AND m.role = 'user'
            AND LENGTH(TRIM(m.content)) > 0
          ORDER BY COALESCE(m.ended_at, m.started_at, m.created_at, 0) DESC,
                   m.position DESC
          LIMIT 1`,
      ).get(project?.id) as { content?: string } | undefined;
      if (typeof row?.content === 'string' && row.content.trim()) {
        return { prompt: row.content.trim(), promptSource: 'message' };
      }
    } catch {
      // Prompt provenance is best-effort; versions still save without it.
    }
    if (typeof project?.pendingPrompt === 'string' && project.pendingPrompt.trim()) {
      return { prompt: project.pendingPrompt.trim(), promptSource: 'project' };
    }
    if (typeof project?.pending_prompt === 'string' && project.pending_prompt.trim()) {
      return { prompt: project.pending_prompt.trim(), promptSource: 'project' };
    }
    return { prompt: null };
  }

  type HtmlVersionOverride = {
    prompt?: string | null;
    promptSource?: ProjectFileVersionPromptSource;
    source?: ProjectFileVersionSource;
    label?: string | null;
  };

  function htmlVersionOptions(
    project: any,
    override?: HtmlVersionOverride,
  ): {
    prompt: string | null;
    promptSource?: ProjectFileVersionPromptSource;
    source?: ProjectFileVersionSource;
    label?: string;
  } {
    const fallbackPromptInfo = latestProjectPrompt(project);
    const prompt = override?.prompt !== undefined
      ? (typeof override.prompt === 'string' && override.prompt.trim() ? override.prompt.trim() : null)
      : (override?.source === 'manual' || override?.source === 'restore' ? null : fallbackPromptInfo.prompt);
    const promptSource = override?.promptSource
      ?? (override?.source === 'manual'
        ? 'manual'
        : override?.source === 'restore'
          ? 'restore'
          : fallbackPromptInfo.promptSource);
    const versionOptions: {
      prompt: string | null;
      promptSource?: ProjectFileVersionPromptSource;
      source?: ProjectFileVersionSource;
      label?: string;
    } = {
      prompt,
    };
    if (promptSource) versionOptions.promptSource = promptSource;
    if (override?.source) versionOptions.source = override.source;
    if (typeof override?.label === 'string' && override.label.trim()) {
      versionOptions.label = override.label.trim();
    }
    return versionOptions;
  }

  type HtmlVersionLock = {
    ensureCurrentVersion: (
      content: string,
      options?: ReturnType<typeof htmlVersionOptions>,
    ) => Promise<ProjectFileVersion | null>;
  };

  function htmlVersionCaptureWarning(err: unknown): ProjectFileVersionWarning {
    const message = err instanceof Error ? err.message : String(err);
    return {
      code: 'PROJECT_FILE_VERSION_CAPTURE_FAILED',
      message: `HTML version could not be saved: ${message}`,
    };
  }

  async function tryEnsureLockedHtmlCurrentVersion(
    project: any,
    fileName: string,
    content: string,
    ensureCurrentVersion: HtmlVersionLock['ensureCurrentVersion'],
    override?: HtmlVersionOverride,
  ): Promise<{ version: ProjectFileVersion | null; versionWarning?: ProjectFileVersionWarning }> {
    if (!/\.html?$/i.test(fileName)) return { version: null };
    try {
      return { version: await ensureCurrentVersion(content, htmlVersionOptions(project, override)) };
    } catch (err) {
      return { version: null, versionWarning: htmlVersionCaptureWarning(err) };
    }
  }

  function fileFromVersionHistory(fileName: string, versions: ProjectFileVersion[]): ProjectFile | null {
    const latest = versions.at(-1);
    if (!latest) return null;
    return {
      name: latest.fileName || fileName,
      path: latest.fileName || fileName,
      type: 'file',
      size: latest.size,
      mtime: latest.createdAt,
      kind: latest.kind,
      mime: latest.mime,
    };
  }

  // Lets a browser (or the desktop export window, which shares the same Chromium
  // session/cache as the web UI) reuse already-downloaded fonts/CSS/images
  // across loads instead of re-fetching them every time — covers, live preview,
  // and screenshot export all hit /raw/. The ETag/Last-Modified are derived from
  // the file's size+mtime, so any agent rewrite changes them and busts the cache
  // immediately; `no-cache` means "always revalidate" (never serve stale without
  // asking), so a 304 only happens when the bytes are genuinely unchanged.
  function setRawRevalidationHeaders(res: Response, meta: { size: number; mtime: number }): string {
    const mtime = Math.floor(meta.mtime);
    const etag = `W/"${meta.size.toString(16)}-${mtime.toString(16)}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', new Date(mtime).toUTCString());
    res.setHeader('Cache-Control', 'no-cache');
    return etag;
  }

  function rawRequestIsFresh(req: any, etag: string, mtimeMs: number): boolean {
    // If-None-Match is authoritative when present (RFC 9110 §13.1.3): freshness
    // is decided solely by whether the ETag matches — do NOT fall through to
    // If-Modified-Since. Otherwise a same-second rewrite (ETag changes
    // immediately, but Last-Modified is identical at HTTP-date second
    // granularity) would 304 stale-but-changed bytes when a client sends both a
    // non-matching ETag and the current If-Modified-Since.
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string') {
      return ifNoneMatch.split(',').some((tag) => tag.trim() === etag);
    }
    const ifModifiedSince = req.headers['if-modified-since'];
    if (typeof ifModifiedSince === 'string') {
      const since = Date.parse(ifModifiedSince);
      // Last-Modified is second-resolution, so compare at second granularity.
      if (Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since) return true;
    }
    return false;
  }

  function setProjectDownloadHeaders(req: any, res: Response, fileName: string): boolean {
    if (req.query?.download !== '1' && !/\.mph$/i.test(fileName)) return false;
    const basename = path.basename(fileName).replace(/[\r\n]/g, '_') || 'download';
    const asciiName = basename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\;]/g, '_').trim() || 'download';
    const encoded = encodeURIComponent(basename).replace(/[!'()*]/g, (char) =>
      `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    return true;
  }

  // RFC 9110 §13.1.5: a Range request with If-Range may only be served as 206
  // when the If-Range validator still matches the current representation; if it
  // doesn't (the file changed), the range must be ignored and the full current
  // file returned, so a resumed download can't splice stale + fresh bytes.
  //
  // §13.1.5 also requires the entity-tag form to use a STRONG validator. Our
  // ETag is weak (`W/"size-mtime"` — size+mtime is not byte-exact), so an
  // entity-tag If-Range can never authorize partial content: a same-size rewrite
  // or mtime-granularity collision could otherwise splice stale + fresh bytes
  // under a matching weak tag. We therefore reject ALL entity-tag If-Range values
  // (weak ones explicitly; a strong `"…"` never equals our weak ETag anyway) and
  // honor only the date form.
  function ifRangeAllowsPartial(req: any, _etag: string, mtimeMs: number): boolean {
    const ifRange = req.headers['if-range'];
    if (typeof ifRange !== 'string' || ifRange.length === 0) return true; // no If-Range → honor Range
    const value = ifRange.trim();
    // Any entity-tag (weak `W/"…"` or strong `"…"`) → not a strong match against
    // our weak validator → fall back to the full 200.
    if (value.startsWith('"') || value.startsWith('W/')) return false;
    // Date form: honor the range only if the file has NOT changed since (its
    // current Last-Modified is at/before the If-Range date).
    const since = Date.parse(value);
    return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }

  async function sendProjectFile(
    req: any,
    res: Response,
    projectId: string,
    relPath: string,
    metadata?: unknown,
    beforeSend?: (mime: string) => void,
    transformFile?: (file: { mime: string; buffer: Buffer }) => Buffer | string | Promise<Buffer | string>,
    revalidate = false,
  ) {
    const meta = await resolveProjectFilePath(
      PROJECTS_DIR,
      projectId,
      relPath,
      metadata,
    );
    const isDownload = setProjectDownloadHeaders(req, res, meta.name);
    beforeSend?.(meta.mime);

    const isStreamed = meta.mime.startsWith('video/') || meta.mime.startsWith('audio/');
    // A transform (the Vite dev-entry -> dist/index.html substitution, or preview
    // bridge injection) can replace the response bytes — but only for HTML. For
    // HTML the source file's mtime/size is NOT a valid validator, so its ETag is
    // computed from the actual sent bytes after the transform. Everything else
    // (assets, fonts, images, streamed media — where the transform is a no-op)
    // keeps the fast mtime ETag with an early 304.
    const willSubstitute =
      !isDownload && !isStreamed && !!transformFile && /^text\/html(?:;|$)/i.test(meta.mime);

    let currentEtag: string | null = null;
    if (revalidate && !willSubstitute && !isDownload) {
      currentEtag = setRawRevalidationHeaders(res, meta);
      if (rawRequestIsFresh(req, currentEtag, meta.mtime)) {
        return res.status(304).end();
      }
    }

    if (isStreamed) {
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', meta.mime);

      if (meta.size === 0) {
        res.setHeader('Content-Length', '0');
        return res.status(200).end();
      }

      // Honor Range only when If-Range still matches the current file — otherwise
      // a resumed download after a rewrite would splice stale + fresh bytes.
      const range =
        ifRangeAllowsPartial(req, currentEtag ?? '', meta.mtime)
          ? parseByteRange(req.headers.range, meta.size)
          : null;

      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${meta.size}`);
        return res.status(416).end();
      }

      let start;
      let end;
      let statusCode;
      if (range) {
        ({ start, end } = range);
        statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${meta.size}`);
        res.setHeader('Content-Length', String(end - start + 1));
      } else {
        start = 0;
        end = meta.size - 1;
        statusCode = 200;
        res.setHeader('Content-Length', String(meta.size));
      }

      res.status(statusCode);
      const stream = fs.createReadStream(meta.filePath, { start, end });
      stream.on('error', (streamErr: any) => {
        if (!res.headersSent) {
          sendApiError(res, 500, 'STREAM_ERROR', String(streamErr));
        } else {
          res.destroy(streamErr);
        }
      });
      stream.pipe(res);
      return;
    }

    const file = await readProjectFile(PROJECTS_DIR, projectId, relPath, metadata);
    const body = !isDownload && transformFile ? await transformFile(file) : file.buffer;
    if (revalidate && willSubstitute) {
      // Validator from the ACTUAL response bytes, so a change to the substituted
      // content (e.g. dist/index.html) busts the cache even when the source
      // file's mtime is unchanged.
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
      const etag = `W/"${createHash('sha1').update(buf).digest('hex').slice(0, 16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Last-Modified', new Date(Math.floor(meta.mtime)).toUTCString());
      const ifNoneMatch = req.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
        return res.status(304).end();
      }
      return res.type(file.mime).send(buf);
    }
    res.type(file.mime).send(body);
  }

  function previewFilePathForProject(project: any, queryFile: unknown): string {
    if (typeof queryFile === 'string' && queryFile.trim().length > 0) {
      return queryFile;
    }
    const entryFile = project?.metadata?.entryFile;
    return typeof entryFile === 'string' && entryFile.length > 0 ? entryFile : 'index.html';
  }

  function encodeProjectPathForUrl(filePath: string): string {
    return filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }

  async function maybeResolveVitePreviewHtml({
    file,
    projectId,
    relPath,
    metadata,
    projectsRoot,
    readProjectFile,
  }: {
    file: { mime: string; buffer: Buffer };
    projectId: string;
    relPath: string;
    metadata?: unknown;
    projectsRoot: string;
    readProjectFile: (projectsRoot: string, projectId: string, relPath: string, metadata?: unknown) => Promise<{ buffer: Buffer }>;
  }): Promise<Buffer | string> {
    if (!/^text\/html(?:;|$)/i.test(file.mime)) return file.buffer;
    const html = file.buffer.toString('utf8');
    if (!isViteDevHtmlEntry(html)) return file.buffer;

    const ownerDir = path.posix.dirname(relPath);
    const distRelPath = ownerDir === '.' ? 'dist/index.html' : `${ownerDir}/dist/index.html`;
    try {
      const distFile = await readProjectFile(projectsRoot, projectId, distRelPath, metadata);
      return rewriteViteDistAssetUrlsForPreview(distFile.buffer.toString('utf8'));
    } catch {
      return file.buffer;
    }
  }

  function isViteDevHtmlEntry(html: string): boolean {
    return /<script\b[^>]*\btype\s*=\s*["']module["'][^>]*\bsrc\s*=\s*["']\/src\/[^"']+["'][^>]*>\s*<\/script>/i.test(html);
  }

  function rewriteViteDistAssetUrlsForPreview(html: string): string {
    return html.replace(
      /\b(href|src)\s*=\s*(["'])\/assets\//gi,
      (_match, attr: string, quote: string) => `${attr}=${quote}dist/assets/`,
    );
  }

  // Project files. Each project owns a flat folder under .od/projects/<id>/
  // containing every file the user has uploaded, pasted, sketched, or that
  // the agent has generated. Names are sanitized; paths are confined to the
  // project's own folder (see apps/daemon/src/projects.ts).
  app.get('/api/projects/:id/files', async (req, res) => {
    try {
      const since = Number(req.query?.since);
      const project = getProject(db, req.params.id);
      const result = await listCachedProjectFiles(PROJECTS_DIR, req.params.id, {
        since: req.query.limit === undefined && Number.isFinite(since) ? since : undefined,
        metadata: project?.metadata,
        scanner: listFiles,
      });
      if (req.query.limit !== undefined) {
        const files = typeof req.query.path === 'string'
          ? result.files.filter(file => (file.path || file.name) === req.query.path)
          : req.query.kind === 'image' || req.query.kind === 'html'
            ? result.files.filter(file => file.kind === req.query.kind) : result.files;
        return res.json(projectFilePage(files, result.snapshotAt, Number(req.query.limit),
          typeof req.query.cursor === 'string' ? req.query.cursor : undefined));
      }
      /** @type {import('@open-design/contracts').ProjectFilesResponse} */
      const body = result;
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects/:id/search', async (req, res) => {
    try {
      const query = String(req.query.q ?? '');
      if (!query) {
        sendApiError(res, 400, 'BAD_REQUEST', 'q query parameter is required');
        return;
      }
      const pattern = req.query.pattern ? String(req.query.pattern) : null;
      const max = Math.min(Number(req.query.max) || 200, 1000);
      const searchProject = getProject(db, req.params.id);
      const matches = await searchProjectFiles(PROJECTS_DIR, req.params.id, query, {
        pattern,
        max,
        metadata: searchProject?.metadata,
      });
      res.json({ query, matches });
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.get('/api/projects/:id/folders', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const folders = await listProjectFolders(PROJECTS_DIR, req.params.id, {
        metadata: project.metadata,
      });
      /** @type {import('@open-design/contracts').ProjectFoldersResponse} */
      const body = { folders };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err));
    }
  });

  app.post('/api/projects/:id/folders', async (req, res) => {
    try {
      const { name } = req.body || {};
      if (typeof name !== 'string' || !name.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'name required');
      }
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const folder = await createProjectFolder(
        PROJECTS_DIR,
        req.params.id,
        name,
        project.metadata,
      );
      /** @type {import('@open-design/contracts').ProjectFolderResponse} */
      const body = { folder };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.delete('/api/projects/:id/folders', async (req, res) => {
    try {
      const { path: folderPath } = req.body || {};
      if (typeof folderPath !== 'string' || !folderPath.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'path required');
      }
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      await deleteProjectFolder(
        PROJECTS_DIR,
        req.params.id,
        folderPath,
        project.metadata,
      );
      invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, project.metadata);
      /** @type {import('@open-design/contracts').DeleteProjectFolderResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err: any) {
      sendApiError(res, 400, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  // Rename/move a folder (with all its contents) inside the project sandbox.
  // Body: { from: "old/rel/path", to: "new/rel/path" }.
  app.post('/api/projects/:id/folders/rename', async (req, res) => {
    try {
      const { from, to } = req.body || {};
      if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'from and to required');
      }
      const project = getProject(db, req.params.id);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const folder = await renameProjectFolder(
        PROJECTS_DIR,
        req.params.id,
        from,
        to,
        project.metadata,
      );
      invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, project.metadata);
      /** @type {import('@open-design/contracts').ProjectFolderResponse} */
      const body = { folder };
      res.json(body);
    } catch (err: any) {
      const status = err?.code === 'EEXIST' ? 409 : err?.code === 'ENOENT' ? 404 : 400;
      sendApiError(res, status, 'BAD_REQUEST', String(err?.message || err));
    }
  });

  app.get('/api/projects/:id/preview-url', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      const requestedPath = previewFilePathForProject(project, req.query.file);
      const meta = await resolveProjectFilePath(
        PROJECTS_DIR,
        project.id,
        requestedPath,
        project.metadata,
      );
      const scope = projectPreviewScopes.mint(project.id);
      /** @type {import('@open-design/contracts').ProjectPreviewUrlResponse} */
      const body = {
        url: `/api/projects/${encodeURIComponent(project.id)}/preview/${scope}/${encodeProjectPathForUrl(meta.name)}`,
        file: meta.name,
        csp: projectPreviewCsp,
        iframeSandbox: projectPreviewIframeSandbox,
        opaqueOrigin: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/preview\/([^/]+)\/(.+)$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string; 2?: string };
      const projectId = String(params[0] ?? '');
      const scope = String(params[1] ?? '');
      const relPath = String(params[2] ?? '');
      if (!previewScopeRe.test(scope)) {
        sendApiError(res, 400, 'BAD_REQUEST', 'invalid preview scope');
        return;
      }
      const project = getProject(db, projectId);
      if (!project) {
        sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
        return;
      }
      if (!projectPreviewScopes.validate(project.id, scope)) {
        sendApiError(res, 404, 'PREVIEW_SCOPE_NOT_FOUND', 'preview scope not found');
        return;
      }
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }
      await sendProjectFile(
        req,
        res,
        project.id,
        relPath,
        project.metadata,
        () => setProjectPreviewHeaders(res),
        async (file) => maybeResolveVitePreviewHtml({
          file,
          projectId: project.id,
          relPath,
          metadata: project.metadata,
          projectsRoot: PROJECTS_DIR,
          readProjectFile,
        }),
      );
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });


  // Preflight for the raw file route. Current artifact fetches are simple GETs
  // (no preflight needed), but an explicit handler future-proofs the route if
  // artifacts ever add custom request headers.
  app.options(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, (req, res) => {
    if (req.headers.origin === 'null') {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    }
    res.sendStatus(204);
  });

  app.get(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string };
      const projectId = String(params[0] ?? '');
      const relPath = String(params[1] ?? '');
      if (rejectInternalVersionPath(res, relPath)) return;
      const project = getProject(db, projectId);
      // The preview iframe loads artifact HTML via srcdoc, giving the iframe Origin: "null".
      // data: URIs, file://, and some sandboxed iframes also send null — all are
      // local-only callers, so this is safe. Real cross-origin sites send a real
      // origin and remain blocked by the browser's same-origin policy.
      if (req.headers.origin === 'null') {
        res.header('Access-Control-Allow-Origin', '*');
      }

      await sendProjectFile(
        req,
        res,
        projectId,
        relPath,
        project?.metadata,
        undefined,
        async (file) => {
          let transformed = await maybeResolveVitePreviewHtml({
            file,
            projectId,
            relPath,
            metadata: project?.metadata,
            projectsRoot: PROJECTS_DIR,
            readProjectFile,
          });
          if (
            (wantsUrlPreviewScrollBridge(req.query.odPreviewBridge) ||
              wantsUrlPreviewSelectionBridge(req.query.odPreviewBridge) ||
              wantsUrlPreviewSnapshotBridge(req.query.odPreviewBridge)) &&
            /^text\/html(?:;|$)/i.test(file.mime)
          ) {
            let html = Buffer.isBuffer(transformed) ? transformed.toString('utf8') : transformed;
            // Sanitize the <title> so Cmd+P → "Save as PDF" produces a
            // Teams-safe filename. The URL-load iframe uses sandbox without
            // allow-same-origin, so the host cannot rewrite contentDocument.title
            // after load — we must do it here in the response. The srcDoc path
            // has its own sanitization in buildSrcdoc (apps/web/src/runtime/srcdoc.ts).
            html = daemonSanitizeTitleInDoc(html);
            if (wantsUrlPreviewScrollBridge(req.query.odPreviewBridge)) {
              html = injectUrlPreviewBridge(html, 'scroll');
            }
            if (wantsUrlPreviewSelectionBridge(req.query.odPreviewBridge)) {
              html = injectUrlPreviewBridge(html, 'selection');
            }
            if (wantsUrlPreviewSnapshotBridge(req.query.odPreviewBridge)) {
              html = injectUrlPreviewBridge(html, 'snapshot');
            }
            transformed = html;
          }
          return transformed;
        },
        true, // revalidate: emit ETag/Last-Modified so covers/preview/export reuse cached assets
      );
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.delete(/^\/api\/projects\/([^/]+)\/raw\/(.+)$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string };
      const projectId = String(params[0] ?? '');
      const rawSplat = String(params[1] ?? '');
      if (rejectInternalVersionPath(res, rawSplat)) return;
      const project = getProject(db, projectId);
      const expectedEtag = typeof req.query.expectedEtag === 'string'
        ? req.query.expectedEtag
        : undefined;
      await deleteProjectFile(
        PROJECTS_DIR,
        projectId,
        rawSplat,
        project?.metadata,
        expectedEtag,
      );
      await markProjectFileVersionStoreDeleted(PROJECTS_DIR, projectId, rawSplat, project?.metadata);
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err: any) {
      const status = err?.code === 'ENOENT'
        ? 404
        : err?.code === 'PROJECT_FILE_CONFLICT'
          ? 409
          : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  app.get('/api/projects/:id/files/:name/preview', async (req, res) => {
    try {
      const project = getProject(db, req.params.id);
      const file = await readProjectFile(
        PROJECTS_DIR,
        req.params.id,
        req.params.name,
        project?.metadata,
      );
      const preview = await buildDocumentPreview(file);
      res.json(preview);
    } catch (err: any) {
      const status =
        err && err.statusCode
          ? err.statusCode
          : err && err.code === 'ENOENT'
            ? 404
            : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        err?.message || 'preview unavailable',
      );
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)\/versions$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string };
      const projectId = String(params[0] ?? '');
      const fileName = String(params[1] ?? '');
      if (rejectInternalVersionPath(res, fileName)) return;
      const project = getProject(db, projectId);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      if (!/\.html?$/i.test(fileName)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'versions are only available for HTML files');
      }
      let file: ProjectFile | null = null;
      let historyFileName = fileName;
      try {
        const workingFile = await readProjectFile(PROJECTS_DIR, project.id, fileName, project.metadata);
        if (!/\.html?$/i.test(workingFile.name)) {
          return sendApiError(res, 400, 'BAD_REQUEST', 'versions are only available for HTML files');
        }
        file = workingFile;
        historyFileName = workingFile.name;
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
      }
      const versions = await listProjectFileVersions(PROJECTS_DIR, project.id, historyFileName, project.metadata);
      file ??= fileFromVersionHistory(historyFileName, versions);
      if (!file) {
        return sendApiError(res, 404, 'FILE_NOT_FOUND', 'file not found');
      }
      /** @type {import('@open-design/contracts').ProjectFileVersionsResponse} */
      const body = { file, versions };
      res.setHeader('Cache-Control', 'no-store');
      res.json(body);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/files\/(.+)\/versions$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string };
      const projectId = String(params[0] ?? '');
      const fileName = String(params[1] ?? '');
      if (rejectInternalVersionPath(res, fileName)) return;
      const project = getProject(db, projectId);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const file = await readProjectFile(PROJECTS_DIR, project.id, fileName, project.metadata);
      if (!/\.html?$/i.test(file.name)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'versions are only available for HTML files');
      }
      const manualPrompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : null;
      const requestedSource = requestProjectFileVersionSource(req.body?.source);
      const fallbackPromptInfo = requestedSource === 'ai' && !manualPrompt ? latestProjectPrompt(project) : null;
      const versionOptions: {
        prompt: string | null;
        promptSource?: ProjectFileVersionPromptSource;
        source: ProjectFileVersionSource;
        label?: string | null;
      } = {
        prompt: manualPrompt ?? fallbackPromptInfo?.prompt ?? null,
        source: requestedSource,
        label: typeof req.body?.label === 'string' ? req.body.label : null,
      };
      if (manualPrompt) {
        versionOptions.promptSource = 'manual';
      } else if (requestedSource === 'manual') {
        versionOptions.promptSource = 'manual';
      } else if (requestedSource === 'restore') {
        versionOptions.promptSource = 'restore';
      } else if (fallbackPromptInfo?.promptSource) {
        versionOptions.promptSource = fallbackPromptInfo.promptSource;
      }
      const version = await createProjectFileVersion(
        PROJECTS_DIR,
        project.id,
        file.name,
        file.buffer.toString('utf8'),
        versionOptions,
        project.metadata,
      );
      if (!version) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'version could not be created');
      }
      /** @type {import('@open-design/contracts').CreateProjectFileVersionResponse} */
      const body = { version };
      res.json(body);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.post(/^\/api\/projects\/([^/]+)\/files\/(.+)\/versions\/([^/]+)\/restore$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string; 2?: string };
      const projectId = String(params[0] ?? '');
      const fileName = String(params[1] ?? '');
      const versionId = String(params[2] ?? '');
      if (rejectInternalVersionPath(res, fileName)) return;
      const project = getProject(db, projectId);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const restored = await readProjectFileVersion(
        PROJECTS_DIR,
        project.id,
        fileName,
        versionId,
        project.metadata,
      );
      const requestPrompt = typeof req.body?.prompt === 'string' && req.body.prompt.trim()
        ? req.body.prompt.trim()
        : null;
      const prompt = requestPrompt
        ?? restored.version.prompt
        ?? latestProjectPrompt(project).prompt;
      const { file, version, versionWarning } = await withProjectFileVersionLock(
        PROJECTS_DIR,
        project.id,
        fileName,
        project.metadata,
        async (versionLock) => {
          const file = await writeProjectFile(
            PROJECTS_DIR,
            project.id,
            fileName,
            Buffer.from(restored.content, 'utf8'),
            {},
            project.metadata,
          );
          let version: ProjectFileVersion | null = null;
          let versionWarning: ProjectFileVersionWarning | undefined;
          try {
            version = await versionLock.createVersion(restored.content, {
              prompt,
              promptSource: requestPrompt ? 'manual' : 'restore',
              source: 'restore',
              restoreFromVersionId: restored.version.id,
            });
          } catch (err) {
            versionWarning = htmlVersionCaptureWarning(err);
          }
          return { file, version, versionWarning };
        },
      );
      /** @type {import('@open-design/contracts').RestoreProjectFileVersionResponse} */
      const body = { file, version, ...(versionWarning ? { versionWarning } : {}) };
      res.json(body);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'VERSION_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)\/versions\/([^/]+)$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string; 2?: string };
      const projectId = String(params[0] ?? '');
      const fileName = String(params[1] ?? '');
      const versionId = String(params[2] ?? '');
      if (rejectInternalVersionPath(res, fileName)) return;
      const project = getProject(db, projectId);
      if (!project) {
        return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      }
      const body = await readProjectFileVersion(
        PROJECTS_DIR,
        project.id,
        fileName,
        versionId,
        project.metadata,
      );
      /** @type {import('@open-design/contracts').ProjectFileVersionResponse} */
      const typedBody = body;
      res.setHeader('Cache-Control', 'no-store');
      res.json(typedBody);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'VERSION_NOT_FOUND' : 'BAD_REQUEST',
        String(err?.message || err),
      );
    }
  });

  app.get(/^\/api\/projects\/([^/]+)\/files\/(.+)$/u, async (req, res) => {
    try {
      const params = req.params as unknown as { 0?: string; 1?: string };
      const projectId = String(params[0] ?? '');
      const fileSplat = String(params[1] ?? '');
      if (rejectInternalVersionPath(res, fileSplat)) return;
      const project = getProject(db, projectId);
      const file = await readProjectFile(
        PROJECTS_DIR,
        projectId,
        fileSplat,
        project?.metadata,
      );
      res.setHeader('X-MatOS-File-Revision', file.etag);
      res.setHeader('Cache-Control', 'no-store');
      res.type(file.mime).send(file.buffer);
    } catch (err: any) {
      const status = err && err.code === 'ENOENT' ? 404 : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

  // Two ways to upload: multipart for binary files (images), and JSON
  // {name, content, encoding} for sketches and pasted text. The frontend
  // uses both depending on the file source.
  app.post(
    '/api/projects/:id/files',
    (req, res, next) => {
      upload.single('file')(req, res, (err: any) => {
        if (err) return sendMulterError(res, err);
        next();
      });
    },
    async (req, res) => {
      try {
        const uploadProject = getProject(db, req.params.id);
        await ensureProject(PROJECTS_DIR, req.params.id, uploadProject?.metadata);
        if (req.file) {
          try {
            const buf = await fs.promises.readFile(req.file.path);
            // A caller-supplied `name` may carry an intentional subdirectory
            // (e.g. "imagery/hero.png" from the design-kit uploader). Preserve it
            // with sanitizePath (sanitizes each segment, keeps the slashes) so the
            // file lands where the import expects it; sanitizeName would flatten
            // the slash to "_" and orphan the asset at the project root. Raw
            // multipart originalnames are plain basenames, so sanitizeName fits.
            const desiredName = req.body?.name
              ? sanitizePath(req.body.name)
              : sanitizeName(req.file.originalname);
            if (rejectInternalVersionPath(res, desiredName)) return;
            const requestedSource = uploadProject && /\.html?$/i.test(desiredName)
              ? requestProjectFileVersionUploadSource(req.body)
              : null;
            const writeAndCapture = async (versionLock?: HtmlVersionLock) => {
              const meta = await writeProjectFile(
                PROJECTS_DIR,
                req.params.id,
                desiredName,
                buf,
                {
                  ...(typeof req.body?.expectedEtag === 'string' || req.body?.expectedEtag === null
                    ? { expectedEtag: req.body.expectedEtag }
                    : {}),
                },
                uploadProject?.metadata,
              );
              const versionCapture = uploadProject && requestedSource && /\.html?$/i.test(meta.name) && versionLock
                ? await (async () => {
                  const savedFile = await readProjectFile(PROJECTS_DIR, uploadProject.id, meta.name, uploadProject.metadata);
                  return tryEnsureLockedHtmlCurrentVersion(
                    uploadProject,
                    meta.name,
                    savedFile.buffer.toString('utf8'),
                    versionLock.ensureCurrentVersion,
                    {
                      prompt: typeof req.body?.versionPrompt === 'string' ? req.body.versionPrompt : null,
                      promptSource: 'manual',
                      source: requestedSource,
                      label: typeof req.body?.versionLabel === 'string' ? req.body.versionLabel : null,
                    },
                  );
                })()
                : null;
              return { meta, versionCapture };
            };
            const { meta, versionCapture } = uploadProject && requestedSource
              ? await withProjectFileVersionLock(
                PROJECTS_DIR,
                req.params.id,
                desiredName,
                uploadProject.metadata,
                (versionLock) => writeAndCapture(versionLock),
              )
              : await writeAndCapture();
            await updateCachedProjectFilesFromEvent(
              PROJECTS_DIR,
              req.params.id,
              { path: meta.path || meta.name, kind: 'change' },
              uploadProject?.metadata,
            ).catch(() => {
              invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, uploadProject?.metadata);
            });
            /** @type {import('@open-design/contracts').ProjectFileResponse} */
            const body = {
              file: meta,
              ...(versionCapture?.versionWarning ? { versionWarning: versionCapture.versionWarning } : {}),
            };
            return res.json(body);
          } finally {
            fs.promises.unlink(req.file.path).catch(() => {});
          }
        }
        const {
          name,
          content,
          encoding,
          artifactManifest,
          artifact,
          overwrite,
          versionLabel,
          versionPrompt,
          expectedEtag,
        } = req.body || {};
        if (typeof name !== 'string' || typeof content !== 'string') {
          return sendApiError(
            res,
            400,
            'BAD_REQUEST',
            'name and content required',
          );
        }
        if (rejectInternalVersionPath(res, name)) return;
        const desiredName = sanitizePath(name);
        if (rejectInternalVersionPath(res, desiredName)) return;
        const requestedSource = uploadProject && /\.html?$/i.test(desiredName)
          ? requestProjectFileVersionUploadSource(req.body)
          : null;
        if (artifactManifest !== undefined && artifactManifest !== null) {
          const validated = validateArtifactManifestInput(
            artifactManifest,
            name,
          );
          if (!validated.ok) {
            return sendApiError(
              res,
              400,
              'BAD_REQUEST',
              `invalid artifactManifest: ${validated.error}`,
            );
          }
        }
        const buf =
          encoding === 'base64'
            ? Buffer.from(content, 'base64')
            : Buffer.from(content, 'utf8');
        const writeAndCapture = async (versionLock?: HtmlVersionLock) => {
          const meta = artifact === true
            ? await createProjectArtifactFile({
              projectsRoot: PROJECTS_DIR,
              projectId: req.params.id,
              input: { name, content, encoding, artifactManifest },
              metadata: uploadProject?.metadata,
              writeProjectFile,
            })
            : await writeProjectFile(
              PROJECTS_DIR,
              req.params.id,
              name,
              buf,
              {
                artifactManifest,
                ...(overwrite === false ? { overwrite: false } : {}),
                ...(typeof expectedEtag === 'string' || expectedEtag === null
                  ? { expectedEtag }
                  : {}),
              },
              uploadProject?.metadata,
            );
          const versionCapture = uploadProject && requestedSource && /\.html?$/i.test(meta.name) && versionLock
            ? await (async () => {
              const savedFile = await readProjectFile(PROJECTS_DIR, uploadProject.id, meta.name, uploadProject.metadata);
              const versionOverride: HtmlVersionOverride = {
                source: requestedSource,
                label: typeof versionLabel === 'string' ? versionLabel : null,
              };
              if (typeof versionPrompt === 'string') {
                versionOverride.prompt = versionPrompt;
              }
              if (requestedSource === 'manual') {
                versionOverride.promptSource = 'manual';
              } else if (requestedSource === 'restore') {
                versionOverride.promptSource = 'restore';
              }
              return tryEnsureLockedHtmlCurrentVersion(
                uploadProject,
                meta.name,
                savedFile.buffer.toString('utf8'),
                versionLock.ensureCurrentVersion,
                versionOverride,
              );
            })()
            : null;
          return { meta, versionCapture };
        };
        const { meta, versionCapture } = uploadProject && requestedSource
          ? await withProjectFileVersionLock(
            PROJECTS_DIR,
            req.params.id,
            desiredName,
            uploadProject.metadata,
            (versionLock) => writeAndCapture(versionLock),
          )
          : await writeAndCapture();
        await updateCachedProjectFilesFromEvent(
          PROJECTS_DIR,
          req.params.id,
          { path: meta.path || meta.name, kind: 'change' },
          uploadProject?.metadata,
        ).catch(() => {
          invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, uploadProject?.metadata);
        });
        /** @type {import('@open-design/contracts').ProjectFileResponse} */
        const body = {
          file: meta,
          ...(versionCapture?.versionWarning ? { versionWarning: versionCapture.versionWarning } : {}),
        };
        res.json(body);
      } catch (err: any) {
        const message = String(err?.message || err);
        if (/^invalid (source|versionSource);/u.test(message)) {
          return sendApiError(res, 400, 'BAD_REQUEST', message);
        }
        if (err instanceof ArtifactRegressionError) {
          return sendApiError(res, 422, 'ARTIFACT_REGRESSION', err.message, {
            details: {
              identifier: err.identifier,
              newSize: err.newSize,
              priorSize: err.priorSize,
              priorName: err.priorName,
            },
          });
        }
        if (err instanceof ArtifactPublicationBlockedError) {
          return sendApiError(res, 422, 'ARTIFACT_PUBLICATION_BLOCKED', err.message, {
            details: { placeholders: err.placeholders },
          });
        }
        if (err?.code === 'EEXIST') {
          return sendApiError(res, 409, 'FILE_EXISTS', 'file already exists');
        }
        if (err?.code === 'PROJECT_FILE_CONFLICT') {
          return sendApiError(res, 409, 'PROJECT_FILE_CONFLICT', err.message, {
            details: {
              expectedEtag: err.expectedEtag,
              actualEtag: err.actualEtag,
            },
          });
        }
        if (err?.code === 'ARTIFACT_MANIFEST_REQUIRED') {
          return sendApiError(res, 400, 'ARTIFACT_MANIFEST_REQUIRED', err.message);
        }
        if (err?.code === 'ARTIFACT_MANIFEST_INVALID') {
          return sendApiError(res, 400, 'BAD_REQUEST', err.message);
        }
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );

  app.post('/api/projects/:id/files/rename', async (req, res) => {
    try {
      const { from, to, expectedEtag } = req.body || {};
      if (typeof from !== 'string' || typeof to !== 'string') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'from and to required');
      }
      if (rejectInternalVersionPath(res, from) || rejectInternalVersionPath(res, to)) return;
      const project = getProject(db, req.params.id);
      const result = await renameProjectFile(
        PROJECTS_DIR,
        req.params.id,
        from,
        to,
        project?.metadata,
        typeof expectedEtag === 'string' || expectedEtag === null
          ? expectedEtag
          : undefined,
      );
      await renameProjectFileVersionStore(
        PROJECTS_DIR,
        req.params.id,
        result.oldName,
        result.newName,
        project?.metadata,
      );
      await Promise.all([
        updateCachedProjectFilesFromEvent(
          PROJECTS_DIR,
          req.params.id,
          { path: result.oldName, kind: 'unlink' },
          project?.metadata,
        ),
        updateCachedProjectFilesFromEvent(
          PROJECTS_DIR,
          req.params.id,
          { path: result.newName, kind: 'change' },
          project?.metadata,
        ),
      ]).catch(() => {
        invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, project?.metadata);
      });
      /** @type {import('@open-design/contracts').RenameProjectFileResponse} */
      const body = result;
      res.json(body);
    } catch (err: any) {
      if (err?.code === 'EEXIST') {
        return sendApiError(res, 409, 'CONFLICT', String(err?.message || err));
      }
      if (err?.code === 'PROJECT_FILE_CONFLICT') {
        return sendApiError(res, 409, 'PROJECT_FILE_CONFLICT', err.message, {
          details: {
            expectedEtag: err.expectedEtag,
            actualEtag: err.actualEtag,
          },
        });
      }
      const message = String(err?.message || err);
      if (err?.code === 'ENOENT' || message.includes('ENOENT') || message.includes('no such file or directory')) {
        return sendApiError(res, 404, 'FILE_NOT_FOUND', message);
      }
      sendApiError(res, 400, 'BAD_REQUEST', message);
    }
  });

  app.delete('/api/projects/:id/files/:name', async (req, res) => {
    try {
      if (rejectInternalVersionPath(res, req.params.name)) return;
      const delProject = getProject(db, req.params.id);
      const expectedEtag = typeof req.query.expectedEtag === 'string'
        ? req.query.expectedEtag
        : undefined;
      await deleteProjectFile(
        PROJECTS_DIR,
        req.params.id,
        req.params.name,
        delProject?.metadata,
        expectedEtag,
      );
      await markProjectFileVersionStoreDeleted(PROJECTS_DIR, req.params.id, req.params.name, delProject?.metadata);
      await updateCachedProjectFilesFromEvent(
        PROJECTS_DIR,
        req.params.id,
        { path: req.params.name, kind: 'unlink' },
        delProject?.metadata,
      ).catch(() => {
        invalidateCachedProjectFiles(PROJECTS_DIR, req.params.id, delProject?.metadata);
      });
      /** @type {import('@open-design/contracts').DeleteProjectFileResponse} */
      const body = { ok: true };
      res.json(body);
    } catch (err: any) {
      const status = err?.code === 'ENOENT'
        ? 404
        : err?.code === 'PROJECT_FILE_CONFLICT'
          ? 409
          : 400;
      sendApiError(
        res,
        status,
        status === 404 ? 'FILE_NOT_FOUND' : status === 409 ? 'CONFLICT' : 'BAD_REQUEST',
        String(err),
      );
    }
  });

}

export interface RegisterProjectUploadRoutesDeps extends RouteDeps<'http' | 'uploads' | 'node'> {}

export function registerProjectUploadRoutes(app: Express, ctx: RegisterProjectUploadRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { handleProjectUpload } = ctx.uploads;
  const { fs } = ctx.node;

  app.post(
    '/api/projects/:id/upload',
    handleProjectUpload,
    async (req, res) => {
      try {
        const incoming = Array.isArray(req.files) ? req.files : [];
        // Subfolder the upload targeted (sanitized, forward-slash, '' for root),
        // stashed by the multer destination resolver. Prepend it so callers
        // get the file's true project-relative path, not just its basename.
        const relDir = typeof (req as any)._uploadRelDir === 'string' ? (req as any)._uploadRelDir : '';
        const out = [];
        for (const f of incoming) {
          try {
            const stat = await fs.promises.stat(f.path);
            const rel = relDir ? `${relDir}/${f.filename}` : f.filename;
            out.push({
              name: rel,
              path: rel,
              size: stat.size,
              mtime: stat.mtimeMs,
              originalName: f.originalname,
            });
          } catch {
            // skip files that vanished mid-flight
          }
        }
        /** @type {import('@open-design/contracts').UploadProjectFilesResponse} */
        const body = { files: out };
        res.json(body);
      } catch (err: any) {
        sendApiError(res, 500, 'INTERNAL_ERROR', 'upload failed');
      }
    },
  );
}
