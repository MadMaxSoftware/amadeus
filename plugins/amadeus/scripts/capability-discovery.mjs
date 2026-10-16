import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, isAbsolute, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { defaultDiscoveryPaths, loadDiscoveryJson, hasDiscoveryConsent, DISCOVERY_SCOPES,
  buildProbeTargets, assertLoopbackOnly } from './provider-discovery.mjs';

const runFile = promisify(execFile);
const inventoryPath = root => join(root, 'providers', 'capabilities.json');
const safeText = value => String(value ?? '').replace(/[\x00-\x1f]/g, '').slice(0, 180);
const list = value => Array.isArray(value) ? value : value ? [value] : [];
const number = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

export function discoveryPreview({ categories = DISCOVERY_SCOPES, locations = [] } = {}) {
  if (!Array.isArray(categories) || !categories.length || categories.some(c => !DISCOVERY_SCOPES.includes(c))) throw new Error('Choose supported discovery categories.');
  if (!Array.isArray(locations) || locations.length > 20 || locations.some(p => typeof p !== 'string' || !isAbsolute(p) || /^[/\\]{2}/.test(p))) throw new Error('Choose up to 20 explicit local absolute locations; network shares are forbidden.');
  return { categories: [...new Set(categories)], locations, startsCollection: false,
    sources: ['Windows CIM selected CPU/GPU/RAM/OS fields', 'Relevant uninstall-registry entries and known tool locations', 'Known loopback model-list interfaces'],
    exclusions: ['personal documents', 'LAN', 'hardware serial numbers', 'application execution', 'recursive file searches'],
    storage: 'Local Amadeus state only', limitations: 'Presence is not proof of licensing, sign-in, compatibility or permission to execute.' };
}

export function viewInventory(stateRoot) {
  return loadDiscoveryJson(inventoryPath(stateRoot), null);
}
export function deleteInventory(stateRoot) {
  for (const file of [inventoryPath(stateRoot), defaultDiscoveryPaths(stateRoot).lastScanPath]) rmSync(file, { force: true });
  // Delete discovery-derived provider entries while preserving explicitly configured ones.
  const path = join(stateRoot, 'providers', 'registry.json');
  const registry = loadDiscoveryJson(path, null);
  if (registry?.providers) {
    registry.providers = Object.fromEntries(Object.entries(registry.providers).filter(([, p]) => p.source === 'manual'));
    writeFileSync(path, JSON.stringify(registry, null, 2) + '\n');
  }
  return { deleted: true };
}

// Only these fixed system queries run. No discovered executable is launched.
export const WINDOWS_QUERIES = Object.freeze({
  hardware: `$ErrorActionPreference='Stop'; [pscustomobject]@{
    cpu=@(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,AddressWidth);
    gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion);
    memory=@(Get-CimInstance Win32_ComputerSystem | Select-Object TotalPhysicalMemory);
    os=@(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,OSArchitecture)
  } | ConvertTo-Json -Depth 5 -Compress`,
  'development-tools': `$ErrorActionPreference='Stop'; [pscustomobject]@{
    software=@(@('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*') | ForEach-Object { Get-ItemProperty -Path $_ -ErrorAction SilentlyContinue } | Where-Object { $_.DisplayName -match '^(Python|Git|Node.js|Microsoft Visual Studio|Visual Studio Code|Docker|PowerShell|AutoHotkey|Ollama|LM Studio|Cursor|CMake|LLVM)( |$|\\d)' } | Select-Object DisplayName,DisplayVersion);
    fixedDrives=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID)
  } | ConvertTo-Json -Depth 5 -Compress`,
});

export async function windowsCollector(category, { locations, signal }, adapters = {}) {
  if ((adapters.platform ?? process.platform) !== 'win32') return { supported: false, limitation: 'Windows collector only' };
  const query = adapters.query ?? (async script => {
    const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 10000, maxBuffer: 262144, signal,
    });
    return stdout.trim() ? JSON.parse(stdout) : [];
  });
  const raw = await query(WINDOWS_QUERIES[category]);
  if (category === 'hardware') return {
    cpu: list(raw.cpu).slice(0, 16).map(c => ({ name: safeText(c.Name), cores: number(c.NumberOfCores), threads: number(c.NumberOfLogicalProcessors), bits: number(c.AddressWidth) })),
    gpu: list(raw.gpu).slice(0, 16).map(g => ({ name: safeText(g.Name), reportedMemoryBytes: number(g.AdapterRAM), driver: safeText(g.DriverVersion) })),
    memoryBytes: number(list(raw.memory)[0]?.TotalPhysicalMemory),
    os: list(raw.os).slice(0, 1).map(o => ({ name: safeText(o.Caption), version: safeText(o.Version), architecture: safeText(o.OSArchitecture) })),
    limitations: ['GPU memory reported by CIM may be incomplete; no model compatibility guarantee.'],
  };
  const localDrive = adapters.localDrive ?? (root => list(raw.fixedDrives).some(drive => String(root).slice(0, 2).toLowerCase() === String(drive).toLowerCase()));
  const requestedRoots = locations.length ? locations : [process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const roots = requestedRoots.filter(root => !/^[/\\]{2}/.test(root) && localDrive(root));
  const tools = [['Ollama', 'Ollama/ollama.exe'], ['LM Studio', 'LM Studio/LM Studio.exe'], ['AutoHotkey', 'AutoHotkey/AutoHotkey.exe'], ['Docker', 'Docker/Docker/Docker Desktop.exe']];
  const check = adapters.exists ?? (path => {
    // Refuse junctions/symlinks before following a path into a mapped/network target.
    const parts = []; let current = resolve(path);
    while (dirname(current) !== current) { parts.unshift(current); current = dirname(current); }
    for (const part of parts) { try { if (lstatSync(part).isSymbolicLink()) return false; } catch { return false; } }
    return existsSync(path);
  });
  return { installed: list(raw.software ?? raw).slice(0, 100).map(v => ({ name: safeText(v.DisplayName), version: safeText(v.DisplayVersion) })),
    skippedNonlocalLocations: requestedRoots.length - roots.length,
    knownLocations: tools.map(([name, relative]) => ({ name, available: roots.some(root => check(join(root, relative))), limitation: 'Presence only; not launched or qualified.' })) };
}

export async function localModelsCollector(_category, { signal }, transport = fetch) {
  const results = [];
  for (const target of buildProbeTargets()) {
    signal.throwIfAborted();
    assertLoopbackOnly(target.url);
    try {
      const response = await transport(target.url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]) });
      if (!response.ok) throw new Error('unavailable');
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let body = '', bytes = 0;
      try { while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 262144) throw new Error('response too large');
        body += decoder.decode(value, { stream: true });
      } } finally { await reader.cancel(); }
      body += decoder.decode();
      const raw = JSON.parse(body);
      results.push({ runtime: target.providerId, available: true, models: list(raw.models ?? raw.data).slice(0, 100).map(m => safeText(m.name ?? m.id)), limitation: 'Advertised only; no inference or model loading performed.' });
    } catch { results.push({ runtime: target.providerId, available: false, models: [] }); }
  }
  return results;
}

export async function runDiscovery(args, { stateRoot, collect, readConsent } = {}) {
  if (args?.requested !== true) throw new Error('A separate explicit scan request is required. Consent alone does not collect.');
  const preview = discoveryPreview(args);
  const readCurrent = readConsent ?? (() => loadDiscoveryJson(defaultDiscoveryPaths(stateRoot).consentPath, null));
  const grant = JSON.stringify(readCurrent());
  const allowed = () => { const current = readCurrent(); return JSON.stringify(current) === grant && preview.categories.every(c => hasDiscoveryConsent(current, c)); };
  if (!allowed()) return { status: 'consent-required', collected: false };
  const controller = new AbortController();
  const timer = setInterval(() => { if (!allowed()) controller.abort(); }, 50);
  const results = {};
  try {
    for (const category of preview.categories) {
      if (!allowed()) return { status: 'consent-required', collected: false };
      const collector = collect ?? (category === 'local-providers' ? localModelsCollector : windowsCollector);
      results[category] = await collector(category, { locations: preview.locations, signal: controller.signal });
    }
    if (!allowed()) return { status: 'consent-required', collected: false };
    const report = { schemaVersion: 1, collectedAt: new Date().toISOString(), categories: results };
    const path = inventoryPath(stateRoot); mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
    return { status: 'complete', collected: true, report };
  } catch (error) {
    if (!allowed()) return { status: 'consent-required', collected: false };
    throw error;
  } finally { clearInterval(timer); }
}
