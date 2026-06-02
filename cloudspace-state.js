const fs = require("fs");
const path = require("path");

const mode = process.argv[2];
const maxDataFileBytes = Number(process.env.SUPABASE_STATE_FILE_MAX_BYTES || 262144);

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

function safeWriteRawDataFile(dataDir, name, content) {
  const file = path.join(dataDir, name);
  const resolved = path.resolve(file);
  const root = path.resolve(dataDir);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing to write outside data dir: ${name}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content);
}

function shouldSkipDataFile(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  if (parts.some((part) => ["cache", "logs", "tmp", "temp"].includes(part.toLowerCase()))) {
    return true;
  }
  return /\.(log|tmp|bak|swp)$/i.test(normalized);
}

function walkFiles(dir, root = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(root, fullPath);
    if (shouldSkipDataFile(relativePath)) continue;
    if (entry.isDirectory()) {
      walkFiles(fullPath, root, out);
    } else if (entry.isFile()) {
      out.push(fullPath);
    }
  }
  return out;
}

function packDataFiles(dataDir) {
  const root = path.resolve(dataDir);
  const files = {};
  for (const file of walkFiles(root)) {
    const stat = fs.statSync(file);
    if (stat.size > maxDataFileBytes) {
      console.log(`Skipping data file above ${maxDataFileBytes} bytes: ${path.relative(root, file)}`);
      continue;
    }
    const relativePath = path.relative(root, file).split(path.sep).join("/");
    files[relativePath] = {
      encoding: "base64",
      size: stat.size,
      content: fs.readFileSync(file).toString("base64")
    };
  }
  return files;
}

function restoreDataFiles(dataDir, files) {
  if (!files || typeof files !== "object") return 0;
  let count = 0;
  for (const [relativePath, file] of Object.entries(files)) {
    if (!file || file.encoding !== "base64" || typeof file.content !== "string") continue;
    safeWriteRawDataFile(dataDir, relativePath, Buffer.from(file.content, "base64"));
    count += 1;
  }
  return count;
}

function restore(inputFile, dataDir, storageOutFile) {
  const raw = fs.readFileSync(inputFile, "utf8");
  const parsed = JSON.parse(raw);

  if (parsed && parsed.version === 2 && Object.prototype.hasOwnProperty.call(parsed, "subStoreStorage")) {
    writeJson(storageOutFile, parsed.subStoreStorage);
    if (parsed.files && parsed.files.accessLock) {
      safeWriteDataFile(dataDir, "cloudspace-access.json", parsed.files.accessLock);
      console.log("Restored CloudSpace access config from Supabase state");
    }
    console.log("Restored CloudSpace storage from Supabase state bundle");
    return;
  }

  if (parsed && parsed.version === 3 && (Object.prototype.hasOwnProperty.call(parsed, "cloudspaceStorage") || Object.prototype.hasOwnProperty.call(parsed, "subStoreStorage"))) {
    writeJson(storageOutFile, parsed.cloudspaceStorage || parsed.subStoreStorage);
    const restoredFiles = restoreDataFiles(dataDir, parsed.dataFiles);
    if (restoredFiles > 0) {
      console.log(`Restored ${restoredFiles} CloudSpace data files from Supabase state bundle`);
    }
    console.log("Restored CloudSpace storage from Supabase state bundle");
    return;
  }

  fs.writeFileSync(storageOutFile, raw.endsWith("\n") ? raw : `${raw}\n`);
  console.log("Restored legacy raw CloudSpace storage from Supabase state");
}

function backup(storageFile, dataDir, outputFile) {
  const cloudspaceStorage = readJson(storageFile);
  const dataFiles = packDataFiles(dataDir);

  writeJson(outputFile, {
    version: 3,
    createdAt: new Date().toISOString(),
    cloudspaceStorage,
    dataFiles
  });
  console.log(`Packed CloudSpace state bundle with ${Object.keys(dataFiles).length} data files`);
}

try {
  if (mode === "restore") {
    restore(process.argv[3], process.argv[4], process.argv[5]);
  } else if (mode === "backup") {
    backup(process.argv[3], process.argv[4], process.argv[5]);
  } else {
    throw new Error("Usage: node cloudspace-state.js restore <input> <dataDir> <storageOut> | backup <storage> <dataDir> <output>");
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
