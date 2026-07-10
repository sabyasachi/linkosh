// Build the unpacked extension: full clean → tsc -b → copy static assets →
// post-emit guards. Zero dependencies; runs from source via Node's type
// stripping (`npm run build`).
//
// Every tsconfig project's outDir sits at its repo-relative position under
// dist/, so dist/ mirrors the repo and **dist/src is the unpacked-extension
// root**. The mirror is what keeps relative imports, worker string URLs and
// import.meta.url vendor resolution working unchanged at runtime (and is
// required by rewriteRelativeImportExtensions across project boundaries).
import { cpSync, existsSync, globSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const ext = join(root, "dist", "src"); // the unpacked-extension root

// 1. Clean. Build info goes too: tsc -b trusts it, and a cleaned dist with
// stale build info would skip re-emitting.
rmSync(join(root, "dist"), { recursive: true, force: true });
rmSync(join(root, ".tsbuildinfo"), { recursive: true, force: true });

// 2. Compile every project (fails the build on any type error).
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-b"], { cwd: root, stdio: "inherit" });

// 3. Static assets, preserving layout. Vendor ships verbatim minus our
// hand-written declaration shims and notes (dev-only, dead weight in dist).
cpSync(join(src, "manifest.json"), join(ext, "manifest.json"));
cpSync(join(src, "debug.html"), join(ext, "debug.html"));
cpSync(join(src, "icons"), join(ext, "icons"), { recursive: true });
cpSync(join(src, "vendor"), join(ext, "vendor"), {
  recursive: true,
  filter: (p) => !/\.d\.(ts|mts)$/.test(p) && !p.endsWith("README.md"),
});
for (const rel of globSync("pages/**/*.{html,css}", { cwd: src })) {
  mkdirSync(join(ext, dirname(rel)), { recursive: true });
  cpSync(join(src, rel), join(ext, rel));
}

// 4a. Guard: injected functions are toString-serialized into third-party
// pages — any downlevel helper or module reference in their emit is a silent
// live-only breakage. Belt-and-braces over the compiler settings.
const injectedDir = join(ext, "injected");
if (existsSync(injectedDir)) {
  for (const rel of globSync("**/*.js", { cwd: injectedDir })) {
    const code = readFileSync(join(injectedDir, rel), "utf8");
    const hit = code.match(/__awaiter|__generator|__spreadArray|__assign|require\(/);
    if (hit) {
      throw new Error(
        `dist/src/injected/${rel} contains a helper reference (${hit[0]}) — ` +
          `the injected-function contract is broken (see src/injected/README.md)`
      );
    }
  }
}

// 4b. Guard: every file the manifest points at must exist in the built dir.
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
const referenced: string[] = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...(manifest.icons ? (Object.values(manifest.icons) as string[]) : []),
  ...(manifest.web_accessible_resources ?? []).flatMap((r: { resources: string[] }) => r.resources),
].filter(Boolean);
const missing = referenced.filter((rel) => !existsSync(join(ext, rel)));
if (missing.length) {
  throw new Error(`manifest.json references missing files in dist/src: ${missing.join(", ")}`);
}

console.log("dist/src ready — load it unpacked via chrome://extensions");
