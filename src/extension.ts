import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';

const PACKAGE_JSON = 'package.json';
const FILE_PROTOCOL = 'file:';
const NPM_REGISTRY = 'https://registry.npmjs.org';

interface NpmRegistryVersion {
  dist?: { unpackedSize?: number };
}

interface NpmRegistryResponse {
  'dist-tags'?: { latest?: string };
  versions?: Record<string, NpmRegistryVersion>;
}

interface DepEntry {
  name: string;
  version: string;
  range: vscode.Range;
}

const sizeCache = new Map<string, string>();
const decorationTypeCache = new Map<string, vscode.TextEditorDecorationType>();

function isPackageJson(doc: vscode.TextDocument): boolean {
  const path = doc.uri.fsPath.toLowerCase();
  return path.endsWith(PACKAGE_JSON) || doc.fileName.toLowerCase() === PACKAGE_JSON;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(1) + ' kB';
  }
  return bytes + ' B';
}

function getDecorationType(sizeText: string, context: vscode.ExtensionContext): vscode.TextEditorDecorationType {
  let type = decorationTypeCache.get(sizeText);
  if (!type) {
    type = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: `  ${sizeText}`,
        color: new vscode.ThemeColor('descriptionForeground'),
        margin: '0 0 0 1em',
      },
    });
    decorationTypeCache.set(sizeText, type);
    context.subscriptions.push(type);
  }
  return type;
}

function parseDepsFromDocument(doc: vscode.TextDocument): { deps: DepEntry[]; devDeps: DepEntry[] } {
  const text = doc.getText();
  const deps: DepEntry[] = [];
  const devDeps: DepEntry[] = [];

  try {
    const json = JSON.parse(text);
    const dependencies = (json.dependencies as Record<string, string>) || {};
    const devDependencies = (json.devDependencies as Record<string, string>) || {};

    const re = /"([^"]+)"\s*:\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const name = m[1];
      const value = m[2];
      if (name in dependencies) {
        const pos = doc.positionAt(m.index);
        const lineEnd = doc.lineAt(pos.line).range.end;
        deps.push({
          name,
          version: value || '*',
          range: new vscode.Range(lineEnd, lineEnd),
        });
      } else if (name in devDependencies) {
        const pos = doc.positionAt(m.index);
        const lineEnd = doc.lineAt(pos.line).range.end;
        devDeps.push({
          name,
          version: value || '*',
          range: new vscode.Range(lineEnd, lineEnd),
        });
      }
    }
  } catch {
    // invalid JSON
  }
  return { deps, devDeps };
}

function parsePackageSpec(spec: string): { name: string; version: string } {
  const at = spec.indexOf('@', 1);
  if (at === -1) return { name: spec, version: '*' };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) || '*' };
}

function isExactVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+(-[^+]+)?(\+.*)?$/.test(version) || version === '*';
}

function isFileDependency(version: string): boolean {
  return version.startsWith(FILE_PROTOCOL);
}

/**
 * Размер пакета в node_modules (установленная/собранная версия для file: зависимостей).
 * node_modules/@scope/name или node_modules/name.
 */
async function getNodeModulesPackageSize(docDir: string, packageName: string): Promise<string> {
  const cacheKey = `node_modules:${path.join(docDir, 'node_modules', packageName)}`;
  const cached = sizeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const parts = packageName.startsWith('@') ? packageName.split('/') : [packageName];
    const installPath = path.join(docDir, 'node_modules', ...parts);
    const stat = await fs.stat(installPath);

    if (stat.isFile()) {
      const text = formatBytes(stat.size);
      sizeCache.set(cacheKey, text);
      return text;
    }

    if (stat.isDirectory()) {
      const total = await getDirSize(installPath);
      const text = formatBytes(total);
      sizeCache.set(cacheKey, text);
      return text;
    }

    sizeCache.set(cacheKey, '—');
    return '—';
  } catch {
    sizeCache.set(cacheKey, '—');
    return '—';
  }
}

async function getDirSize(dirPath: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dirPath, ent.name);
    if (ent.isDirectory()) {
      total += await getDirSize(full);
    } else {
      const stat = await fs.stat(full);
      total += stat.size;
    }
  }
  return total;
}

async function fetchSize(packageSpec: string): Promise<string> {
  const cached = sizeCache.get(packageSpec);
  if (cached !== undefined) return cached;

  const { name, version } = parsePackageSpec(packageSpec);
  if (!name) {
    sizeCache.set(packageSpec, '—');
    return '—';
  }

  const useExact = version && version !== '*' && isExactVersion(version);
  const encodedName = encodeURIComponent(name);

  try {
    if (useExact) {
      const url = `${NPM_REGISTRY}/${encodedName}/${encodeURIComponent(version)}`;
      const res = await fetch(url);
      if (!res.ok) {
        sizeCache.set(packageSpec, '—');
        return '—';
      }
      const data = (await res.json()) as NpmRegistryVersion;
      const bytes = data?.dist?.unpackedSize;
      if (bytes == null || typeof bytes !== 'number') {
        sizeCache.set(packageSpec, '—');
        return '—';
      }
      const text = formatBytes(bytes);
      sizeCache.set(packageSpec, text);
      return text;
    }

    const url = `${NPM_REGISTRY}/${encodedName}`;
    const res = await fetch(url);
    if (!res.ok) {
      sizeCache.set(packageSpec, '—');
      return '—';
    }
    const data = (await res.json()) as NpmRegistryResponse;
    const versions = data.versions;
    if (!versions || typeof versions !== 'object') {
      sizeCache.set(packageSpec, '—');
      return '—';
    }

    const versionToUse = !version || version === '*' ? data['dist-tags']?.latest : version;
    const ver =
      versionToUse && versions[versionToUse]
        ? versions[versionToUse]
        : versions[data['dist-tags']?.latest ?? ''];
    const bytes = ver?.dist?.unpackedSize;
    if (bytes == null || typeof bytes !== 'number') {
      sizeCache.set(packageSpec, '—');
      return '—';
    }
    const text = formatBytes(bytes);
    sizeCache.set(packageSpec, text);
    return text;
  } catch {
    sizeCache.set(packageSpec, '—');
    return '—';
  }
}

async function updateDecorations(editor: vscode.TextEditor, context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('packageSizeInline');
  if (!config.get<boolean>('enabled', true)) return;
  if (!isPackageJson(editor.document)) return;

  const { deps, devDeps } = parseDepsFromDocument(editor.document);
  const all = [...deps, ...devDeps];
  if (all.length === 0) return;

  const docDir = path.dirname(editor.document.uri.fsPath);

  const sizes = await Promise.all(
    all.map((d) => {
      if (isFileDependency(d.version)) {
        return getNodeModulesPackageSize(docDir, d.name);
      }
      const spec = d.version && d.version !== '*' ? `${d.name}@${d.version}` : d.name;
      return fetchSize(spec);
    })
  );

  const bySize = new Map<string, vscode.Range[]>();
  for (let i = 0; i < all.length; i++) {
    const sizeText = sizes[i];
    const ranges = bySize.get(sizeText) ?? [];
    ranges.push(all[i].range);
    bySize.set(sizeText, ranges);
  }

  const typesUsed = new Set<string>();
  for (const [sizeText, ranges] of bySize) {
    const type = getDecorationType(sizeText, context);
    typesUsed.add(sizeText);
    editor.setDecorations(type, ranges);
  }

  for (const [cachedText, type] of decorationTypeCache) {
    if (!typesUsed.has(cachedText)) {
      editor.setDecorations(type, []);
    }
  }
}

function clearAllDecorations(editor: vscode.TextEditor) {
  for (const type of decorationTypeCache.values()) {
    editor.setDecorations(type, []);
  }
}

export function activate(context: vscode.ExtensionContext) {
  let timeout: ReturnType<typeof setTimeout> | undefined;

  function triggerUpdate(editor: vscode.TextEditor | undefined, throttle = false) {
    if (timeout) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (!editor) return;
    if (!isPackageJson(editor.document)) {
      clearAllDecorations(editor);
      return;
    }
    if (throttle) {
      timeout = setTimeout(() => {
        updateDecorations(editor, context).catch((err) => {
          console.error('[Package Size Inline]', err);
        });
      }, 400);
    } else {
      updateDecorations(editor, context).catch((err) => {
        console.error('[Package Size Inline]', err);
      });
    }
  }

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor && isPackageJson(activeEditor.document)) {
    triggerUpdate(activeEditor);
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined) => {
      if (editor && isPackageJson(editor.document)) triggerUpdate(editor);
      else if (editor) clearAllDecorations(editor);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent) => {
      const editor = vscode.window.activeTextEditor;
      if (editor && event.document === editor.document) triggerUpdate(editor, true);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc: vscode.TextDocument) => {
      if (isPackageJson(doc) && vscode.window.activeTextEditor?.document === doc) {
        triggerUpdate(vscode.window.activeTextEditor);
      }
    })
  );
}

export function deactivate() {
  decorationTypeCache.forEach((t) => t.dispose());
  decorationTypeCache.clear();
  sizeCache.clear();
}
