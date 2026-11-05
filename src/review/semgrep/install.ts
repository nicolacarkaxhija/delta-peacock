/** One pinned wheel: where it is and the sha256 it must have. */
export interface WheelPin {
  url: string;
  sha256: string;
}

/** The semgrep pins package.json carries. */
export interface SemgrepPins {
  version: string;
  wheels: Readonly<Record<string, WheelPin>>;
}

/** The files of a wheel's bin folder. */
export function unpackBin(zip: Buffer, version: string): { name: string; data: Buffer }[] {
  throw new Error(`not built: ${String(zip.length)} ${version}`);
}

export interface InstallOptions {
  pins: SemgrepPins;
  platform: string;
  dir: string;
  download: (url: string) => Promise<Buffer>;
}

/** Installs the pinned semgrep into dir and returns dir. */
export function installSemgrep(options: InstallOptions): Promise<string> {
  return Promise.reject(new Error(`not built: ${options.dir}`));
}
