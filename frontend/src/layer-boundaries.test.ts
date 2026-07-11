/**
 * Import-boundary rules between the source layers (see #122).
 *
 * Layer ladder (arrows = allowed static-import direction):
 *
 *   editor/ + components/ + pages/  (React UI)
 *        │
 *        ▼
 *   local/                          (pipeline, workers, storage glue)
 *        │
 *        ▼
 *   core/                           (pure shared domain: fx, render,
 *                                    timing, arrangement, waveform, types)
 *
 * Rules enforced here:
 *  1. local/ never imports from editor/, components/ or pages/ —
 *     worker/export bundles must not absorb UI-layer code, and file
 *     cycles (editor -> local -> editor) must be impossible.
 *  2. core/ never imports from editor/, local/, components/ or pages/,
 *     and never imports React/zustand — it is the dependency-free
 *     bottom layer both sides may share.
 *
 * The scan covers production sources only (tests may reach anywhere).
 * Both `import ... from "x"`, `export ... from "x"`, dynamic
 * `import("x")` and inline `import("x").T` type references count.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const SRC = path.resolve(__dirname);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    // Production sources only — test files may import across layers.
    if (/\.(test|browser\.test|bench\.browser\.test)\.(ts|tsx)$/.test(entry)) {
      continue;
    }
    if (entry === "test-setup.ts") continue;
    out.push(full);
  }
  return out;
}

/** All static/dynamic import specifiers appearing in a module. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `import x from "spec"`, `export { y } from "spec"`, `import "spec"`,
  // `import("spec")` — one permissive regex; comments that happen to
  // contain import-shaped text would surface as (easily fixed) noise.
  const re = /(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
  for (let m = re.exec(source); m; m = re.exec(source)) specs.push(m[1]);
  return specs;
}

/** Top-level src/ segment a relative import resolves into, or null. */
function resolvedLayer(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(file), spec);
  const rel = path.relative(SRC, abs);
  if (rel.startsWith("..")) return null;
  return rel.split(path.sep)[0] ?? null;
}

function violationsOf(
  layerDir: string,
  bannedLayers: readonly string[],
  bannedPackages: readonly string[] = [],
): string[] {
  const hits: string[] = [];
  for (const file of listSourceFiles(path.join(SRC, layerDir))) {
    const source = readFileSync(file, "utf-8");
    for (const spec of importSpecifiers(source)) {
      const layer = resolvedLayer(file, spec);
      const relFile = path.relative(SRC, file);
      if (layer && bannedLayers.includes(layer)) {
        hits.push(`${relFile} -> ${spec} (resolves into src/${layer})`);
      }
      if (!spec.startsWith(".")) {
        const pkg = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (bannedPackages.includes(pkg)) {
          hits.push(`${relFile} -> ${spec} (banned package in this layer)`);
        }
      }
    }
  }
  return hits;
}

describe("layer boundaries", () => {
  it("local/ (pipeline + workers) never imports from the UI layer", () => {
    expect(
      violationsOf("local", ["editor", "components", "pages"]),
    ).toEqual([]);
  });

  it("core/ is the dependency-free bottom layer", () => {
    expect(
      violationsOf(
        "core",
        ["editor", "local", "components", "pages"],
        ["react", "react-dom", "react-router-dom", "zustand"],
      ),
    ).toEqual([]);
  });
});
