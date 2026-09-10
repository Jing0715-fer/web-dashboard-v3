import { en } from "../src/lib/i18n/dictionaries/en.ts";
import fs from "fs";

const files = [
  "src/app/page.tsx",
  "src/components/auth/user-management-dialog.tsx",
  "src/components/analyze-wizard.tsx",
  "src/components/remote-project-dialog.tsx",
  "src/components/mesh-pairing.tsx",
  "src/components/mesh-join.tsx",
];
const used = new Map(); // key -> [file:line]
const re = /t\((["'`])([a-zA-Z0-9_.]+)\1/g;
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const key = m[2];
      if (!used.has(key)) used.set(key, []);
      used.get(key).push(`${f}:${i + 1}`);
    }
  });
}
const missing = [...used.keys()].filter((k) => !(k in en)).sort();
console.log("used static keys:", used.size);
console.log("MISSING from dict:", JSON.stringify(missing, null, 1));

// find dynamic key bases: t(`dlg.x.${v}`) patterns — collect prefixes
const dynRe = /t\(`([a-zA-Z0-9_.]+)\$\{/g;
const dyn = new Set();
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  let m;
  dynRe.lastIndex = 0;
  while ((m = dynRe.exec(src)) !== null) dyn.add(m[1]);
}
console.log("dynamic prefixes:", JSON.stringify([...dyn].sort()));
for (const p of [...dyn].sort()) {
  const matches = Object.keys(en).filter((k) => k.startsWith(p));
  console.log(`  ${p}* -> ${matches.length} keys:`, JSON.stringify(matches));
}
