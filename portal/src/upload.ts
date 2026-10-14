// The folder a developer chose in the browser, as the API receives it: walked by the
// command's own rules (core/upload-rules.js, PHASE2-PLAN D6), zipped here, sent as
// base64. Secret files go as names only, so their contents never leave this computer.
//
// Three ways to choose a folder, one tree: the folder picker (Chrome and Edge, read
// lazily, so node_modules is never opened), a folder dropped on the page (also lazy),
// and the folder input every browser has (which lists everything first).
import ignore from "ignore";
import { zipSync } from "fflate";
import { collectUpload, SecretsFound, treeFromPaths, UploadRefused } from "../../core/upload-rules.js";

export { SecretsFound, UploadRefused };

/** A value that looks like a secret: file, line, rule and kind (core/scan.js). Never the value. */
export interface Finding { file: string; line: number; rule: string; kind: string }

type Bytes = Uint8Array;
interface TreeFile { name: string; kind: "file"; size: number; bytes(): Promise<Bytes>; text(): Promise<string> }
interface TreeDir { name: string; kind: "dir"; children(): Promise<TreeNode[]> | TreeNode[] }
type TreeNode = TreeFile | TreeDir | { name: string; kind: "other" };

/** A folder the developer chose: its name, and a way to walk it. */
export interface ChosenFolder { name: string; root: TreeDir }

const fileNode = (file: File, name = file.name): TreeFile => ({
  name,
  kind: "file",
  size: file.size,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
  text: () => file.text()
});

// The File System Access API, where the browser has it.
interface DirHandle { kind: "directory"; name: string; values(): AsyncIterable<DirHandle | FileHandle> }
interface FileHandle { kind: "file"; name: string; getFile(): Promise<File> }

function handleNode(handle: DirHandle): TreeDir {
  return {
    name: handle.name,
    kind: "dir",
    children: async () => {
      const out: TreeNode[] = [];
      for await (const entry of handle.values()) {
        if (entry.kind === "directory") out.push(handleNode(entry));
        else {
          const file = await entry.getFile();
          out.push(fileNode(file, entry.name));
        }
      }
      return out;
    }
  };
}

/** Whether this browser can open a folder picker. */
export const canPickFolder = () => typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";

/** Ask the browser for a folder (read only). Null when the developer cancels. */
export async function pickFolder(): Promise<ChosenFolder | null> {
  try {
    const picker = (window as unknown as { showDirectoryPicker: (o: object) => Promise<DirHandle> }).showDirectoryPicker;
    const handle = await picker({ mode: "read" });
    return { name: handle.name, root: handleNode(handle) };
  } catch (err) {
    if ((err as Error).name === "AbortError") return null;
    throw err;
  }
}

/** The files a folder input gives (each with its path under the chosen folder). */
export function folderFromInput(files: FileList | File[]): ChosenFolder | null {
  const list = Array.from(files);
  if (!list.length) return null;
  const first = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || list[0].name;
  const name = first.split("/")[0];
  const inside = list.map(file => {
    const rel = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).split("/").slice(1).join("/");
    return { path: rel, size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()), text: () => file.text() };
  });
  return { name, root: treeFromPaths(name, inside) as TreeDir };
}

// A folder dropped on the page (the old File and Directory Entries API, in every browser).
interface Entry { name: string; isFile: boolean; isDirectory: boolean }
interface FileEntry extends Entry { file(ok: (f: File) => void, bad: (e: unknown) => void): void }
interface DirEntry extends Entry { createReader(): { readEntries(ok: (e: Entry[]) => void, bad: (e: unknown) => void): void } }

function entryNode(entry: Entry): TreeNode {
  if (entry.isFile) {
    // Only the dropped folder's own entries reach here as files; see children() below.
    return { name: entry.name, kind: "other" };
  }
  if (entry.isDirectory) {
    return {
      name: entry.name,
      kind: "dir",
      children: async () => {
        const reader = (entry as DirEntry).createReader();
        const all: Entry[] = [];
        // readEntries hands back a batch at a time until it hands back none.
        for (;;) {
          const batch = await new Promise<Entry[]>((ok, bad) => reader.readEntries(ok, bad));
          if (!batch.length) break;
          all.push(...batch);
        }
        // A file is opened as a File here, which reads nothing but gives its size, so
        // the walk can refuse a big one before reading it.
        return Promise.all(all.map(async (e): Promise<TreeNode> =>
          e.isFile ? fileNode(await new Promise<File>((ok, bad) => (e as FileEntry).file(ok, bad)), e.name) : entryNode(e)));
      }
    };
  }
  return { name: entry.name, kind: "other" };
}

/** A folder dropped on the page, or null when what was dropped is not one folder. */
export function folderFromDrop(data: DataTransfer): ChosenFolder | null {
  const items = Array.from(data.items || []);
  const entries = items.map(i => (i as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.()).filter(Boolean) as Entry[];
  if (entries.length !== 1 || !entries[0].isDirectory) return null;
  return { name: entries[0].name, root: entryNode(entries[0]) as TreeDir };
}

/** The app's name, as the command works it out: package.json's name, else the folder's. */
export async function appNameOf(folder: ChosenFolder): Promise<string> {
  const children = await folder.root.children();
  const pkg = children.find(c => c.kind === "file" && c.name === "package.json") as TreeFile | undefined;
  if (pkg) {
    try {
      const name = JSON.parse(await pkg.text())?.name;
      if (typeof name === "string" && name.trim()) return name.replace(/^@[^/]+\//, "");
    } catch { /* not JSON: the folder's name, as the command does */ }
  }
  return folder.name;
}

export interface Packed { zip: string; withheld: string[]; ignored: number; findings: Finding[] }

/**
 * Walk and zip the folder for an interview or a deploy. Throws UploadRefused in words,
 * and SecretsFound (an UploadRefused) for a deploy whose code looks like it holds a
 * secret. An interview's files with a finding are sent as names only.
 */
export async function pack(folder: ChosenFolder, purpose: "interview" | "deploy"): Promise<Packed> {
  const { entries, withheld, ignored, findings } = await collectUpload(folder.root, { purpose, ignore });
  const zip = zipSync(entries as Record<string, Uint8Array>, { level: 6 });
  return { zip: toBase64(zip), withheld, ignored, findings: findings as Finding[] };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** An empty zip, for a deploy that sends nothing of the folder (a drafted plan). */
export const emptyZip = () => toBase64(zipSync({}));

