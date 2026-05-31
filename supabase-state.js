const fs = require("fs");
const path = require("path");

const mode = process.argv[2];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function safeWriteDataFile(dataDir, name, value) {
  const file = path.join(dataDir, name);
  const resolved = path.resolve(file);
  const root = path.resolve(dataDir);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside data dir: ${name}`);
  }
  writeJson(resolved, value);
}

function restore(inputFile, dataDir, storageOutFile) {
  const raw = fs.readFileSync(inputFile, "utf8");
  const parsed = JSON.parse(raw);

  if (parsed && parsed.version === 2 && Object.prototype.hasOwnProperty.call(parsed, "subStoreStorage")) {
    writeJson(storageOutFile, parsed.subStoreStorage);
    if (parsed.files && parsed.files.accessLock) {
      safeWriteDataFile(dataDir, "access-lock.json", parsed.files.accessLock);
      console.log("Restored access lock config from Supabase state");
    }
    console.log("Restored Sub-Store storage from Supabase state bundle");
    return;
  }

  fs.writeFileSync(storageOutFile, raw.endsWith("\n") ? raw : `${raw}\n`);
  console.log("Restored legacy raw Sub-Store storage from Supabase state");
}

function backup(storageFile, dataDir, outputFile) {
  const subStoreStorage = readJson(storageFile);
  const files = {};
  const lockFile = path.join(dataDir, "access-lock.json");
  if (fs.existsSync(lockFile)) {
    files.accessLock = readJson(lockFile);
  }

  writeJson(outputFile, {
    version: 2,
    createdAt: new Date().toISOString(),
    subStoreStorage,
    files
  });
  console.log("Packed Sub-Store state bundle");
}

try {
  if (mode === "restore") {
    restore(process.argv[3], process.argv[4], process.argv[5]);
  } else if (mode === "backup") {
    backup(process.argv[3], process.argv[4], process.argv[5]);
  } else {
    throw new Error("Usage: node supabase-state.js restore <input> <dataDir> <storageOut> | backup <storage> <dataDir> <output>");
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
