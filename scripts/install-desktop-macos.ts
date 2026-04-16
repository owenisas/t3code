#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

type MacArch = "arm64" | "x64" | "universal";

interface Options {
  readonly arch: MacArch;
  readonly outputDir: string;
  readonly skipBuild: boolean;
  readonly signed: boolean;
  readonly launch: boolean;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const productName = desktopPackageJson.productName ?? "T3 Code";
const appBundleName = `${productName}.app`;
const applicationsDir = "/Applications";
const appDestinationPath = join(applicationsDir, appBundleName);

function usage(): string {
  return `Build the macOS DMG and install ${appBundleName} into /Applications.

Usage:
  bun run install:desktop:mac [options]

Options:
  --arch <arm64|x64|universal>  Build architecture. Defaults to host arch.
  --output-dir <path>           Artifact directory. Defaults to ./release.
  --skip-build                  Install from the newest matching DMG already in output dir.
  --signed                      Allow signing/notarization discovery during packaging.
  --launch                      Launch the installed app after copying it.
  -h, --help                    Show this help.
`;
}

function resolveDefaultArch(): MacArch {
  return process.arch === "arm64" ? "arm64" : "x64";
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  let arch: MacArch = resolveDefaultArch();
  let outputDir = resolve(repoRoot, "release");
  let skipBuild = false;
  let signed = false;
  let launch = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }

    if (arg === "--skip-build") {
      skipBuild = true;
      continue;
    }

    if (arg === "--signed") {
      signed = true;
      continue;
    }

    if (arg === "--launch") {
      launch = true;
      continue;
    }

    if (arg === "--arch") {
      const value = argv[index + 1];
      if (value !== "arm64" && value !== "x64" && value !== "universal") {
        throw new Error("--arch must be one of arm64, x64, or universal.");
      }
      arch = value;
      index += 1;
      continue;
    }

    if (arg === "--output-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--output-dir requires a path.");
      }
      outputDir = resolve(repoRoot, value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return { arch, outputDir, skipBuild, signed, launch };
}

function run(command: string, args: ReadonlyArray<string>, cwd = repoRoot): void {
  execFileSync(command, [...args], {
    cwd,
    stdio: "inherit",
  });
}

function buildDmg(options: Options): void {
  if (options.skipBuild) {
    console.log("[desktop-install] Skipping build; using existing DMG.");
    return;
  }

  mkdirSync(options.outputDir, { recursive: true });
  run(process.execPath, [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "mac",
    "--target",
    "dmg",
    "--arch",
    options.arch,
    "--output-dir",
    options.outputDir,
    ...(options.signed ? ["--signed"] : []),
  ]);
}

function findNewestDmg(outputDir: string, arch: MacArch): string {
  const archSuffix = `-${arch}.dmg`;
  const candidates = readdirSync(outputDir)
    .filter((entry) => entry.endsWith(archSuffix))
    .map((entry) => resolve(outputDir, entry))
    .filter((entry) => statSync(entry).isFile())
    .toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  const dmgPath = candidates[0];
  if (!dmgPath) {
    throw new Error(`No ${arch} DMG found in ${outputDir}.`);
  }

  return dmgPath;
}

function attachDmg(dmgPath: string): string {
  const output = execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const mountPoint = output
    .split("\n")
    .map((line) => /\/Volumes\/.+$/.exec(line)?.[0])
    .find((value): value is string => value !== undefined);

  if (!mountPoint) {
    throw new Error(`Could not find mount point in hdiutil output for ${dmgPath}.`);
  }

  return mountPoint;
}

function detachDmg(mountPoint: string): void {
  try {
    execFileSync("hdiutil", ["detach", mountPoint], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  } catch {
    console.warn(`[desktop-install] Warning: failed to detach ${mountPoint}.`);
  }
}

function findMountedApp(mountPoint: string): string {
  const exactPath = join(mountPoint, appBundleName);
  if (existsSync(exactPath)) {
    return exactPath;
  }

  const appEntry = readdirSync(mountPoint).find((entry) => entry.endsWith(".app"));
  if (!appEntry) {
    throw new Error(`No .app bundle found in ${mountPoint}.`);
  }

  return join(mountPoint, appEntry);
}

function isInstalledAppRunning(): boolean {
  const executablePath = join(appDestinationPath, "Contents", "MacOS", productName);
  const result = spawnSync("ps", ["-ax", "-o", "command="], {
    encoding: "utf8",
  });
  return (
    result.status === 0 && result.stdout.split("\n").some((line) => line.includes(executablePath))
  );
}

function waitForInstalledAppToQuit(timeoutMs: number): boolean {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!isInstalledAppRunning()) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  return !isInstalledAppRunning();
}

function quitExistingAppIfRunning(): void {
  if (!existsSync(appDestinationPath) || !isInstalledAppRunning()) {
    return;
  }

  console.log(`[desktop-install] Asking existing ${productName} process to quit...`);
  spawnSync("osascript", ["-e", `tell application "${productName}" to quit`], {
    encoding: "utf8",
  });

  if (!waitForInstalledAppToQuit(10_000)) {
    throw new Error(
      `${productName} is still running. Quit it manually, then rerun bun run install:desktop:mac.`,
    );
  }
}

function installApp(sourceAppPath: string): void {
  mkdirSync(applicationsDir, { recursive: true });
  quitExistingAppIfRunning();

  const backupPath = join(
    applicationsDir,
    `.${appBundleName}.replacing-${Date.now()}-${process.pid}`,
  );
  const hadExistingApp = existsSync(appDestinationPath);

  if (hadExistingApp) {
    console.log(`[desktop-install] Replacing existing ${appDestinationPath}`);
    renameSync(appDestinationPath, backupPath);
  } else {
    console.log(`[desktop-install] Installing ${appDestinationPath}`);
  }

  try {
    run("ditto", [sourceAppPath, appDestinationPath]);
    if (hadExistingApp) {
      rmSync(backupPath, { recursive: true, force: true });
    }
  } catch (error) {
    rmSync(appDestinationPath, { recursive: true, force: true });
    if (hadExistingApp && existsSync(backupPath)) {
      renameSync(backupPath, appDestinationPath);
    }
    throw error;
  }
}

function launchApp(): void {
  run("open", ["-a", appDestinationPath]);
}

function main(): void {
  if (process.platform !== "darwin") {
    throw new Error("install-desktop-macos only runs on macOS.");
  }

  const options = parseArgs(process.argv.slice(2));
  buildDmg(options);

  const dmgPath = findNewestDmg(options.outputDir, options.arch);
  console.log(`[desktop-install] Installing from ${dmgPath}`);

  const mountPoint = attachDmg(dmgPath);
  try {
    const sourceAppPath = findMountedApp(mountPoint);
    installApp(sourceAppPath);
  } finally {
    detachDmg(mountPoint);
  }

  if (options.launch) {
    launchApp();
  }

  console.log(`[desktop-install] Installed ${appDestinationPath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
