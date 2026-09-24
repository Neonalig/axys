// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Opening and writing files, through the host's own picker where there is one.
 *
 * The File System Access API lets one picker offer several kinds at once and lets a second save
 * go back to the same file without asking, which is what makes Save worth pressing often. Where
 * it is missing, a hidden input and a download do the same job with an extra prompt each time,
 * so nothing here is ever the only way to get work out of the editor.
 */

/** One kind of file a picker offers, as the host's own dialog lists it. */
export interface FileKind {
  /** Label for the kind, shown in the picker's type list. */
  description: string;
  /** Media type to extension list, such as `{ 'audio/wav': ['.wav'] }`. */
  accept: Record<string, string[]>;
}

/** A file the user chose, with the handle when the host provided one. */
export interface PickedFile {
  file: File;
  /** Handle to write back to, or `null` when the host has no File System Access API. */
  handle: FileHandle | null;
}

/** The slice of `FileSystemFileHandle` this module uses. */
export interface FileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFileStream>;
}

/** The slice of `FileSystemWritableFileStream` this module uses. */
export interface WritableFileStream {
  write(data: BlobPart): Promise<void>;
  close(): Promise<void>;
}

interface OpenOptions {
  types?: readonly FileKind[];
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
}

interface SaveOptions {
  suggestedName?: string;
  types?: readonly FileKind[];
}

interface FilePickerHost {
  showOpenFilePicker?(options: OpenOptions): Promise<FileHandle[]>;
  showSaveFilePicker?(options: SaveOptions): Promise<FileHandle>;
}

/** The picker API as this host provides it, narrowed rather than assumed. */
function pickers(): FilePickerHost {
  return globalThis as FilePickerHost;
}

/** Whether the host can open and write files in place rather than only download them. */
export function hasFileSystemAccess(): boolean {
  const host = pickers();
  return (
    typeof host.showOpenFilePicker === 'function' && typeof host.showSaveFilePicker === 'function'
  );
}

/**
 * Opens one file, offering every kind in a single picker.
 *
 * @remarks `null` when the user cancelled, which is not a failure and is never reported as one.
 */
export async function openFile(kinds: readonly FileKind[]): Promise<PickedFile | null> {
  const host = pickers();
  if (typeof host.showOpenFilePicker === 'function') {
    try {
      const [handle] = await host.showOpenFilePicker({ types: kinds, multiple: false });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (thrown) {
      if (isAbort(thrown)) return null;
      throw thrown;
    }
  }
  const file = await pickWithInput(acceptAttribute(kinds));
  return file === null ? null : { file, handle: null };
}

/**
 * Asks where to write and writes there, returning the handle for later saves.
 *
 * @remarks Falls back to a download where the host has no save picker, and returns `null`, which
 * is why a caller must treat a null handle as "ask again next time" rather than as a failure.
 */
export async function saveFileAs(
  data: BlobPart,
  suggestedName: string,
  kinds: readonly FileKind[],
  mime: string,
): Promise<FileHandle | null> {
  const host = pickers();
  if (typeof host.showSaveFilePicker === 'function') {
    try {
      const handle = await host.showSaveFilePicker({ suggestedName, types: kinds });
      await writeFile(handle, data);
      return handle;
    } catch (thrown) {
      if (isAbort(thrown)) return null;
      throw thrown;
    }
  }
  downloadFile(data, suggestedName, mime);
  return null;
}

/** Writes to a file chosen earlier, without asking again. */
export async function writeFile(handle: FileHandle, data: BlobPart): Promise<void> {
  const stream = await handle.createWritable();
  try {
    await stream.write(data);
  } finally {
    await stream.close();
  }
}

/** Writes a file through the browser's download path. */
export function downloadFile(data: BlobPart, name: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}

/** A cancelled picker, which every browser reports as an `AbortError`. */
function isAbort(thrown: unknown): boolean {
  return thrown instanceof DOMException && thrown.name === 'AbortError';
}

/** The `accept` attribute covering every kind, for the input-element fallback. */
function acceptAttribute(kinds: readonly FileKind[]): string {
  const parts: string[] = [];
  for (const kind of kinds) {
    for (const [mime, extensions] of Object.entries(kind.accept)) {
      parts.push(mime, ...extensions);
    }
  }
  return parts.join(',');
}

/** Opens the host file picker through a hidden input and resolves with what was chosen. */
function pickWithInput(accept: string): Promise<File | null> {
  return new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null);
    });
    input.addEventListener('cancel', () => {
      finish(null);
    });
    document.body.append(input);
    input.click();
  });
}

/**
 * What Open offers, as one picker's type list.
 *
 * @remarks A project or a vocal, both of which open a project. A MIDI guide is imported into an
 * open project rather than opening one, so it has its own command and its own picker.
 */
export const OPENABLE: readonly FileKind[] = [
  { description: 'Axys Project', accept: { 'application/json': ['.axys.json', '.json'] } },
  {
    description: 'Audio',
    accept: {
      'audio/*': ['.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus'],
    },
  },
];

/** The MIDI kind, for importing a guide. */
export const MIDI_KIND: readonly FileKind[] = [
  { description: 'MIDI', accept: { 'audio/midi': ['.mid', '.midi'] } },
];

/** The audio kinds a vocal or a reference is imported from. */
export const AUDIO_KIND: readonly FileKind[] = [
  {
    description: 'Audio',
    accept: {
      'audio/*': ['.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.opus'],
    },
  },
];

/** What Import offers: audio for a vocal or a reference, or a MIDI guide. */
export const IMPORTABLE: readonly FileKind[] = [...AUDIO_KIND, ...MIDI_KIND];

/** The project document kind, for saving. */
export const PROJECT_KIND: readonly FileKind[] = [
  { description: 'Axys Project', accept: { 'application/json': ['.axys.json'] } },
];

/** The audio kinds an export may be written as. */
export const EXPORT_KIND: readonly FileKind[] = [
  { description: 'WAV Audio', accept: { 'audio/wav': ['.wav'] } },
];
