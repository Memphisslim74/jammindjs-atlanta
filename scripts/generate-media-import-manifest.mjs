import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("public/wp-content/uploads");
const output = path.resolve("public/_media-import-manifest.json");
const paths = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute);
    } else if (entry.isFile() && entry.name !== ".gitkeep") {
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      paths.push(`/wp-content/uploads/${relative}`);
    }
  }
}

await walk(root);
paths.sort();
await writeFile(output, `${JSON.stringify(paths)}\n`);
console.log(`Wrote ${paths.length} media paths to ${output}.`);
