#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const DEPS = join(DIST, "_deps");
const MODULES = join(DEPS, "modules");
const IMAGE_IDS = new Set();

function walk(dir, cb) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function writeU8(value) {
  const buf = Buffer.allocUnsafe(1);
  buf.writeUInt8(value, 0);
  return buf;
}

function writeI8(value) {
  const buf = Buffer.allocUnsafe(1);
  buf.writeInt8(value, 0);
  return buf;
}

function writeU16(value) {
  const buf = Buffer.allocUnsafe(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

function writeU32(value) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function writeI64(value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeBigInt64BE(BigInt(value), 0);
  return buf;
}

function writeF64(value) {
  const buf = Buffer.allocUnsafe(8);
  buf.writeDoubleBE(value, 0);
  return buf;
}

function writeString(value) {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([writeU32(bytes.length), bytes]);
}

function writeJson(value) {
  return writeString(JSON.stringify(value));
}

function rewriteAssetUrl(raw) {
  if (typeof raw !== "string") return raw;

  if (raw.startsWith("/_deps/")) {
    try {
      const url = new URL(raw, "https://local.invalid");
      if (!url.searchParams.has("pad")) return raw;
      url.searchParams.delete("pad");
      const search = url.searchParams.toString();
      return `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
    } catch {
      return raw;
    }
  }

  if (!raw.includes("framerusercontent.com")) return raw;

  try {
    const url = new URL(raw);
    if (url.hostname !== "framerusercontent.com") return raw;

    if (url.pathname.startsWith("/images/")) {
      const filename = url.pathname.split("/").pop();
      if (filename) IMAGE_IDS.add(filename);
      return "/_deps" + url.pathname;
    }

    if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/modules/") || url.pathname.startsWith("/sites/")) {
      return "/_deps" + url.pathname;
    }
  } catch {
    return raw;
  }

  return raw;
}

function rewriteSrcSet(raw) {
  if (typeof raw !== "string") return raw;
  if (!raw.includes("framerusercontent.com") && !raw.includes("/_deps/")) return raw;

  return raw
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const pieces = trimmed.split(/\s+/);
      const rewritten = rewriteAssetUrl(pieces[0]);
      return [rewritten, ...pieces.slice(1)].join(" ").trim();
    })
    .join(", ");
}

function rewriteJsonValue(value) {
  if (Array.isArray(value)) return value.map(rewriteJsonValue);

  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (key === "srcSet" && typeof inner === "string") out[key] = rewriteSrcSet(inner);
      else if (typeof inner === "string") out[key] = rewriteAssetUrl(inner);
      else out[key] = rewriteJsonValue(inner);
    }
    return out;
  }

  if (typeof value === "string") return rewriteAssetUrl(value);
  return value;
}

function rewriteUtf8Blob(text, tag) {
  const directRewrite = rewriteAssetUrl(text);
  if (directRewrite !== text) {
    return { text: directRewrite, changed: true };
  }

  if (!text.includes("framerusercontent.com") && !text.includes("/_deps/")) {
    return { text, changed: false };
  }

  if (tag === 10) {
    try {
      const parsed = JSON.parse(text);
      const rewritten = rewriteJsonValue(parsed);
      const next = JSON.stringify(rewritten);
      return { text: next, changed: next !== text };
    } catch {
      // Fall through to direct text replacement.
    }
  }

  const next = text.replace(
    /https:\/\/framerusercontent\.com\/[^\s"'`,<>)\]]+|\/_deps\/[^\s"'`,<>)\]]+/g,
    (match) => rewriteAssetUrl(match)
  );
  return { text: next, changed: next !== text };
}

function rewriteAssetUrlPreservingLength(raw) {
  if (typeof raw !== "string" || !raw.includes("framerusercontent.com")) return raw;

  const rewritten = rewriteAssetUrl(raw);
  if (rewritten === raw) return raw;
  if (rewritten.length > raw.length) return raw;
  if (rewritten.length === raw.length) return rewritten;

  const padLength = raw.length - rewritten.length;
  const sep = rewritten.includes("?") ? "&" : "?";
  const prefix = "pad=";
  const fillerLength = padLength - sep.length - prefix.length;
  if (fillerLength < 0) return raw;

  return rewritten + sep + prefix + "x".repeat(fillerLength);
}

function rewriteRawBufferPreservingLength(input) {
  const original = input.toString("latin1");
  let changed = false;
  const rewritten = original.replace(/https:\/\/framerusercontent\.com\/[^\s"'`,<>)\]]+/g, (match) => {
    const next = rewriteAssetUrlPreservingLength(match);
    if (next !== match) changed = true;
    return next;
  });

  if (!changed) return { changed: false, buffer: input, rewrittenFields: 0 };
  if (rewritten.length !== original.length) {
    throw new Error("Length-preserving rewrite changed byte length");
  }

  return {
    changed: true,
    buffer: Buffer.from(rewritten, "latin1"),
    rewrittenFields: (original.match(/https:\/\/framerusercontent\.com\/[^\s"'`,<>)\]]+/g) || []).length,
  };
}

function makeReader(buffer) {
  let offset = 0;

  function ensure(length) {
    if (offset + length > buffer.length) {
      throw new Error(`Reading out of bounds at ${offset} (+${length}) in buffer of ${buffer.length} bytes`);
    }
  }

  return {
    get offset() {
      return offset;
    },
    readU8() {
      ensure(1);
      const value = buffer.readUInt8(offset);
      offset += 1;
      return value;
    },
    readU16() {
      ensure(2);
      const value = buffer.readUInt16BE(offset);
      offset += 2;
      return value;
    },
    readU32() {
      ensure(4);
      const value = buffer.readUInt32BE(offset);
      offset += 4;
      return value;
    },
    readI8() {
      ensure(1);
      const value = buffer.readInt8(offset);
      offset += 1;
      return value;
    },
    readI64() {
      ensure(8);
      const value = Number(buffer.readBigInt64BE(offset));
      offset += 8;
      return value;
    },
    readF64() {
      ensure(8);
      const value = buffer.readDoubleBE(offset);
      offset += 8;
      return value;
    },
    readBytes(length) {
      ensure(length);
      const value = buffer.subarray(offset, offset + length);
      offset += length;
      return value;
    },
    readString() {
      const length = this.readU32();
      return this.readBytes(length).toString("utf8");
    },
    readJson() {
      return JSON.parse(this.readString());
    },
    done() {
      return offset >= buffer.length;
    },
  };
}

function readTypedValue(reader) {
  const tag = reader.readU8();

  switch (tag) {
    case 0:
      return { tag, value: null };
    case 1: {
      const count = reader.readU16();
      return {
        tag,
        value: Array.from({ length: count }, () => readTypedValue(reader)),
      };
    }
    case 2:
      return { tag, value: reader.readU8() !== 0 };
    case 3:
    case 5:
    case 6:
    case 12:
      return { tag, value: reader.readString() };
    case 4:
      return { tag, value: reader.readI64() };
    case 7:
    case 10:
      return { tag, value: reader.readJson() };
    case 8:
      return { tag, value: reader.readF64() };
    case 9: {
      const count = reader.readU16();
      const value = [];
      for (let i = 0; i < count; i++) {
        value.push({ key: reader.readString(), value: readTypedValue(reader) });
      }
      return { tag, value };
    }
    case 11: {
      const marker = reader.readI8();
      if (marker === 0) return { tag, marker, value: reader.readU32() };
      if (marker === 1) return { tag, marker, value: reader.readString() };
      throw new Error(`Invalid rich text marker ${marker}`);
    }
    case 13:
      return { tag, value: reader.readU32() };
    default:
      throw new Error(`Unsupported typed value tag ${tag}`);
  }
}

function writeTypedValue(node) {
  if (!node || typeof node !== "object" || typeof node.tag !== "number") {
    throw new Error("Invalid typed value node");
  }

  const parts = [writeU8(node.tag)];

  switch (node.tag) {
    case 0:
      break;
    case 1:
      parts.push(writeU16(node.value.length), ...node.value.map(writeTypedValue));
      break;
    case 2:
      parts.push(writeU8(node.value ? 1 : 0));
      break;
    case 3:
    case 5:
    case 6:
    case 12:
      parts.push(writeString(node.value));
      break;
    case 4:
      parts.push(writeI64(node.value));
      break;
    case 7:
    case 10:
      parts.push(writeJson(node.value));
      break;
    case 8:
      parts.push(writeF64(node.value));
      break;
    case 9:
      parts.push(
        writeU16(node.value.length),
        ...node.value.flatMap((entry) => [writeString(entry.key), writeTypedValue(entry.value)])
      );
      break;
    case 11:
      parts.push(writeI8(node.marker));
      if (node.marker === 0) parts.push(writeU32(node.value));
      else if (node.marker === 1) parts.push(writeString(node.value));
      else throw new Error(`Invalid rich text marker ${node.marker}`);
      break;
    case 13:
      parts.push(writeU32(node.value));
      break;
    default:
      throw new Error(`Unsupported typed value tag ${node.tag}`);
  }

  return Buffer.concat(parts);
}

function rewriteTypedNode(node) {
  switch (node.tag) {
    case 0:
    case 2:
    case 4:
    case 8:
    case 13:
      return { node, changed: false, rewrittenFields: 0 };
    case 1: {
      let changed = false;
      let rewrittenFields = 0;
      const value = node.value.map((entry) => {
        const result = rewriteTypedNode(entry);
        changed ||= result.changed;
        rewrittenFields += result.rewrittenFields;
        return result.node;
      });
      return { node: { ...node, value }, changed, rewrittenFields };
    }
    case 3:
    case 5:
    case 6:
    case 12: {
      const { text, changed } = rewriteUtf8Blob(node.value, node.tag);
      return { node: changed ? { ...node, value: text } : node, changed, rewrittenFields: changed ? 1 : 0 };
    }
    case 7:
    case 10: {
      const rewritten = rewriteJsonValue(node.value);
      const changed = JSON.stringify(rewritten) !== JSON.stringify(node.value);
      return { node: changed ? { ...node, value: rewritten } : node, changed, rewrittenFields: changed ? 1 : 0 };
    }
    case 9: {
      let changed = false;
      let rewrittenFields = 0;
      const value = node.value.map((entry) => {
        const result = rewriteTypedNode(entry.value);
        changed ||= result.changed;
        rewrittenFields += result.rewrittenFields;
        return result.changed ? { key: entry.key, value: result.node } : entry;
      });
      return { node: changed ? { ...node, value } : node, changed, rewrittenFields };
    }
    case 11: {
      if (node.marker !== 1 || typeof node.value !== "string") {
        return { node, changed: false, rewrittenFields: 0 };
      }
      const { text, changed } = rewriteUtf8Blob(node.value, node.tag);
      return { node: changed ? { ...node, value: text } : node, changed, rewrittenFields: changed ? 1 : 0 };
    }
    default:
      throw new Error(`Unsupported typed value tag ${node.tag}`);
  }
}

function rewriteChunkFile(filePath) {
  const input = readFileSync(filePath);
  const reader = makeReader(input);
  const recordCount = reader.readU32();

  const outputParts = [writeU32(recordCount)];
  let changed = false;
  let rewrittenFields = 0;

  for (let recordIndex = 0; recordIndex < recordCount; recordIndex++) {
    const fieldCount = reader.readU16();
    outputParts.push(writeU16(fieldCount));

    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex++) {
      const name = reader.readString();
      const node = readTypedValue(reader);
      const result = rewriteTypedNode(node);
      changed ||= result.changed;
      rewrittenFields += result.rewrittenFields;
      outputParts.push(writeString(name), writeTypedValue(result.node));
    }
  }

  if (!reader.done()) {
    throw new Error(`Parser did not consume ${filePath} cleanly (${input.length - reader.offset} bytes remain)`);
  }

  if (changed) {
    writeFileSync(filePath, Buffer.concat(outputParts));
  }

  return { changed, rewrittenFields, rangePatchedFiles: 0, rangePatchedRefs: 0 };
}

function readIndexModel(reader) {
  const start = reader.offset;
  const collation = reader.readJson();
  const fieldCount = reader.readU8();
  const fieldNames = Array.from({ length: fieldCount }, () => reader.readString());
  const entryCount = reader.readU32();
  const entries = [];

  for (let entryIndex = 0; entryIndex < entryCount; entryIndex++) {
    const values = fieldNames.map(() => readTypedValue(reader));
    const pointer = {
      chunkId: reader.readU16(),
      offset: reader.readU32(),
      length: reader.readU32(),
    };
    entries.push({ values, pointer });
  }

  return {
    start,
    end: reader.offset,
    collation,
    fieldNames,
    entries,
  };
}

function writeIndexModel(model) {
  const parts = [
    writeJson(model.collation),
    writeU8(model.fieldNames.length),
    ...model.fieldNames.map(writeString),
    writeU32(model.entries.length),
  ];

  for (const entry of model.entries) {
    parts.push(...entry.values.map(writeTypedValue));
    parts.push(writeU16(entry.pointer.chunkId), writeU32(entry.pointer.offset), writeU32(entry.pointer.length));
  }

  return Buffer.concat(parts);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patchIndexRangeReferences(indexFilePath, rangeUpdates) {
  if (rangeUpdates.length === 0) return { patchedFiles: 0, patchedRefs: 0 };

  const targetName = basename(indexFilePath);
  const targetNameRegex = escapeRegExp(targetName);
  let patchedFiles = 0;
  let patchedRefs = 0;

  walk(DEPS, (candidatePath) => {
    if (!/\.(mjs|js|html)$/i.test(candidatePath)) return;

    const original = readFileSync(candidatePath, "utf8");
    if (!original.includes(targetName) || !original.includes("range:{from:")) return;

    let next = original;
    for (const update of rangeUpdates) {
      const pattern = new RegExp(
        `range:\\{from:${update.oldFrom},to:${update.oldTo}\\}(?=,url:new URL\\(\\\`\\./${targetNameRegex}\\\`)`,
        "g"
      );
      const matches = next.match(pattern);
      if (matches) patchedRefs += matches.length;
      next = next.replace(pattern, `range:{from:${update.newFrom},to:${update.newTo}}`);
    }

    if (next !== original) {
      writeFileSync(candidatePath, next);
      patchedFiles++;
    }
  });

  return { patchedFiles, patchedRefs };
}

// Scan a chunk file and return Map<id_string, {offset, length}> keyed by the "id" field value.
function scanChunkFile(filePath) {
  const input = readFileSync(filePath);
  const reader = makeReader(input);
  const recordCount = reader.readU32();
  const idMap = new Map();

  for (let ri = 0; ri < recordCount; ri++) {
    const recStart = reader.offset;
    const fieldCount = reader.readU16();
    let idValue = null;

    for (let fi = 0; fi < fieldCount; fi++) {
      const name = reader.readString();
      const value = readTypedValue(reader);
      if (name === "id" && value.tag === 12) idValue = value.value;
    }

    const recLength = reader.offset - recStart;
    if (idValue !== null) idMap.set(idValue, { offset: recStart, length: recLength });
  }

  return idMap;
}

// Build a stale-offset → correct-{offset,length} map using index models that carry an "id" field.
function buildStalePointerCorrections(models, chunkIdMaps) {
  const corrections = new Map(); // key: "chunkId:staleOffset"
  if (!chunkIdMaps) return corrections;

  for (const model of models) {
    const idIdx = model.fieldNames.indexOf("id");
    if (idIdx < 0) continue;

    for (const entry of model.entries) {
      const idVal = entry.values[idIdx];
      if (!idVal || idVal.tag !== 12) continue;

      const chunkMap = chunkIdMaps.get(entry.pointer.chunkId);
      if (!chunkMap) continue;

      const correct = chunkMap.get(idVal.value);
      if (!correct) continue;

      const key = `${entry.pointer.chunkId}:${entry.pointer.offset}`;
      if (!corrections.has(key) &&
          (correct.offset !== entry.pointer.offset || correct.length !== entry.pointer.length)) {
        corrections.set(key, { chunkId: entry.pointer.chunkId, offset: correct.offset, length: correct.length });
      }
    }
    break; // one model with "id" field is sufficient
  }

  return corrections;
}

function rewriteIndexFile(filePath, chunkIdMaps) {
  const input = readFileSync(filePath);
  const reader = makeReader(input);
  const models = [];
  let changed = false;
  let rewrittenFields = 0;

  while (!reader.done()) {
    const model = readIndexModel(reader);
    const nextEntries = [];

    for (const entry of model.entries) {
      const values = entry.values.map((value) => {
        const result = rewriteTypedNode(value);
        changed ||= result.changed;
        rewrittenFields += result.rewrittenFields;
        return result.node;
      });
      nextEntries.push({ values, pointer: entry.pointer });
    }

    models.push({
      originalStart: model.start,
      originalEnd: model.end,
      collation: model.collation,
      fieldNames: model.fieldNames,
      entries: nextEntries,
    });
  }

  // Fix stale chunk pointer offsets caused by the chunk file being rewritten with shorter URLs.
  const staleToCorrect = buildStalePointerCorrections(models, chunkIdMaps);
  if (staleToCorrect.size > 0) {
    for (const model of models) {
      for (const entry of model.entries) {
        const key = `${entry.pointer.chunkId}:${entry.pointer.offset}`;
        const correction = staleToCorrect.get(key);
        if (correction) {
          entry.pointer = correction;
          changed = true;
        }
      }
    }
    console.log(`  Corrected ${staleToCorrect.size} stale chunk pointer(s) in ${basename(filePath)}`);
  }

  const outputParts = [];
  const rangeUpdates = [];
  let nextOffset = 0;

  for (const model of models) {
    const buffer = writeIndexModel(model);
    const newStart = nextOffset;
    const newEnd = newStart + buffer.length;
    rangeUpdates.push({
      oldFrom: model.originalStart,
      oldTo: model.originalEnd,
      newFrom: newStart,
      newTo: newEnd,
    });
    outputParts.push(buffer);
    nextOffset = newEnd;
  }

  const output = Buffer.concat(outputParts);
  const rangesChanged = rangeUpdates.some((update) => update.oldFrom !== update.newFrom || update.oldTo !== update.newTo);

  let rangePatchedFiles = 0;
  let rangePatchedRefs = 0;

  if (changed || rangesChanged) {
    writeFileSync(filePath, output);
    const patched = patchIndexRangeReferences(filePath, rangeUpdates);
    rangePatchedFiles = patched.patchedFiles;
    rangePatchedRefs = patched.patchedRefs;
  }

  return {
    changed: changed || rangesChanged,
    rewrittenFields,
    rangePatchedFiles,
    rangePatchedRefs,
  };
}

async function downloadMissingImages() {
  const imagesDir = join(DEPS, "images");
  mkdirSync(imagesDir, { recursive: true });

  const missing = [...IMAGE_IDS].filter((id) => !existsSync(join(imagesDir, id)));
  if (missing.length === 0) {
    console.log("All CMS-referenced images already present");
    return;
  }

  console.log(`Downloading ${missing.length} missing CMS-referenced images...`);
  for (let i = 0; i < missing.length; i += 8) {
    const batch = missing.slice(i, i + 8);
    await Promise.all(
      batch.map(async (id) => {
        const url = `https://framerusercontent.com/images/${id}`;
        const dest = join(imagesDir, id);
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
          if (!res.ok) {
            console.warn(`  Warning: ${res.status} ${url}`);
            return;
          }
          const buf = Buffer.from(await res.arrayBuffer());
          writeFileSync(dest, buf);
          console.log(`  Downloaded /images/${id} (${(buf.length / 1024).toFixed(0)}KB)`);
        } catch (err) {
          console.warn(`  Warning: ${url} (${err.message})`);
        }
      })
    );
  }
}

async function main() {
  let changedFiles = 0;
  let rewrittenFields = 0;
  let skippedFiles = 0;
  let rangePatchedFiles = 0;
  let rangePatchedRefs = 0;

  // PASS 1: process chunk files and collect id→position maps.
  // key: "dir|prefix|locale" → Map<chunkIndex, Map<id, {offset, length}>>
  const chunkIdMapsPerKey = new Map();

  walk(MODULES, (filePath) => {
    if (!filePath.endsWith(".framercms") || filePath.includes("-indexes-")) return;

    try {
      const result = rewriteChunkFile(filePath);
      if (result.changed) {
        changedFiles++;
        rewrittenFields += result.rewrittenFields;
        console.log(`Rewrote ${result.rewrittenFields} fields in ${filePath}`);
      }
    } catch (err) {
      try {
        const raw = readFileSync(filePath);
        const hasCdnUrls = raw.toString('latin1').includes('framerusercontent.com');
        if (!hasCdnUrls) {
          // Unrecognized format but no CDN URLs present — nothing to rewrite.
          skippedFiles++;
          console.log(`  Skipped (unrecognized format, no CDN URLs): ${basename(filePath)}`);
        } else {
          const fallback = rewriteRawBufferPreservingLength(raw);
          if (fallback.changed) {
            writeFileSync(filePath, fallback.buffer);
            changedFiles++;
            rewrittenFields += fallback.rewrittenFields;
            console.log(`Rewrote ${fallback.rewrittenFields} URL occurrences in unsupported CMS file ${filePath}`);
          } else {
            skippedFiles++;
            console.warn(`Skipped unsupported CMS chunk ${filePath}: ${err.message}`);
          }
        }
      } catch (fallbackErr) {
        skippedFiles++;
        console.warn(`Skipped unsupported CMS chunk ${filePath}: ${fallbackErr.message}`);
      }
    }

    // Scan the current (possibly just-rewritten) chunk file for id→position map.
    try {
      const match = basename(filePath).match(/^(.+)-chunk-(.+)-(\d+)\.framercms$/);
      if (match) {
        const [, prefix, locale, idxStr] = match;
        const mapKey = `${dirname(filePath)}|${prefix}|${locale}`;
        if (!chunkIdMapsPerKey.has(mapKey)) chunkIdMapsPerKey.set(mapKey, new Map());
        chunkIdMapsPerKey.get(mapKey).set(parseInt(idxStr), scanChunkFile(filePath));
      }
    } catch (scanErr) {
      console.warn(`Could not scan chunk id map for ${filePath}: ${scanErr.message}`);
    }
  });

  // PASS 2: process index files, passing the chunk id maps for pointer correction.
  walk(MODULES, (filePath) => {
    if (!filePath.endsWith(".framercms") || !filePath.includes("-indexes-")) return;

    let chunkIdMaps = null;
    const match = basename(filePath).match(/^(.+)-indexes-(.+)-\d+\.framercms$/);
    if (match) {
      const [, prefix, locale] = match;
      const mapKey = `${dirname(filePath)}|${prefix}|${locale}`;
      chunkIdMaps = chunkIdMapsPerKey.get(mapKey) ?? null;
    }

    try {
      const result = rewriteIndexFile(filePath, chunkIdMaps);
      if (result.changed) {
        changedFiles++;
        rewrittenFields += result.rewrittenFields;
        rangePatchedFiles += result.rangePatchedFiles;
        rangePatchedRefs += result.rangePatchedRefs;
        console.log(`Rewrote ${result.rewrittenFields} fields in ${filePath}`);
        if (result.rangePatchedRefs > 0) {
          console.log(`Patched ${result.rangePatchedRefs} range references across ${result.rangePatchedFiles} generated files for ${basename(filePath)}`);
        }
      }
    } catch (err) {
      skippedFiles++;
      console.warn(`Skipped unsupported CMS index ${filePath}: ${err.message}`);
    }
  });

  console.log(`Rewrote ${rewrittenFields} CMS fields across ${changedFiles} CMS files`);
  if (rangePatchedRefs > 0) {
    console.log(`Patched ${rangePatchedRefs} generated range references across ${rangePatchedFiles} files`);
  }
  if (skippedFiles > 0) {
    console.log(`Skipped ${skippedFiles} CMS files with unsupported encoding`);
  }
  await downloadMissingImages();
}

main().catch((err) => {
  console.error("Failed to rewrite Framer CMS chunks:", err);
  process.exit(1);
});
