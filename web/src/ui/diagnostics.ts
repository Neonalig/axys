// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diagnostics: what this browser supports, what playback is doing, and where the source is.
 *
 * The Source Code entry is the AGPL offer of corresponding source, so it names the exact
 * version and revision this build was made from.
 */

import type { Capability } from '../capabilities.js';
import type { EngineReport } from '../audio/engine.js';
import { probeCapabilities } from '../capabilities.js';
import { Dialog } from './dialog.js';
import { setTooltip } from './tooltip.js';

declare const __AXYS_VERSION__: string;
declare const __AXYS_REVISION__: string;
declare const __AXYS_REPOSITORY__: string;

/** Identity of this build, as the AGPL source offer states it. */
export interface BuildInfo {
  /** Package version, such as `0.3.1`. */
  version: string;
  /** Source revision, or `unknown` when the build was made outside a checkout. */
  revision: string;
  /** Repository the corresponding source lives in. */
  repository: string;
  /** Link that resolves to this exact revision, falling back to the repository root. */
  sourceUrl: string;
}

/** What the diagnostics panel reports. */
export interface DiagnosticsInput {
  capabilities: readonly Capability[];
  /** Playback figures from the renderer worklet, or `null` before audio has loaded. */
  engine: EngineReport | null;
}

const ENGINE_STATUS_TEXT: Readonly<Record<EngineReport['status'], string>> = {
  idle: 'No audio loaded',
  blocked: 'Waiting for a click to start audio',
  running: 'Playing through the renderer worklet',
  failed: 'Renderer failed and is outputting silence',
};

let latestEngineReport: EngineReport | null = null;
let latestCapabilities: readonly Capability[] | null = null;

function trimRepository(repository: string): string {
  return repository.replace(/\.git$/, '').replace(/\/+$/, '');
}

/** Version, revision and repository this build reports. */
export function buildInfo(): BuildInfo {
  const version = __AXYS_VERSION__;
  const revision = __AXYS_REVISION__;
  const repository = trimRepository(__AXYS_REPOSITORY__);
  const known = /^[0-9a-f]{7,40}$/i.test(revision);
  return {
    version,
    revision,
    repository,
    sourceUrl: known ? `${repository}/tree/${revision}` : repository,
  };
}

function definition(list: HTMLElement, term: string, value: string): void {
  const item = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'axys-readout-label';
  name.textContent = term;
  const detail = document.createElement('span');
  detail.className = 'axys-readout';
  detail.textContent = value;
  item.append(name, detail);
  list.append(item);
}

function heading(text: string): HTMLElement {
  const element = document.createElement('h3');
  element.textContent = text;
  return element;
}

/** Capability probe results, blocking ones first. */
export function renderCapabilities(capabilities: readonly Capability[]): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'axys-caps';
  const ordered = [...capabilities].sort((a, b) => {
    const rank = (cap: Capability): number =>
      cap.required && !cap.available ? 0 : cap.available ? 2 : 1;
    return rank(a) - rank(b);
  });
  for (const cap of ordered) {
    const item = document.createElement('li');
    const state = document.createElement('span');
    state.className = cap.available ? 'is-ok' : cap.required ? 'is-blocking' : 'is-missing';
    state.textContent = cap.available ? 'yes' : cap.required ? 'blocked' : 'no';
    const label = document.createElement('span');
    label.textContent = cap.label;
    const detail = document.createElement('span');
    detail.className = 'axys-hint';
    detail.textContent = cap.detail;
    item.append(state, label, detail);
    list.append(item);
  }
  return list;
}

/** Playback figures the renderer worklet reports. */
export function renderEngineReport(report: EngineReport | null): HTMLElement {
  const list = document.createElement('ul');
  list.className = 'axys-caps';
  if (!report) {
    definition(list, 'Playback', 'No audio loaded');
    return list;
  }
  definition(list, 'Playback', ENGINE_STATUS_TEXT[report.status]);
  definition(list, 'Underruns', String(report.underruns));
  definition(
    list,
    'Output Rate',
    report.contextRate === null ? 'No context' : `${String(Math.round(report.contextRate))} Hz`,
  );
  definition(
    list,
    'Source Rate',
    report.sourceRate === null ? 'No source' : `${String(Math.round(report.sourceRate))} Hz`,
  );
  if (report.contextRate !== null && report.sourceRate !== null) {
    definition(
      list,
      'Resampling',
      report.contextRate === report.sourceRate ? 'None' : 'Output rate differs from the source',
    );
  }
  if (report.message !== null) {
    definition(list, 'Last Message', report.message);
  }
  definition(list, 'Logical Cores', String(globalThis.navigator?.hardwareConcurrency ?? 'unknown'));
  return list;
}

/** The AGPL Source Code entry: version, revision and a link to the corresponding source. */
export function renderSourceCode(): HTMLElement {
  const info = buildInfo();
  const section = document.createElement('div');

  const list = document.createElement('ul');
  list.className = 'axys-caps';
  definition(list, 'Version', info.version);
  definition(list, 'Revision', info.revision);
  section.append(list);

  const paragraph = document.createElement('p');
  paragraph.className = 'axys-hint axys-blurb';
  paragraph.textContent =
    'Axys is free software under the GNU Affero General Public License, version 3 or later. The corresponding source for this build is at:';
  section.append(paragraph);

  const link = document.createElement('a');
  link.href = info.sourceUrl;
  link.textContent = info.sourceUrl;
  link.rel = 'noreferrer';
  link.target = '_blank';
  setTooltip(link, 'Corresponding Source');
  section.append(link);

  if (info.revision === 'unknown') {
    const warning = document.createElement('p');
    warning.className = 'axys-hint axys-warning';
    warning.textContent =
      'This build records no revision, so the link resolves to the repository rather than the exact source. A host serving a modified Axys must set AXYS_SOURCE_REPOSITORY and AXYS_SOURCE_REVISION at build time';
    section.append(warning);
  }

  return section;
}

/** The whole diagnostics report as one element. */
export function renderDiagnostics(input: DiagnosticsInput): HTMLElement {
  const container = document.createElement('div');
  container.className = 'axys-diagnostics';
  container.append(
    heading('Browser Capabilities'),
    renderCapabilities(input.capabilities),
    heading('Playback'),
    renderEngineReport(input.engine),
    heading('Source Code'),
    renderSourceCode(),
  );
  return container;
}

/**
 * Opens the help panel.
 *
 * @remarks Titled for what someone opens it to get rather than for what it contains: it answers
 * what this browser can do, what playback is doing, and where the source is.
 */
export function showDiagnostics(input: DiagnosticsInput): Dialog {
  return Dialog.open({ title: 'Help', icon: 'help', content: renderDiagnostics(input) });
}

/**
 * Probes the browser and opens the diagnostics dialog.
 *
 * @remarks Playback figures come from the most recent {@link noteEngineReport} call, because
 * the command that opens this dialog carries no arguments.
 */
export async function openDiagnostics(): Promise<Dialog> {
  const capabilities = latestCapabilities ?? (await probeCapabilities());
  return showDiagnostics({ capabilities, engine: latestEngineReport });
}

/** Records the newest playback report, so the diagnostics dialog can show current figures. */
export function noteEngineReport(report: EngineReport | null): void {
  latestEngineReport = report;
}

/** Records the capability probe, so the diagnostics dialog need not probe again. */
export function noteCapabilities(capabilities: readonly Capability[]): void {
  latestCapabilities = capabilities;
}

/** Opens the Source Code entry in its own panel. */
export function showSourceCode(): Dialog {
  return Dialog.open({ title: 'Source Code', icon: 'sourceCode', content: renderSourceCode() });
}
