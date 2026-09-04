import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const command = process.argv[2];

if (command === "fingerprint") {
  printFingerprint();
} else if (command === "verify") {
  await verifyNativeDependencies();
} else {
  throw new Error("ci-native-dependencies requires fingerprint or verify");
}

function printFingerprint() {
  const lock = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
  const packagePaths = [
    "node_modules/better-sqlite3",
    "node_modules/node-pty",
    "node_modules/node-addon-api"
  ];
  const packages = packagePaths.map((path) => {
    const entry = lock.packages?.[path];
    if (typeof entry?.version !== "string" || typeof entry.integrity !== "string") {
      throw new Error(`package-lock.json is missing the locked native input ${path}`);
    }
    return {
      path,
      version: entry.version,
      integrity: entry.integrity
    };
  });
  const input = JSON.stringify({
    imageOs: process.env.ImageOS ?? process.platform,
    architecture: process.arch,
    nodeAbi: process.versions.modules,
    packages
  });
  const digest = createHash("sha256").update(input).digest("hex");

  console.log(`${process.platform}-${process.arch}-abi${process.versions.modules}-${digest}`);
}

async function verifyNativeDependencies() {
  const [{ default: Database }, nodePty] = await Promise.all([
    import("better-sqlite3"),
    import("node-pty")
  ]);
  const database = new Database(":memory:");

  try {
    const result = database.prepare("SELECT 1 AS value").get();
    if (result?.value !== 1) {
      throw new Error("better-sqlite3 native query returned an unexpected result");
    }
    if (typeof nodePty.spawn !== "function") {
      throw new Error("node-pty native module did not expose spawn");
    }
  } finally {
    database.close();
  }

  console.log("Native dependencies verified.");
}
