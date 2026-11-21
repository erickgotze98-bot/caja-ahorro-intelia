import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const resolvedRoot = path.resolve(root);
const resolvedDist = path.resolve(dist);
if (!resolvedDist.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("La carpeta de salida debe permanecer dentro del proyecto.");
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });

execFileSync(process.execPath, [
  path.join(root, "node_modules", "tailwindcss", "lib", "cli.js"),
  "-c", path.join(root, "tailwind.config.js"),
  "-i", path.join(root, "styles.css"),
  "-o", path.join(dist, "styles.css"),
  "--minify"
], { cwd: root, stdio: "inherit" });

await build({
  entryPoints: [path.join(root, "app.js")],
  outfile: path.join(dist, "app.js"),
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  sourcemap: false
});

fs.copyFileSync(path.join(root, "index.html"), path.join(dist, "index.html"));
for (const name of ["manifest.webmanifest", "icon.svg", "sw.js", ".nojekyll"]) {
  fs.copyFileSync(path.join(root, name), path.join(dist, name));
}
console.log("Compilación lista en dist/");
