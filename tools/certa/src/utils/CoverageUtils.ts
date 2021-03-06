/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
import * as fs from "fs";
import * as path from "path";
import * as uuid from "uuid";
import { spawnChildProcess, onExit } from "./SpawnUtils";

/**
 * Helper function for relaunching (as a child process) the current process running under `nyc` for measuring code coverage.
 * Once that completes, a second `nyc` child process will be spawned to report the coverage results.
 * Returns a promise that will be resolved with either 0 or the first non-zero child process exit code, once the reporter process terminates.
 */
export async function relaunchForCoverage(): Promise<number> {
  const nyc = require.resolve("nyc/bin/nyc");
  const relaunchArgs = [
    nyc,
    "--silent",
    "--",
    ...process.argv,
  ];

  // By splitting "instrument/runTests" and "report coverage" into two steps, we allow test runners the option of
  // running separate (concurrent) instrumented processes that also write to `nyc`'s temp directory.
  const instrumentedProcess = spawnChildProcess("node", relaunchArgs);
  const instrumentedStatus = await onExit(instrumentedProcess);

  // Now create a *combined* report for everything in `nyc`'s temp directory.
  const reporterProcess = spawnChildProcess("node", [require.resolve("nyc/bin/nyc"), "report"]);
  const reporterStatus = await onExit(reporterProcess);

  // Certa should exit with an error code if _either_ step failed.
  return instrumentedStatus || reporterStatus;
}

/** Gets the current effective nyc config from `process.env`. Assumes we're running as a child process of `nyc`. */
function getNycConfig(): any {
  const nycConfig = process.env.NYC_CONFIG;
  if (!nycConfig)
    throw new Error("NYC_CONFIG is not set in environment");

  return JSON.parse(nycConfig);
}

/**
 * Writes nyc or istanbul-generated coverage data to a uniquely-named file inside `nyc`'s temp directory.
 * All such files in the nyc temp directory are merged together when nyc reports are generated via `nyc report`.
 * @param coverageData The value of an nyc/istanbul-generated `__coverage__` object.
 */
export function writeCoverageData(coverageData: any): void {
  const nycConfig = getNycConfig();
  const nycCWD = nycConfig.cwd;
  const nycTempDir = nycConfig["temp-directory"];
  if (!nycCWD || !nycTempDir)
    throw new Error("Failed to determine nyc temp directory.");

  const nycTempDirAbsolute = path.resolve(nycCWD, nycTempDir);
  if (!fs.existsSync(nycTempDirAbsolute))
    throw new Error(`Cannot save coverage data - nyc temp directory "${nycTempDirAbsolute}" does not exist.`);

  // Use uuid/v4 to generate a unique filename, just like `nyc` does.
  const coverageFileName = path.join(nycTempDirAbsolute, uuid.v4() + ".json");
  fs.writeFileSync(coverageFileName, JSON.stringify(coverageData));
}
